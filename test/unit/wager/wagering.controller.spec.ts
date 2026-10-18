import { describe, expect, mock, test } from "bun:test";
import { DomainError } from "../../../src/shared/domain/domain-error";
import { WageringController } from "../../../src/wager/presentation/wagering.controller";

describe("WageringController", () => {
  test("rejects malformed request bodies as client errors", async () => {
    const processBet = { execute: mock(async () => { throw new Error("must not run"); }) };
    const controller = new WageringController(
      processBet as never,
      {} as never,
    );

    await expect(controller.submit(null)).rejects.toBeInstanceOf(DomainError);
    expect(processBet.execute).not.toHaveBeenCalled();
  });

  test("serializes the normalized currency from the validated request", async () => {
    const processBet = {
      execute: mock(async () => ({
        transactionId: "transaction-1",
        status: "PROCESSED" as const,
        balance: "90.00",
        failureCode: null,
      })),
    };
    const controller = new WageringController(processBet as never, {} as never);
    const response = { statusCode: 0 };

    const result = await controller.submit({
      providerId: "provider",
      externalTransactionId: "external-1",
      playerId: "player-1",
      walletId: "00000000-0000-4000-8000-000000000001",
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "10.00", currency: "brl" },
    }, "key-1", response);

    expect(result.balance).toEqual({ amount: "90.00", currency: "BRL" });
    expect(response.statusCode).toBe(200);
  });
});
