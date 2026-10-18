import { randomUUID } from "node:crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";

import { PostgresTransactionManager } from "../../shared/infrastructure/postgres-transaction-manager";
import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../../wallet/domain/money";
import { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry";
import { TransactionalWalletRepository } from "../../wallet/infrastructure/transactional-wallet.repository";
import { TransactionalWalletLedgerRepository } from "../../wallet/infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWagerTransactionRepository } from "../infrastructure/transactional-wager-transaction.repository";
import { WagerTransactionEntity } from "../infrastructure/wager-transaction.entity";
import { MetricsRegistry } from "../../observability/metrics.registry";
import { TransactionalOutboxRepository } from "../../messaging/infrastructure/transactional-outbox.repository";
import { WagerTransaction } from "../domain/wager-transaction";
import { IdempotencyService } from "../../shared/infrastructure/idempotency.service";
import { IdempotencyConflictError } from "../../shared/domain/idempotency-conflict.error";
import {
  WagerTransactionStatus,
  WagerTransactionType,
} from "../domain/wager-transaction.types";

export interface ProcessBetInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  currency?: string;
  amount?: string;
  kind?: WagerTransactionType;
  money?: { amount: string; currency: string };
  idempotencyKey: string;
  referenceExternalTransactionId?: string;
}

export interface ProcessBetResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: string | null;
  failureCode: string | null;
  idempotentReplay?: boolean;
}

@Injectable()
export class ProcessBetUseCase {
  private readonly logger = new Logger(ProcessBetUseCase.name);
  constructor(
    private readonly transactionManager: PostgresTransactionManager,
    private readonly walletRepository: TransactionalWalletRepository,
    private readonly ledgerRepository: TransactionalWalletLedgerRepository,
    private readonly wagerRepository: TransactionalWagerTransactionRepository,
    private readonly idempotencyService: IdempotencyService,
    private readonly outboxRepository: TransactionalOutboxRepository,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  async retryPendingReferences(
    batchSize = 25,
    transactionIds?: readonly string[],
  ): Promise<number> {
    const ids = await this.transactionManager.execute((em) =>
      this.wagerRepository.findDuePendingReferenceIds(
        em,
        batchSize,
        transactionIds,
      ),
    );
    let completed = 0;
    for (const transactionId of ids) {
      const changed = await this.transactionManager.execute(async (em) => {
        const pending = await this.wagerRepository.findById(em, transactionId);
        if (
          !pending ||
          pending.status !== WagerTransactionStatus.PENDING_REFERENCE ||
          !pending.referenceNextAttemptAt ||
          pending.referenceNextAttemptAt > new Date()
        ) return false;

        const nextAttempt = pending.referenceAttempts + 1;
        const maxAttempts = Number(process.env.REFERENCE_MAX_ATTEMPTS ?? 12);
        if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
          throw new Error("REFERENCE_MAX_ATTEMPTS must be a positive integer.");
        }
        const reference = pending.referenceExternalTransactionId
          ? await this.wagerRepository.findByProviderAndExternalId(
              em,
              pending.providerId,
              pending.referenceExternalTransactionId,
            )
          : null;
        const waitingForReference =
          !reference ||
          reference.status === WagerTransactionStatus.PENDING ||
          reference.status === WagerTransactionStatus.PENDING_REFERENCE;

        if (waitingForReference && nextAttempt < maxAttempts) {
          const delaySeconds = Math.min(300, 2 ** Math.min(nextAttempt, 8));
          await em.nativeUpdate(
            WagerTransactionEntity,
            { id: pending.id, status: WagerTransactionStatus.PENDING_REFERENCE },
            {
              referenceAttempts: nextAttempt,
              referenceNextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
            },
          );
          this.metrics?.increment("pending_reference_retries_total");
          return true;
        }

        const wallet = await this.walletRepository.findByIdForUpdate(em, pending.walletId);
        let status = WagerTransactionStatus.REJECTED;
        let failureCode: string | null = waitingForReference
          ? "REFERENCE_NOT_FOUND"
          : null;
        let referenceId: string | null = reference?.id ?? null;
        let ledgerEntry;

        if (!waitingForReference && wallet && reference) {
          if (
            reference.status !== WagerTransactionStatus.PROCESSED ||
            reference.playerId !== pending.playerId ||
            reference.walletId !== pending.walletId ||
            reference.currency !== pending.currency ||
            reference.roundId !== pending.roundId
          ) failureCode = "REFERENCE_NOT_REVERSIBLE";
          else if (
            (pending.type === WagerTransactionType.REFUND || pending.type === WagerTransactionType.ROLLBACK) &&
            pending.amount !== reference.amount
          ) failureCode = "REFERENCE_AMOUNT_MISMATCH";
          else if (pending.type === WagerTransactionType.REFUND && reference.type !== WagerTransactionType.BET)
            failureCode = "REFERENCE_NOT_REVERSIBLE";
          else if (pending.type === WagerTransactionType.ROLLBACK && ![
            WagerTransactionType.BET,
            WagerTransactionType.WIN,
            WagerTransactionType.REFUND,
          ].includes(reference.type)) failureCode = "REFERENCE_NOT_REVERSIBLE";
          else if (pending.type === WagerTransactionType.WIN && reference.type !== WagerTransactionType.BET)
            failureCode = "REFERENCE_NOT_REVERSIBLE";
          else if (
            (pending.type === WagerTransactionType.REFUND || pending.type === WagerTransactionType.ROLLBACK) &&
            await this.wagerRepository.hasPriorReversal(em, reference.id, pending.type)
          ) failureCode = "REFERENCE_ALREADY_REVERSED";
          else {
            const amount = Money.create(pending.amount, pending.currency);
            const shouldDebit = pending.type === WagerTransactionType.ROLLBACK &&
              reference.type !== WagerTransactionType.BET;
            try {
              if (pending.type === WagerTransactionType.BET || shouldDebit) {
                ledgerEntry = wallet.debit(amount, pending.id);
              } else if (pending.type !== WagerTransactionType.LOSS) {
                ledgerEntry = wallet.credit(amount, pending.id);
              }
              status = WagerTransactionStatus.PROCESSED;
            } catch (error: unknown) {
              if (!(error instanceof DomainError) || error.code !== "INSUFFICIENT_FUNDS") throw error;
              failureCode = "REVERSAL_INSUFFICIENT_FUNDS";
            }
          }
        } else if (!wallet) {
          failureCode = "WALLET_NOT_FOUND";
        }

        await em.nativeUpdate(WagerTransactionEntity, { id: pending.id }, {
          status,
          failureCode,
          referenceTransactionId: referenceId,
          referenceAttempts: nextAttempt,
          referenceNextAttemptAt: null,
          processedAt: status === WagerTransactionStatus.PROCESSED ? new Date() : null,
          updatedAt: new Date(),
        });
        if (ledgerEntry && wallet) {
          await this.walletRepository.updateBalance(em, wallet);
          await this.ledgerRepository.insert(em, ledgerEntry);
        }
        const balance = wallet?.balance.toString() ?? null;
        const result: ProcessBetResult = {
          transactionId: pending.id,
          status,
          balance,
          failureCode,
        };
        await this.idempotencyService.updateResponse(
          em,
          "PROCESS_BET",
          pending.idempotencyKey,
          result as unknown as Record<string, unknown>,
        );
        await this.outboxRepository.enqueue(em, {
          eventType: status === WagerTransactionStatus.PROCESSED
            ? "WAGER.PROCESSED"
            : "WAGER.REJECTED",
          aggregateId: pending.id,
          payload: {
            transactionId: pending.id,
            providerId: pending.providerId,
            externalTransactionId: pending.externalTransactionId,
            status,
            balance,
            failureCode,
          },
        });
        if (ledgerEntry && balance !== null && wallet) {
          await this.outboxRepository.enqueue(em, {
            eventType: "WALLET.BALANCE_CHANGED",
            aggregateId: pending.walletId,
            payload: {
              walletId: pending.walletId,
              transactionId: pending.id,
              direction: ledgerEntry.type,
              money: {
                amount: ledgerEntry.amount.toString(),
                currency: ledgerEntry.amount.currency,
              },
              balanceBefore: {
                amount: ledgerEntry.balanceBefore.toString(),
                currency: ledgerEntry.balanceBefore.currency,
              },
              balanceAfter: {
                amount: ledgerEntry.balanceAfter.toString(),
                currency: ledgerEntry.balanceAfter.currency,
              },
              walletVersion: wallet.version,
            },
          });
        }
        this.logger.log(JSON.stringify({ event: "pending_reference_resolved", transactionId: pending.id, status, attempts: nextAttempt }));
        this.metrics?.increment("wager_transactions_total", { status, kind: pending.type });
        return true;
      });
      if (changed) completed += 1;
    }
    return completed;
  }

  async execute(
    input: ProcessBetInput,
    existingEm?: EntityManager,
  ): Promise<ProcessBetResult> {
    const startedAt = Date.now();
    const providerId = input.providerId.trim();
    const externalTransactionId = input.externalTransactionId.trim();
    const playerId = input.playerId.trim();
    const walletId = input.walletId.trim();
    const roundId = input.roundId.trim();
    const gameId = input.gameId.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    const kind = input.kind ?? WagerTransactionType.BET;
    const currency = (input.money?.currency ?? input.currency ?? "").trim().toUpperCase();
    const amount = Money.create(input.money?.amount ?? input.amount ?? "", currency);
    const referenceExternalTransactionId =
      input.referenceExternalTransactionId?.trim() || undefined;

    if (
      !providerId ||
      !externalTransactionId ||
      !playerId ||
      !walletId ||
      !roundId ||
      !gameId
    ) {
      throw new DomainError(
        "INVALID_TRANSACTION_INPUT",
        "Provider, external transaction, player, wallet, round and game are required.",
      );
    }

    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new DomainError(
        "INVALID_IDEMPOTENCY_KEY",
        "A valid idempotency key is required.",
      );
    }

    if (kind === WagerTransactionType.OPENING) {
      throw new DomainError("INVALID_TRANSACTION_KIND", "OPENING is reserved for wallet creation.");
    }
    if (!Object.values(WagerTransactionType).includes(kind)) {
      throw new DomainError("INVALID_TRANSACTION_KIND", "Transaction kind is not supported.");
    }

    const payload = {
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      type: kind,
      currency,
      amount: amount.toString(),
      referenceExternalTransactionId: referenceExternalTransactionId ?? null,
    };

    const payloadHash = this.idempotencyService.hashPayload(payload);

    const result = await this.transactionManager.execute(async (em) => {
      const reserved = await this.idempotencyService.reserve(
        em,
        "PROCESS_BET",
        idempotencyKey,
        payloadHash,
      );

      if (!reserved) {
        const existing = await this.idempotencyService.find(
          em,
          "PROCESS_BET",
          idempotencyKey,
        );

        if (!existing) {
          throw new Error("Idempotency record was not found after conflict.");
        }

        if (existing.payloadHash !== payloadHash) {
          throw new IdempotencyConflictError();
        }

        return {
          ...(existing.response as unknown as ProcessBetResult),
          idempotentReplay: true,
        };
      }

      const transaction = WagerTransaction.create({
        id: randomUUID(),
        providerId,
        externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId,
        playerId,
        roundId,
        gameId,
        type: kind,
        amount,
        referenceExternalTransactionId,
      });

      const wallet = await this.walletRepository.findByIdForUpdate(
        em,
        walletId,
      );

      let result: ProcessBetResult;
      let ledgerEntry: WalletLedgerEntry | undefined;

      if (
        !wallet ||
        wallet.playerId !== playerId ||
        wallet.currency !== currency
      ) {
        transaction.markRejected("WALLET_NOT_FOUND");

        await this.wagerRepository.insert(em, transaction);

        result = {
          transactionId: transaction.id,
          status: transaction.status,
          balance: null,
          failureCode: transaction.failureCode,
        };
      } else {
        const reference = referenceExternalTransactionId
          ? await this.wagerRepository.findByProviderAndExternalId(
              em,
              providerId,
              referenceExternalTransactionId,
            )
          : null;

        if (
          !reference &&
          (kind === WagerTransactionType.REFUND ||
            kind === WagerTransactionType.ROLLBACK ||
            (kind === WagerTransactionType.WIN && referenceExternalTransactionId))
        ) {
          transaction.markPendingReference();
          await this.wagerRepository.insert(em, transaction);
          result = { transactionId: transaction.id, status: transaction.status, balance: wallet.balance.toString(), failureCode: null };
        } else {
          if (reference) transaction.resolveReference(reference.id);
          let rejectionCode: string | undefined;
          if (referenceExternalTransactionId && reference) {
            if (
              reference.status === WagerTransactionStatus.PENDING ||
              reference.status === WagerTransactionStatus.PENDING_REFERENCE
            ) {
              transaction.markPendingReference();
            } else if (reference.status !== WagerTransactionStatus.PROCESSED || reference.playerId !== playerId || reference.walletId !== walletId || reference.currency !== currency || reference.roundId !== roundId) rejectionCode = "REFERENCE_NOT_REVERSIBLE";
            else if ((kind === WagerTransactionType.REFUND || kind === WagerTransactionType.ROLLBACK) && amount.toString() !== reference.amount) rejectionCode = "REFERENCE_AMOUNT_MISMATCH";
            else if (kind === WagerTransactionType.REFUND && reference.type !== WagerTransactionType.BET) rejectionCode = "REFERENCE_NOT_REVERSIBLE";
            else if (kind === WagerTransactionType.ROLLBACK && ![WagerTransactionType.BET, WagerTransactionType.WIN, WagerTransactionType.REFUND].includes(reference.type)) rejectionCode = "REFERENCE_NOT_REVERSIBLE";
            else if (kind === WagerTransactionType.WIN && reference.type !== WagerTransactionType.BET) rejectionCode = "REFERENCE_NOT_REVERSIBLE";
            else if ((kind === WagerTransactionType.REFUND || kind === WagerTransactionType.ROLLBACK) && await this.wagerRepository.hasPriorReversal(em, reference.id, kind)) rejectionCode = "REFERENCE_ALREADY_REVERSED";
          } else if (kind === WagerTransactionType.WIN && referenceExternalTransactionId && !reference) {
            transaction.markPendingReference();
          }

          if (rejectionCode) transaction.markRejected(rejectionCode);
          if (!rejectionCode && transaction.status !== WagerTransactionStatus.PENDING_REFERENCE) {
            try {
              let direction: "DEBIT" | "CREDIT" | undefined = kind === WagerTransactionType.BET
                ? "DEBIT"
                : kind === WagerTransactionType.LOSS
                  ? undefined
                  : kind === WagerTransactionType.ROLLBACK && reference?.type === WagerTransactionType.BET
                    ? "CREDIT"
                    : kind === WagerTransactionType.ROLLBACK || kind === WagerTransactionType.REFUND
                      ? "CREDIT"
                      : "CREDIT";
              if (kind === WagerTransactionType.ROLLBACK && reference && reference.type !== WagerTransactionType.BET) direction = "DEBIT";
              if (direction === "DEBIT") ledgerEntry = wallet.debit(amount, transaction.id);
              else if (direction === "CREDIT") ledgerEntry = wallet.credit(amount, transaction.id);
              transaction.markProcessed();
            } catch (error: unknown) {
              if (!(error instanceof DomainError) || error.code !== "INSUFFICIENT_FUNDS") throw error;
              transaction.markRejected(kind === WagerTransactionType.ROLLBACK || kind === WagerTransactionType.REFUND ? "REVERSAL_INSUFFICIENT_FUNDS" : error.code);
            }
          }
          await this.wagerRepository.insert(em, transaction);
          if (ledgerEntry) {
            await this.walletRepository.updateBalance(em, wallet);
            await this.ledgerRepository.insert(em, ledgerEntry);
          }
          result = { transactionId: transaction.id, status: transaction.status, balance: wallet.balance.toString(), failureCode: transaction.failureCode };
        }
      }

      await this.outboxRepository.enqueue(em, {
        eventType: result.status === WagerTransactionStatus.PENDING_REFERENCE
          ? "WAGER.PENDING_REFERENCE"
          : result.status === WagerTransactionStatus.PROCESSED
            ? "WAGER.PROCESSED"
            : "WAGER.REJECTED",
        aggregateId: transaction.id,
        payload: {
          transactionId: transaction.id,
          providerId,
          externalTransactionId,
          playerId,
          walletId,
          currency,
          amount: amount.toString(),
          status: result.status,
          balance: result.balance,
          failureCode: result.failureCode,
        },
      });

      if (result.status === WagerTransactionStatus.PROCESSED && result.balance !== null && kind !== WagerTransactionType.LOSS && ledgerEntry && wallet) {
        await this.outboxRepository.enqueue(em, {
          eventType: "WALLET.BALANCE_CHANGED",
          aggregateId: walletId,
          payload: {
            walletId,
            transactionId: transaction.id,
            direction: ledgerEntry.type,
            money: {
              amount: ledgerEntry.amount.toString(),
              currency: ledgerEntry.amount.currency,
            },
            balanceBefore: {
              amount: ledgerEntry.balanceBefore.toString(),
              currency: ledgerEntry.balanceBefore.currency,
            },
            balanceAfter: {
              amount: ledgerEntry.balanceAfter.toString(),
              currency: ledgerEntry.balanceAfter.currency,
            },
            walletVersion: wallet.version,
          },
        });
      }

      await this.idempotencyService.updateResponse(
        em,
        "PROCESS_BET",
        idempotencyKey,
        result as unknown as Record<string, unknown>,
      );

      return result;
    }, existingEm);
    this.metrics?.increment("wager_transactions_total", {
      status: result.status,
      kind,
    });
    if (result.idempotentReplay) this.metrics?.increment("idempotency_duplicates_total", { scope: "wager" });
    this.metrics?.observe("wager_processing_latency_ms", Date.now() - startedAt, { kind });
    return result;
  }
}
