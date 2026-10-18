import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";
import { Money } from "../../../src/wallet/domain/money";
import { WalletLedgerEntryEntity } from "../../../src/wallet/infrastructure/wallet-ledger-entry.entity";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";
import { WagerTransaction } from "../../../src/wager/domain/wager-transaction";
import { WagerTransactionType } from "../../../src/wager/domain/wager-transaction.types";
import { WagerTransactionEntity } from "../../../src/wager/infrastructure/wager-transaction.entity";
import { MikroOrmWagerTransactionRepository } from "../../../src/wager/infrastructure/mikro-orm-wager-transaction.repository";
import { cleanupTestWallets } from "../cleanup-test-wallets";

describe("Wallet ledger immutability (integration)", () => {
  let orm: MikroORM;
  const testWalletIds: string[] = [];

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(mikroOrmConfig);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  afterEach(async () => {
    await cleanupTestWallets(orm, testWalletIds.splice(0));
  });

  async function createLedgerEntry(): Promise<string> {
    const em = orm.em.fork();
    const id = randomUUID();
    const playerId = `ledger-test-${randomUUID()}`;
    const walletId = randomUUID();
    testWalletIds.push(walletId);
    const now = new Date();

    const transaction = WagerTransaction.create({
      id,
      playerId,
      type: WagerTransactionType.WIN,
      amount: Money.create("10.00", "BRL"),
      providerId: "ledger-immutability-test",
      externalTransactionId: `external-${id}`,
      idempotencyKey: `key-${id}`,
      payloadHash: "a".repeat(64),
      walletId,
      roundId: "round-test",
      gameId: "game-test",
    });
    transaction.markProcessed();

    await em.transactional(async (tx) => {
      await tx.insert(WalletEntity, {
        id: walletId,
        playerId,
        currency: "BRL",
        balance: "10.00",
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      const transactionRepository = new MikroOrmWagerTransactionRepository(
        tx.getRepository(WagerTransactionEntity),
      );
      await transactionRepository.save(transaction);

      await tx.insert(WalletLedgerEntryEntity, {
        id: randomUUID(),
        walletId,
        transactionId: id,
        type: "CREDIT",
        currency: "BRL",
        amount: "10.00",
        balanceBefore: "0.00",
        balanceAfter: "10.00",
        createdAt: now,
      });
    });

    return id;
  }

  test("rejects updates to existing ledger entries", async () => {
    const em = orm.em.fork();
    const transactionId = await createLedgerEntry();

    await expect(
      em
        .getConnection()
        .execute(
          "UPDATE wallet_ledger_entries SET amount = ? WHERE transaction_id = ?",
          ["20.00", transactionId],
        ),
    ).rejects.toThrow();

    const rows = await em
      .getConnection()
      .execute(
        "SELECT amount FROM wallet_ledger_entries WHERE transaction_id = ?",
        [transactionId],
      );

    expect(rows[0].amount).toBe("10.00");
  });

  test("rejects deletes of existing ledger entries", async () => {
    const em = orm.em.fork();
    const transactionId = await createLedgerEntry();

    await expect(
      em
        .getConnection()
        .execute("DELETE FROM wallet_ledger_entries WHERE transaction_id = ?", [
          transactionId,
        ]),
    ).rejects.toThrow();

    const rows = await em
      .getConnection()
      .execute(
        "SELECT id FROM wallet_ledger_entries WHERE transaction_id = ?",
        [transactionId],
      );

    expect(rows).toHaveLength(1);
  });

  test("rejects truncating the ledger table", async () => {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      await tx.execute("SAVEPOINT safe_ledger_truncate_attempt");
      let truncateError: unknown;

      try {
        await tx.execute("TRUNCATE TABLE wallet_ledger_entries");
      } catch (error: unknown) {
        truncateError = error;
      }

      // Roll back the attempt even if a missing trigger would allow TRUNCATE.
      await tx.execute("ROLLBACK TO SAVEPOINT safe_ledger_truncate_attempt");
      expect(truncateError).toBeDefined();
    });
  });
});
