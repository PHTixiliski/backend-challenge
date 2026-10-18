import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";
import { Money } from "../../../src/wallet/domain/money";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";
import { WagerTransaction } from "../../../src/wager/domain/wager-transaction";
import {
  WagerTransactionStatus,
  WagerTransactionType,
} from "../../../src/wager/domain/wager-transaction.types";
import { WagerTransactionEntity } from "../../../src/wager/infrastructure/wager-transaction.entity";
import { MikroOrmWagerTransactionRepository } from "../../../src/wager/infrastructure/mikro-orm-wager-transaction.repository";

describe("MikroOrmWagerTransactionRepository (integration)", () => {
  let orm: MikroORM;
  let repository: MikroOrmWagerTransactionRepository;
  const testWalletIds: string[] = [];

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(mikroOrmConfig);

    const em = orm.em.fork();

    repository = new MikroOrmWagerTransactionRepository(
      em.getRepository(WagerTransactionEntity),
    );
  });

  afterAll(async () => {
    await orm.close(true);
  });

  afterEach(async () => {
    for (const walletId of testWalletIds.splice(0)) {
      const em = orm.em.fork();
      await em.getConnection().execute(
        "DELETE FROM wager_transactions WHERE wallet_id = ?",
        [walletId],
      );
      await em.nativeDelete(WalletEntity, { id: walletId });
    }
  });

  test("persists and retrieves a wager transaction", async () => {
    const id = randomUUID();
    const playerId = `integration-${randomUUID()}`;
    const walletId = randomUUID();

    await orm.em.fork().insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "0.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    testWalletIds.push(walletId);

    const transaction = WagerTransaction.create({
      id,
      playerId,
      type: WagerTransactionType.BET,
      amount: Money.create("25.75", "BRL"),
      providerId: "provider-test",
      externalTransactionId: `external-${id}`,
      idempotencyKey: `key-${id}`,
      payloadHash: "a".repeat(64),
      walletId,
      roundId: "round-1",
      gameId: "game-1",
    });

    await repository.save(transaction);

    const retrieved = await repository.findById(id);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(id);
    expect(retrieved?.playerId).toBe(playerId);
    expect(retrieved?.type).toBe(WagerTransactionType.BET);
    expect(retrieved?.amount.toString()).toBe("25.75");
    expect(retrieved?.amount.currency).toBe("BRL");
    expect(retrieved?.status).toBe(WagerTransactionStatus.PENDING);
    expect(
      retrieved?.referenceExternalTransactionId ?? undefined,
    ).toBeUndefined();
    expect(retrieved?.referenceTransactionId ?? undefined).toBeUndefined();
    expect(retrieved?.failureCode).toBeNull();
  });

  test("returns null when the transaction does not exist", async () => {
    const retrieved = await repository.findById(randomUUID());

    expect(retrieved).toBeNull();
  });

  test("persists a reference and a rejection code", async () => {
    const id = randomUUID();
    const referenceId = randomUUID();
    const playerId = `integration-${randomUUID()}`;
    const walletId = randomUUID();

    // A carteira precisa existir antes das transações que a referenciam.
    await orm.em.fork().insert(WalletEntity, {
      id: walletId,
      playerId,
      currency: "BRL",
      balance: "0.00",
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    testWalletIds.push(walletId);

    const referenceTransaction = WagerTransaction.create({
      id: referenceId,
      playerId,
      type: WagerTransactionType.BET,
      amount: Money.create("25.75", "BRL"),
      providerId: "provider-test",
      externalTransactionId: `external-reference-${referenceId}`,
      idempotencyKey: `key-reference-${referenceId}`,
      payloadHash: "b".repeat(64),
      walletId,
      roundId: "round-1",
      gameId: "game-1",
    });
    referenceTransaction.markProcessed();

    // A transação original precisa existir antes do rollback.
    await repository.save(referenceTransaction);

    const transaction = WagerTransaction.create({
      id,
      playerId,
      type: WagerTransactionType.ROLLBACK,
      amount: Money.create("25.75", "BRL"),
      providerId: "provider-test",
      externalTransactionId: `external-${id}`,
      idempotencyKey: `key-${id}`,
      payloadHash: "a".repeat(64),
      walletId,
      roundId: "round-1",
      gameId: "game-1",
      referenceExternalTransactionId: `external-reference-${referenceId}`,
    });
    transaction.resolveReference(referenceId);
    transaction.markRejected("REFERENCE_NOT_REVERSIBLE");

    await repository.save(transaction);

    const retrieved = await repository.findById(id);

    expect(retrieved?.referenceTransactionId).toBe(referenceId);
    expect(retrieved?.failureCode).toBe("REFERENCE_NOT_REVERSIBLE");
    expect(retrieved?.status).toBe(WagerTransactionStatus.REJECTED);
  });
});
