import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { Money } from "../../../src/wallet/domain/money";
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

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);

    const em = orm.em.fork();

    repository = new MikroOrmWagerTransactionRepository(
      em.getRepository(WagerTransactionEntity),
    );
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test("persists and retrieves a wager transaction", async () => {
    const id = randomUUID();
    const playerId = `integration-${randomUUID()}`;

    const transaction = new WagerTransaction({
      id,
      playerId,
      type: WagerTransactionType.BET,
      amount: Money.create("25.75", "BRL"),
      status: WagerTransactionStatus.PENDING,
      providerId: "provider-test",
      externalTransactionId: `external-${id}`,
      idempotencyKey: `key-${id}`,
      payloadHash: "a".repeat(64),
      walletId: "00000000-0000-4000-8000-000000000001",
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
    expect(retrieved?.referenceExternalTransactionId).toBeUndefined();
    expect(retrieved?.referenceTransactionId).toBeUndefined();
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

    const transaction = new WagerTransaction({
      id,
      playerId,
      type: WagerTransactionType.ROLLBACK,
      amount: Money.create("25.75", "BRL"),
      status: WagerTransactionStatus.REJECTED,
      providerId: "provider-test",
      externalTransactionId: `external-${id}`,
      idempotencyKey: `key-${id}`,
      payloadHash: "a".repeat(64),
      walletId: "00000000-0000-4000-8000-000000000001",
      roundId: "round-1",
      gameId: "game-1",
      referenceExternalTransactionId: `external-reference-${referenceId}`,
      referenceTransactionId: referenceId,
      failureCode: "REFERENCE_NOT_REVERSIBLE",
    });

    await repository.save(transaction);

    const retrieved = await repository.findById(id);

    expect(retrieved?.referenceTransactionId).toBe(referenceId);
    expect(retrieved?.failureCode).toBe("REFERENCE_NOT_REVERSIBLE");
    expect(retrieved?.status).toBe(WagerTransactionStatus.REJECTED);
  });
});
