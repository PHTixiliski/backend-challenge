import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";

import { PostgresTransactionManager } from "../../shared/infrastructure/postgres-transaction-manager";
import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../../wallet/domain/money";
import { TransactionalWalletRepository } from "../../wallet/infrastructure/transactional-wallet.repository";
import { TransactionalWalletLedgerRepository } from "../../wallet/infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWagerTransactionRepository } from "../infrastructure/transactional-wager-transaction.repository";
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
  currency: string;
  amount: string;
  idempotencyKey: string;
  referenceExternalTransactionId?: string;
}

export interface ProcessBetResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: string | null;
  failureCode: string | null;
}

@Injectable()
export class ProcessBetUseCase {
  constructor(
    private readonly transactionManager: PostgresTransactionManager,
    private readonly walletRepository: TransactionalWalletRepository,
    private readonly ledgerRepository: TransactionalWalletLedgerRepository,
    private readonly wagerRepository: TransactionalWagerTransactionRepository,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  async execute(input: ProcessBetInput): Promise<ProcessBetResult> {
    const providerId = input.providerId.trim();
    const externalTransactionId = input.externalTransactionId.trim();
    const playerId = input.playerId.trim();
    const walletId = input.walletId.trim();
    const roundId = input.roundId.trim();
    const gameId = input.gameId.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    const currency = input.currency.trim().toUpperCase();
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

    const amount = Money.create(input.amount, currency);

    const payload = {
      providerId,
      externalTransactionId,
      playerId,
      walletId,
      roundId,
      gameId,
      type: WagerTransactionType.BET,
      currency,
      amount: amount.toString(),
      referenceExternalTransactionId: referenceExternalTransactionId ?? null,
    };

    const payloadHash = this.idempotencyService.hashPayload(payload);

    return this.transactionManager.execute(async (em) => {
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

        return existing.response as unknown as ProcessBetResult;
      }

      const transaction = new WagerTransaction({
        id: randomUUID(),
        providerId,
        externalTransactionId,
        idempotencyKey,
        payloadHash,
        walletId,
        playerId,
        roundId,
        gameId,
        type: WagerTransactionType.BET,
        amount,
        status: WagerTransactionStatus.PENDING,
        referenceExternalTransactionId,
      });

      const wallet = await this.walletRepository.findByIdForUpdate(
        em,
        walletId,
      );

      let result: ProcessBetResult;

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
        try {
          const ledgerEntry = wallet.debit(amount, transaction.id);

          transaction.markProcessed();

          await this.walletRepository.updateBalance(em, wallet);
          await this.wagerRepository.insert(em, transaction);
          await this.ledgerRepository.insert(em, ledgerEntry);

          result = {
            transactionId: transaction.id,
            status: transaction.status,
            balance: wallet.balance.toString(),
            failureCode: null,
          };
        } catch (error: unknown) {
          if (
            !(error instanceof DomainError) ||
            error.code !== "INSUFFICIENT_FUNDS"
          ) {
            throw error;
          }

          transaction.markRejected(error.code);
          await this.wagerRepository.insert(em, transaction);

          result = {
            transactionId: transaction.id,
            status: transaction.status,
            balance: wallet.balance.toString(),
            failureCode: transaction.failureCode,
          };
        }
      }

      await this.idempotencyService.updateResponse(
        em,
        "PROCESS_BET",
        idempotencyKey,
        result as unknown as Record<string, unknown>,
      );

      return result;
    });
  }
}
