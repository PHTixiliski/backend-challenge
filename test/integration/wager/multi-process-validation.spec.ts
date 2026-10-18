import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../../src/mikro-orm.config";
import { createTestWallet as createTestWalletFixture } from "./process-bet.test-helpers";
import { cleanupTestWallets } from "../cleanup-test-wallets";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";
import { WalletLedgerEntryEntity } from "../../../src/wallet/infrastructure/wallet-ledger-entry.entity";
import { WagerTransactionEntity } from "../../../src/wager/infrastructure/wager-transaction.entity";
import { WagerTransactionStatus, WagerTransactionType } from "../../../src/wager/domain/wager-transaction.types";
import { Money } from "../../../src/wallet/domain/money";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";

const workerPath = join(process.cwd(), "test/integration/wager/multi-process-validation.worker.ts");

async function runWorker(mode: "submit" | "retry", input?: unknown): Promise<Record<string, unknown>> {
  const child = Bun.spawn(["bun", "run", workerPath, mode, JSON.stringify(input ?? {})], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Worker exited ${exitCode}: ${stderr}`);
  const jsonLine = stdout.trim().split(/\r?\n/).at(-1);
  if (!jsonLine) throw new Error(`Worker produced no JSON output: ${stderr}`);
  return JSON.parse(jsonLine) as Record<string, unknown>;
}

describe("Wagering multi-process and restart validation", () => {
  let orm: MikroORM;
  const testWalletIds: string[] = [];

  async function createTestWallet(
    em: Parameters<typeof createTestWalletFixture>[0],
    options?: Parameters<typeof createTestWalletFixture>[1],
  ) {
    const wallet = await createTestWalletFixture(em, options);
    testWalletIds.push(wallet.walletId);
    return wallet;
  }

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(config);
  });

  afterAll(async () => {
    await orm.close(true);
  });

  afterEach(async () => {
    await cleanupTestWallets(orm, testWalletIds.splice(0));
  });

  test("three independent processes apply the same idempotent wager once", async () => {
    const em = orm.em.fork();
    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `multi-process-${randomUUID()}`,
      balance: "100.00",
    });
    const input = {
      providerId: "provider-multiprocess",
      externalTransactionId: `external-${randomUUID()}`,
      playerId,
      walletId,
      roundId: "round-multi",
      gameId: "game-multi",
      currency: "BRL",
      amount: "25.00",
      idempotencyKey: `same-key-${randomUUID()}`,
    };

    const results = await Promise.all([
      runWorker("submit", input),
      runWorker("submit", input),
      runWorker("submit", input),
    ]);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.every((result) => result.status === WagerTransactionStatus.PROCESSED)).toBe(true);
    expect(results.filter((result) => result.idempotentReplay === true)).toHaveLength(2);

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    const entries = await em.find(WalletLedgerEntryEntity, { walletId });
    expect(wallet.balance).toBe("75.00");
    expect(entries).toHaveLength(2);
    expect(entries.some((entry) => entry.balanceAfter === "75.00")).toBe(true);
    const reconstructed = entries.reduce(
      (balance, entry) => {
        const amount = Money.create(entry.amount, entry.currency);
        return entry.type === "CREDIT" ? balance.add(amount) : balance.subtract(amount);
      },
      Money.zero("BRL"),
    );
    expect(reconstructed.toString()).toBe(wallet.balance);

    const contested = await createTestWallet(em, {
      playerId: `multi-process-contested-${randomUUID()}`,
      balance: "100.00",
    });
    const competingResults = await Promise.all([
      runWorker("submit", {
        providerId: "provider-multiprocess",
        externalTransactionId: `external-${randomUUID()}`,
        playerId: contested.playerId,
        walletId: contested.walletId,
        roundId: "round-contested",
        gameId: "game-multi",
        currency: "BRL",
        amount: "80.00",
        idempotencyKey: `key-${randomUUID()}`,
      }),
      runWorker("submit", {
        providerId: "provider-multiprocess",
        externalTransactionId: `external-${randomUUID()}`,
        playerId: contested.playerId,
        walletId: contested.walletId,
        roundId: "round-contested",
        gameId: "game-multi",
        currency: "BRL",
        amount: "80.00",
        idempotencyKey: `key-${randomUUID()}`,
      }),
    ]);
    expect(competingResults.filter((result) => result.status === WagerTransactionStatus.PROCESSED)).toHaveLength(1);
    expect(competingResults.filter((result) => result.status === WagerTransactionStatus.REJECTED)).toHaveLength(1);
    const contestedWallet = await em.findOneOrFail(WalletEntity, { id: contested.walletId });
    const contestedLedger = await em.find(WalletLedgerEntryEntity, { walletId: contested.walletId });
    expect(contestedWallet.balance).toBe("20.00");
    expect(contestedLedger).toHaveLength(2);
    expect(contestedLedger.filter((entry) => entry.type === "DEBIT")).toHaveLength(1);
  });

  test("processes wagers for distinct wallets in parallel", async () => {
    const em = orm.em.fork();
    const fixtures = [];
    for (let index = 0; index < 3; index++) {
      fixtures.push(await createTestWallet(em, {
        playerId: `multi-wallet-${randomUUID()}`,
        balance: "100.00",
      }));
    }

    const results = await Promise.all(
      fixtures.map(({ playerId, walletId }) =>
        runWorker("submit", {
          providerId: "provider-multi-wallet",
          externalTransactionId: `external-${randomUUID()}`,
          playerId,
          walletId,
          roundId: `round-${walletId}`,
          gameId: "game-multi-wallet",
          currency: "BRL",
          amount: "25.00",
          idempotencyKey: `key-${randomUUID()}`,
        }),
      ),
    );

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.status === WagerTransactionStatus.PROCESSED)).toBe(true);

    for (const { walletId } of fixtures) {
      const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
      const entries = await em.find(WalletLedgerEntryEntity, { walletId });
      expect(wallet.balance).toBe("75.00");
      expect(entries).toHaveLength(2);
      expect(entries.filter((entry) => entry.type === "DEBIT")).toHaveLength(1);
      const reconstructed = entries.reduce(
        (balance, entry) => {
          const amount = Money.create(entry.amount, entry.currency);
          return entry.type === "CREDIT" ? balance.add(amount) : balance.subtract(amount);
        },
        Money.zero("BRL"),
      );
      expect(reconstructed.toString()).toBe(wallet.balance);
    }
  });

  test("pending rollback survives process exit and is applied by a fresh process", async () => {
    const em = orm.em.fork();
    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `restart-${randomUUID()}`,
      balance: "100.00",
    });
    const referenceId = `reference-${randomUUID()}`;
    const rollbackId = `rollback-${randomUUID()}`;
    const common = {
      providerId: "provider-restart",
      playerId,
      walletId,
      roundId: "round-restart",
      gameId: "game-restart",
      currency: "BRL",
    };

    const pending = await runWorker("submit", {
      ...common,
      externalTransactionId: rollbackId,
      referenceExternalTransactionId: referenceId,
      kind: WagerTransactionType.ROLLBACK,
      amount: "10.00",
      idempotencyKey: `key-${rollbackId}`,
    });
    expect(pending.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);

    // This is a new OS process with a fresh ORM pool, simulating service restart.
    await runWorker("submit", {
      ...common,
      externalTransactionId: referenceId,
      kind: WagerTransactionType.BET,
      amount: "10.00",
      idempotencyKey: `key-${referenceId}`,
    });

    await new Promise((resolve) => setTimeout(resolve, 2200));
    const retryResult = await runWorker("retry", {
      transactionIds: [String(pending.transactionId)],
    });
    expect(Number(retryResult.processed)).toBeGreaterThanOrEqual(1);

    const transaction = await em.findOneOrFail(WagerTransactionEntity, {
      id: String(pending.transactionId),
    });
    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    const entries = await em.find(WalletLedgerEntryEntity, { walletId });
    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.referenceTransactionId).toBeTruthy();
    expect(wallet.balance).toBe("100.00");
    expect(entries).toHaveLength(3);
    const reconstructed = entries.reduce(
      (balance, entry) => {
        const amount = Money.create(entry.amount, entry.currency);
        return entry.type === "CREDIT" ? balance.add(amount) : balance.subtract(amount);
      },
      Money.zero("BRL"),
    );
    expect(reconstructed.toString()).toBe(wallet.balance);
  });
});
