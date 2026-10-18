import { randomUUID } from "node:crypto";
import type { EntityManager } from "@mikro-orm/postgresql";

import { Money } from "../../../src/wallet/domain/money";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";
import { WalletLedgerEntryEntity } from "../../../src/wallet/infrastructure/wallet-ledger-entry.entity";
import { WagerTransactionEntity } from "../../../src/wager/infrastructure/wager-transaction.entity";
import { WagerTransactionStatus, WagerTransactionType } from "../../../src/wager/domain/wager-transaction.types";

export interface TestWallet {
  walletId: string;
  playerId: string;
}

export async function createTestWallet(
  em: EntityManager,
  options: {
    playerId?: string;
    walletId?: string;
    currency?: string;
    balance?: string;
    version?: number;
  } = {},
): Promise<TestWallet> {
  const playerId = options.playerId ?? `test-${randomUUID()}`;
  const walletId = options.walletId ?? randomUUID();
  const currency = options.currency ?? "BRL";
  const balance = options.balance ?? "100.00";
  const version = options.version ?? 1;

  const wallet = Wallet.rehydrate({
    id: walletId,
    playerId,
    currency,
    balance: Money.create(balance, currency),
    version,
  });

  await em.transactional(async (txEm) => {
    await txEm.insert(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Funded integration wallets need a durable opening transaction so the
    // ledger reconstructs their balance from zero, just like production data.
    if (!wallet.balance.isPositive()) return;
    const transactionId = randomUUID();
    const now = new Date();
    await txEm.insert(WagerTransactionEntity, {
      id: transactionId,
      providerId: "internal",
      externalTransactionId: `opening:${walletId}`,
      idempotencyKey: `opening:${walletId}`,
      payloadHash: "a".repeat(64),
      walletId,
      playerId,
      roundId: `opening:${walletId}`,
      gameId: "internal",
      type: WagerTransactionType.OPENING,
      currency,
      amount: wallet.balance.toString(),
      status: WagerTransactionStatus.PROCESSED,
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      failureCode: null,
      processedAt: now,
      referenceAttempts: 0,
      referenceNextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await txEm.insert(WalletLedgerEntryEntity, {
      id: randomUUID(),
      walletId,
      transactionId,
      type: "CREDIT",
      currency,
      amount: wallet.balance.toString(),
      balanceBefore: Money.create("0", currency).toString(),
      balanceAfter: wallet.balance.toString(),
      createdAt: now,
    });
  });

  return { walletId, playerId };
}
