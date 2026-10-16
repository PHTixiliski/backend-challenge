import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DomainError } from "../../../src/shared/domain/domain-error";
import { Money } from "../../../src/wallet/domain/money";
import { WagerTransaction } from "../../../src/wager/domain/wager-transaction";
import {
  WagerTransactionStatus,
  WagerTransactionType,
} from "../../../src/wager/domain/wager-transaction.types";

describe("WagerTransaction", () => {
  function createTransaction(
    overrides: Partial<ConstructorParameters<typeof WagerTransaction>[0]> = {},
  ): WagerTransaction {
    return new WagerTransaction({
      id: randomUUID(),
      providerId: "provider-test",
      externalTransactionId: "external-tx-001",
      idempotencyKey: "provider-test:external-tx-001",
      payloadHash: "a".repeat(64),
      walletId: randomUUID(),
      playerId: "player-001",
      roundId: "round-001",
      gameId: "game-001",
      type: WagerTransactionType.BET,
      amount: Money.create("10.00", "BRL"),
      status: WagerTransactionStatus.PENDING,
      ...overrides,
    });
  }

  test("creates a pending transaction", () => {
    const transaction = createTransaction();
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.amount.toString()).toBe("10.00");
    expect(transaction.amount.currency).toBe("BRL");
  });

  test("marks a pending transaction as processed", () => {
    const transaction = createTransaction();
    transaction.markProcessed();

    expect(transaction.status).toBe(WagerTransactionStatus.PROCESSED);
    expect(transaction.failureCode).toBeNull();
    expect(transaction.failureCode).toBeNull();
  });

  test("rejects transitions from terminal states", () => {
    const transaction = createTransaction({
      status: WagerTransactionStatus.PROCESSED,
    });
    expect(() => transaction.markFailed("INTERNAL_ERROR")).toThrow(DomainError);
  });

  test("requires a failure code when rejecting", () => {
    const transaction = createTransaction();
    expect(() => transaction.markRejected("")).toThrow(DomainError);
  });

  test("requires a reference for refunds", () => {
    expect(
      () =>
        new WagerTransaction({
          id: "refund-1",
          providerId: "provider-test",
          externalTransactionId: "external-refund-1",
          idempotencyKey: "key-refund-1",
          payloadHash: "a".repeat(64),
          walletId: "00000000-0000-4000-8000-000000000001",
          playerId: "player-1",
          roundId: "round-1",
          gameId: "game-1",
          type: WagerTransactionType.REFUND,
          amount: Money.create("10.00", "BRL"),
          status: WagerTransactionStatus.PENDING,
        }),
    ).toThrow(DomainError);
  });

  test("rejects a self-referencing transaction", () => {
    expect(
      () =>
        new WagerTransaction({
          id: "transaction-1",
          providerId: "provider-test",
          externalTransactionId: "external-tx-1",
          idempotencyKey: "key-tx-1",
          payloadHash: "a".repeat(64),
          walletId: "00000000-0000-4000-8000-000000000001",
          playerId: "player-1",
          roundId: "round-1",
          gameId: "game-1",
          type: WagerTransactionType.ROLLBACK,
          amount: Money.create("10.00", "BRL"),
          status: WagerTransactionStatus.PENDING,
          referenceTransactionId: "transaction-1",
          referenceExternalTransactionId: "external-tx-1",
        }),
    ).toThrow(DomainError);
  });
});
