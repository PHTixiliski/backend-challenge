import { describe, expect, test } from "bun:test";

import { DomainError } from "../../../src/shared/domain/domain-error";
import { parseWagerTransactionMessage } from "../../../src/messaging/application/parse-wager-transaction-message";

const validMessage = {
  messageId: "msg-123",
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-4d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: {
      amount: "25.00",
      currency: "BRL",
    },
  },
};

describe("parseWagerTransactionMessage", () => {
  test("parses a valid BET message", () => {
    const result = parseWagerTransactionMessage(
      JSON.stringify(validMessage),
    );

    expect(result.messageId).toBe("msg-123");
    expect(result.data.kind).toBe("BET");
    expect(result.data.money.amount).toBe("25.00");
    expect(result.data.money.currency).toBe("BRL");
  });

  test("rejects invalid JSON", () => {
    expect(() => parseWagerTransactionMessage("{invalid")).toThrow(
      DomainError,
    );
  });

  test("rejects missing required fields", () => {
    const message = {
      ...validMessage,
      data: {
        ...validMessage.data,
        walletId: " ",
      },
    };

    expect(() =>
      parseWagerTransactionMessage(JSON.stringify(message)),
    ).toThrow(DomainError);
  });

  test("rejects unsupported transaction kinds", () => {
    const message = {
      ...validMessage,
      data: {
        ...validMessage.data,
        kind: "OPENING",
      },
    };

    expect(() =>
      parseWagerTransactionMessage(JSON.stringify(message)),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_TRANSACTION_KIND",
      }),
    );
  });

  test("rejects unsupported event types", () => {
    const message = {
      ...validMessage,
      type: "UnknownEvent",
    };

    expect(() =>
      parseWagerTransactionMessage(JSON.stringify(message)),
    ).toThrow(
      expect.objectContaining({
        code: "UNSUPPORTED_MESSAGE_TYPE",
      }),
    );
  });
});
