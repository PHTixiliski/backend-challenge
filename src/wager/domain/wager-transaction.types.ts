export enum WagerTransactionType {
  OPENING = "OPENING",
  BET = "BET",
  WIN = "WIN",
  LOSS = "LOSS",
  REFUND = "REFUND",
  ROLLBACK = "ROLLBACK",
}

export enum WagerTransactionStatus {
  PENDING = "PENDING",
  PENDING_REFERENCE = "PENDING_REFERENCE",
  PROCESSED = "PROCESSED",
  REJECTED = "REJECTED",
  FAILED = "FAILED",
}

export const TERMINAL_TRANSACTION_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.PROCESSED,
  WagerTransactionStatus.REJECTED,
  WagerTransactionStatus.FAILED,
]);
