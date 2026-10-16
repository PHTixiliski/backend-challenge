import { describe, expect, test } from "bun:test";
import { IdempotencyService } from "../../../src/shared/infrastructure/idempotency.service";

describe("IdempotencyService", () => {
  const service = new IdempotencyService();

  test("generates the same hash regardless of object property order", () => {
    const first = service.hashPayload({
      playerId: "player-1",
      currency: "BRL",
      amount: "10.00",
    });

    const second = service.hashPayload({
      amount: "10.00",
      currency: "BRL",
      playerId: "player-1",
    });

    expect(first).toBe(second);
  });

  test("generates different hashes when payload values differ", () => {
    const first = service.hashPayload({
      playerId: "player-1",
      currency: "BRL",
      amount: "10.00",
    });

    const second = service.hashPayload({
      playerId: "player-1",
      currency: "BRL",
      amount: "20.00",
    });

    expect(first).not.toBe(second);
  });

  test("generates a SHA-256 hexadecimal hash", () => {
    const hash = service.hashPayload({ amount: "10.00" });

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
