import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { PostgresTransactionManager } from "../../../src/shared/infrastructure/postgres-transaction-manager";
import { Money } from "../../../src/wallet/domain/money";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";
import { WalletLedgerEntryEntity } from "../../../src/wallet/infrastructure/wallet-ledger-entry.entity";
import { TransactionalWalletRepository } from "../../../src/wallet/infrastructure/transactional-wallet.repository";
import { TransactionalWalletLedgerRepository } from "../../../src/wallet/infrastructure/transactional-wallet-ledger.repository";
import { WagerTransactionEntity } from "../../../src/wager/infrastructure/wager-transaction.entity";
import { TransactionalWagerTransactionRepository } from "../../../src/wager/infrastructure/transactional-wager-transaction.repository";
import { ProcessBetUseCase } from "../../../src/wager/application/process-bet.use-case";
import { WagerTransactionStatus } from "../../../src/wager/domain/wager-transaction.types";
import { IdempotencyService } from "../../../src/shared/infrastructure/idempotency.service";

describe("ProcessBetUseCase (integration)", () => {
  let orm: MikroORM;
  let useCase: ProcessBetUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);

    useCase = new ProcessBetUseCase(
      new PostgresTransactionManager(orm.em.fork()),
      new TransactionalWalletRepository(),
      new TransactionalWalletLedgerRepository(),
      new TransactionalWagerTransactionRepository(),
      new IdempotencyService(),
    );
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test("processes a bet and atomically updates wallet, transaction and ledger", async () => {
    const em = orm.em.fork();
    const playerId = `bet-${randomUUID()}`;
    const walletId = randomUUID();

    const wallet = new Wallet({
      id: walletId,
      playerId,
      currency: "BRL",
      balance: Money.create("100.00", "BRL"),
      version: 0,
    });

    await em.insert(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await useCase.execute({
      playerId,
      currency: "BRL",
      amount: "30.00",
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(result.balance).toBe("70.00");
    expect(result.failureCode).toBeNull();

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("70.00");
    expect(storedWallet.version).toBe(1);

    const storedTransactions = await em.find(WagerTransactionEntity, {
      playerId,
    });
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
  });

  test("rejects a bet with insufficient funds without changing the wallet or ledger", async () => {
    const em = orm.em.fork();
    const playerId = `insufficient-${randomUUID()}`;
    const walletId = randomUUID();

    await em.insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "50.00",
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await useCase.execute({
      playerId,
      currency: "BRL",
      amount: "80.00",
      idempotencyKey: randomUUID(),
    });

    expect(result.status).toBe(WagerTransactionStatus.REJECTED);
    expect(result.balance).toBe("50.00");
    expect(result.failureCode).toBe("INSUFFICIENT_FUNDS");

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("50.00");
    expect(storedWallet.version).toBe(0);

    const transactions = await em.find(WagerTransactionEntity, { playerId });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.status).toBe(WagerTransactionStatus.REJECTED);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(0);
  });

  test("prevents concurrent bets from spending more than the wallet balance", async () => {
    const em = orm.em.fork();
    const playerId = `concurrent-${randomUUID()}`;
    const walletId = randomUUID();

    await em.insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "100.00",
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const results = await Promise.all([
      useCase.execute({
        playerId,
        currency: "BRL",
        amount: "80.00",
        idempotencyKey: randomUUID(),
      }),
      useCase.execute({
        playerId,
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

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("20.00");
    expect(storedWallet.version).toBe(1);

    const transactions = await em.find(WagerTransactionEntity, { playerId });
    expect(transactions).toHaveLength(2);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]?.amount).toBe("80.00");
    expect(ledgerEntries[0]?.balanceAfter).toBe("20.00");
  });

  test("replays the original response when the same idempotency key and payload are reused", async () => {
    const em = orm.em.fork();
    const playerId = `idempotent-${randomUUID()}`;
    const walletId = randomUUID();
    const idempotencyKey = randomUUID();

    await em.insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "100.00",
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const input = {
      playerId,
      currency: "BRL",
      amount: "30.00",
      idempotencyKey,
    };

    const firstResult = await useCase.execute(input);
    const replayResult = await useCase.execute(input);

    expect(replayResult).toEqual(firstResult);

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("70.00");
    expect(storedWallet.version).toBe(1);

    const transactions = await em.find(WagerTransactionEntity, { playerId });
    expect(transactions).toHaveLength(1);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(1);
  });

  test("rejects reuse of an idempotency key with a different payload", async () => {
    const em = orm.em.fork();
    const playerId = `idempotency-conflict-${randomUUID()}`;
    const walletId = randomUUID();
    const idempotencyKey = randomUUID();

    await em.insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "100.00",
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await useCase.execute({
      playerId,
      currency: "BRL",
      amount: "30.00",
      idempotencyKey,
    });

    await expect(
      useCase.execute({
        playerId,
        currency: "BRL",
        amount: "40.00",
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("70.00");
    expect(storedWallet.version).toBe(1);

    const transactions = await em.find(WagerTransactionEntity, { playerId });
    expect(transactions).toHaveLength(1);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(1);
  });

  test("processes concurrent requests with the same key only once", async () => {
    const em = orm.em.fork();
    const playerId = `concurrent-idempotency-${randomUUID()}`;
    const walletId = randomUUID();
    const idempotencyKey = randomUUID();

    await em.insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "100.00",
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const input = {
      playerId,
      currency: "BRL",
      amount: "30.00",
      idempotencyKey,
    };

    const [firstResult, secondResult] = await Promise.all([
      useCase.execute(input),
      useCase.execute(input),
    ]);

    expect(firstResult).toEqual(secondResult);

    const storedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(storedWallet.balance).toBe("70.00");
    expect(storedWallet.version).toBe(1);

    const transactions = await em.find(WagerTransactionEntity, { playerId });
    expect(transactions).toHaveLength(1);

    const ledgerEntries = await em.find(WalletLedgerEntryEntity, {
      walletId,
    });
    expect(ledgerEntries).toHaveLength(1);

    const idempotencyRecords = await em.find(
      (
        await import("../../../src/shared/infrastructure/idempotency-record.entity")
      ).IdempotencyRecordEntity,
      { scope: "PROCESS_BET", key: idempotencyKey },
    );

    expect(idempotencyRecords).toHaveLength(1);
  });
});
