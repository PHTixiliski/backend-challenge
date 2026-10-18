import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";

import { createTestWallet as createTestWalletFixture } from "./process-bet.test-helpers";
import { cleanupTestWallets } from "../cleanup-test-wallets";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { PostgresTransactionManager } from "../../../src/shared/infrastructure/postgres-transaction-manager";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";
import { WalletLedgerEntryEntity } from "../../../src/wallet/infrastructure/wallet-ledger-entry.entity";
import { TransactionalWalletRepository } from "../../../src/wallet/infrastructure/transactional-wallet.repository";
import { TransactionalWalletLedgerRepository } from "../../../src/wallet/infrastructure/transactional-wallet-ledger.repository";
import { WagerTransactionEntity } from "../../../src/wager/infrastructure/wager-transaction.entity";
import { TransactionalWagerTransactionRepository } from "../../../src/wager/infrastructure/transactional-wager-transaction.repository";
import { ProcessBetUseCase } from "../../../src/wager/application/process-bet.use-case";
import { WagerTransactionStatus, WagerTransactionType } from "../../../src/wager/domain/wager-transaction.types";
import { IdempotencyService } from "../../../src/shared/infrastructure/idempotency.service";
import { IdempotencyRecordEntity } from "../../../src/shared/infrastructure/idempotency-record.entity";
import { TransactionalOutboxRepository } from "../../../src/messaging/infrastructure/transactional-outbox.repository";
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from "../../../src/messaging/infrastructure/outbox-message.entity";

describe("ProcessBetUseCase (integration)", () => {
  let orm: MikroORM;
  let useCase: ProcessBetUseCase;
  const testWalletIds: string[] = [];

  async function findWagerTransactions(em: Parameters<typeof createTestWalletFixture>[0], playerId: string) {
    return (await em.find(WagerTransactionEntity, { playerId })).filter(
      (transaction) => transaction.type !== WagerTransactionType.OPENING,
    );
  }

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
    orm = await MikroORM.init(mikroOrmConfig);

    useCase = new ProcessBetUseCase(
      new PostgresTransactionManager(orm.em.fork()),
      new TransactionalWalletRepository(),
      new TransactionalWalletLedgerRepository(),
      new TransactionalWagerTransactionRepository(),
      new IdempotencyService(),
      new TransactionalOutboxRepository(),
    );
  });

  afterAll(async () => {
    await orm.close(true);
  });

  afterEach(async () => {
    await cleanupTestWallets(orm, testWalletIds.splice(0));
  });

  test("processes a bet and atomically updates wallet, transaction and ledger", async () => {
    const em = orm.em.fork();

    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `bet-${randomUUID()}`,
      balance: "100.00",
    });

    const result = await useCase.execute({
      providerId: "provider-test",
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: "round-test",
      gameId: "game-test",
      currency: "BRL",
      amount: "30.00",
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toBe("70.00");
    expect(result.failureCode).toBeNull();

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("70.00");
    expect(storedWallet.version).toBe(2);

    const storedTransactions = await findWagerTransactions(em, playerId);
    expect(storedTransactions).toHaveLength(1);
    expect(storedTransactions[0]?.status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
    expect(storedTransactions[0]?.amount).toBe("30.00");

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      transactionId: result.transactionId,
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.type).toBe("DEBIT");
    expect(ledgerEntries[0]?.amount).toBe("30.00");
    expect(ledgerEntries[0]?.balanceAfter).toBe("70.00");

    const outboxMessages = await em.find(OutboxMessageEntity, {
      aggregateId: result.transactionId,
    });

    expect(outboxMessages).toHaveLength(1);
    expect(outboxMessages[0]?.eventType).toBe("WAGER.PROCESSED");
    expect(outboxMessages[0]?.status).toBe(OutboxMessageStatus.PENDING);
    expect(outboxMessages[0]?.payload).toMatchObject({
      transactionId: result.transactionId,
      playerId,
      walletId,
      currency: "BRL",
      amount: "30.00",
      status: WagerTransactionStatus.PROCESSED,
    });

    const balanceChanged = await em.findOneOrFail(OutboxMessageEntity, {
      aggregateId: walletId,
      eventType: "WALLET.BALANCE_CHANGED",
    });
    expect(balanceChanged.payload).toMatchObject({
      walletId,
      transactionId: result.transactionId,
      direction: "DEBIT",
      money: { amount: "30.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "70.00", currency: "BRL" },
      walletVersion: 2,
    });
  });

  test("rejects a bet with insufficient funds without changing the wallet or ledger", async () => {
    const em = orm.em.fork();

    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `insufficient-${randomUUID()}`,
      balance: "50.00",
    });

    const result = await useCase.execute({
      providerId: "provider-test",
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: "round-test",
      gameId: "game-test",
      currency: "BRL",
      amount: "80.00",
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.balance).toBe("50.00");
    expect(result.failureCode).toBe("INSUFFICIENT_FUNDS");

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("50.00");
    expect(storedWallet.version).toBe(1);

    const transactions = await findWagerTransactions(em, playerId);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.status).toBe(WagerTransactionStatus.REJECTED);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.type).toBe("CREDIT");

    const outboxMessages = await em.find(OutboxMessageEntity, {
      aggregateId: result.transactionId,
    });

    expect(outboxMessages).toHaveLength(1);
    expect(outboxMessages[0]?.eventType).toBe("WAGER.REJECTED");
    expect(outboxMessages[0]?.status).toBe(OutboxMessageStatus.PENDING);
    expect(outboxMessages[0]?.payload).toMatchObject({
      transactionId: result.transactionId,
      status: WagerTransactionStatus.REJECTED,
      failureCode: "INSUFFICIENT_FUNDS",
    });
  });

  test("prevents concurrent bets from spending more than the wallet balance", async () => {
    const em = orm.em.fork();

    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `concurrent-${randomUUID()}`,
      balance: "100.00",
    });

    const results = await Promise.all([
      useCase.execute({
        providerId: "provider-test",
        externalTransactionId: randomUUID(),
        playerId,
        walletId,
        roundId: "round-test",
        gameId: "game-test",
        currency: "BRL",
        amount: "80.00",
        idempotencyKey: randomUUID(),
      }),
      useCase.execute({
        providerId: "provider-test",
        externalTransactionId: randomUUID(),
        playerId,
        walletId,
        roundId: "round-test",
        gameId: "game-test",
        currency: "BRL",
        amount: "80.00",
        idempotencyKey: randomUUID(),
      }),
    ]);

    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(1);

    expect(
      results.filter(
        (result) => result.status === WagerTransactionStatus.REJECTED,
      ),
    ).toHaveLength(1);

    const storedWallet = await em.findOneOrFail(WalletEntity, {
      id: walletId,
    });

    expect(storedWallet.balance).toBe("20.00");
    expect(storedWallet.version).toBe(2);

    const transactions = await findWagerTransactions(em, playerId);

    expect(transactions).toHaveLength(2);

    expect(
      transactions.filter(
        (transaction) =>
          transaction.status === WagerTransactionStatus.PROCESSED,
      ),
    ).toHaveLength(1);

    expect(
      transactions.filter(
        (transaction) => transaction.status === WagerTransactionStatus.REJECTED,
      ),
    ).toHaveLength(1);

    expect(
      transactions.find(
        (transaction) => transaction.status === WagerTransactionStatus.REJECTED,
      )?.failureCode,
    ).toBe("INSUFFICIENT_FUNDS");

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });

    expect(ledgerEntries).toHaveLength(2);
    expect(ledgerEntries.filter((entry) => entry.type === "DEBIT")).toHaveLength(1);
    expect(ledgerEntries.find((entry) => entry.type === "DEBIT")?.amount).toBe("80.00");
    expect(ledgerEntries.find((entry) => entry.type === "DEBIT")?.balanceAfter).toBe("20.00");
  });

  test("replays the original response when the same idempotency key and payload are reused", async () => {
    const em = orm.em.fork();
    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `idempotent-${randomUUID()}`,
      balance: "100.00",
    });

    const idempotencyKey = randomUUID();

    const input = {
      providerId: "provider-test",
      externalTransactionId: `external-${randomUUID()}`,
      playerId,
      walletId,
      roundId: "round-test",
      gameId: "game-test",
      currency: "BRL",
      amount: "30.00",
      idempotencyKey,
    };

    const firstResult = await useCase.execute(input);
    const replayResult = await useCase.execute(input);

    expect(replayResult).toMatchObject(firstResult);
    expect(replayResult.idempotentReplay).toBe(true);

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("70.00");
    expect(storedWallet.version).toBe(2);

    const transactions = await findWagerTransactions(em, playerId);
    expect(transactions).toHaveLength(1);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(2);

    const outboxMessages = await em.find(OutboxMessageEntity, {
      aggregateId: firstResult.transactionId,
    });

    expect(outboxMessages).toHaveLength(1);
    expect(outboxMessages[0]?.eventType).toBe("WAGER.PROCESSED");
  });

  test("rejects reuse of an idempotency key with a different payload", async () => {
    const em = orm.em.fork();
    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `idempotency-conflict-${randomUUID()}`,
      balance: "100.00",
    });

    const idempotencyKey = randomUUID();

    const input = {
      providerId: "provider-test",
      externalTransactionId: `external-${randomUUID()}`,
      playerId,
      walletId,
      roundId: "round-test",
      gameId: "game-test",
      currency: "BRL",
      amount: "30.00",
      idempotencyKey,
    };

    await useCase.execute(input);

    await expect(
      useCase.execute({
        ...input,
        amount: "40.00",
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("70.00");
    expect(storedWallet.version).toBe(2);

    const transactions = await findWagerTransactions(em, playerId);
    expect(transactions).toHaveLength(1);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(2);
  });

  test("returns a conflict when a provider external transaction ID is reused with another key", async () => {
    const em = orm.em.fork();
    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `external-id-conflict-${randomUUID()}`,
      balance: "100.00",
    });
    const externalTransactionId = `external-${randomUUID()}`;
    const input = {
      providerId: "provider-test",
      externalTransactionId,
      playerId,
      walletId,
      roundId: "round-test",
      gameId: "game-test",
      currency: "BRL",
      amount: "30.00",
      idempotencyKey: randomUUID(),
    };

    await useCase.execute(input);
    await expect(useCase.execute({ ...input, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "EXTERNAL_TRANSACTION_ID_REUSED" });

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(wallet.balance).toBe("70.00");
    expect(await findWagerTransactions(em, playerId)).toHaveLength(1);
    expect(await em.find(WalletLedgerEntryEntity, { walletId })).toHaveLength(2);
  });

  test("processes concurrent requests with the same key only once", async () => {
    const em = orm.em.fork();

    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `idempotency-concurrent-${randomUUID()}`,
      balance: "100.00",
    });

    const idempotencyKey = randomUUID();

    const input = {
      providerId: "provider-test",
      externalTransactionId: `external-${randomUUID()}`,
      playerId,
      walletId,
      roundId: "round-test",
      gameId: "game-test",
      currency: "BRL",
      amount: "30.00",
      idempotencyKey,
    };

    const [firstResult, secondResult] = await Promise.all([
      useCase.execute(input),
      useCase.execute(input),
    ]);

    expect(firstResult.transactionId).toBe(secondResult.transactionId);
    expect(firstResult.status).toBe(secondResult.status);
    expect(firstResult.balance).toBe(secondResult.balance);
    expect([firstResult.idempotentReplay ?? false, secondResult.idempotentReplay ?? false].sort()).toEqual([false, true]);

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("70.00");
    expect(storedWallet.version).toBe(2);

    const transactions = await findWagerTransactions(em, playerId);
    expect(transactions).toHaveLength(1);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(2);

    const idempotencyRecords = await em.find(IdempotencyRecordEntity, {
      scope: "PROCESS_BET",
      key: idempotencyKey,
    });

    expect(idempotencyRecords).toHaveLength(1);
  });

  test("applies the same wager once when submitted 50 times concurrently", async () => {
    const em = orm.em.fork();
    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `fifty-parallel-${randomUUID()}`,
      balance: "100.00",
    });
    const input = {
      providerId: "provider-test",
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: "round-test",
      gameId: "game-test",
      currency: "BRL",
      amount: "25.00",
      idempotencyKey: randomUUID(),
    };

    const results = await Promise.all(
      Array.from({ length: 50 }, () => useCase.execute(input)),
    );

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.filter((result) => result.idempotentReplay !== true)).toHaveLength(1);
    expect(results.every((result) => result.status === WagerTransactionStatus.PROCESSED)).toBe(true);

    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    const transaction = await em.findOneOrFail(WagerTransactionEntity, {
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
    });
    const entries = await em.find(WalletLedgerEntryEntity, {
      transactionId: transaction.id,
    });
    expect(wallet.balance).toBe("75.00");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("DEBIT");
    expect(entries[0]?.amount).toBe("25.00");
  });

  test("rolls back all database writes when outbox enqueue fails", async () => {
    const em = orm.em.fork();
    const { playerId, walletId } = await createTestWallet(em, {
      playerId: `rollback-${randomUUID()}`,
      balance: "100.00",
    });

    const idempotencyKey = randomUUID();

    const failingOutbox = {
      enqueue: async () => {
        throw new Error("Simulated outbox failure");
      },
    } as unknown as TransactionalOutboxRepository;

    const failingUseCase = new ProcessBetUseCase(
      new PostgresTransactionManager(orm.em.fork()),
      new TransactionalWalletRepository(),
      new TransactionalWalletLedgerRepository(),
      new TransactionalWagerTransactionRepository(),
      new IdempotencyService(),
      failingOutbox,
    );

    const input = {
      providerId: "provider-test",
      externalTransactionId: `external-${randomUUID()}`,
      playerId,
      walletId,
      roundId: "round-test",
      gameId: "game-test",
      currency: "BRL",
      amount: "30.00",
      idempotencyKey,
    };

    // First attempt: the outbox failure must roll back all writes.
    await expect(failingUseCase.execute(input)).rejects.toThrow(
      "Simulated outbox failure",
    );

    const walletAfterFailure = await em.findOneOrFail(WalletEntity, {
      id: walletId,
    });

    expect(walletAfterFailure.balance).toBe("100.00");
    expect(walletAfterFailure.version).toBe(1);

    expect(await findWagerTransactions(em, playerId)).toHaveLength(0);

    expect(await em.find(WalletLedgerEntryEntity, { walletId })).toHaveLength(
      1,
    );

    expect(
      await em.find(IdempotencyRecordEntity, {
        scope: "PROCESS_BET",
        key: idempotencyKey,
      }),
    ).toHaveLength(0);

    // Retry with the same input and idempotency key using the real outbox.
    const result = await useCase.execute(input);

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toBe("70.00");
    expect(result.failureCode).toBeNull();

    // Use a fresh EntityManager to avoid stale Identity Map entities.
    const verificationEm = orm.em.fork();

    try {
      const walletAfterRetry = await verificationEm.findOneOrFail(
        WalletEntity,
        { id: walletId },
      );

      expect(walletAfterRetry.balance).toBe("70.00");
      expect(walletAfterRetry.version).toBe(2);

      const transactions = await findWagerTransactions(verificationEm, playerId);

      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.status).toBe(WagerTransactionStatus.PROCESSED);

      const ledgerEntries = await verificationEm.find(WalletLedgerEntryEntity, {
        walletId,
      });

      expect(ledgerEntries).toHaveLength(2);
      const debit = ledgerEntries.find((entry) => entry.type === "DEBIT");
      expect(debit?.amount).toBe("30.00");
      expect(debit?.balanceAfter).toBe("70.00");

      const outboxMessages = await verificationEm.find(OutboxMessageEntity, {
        aggregateId: result.transactionId,
      });

      expect(outboxMessages).toHaveLength(1);
      expect(outboxMessages[0]?.eventType).toBe("WAGER.PROCESSED");
      expect(outboxMessages[0]?.status).toBe(OutboxMessageStatus.PENDING);

      const idempotencyRecords = await verificationEm.find(
        IdempotencyRecordEntity,
        {
          scope: "PROCESS_BET",
          key: idempotencyKey,
        },
      );

      expect(idempotencyRecords).toHaveLength(1);
    } finally {
      await verificationEm.getConnection().close();
    }
  });
});
