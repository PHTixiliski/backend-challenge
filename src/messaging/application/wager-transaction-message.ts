export interface WagerTransactionRequestedMessage {
  messageId: string;
  type: "WagerTransactionRequested";
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
    referenceExternalTransactionId?: string;
    money: {
      amount: string;
      currency: string;
    };
  };
}
