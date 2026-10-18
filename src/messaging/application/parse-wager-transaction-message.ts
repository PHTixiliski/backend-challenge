import { DomainError } from "../../shared/domain/domain-error";
import type { WagerTransactionRequestedMessage } from "./wager-transaction-message";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function requireString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError(
      "INVALID_MESSAGE",
      `Field "${field}" must be a non-empty string.`,
    );
  }

  return value.trim();
}

export function parseWagerTransactionMessage(
  raw: string,
): WagerTransactionRequestedMessage {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError(
      "INVALID_MESSAGE",
      "Message body must contain valid JSON.",
    );
  }

  if (!isRecord(parsed) || !isRecord(parsed.data)) {
    throw new DomainError(
      "INVALID_MESSAGE",
      "Message and data must be JSON objects.",
    );
  }

  const data = parsed.data;

  if (!isRecord(data.money)) {
    throw new DomainError(
      "INVALID_MESSAGE",
      'Field "data.money" must be an object.',
    );
  }

  const type = requireString(parsed.type, "type");

  if (type !== "WagerTransactionRequested") {
    throw new DomainError(
      "UNSUPPORTED_MESSAGE_TYPE",
      `Unsupported message type "${type}".`,
    );
  }

  const kind = requireString(data.kind, "data.kind");

  if (!("BET WIN LOSS REFUND ROLLBACK" as string).split(" ").includes(kind)) {
    throw new DomainError(
      "UNSUPPORTED_TRANSACTION_KIND",
      `Unsupported transaction kind "${kind}".`,
    );
  }

  const occurredAt = requireString(parsed.occurredAt, "occurredAt");

  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new DomainError(
      "INVALID_MESSAGE",
      'Field "occurredAt" must be a valid date.',
    );
  }

  return {
    messageId: requireString(parsed.messageId, "messageId"),
    type: "WagerTransactionRequested",
    occurredAt,
    data: {
      providerId: requireString(data.providerId, "data.providerId"),
      externalTransactionId: requireString(
        data.externalTransactionId,
        "data.externalTransactionId",
      ),
      idempotencyKey: requireString(
        data.idempotencyKey,
        "data.idempotencyKey",
      ),
      playerId: requireString(data.playerId, "data.playerId"),
      walletId: requireString(data.walletId, "data.walletId"),
      roundId: requireString(data.roundId, "data.roundId"),
      gameId: requireString(data.gameId, "data.gameId"),
      kind: kind as WagerTransactionRequestedMessage["data"]["kind"],
      ...(typeof data.referenceExternalTransactionId === "string"
        ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
        : {}),
      money: {
        amount: requireString(data.money.amount, "data.money.amount"),
        currency: requireString(
          data.money.currency,
          "data.money.currency",
        ),
      },
    },
  };
}
