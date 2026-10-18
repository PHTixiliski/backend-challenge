import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../domain/money";
import { Wallet } from "../domain/wallet";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { PostgresTransactionManager } from "../../shared/infrastructure/postgres-transaction-manager";
import { TransactionalWalletRepository } from "../infrastructure/transactional-wallet.repository";
import { TransactionalWalletLedgerRepository } from "../infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWagerTransactionRepository } from "../../wager/infrastructure/transactional-wager-transaction.repository";
import { TransactionalOutboxRepository } from "../../messaging/infrastructure/transactional-outbox.repository";
import { WagerTransaction } from "../../wager/domain/wager-transaction";
import {
  WagerTransactionStatus,
  WagerTransactionType,
} from "../../wager/domain/wager-transaction.types";
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from "../domain/wallet.repository";

export interface CreateWalletInput {
  playerId: string;
  currency?: string;
  initialBalance?: { amount: string; currency: string };
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY)
    private readonly walletRepository: WalletRepository,
    private readonly transactionManager: PostgresTransactionManager,
    private readonly transactionalWallets: TransactionalWalletRepository,
    private readonly ledgerRepository: TransactionalWalletLedgerRepository,
    private readonly wagerRepository: TransactionalWagerTransactionRepository,
    private readonly outboxRepository: TransactionalOutboxRepository,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const playerId = input.playerId.trim();
    const currency = (
      input.initialBalance?.currency ??
      input.currency ??
      "BRL"
    ).toUpperCase();

    if (!playerId) {
      throw new DomainError("INVALID_PLAYER_ID", "Player ID is required.");
    }

    const initialBalance = input.initialBalance
      ? Money.create(input.initialBalance.amount, currency)
      : Money.zero(currency);

    const existingWallet =
      await this.walletRepository.findByPlayerIdAndCurrency(
        playerId,
        currency,
      );

    if (existingWallet) {
      throw new DomainError(
        "WALLET_ALREADY_EXISTS",
        "A wallet already exists for this player and currency.",
      );
    }

    const wallet = Wallet.open({
      id: randomUUID(),
      playerId,
      initialBalance,
    });

    await this.transactionManager.execute(async (em) => {
      await this.transactionalWallets.insert(em, wallet);
      if (!initialBalance.isZero()) {
        const transactionId = randomUUID();
        const payloadHash = createHash("sha256")
          .update(`${wallet.id}:${initialBalance.toString()}:${currency}`)
          .digest("hex");
        const opening = WagerTransaction.create({
          id: transactionId,
          providerId: "internal",
          externalTransactionId: `opening:${wallet.id}`,
          idempotencyKey: `opening:${wallet.id}`,
          payloadHash,
          walletId: wallet.id,
          playerId,
          roundId: `opening:${wallet.id}`,
          gameId: "internal",
          type: WagerTransactionType.OPENING,
          amount: initialBalance,
        });
        opening.markProcessed();
        const entry = WalletLedgerEntry.create({
          walletId: wallet.id,
          transactionId,
          type: "CREDIT",
          amount: initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: initialBalance,
        });
        await this.wagerRepository.insert(em, opening);
        await this.ledgerRepository.insert(em, entry);
        await this.outboxRepository.enqueue(em, {
          eventType: "WAGER.PROCESSED",
          aggregateId: transactionId,
          payload: {
            transactionId,
            providerId: opening.providerId,
            externalTransactionId: opening.externalTransactionId,
            playerId,
            walletId: wallet.id,
            roundId: opening.roundId,
            gameId: opening.gameId,
            kind: opening.type,
            currency,
            amount: initialBalance.toString(),
            status: WagerTransactionStatus.PROCESSED,
            balance: initialBalance.toString(),
            failureCode: null,
          },
        });
        await this.outboxRepository.enqueue(em, {
          eventType: "WALLET.BALANCE_CHANGED",
          aggregateId: wallet.id,
          payload: {
            walletId: wallet.id,
            transactionId,
            direction: entry.type,
            money: entry.amount.toJSON(),
            balanceBefore: entry.balanceBefore.toJSON(),
            balanceAfter: entry.balanceAfter.toJSON(),
            walletVersion: wallet.version,
          },
        });
      }
    });

    return wallet;
  }
}
