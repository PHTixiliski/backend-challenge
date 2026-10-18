import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../../wallet/domain/money";
import { randomUUID } from "node:crypto";
import {
  TERMINAL_TRANSACTION_STATUSES,
  WagerTransactionStatus,
  WagerTransactionType,
} from "./wager-transaction.types";

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  type: WagerTransactionType;
  amount: Money;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  createdAt?: Date;
  processedAt?: Date | null;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionProps,
  | "id"
  | "status"
  | "referenceTransactionId"
  | "failureCode"
  | "processedAt"
> & { id?: string };

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly type: WagerTransactionType;
  readonly amount: Money;
  readonly referenceExternalTransactionId: string | null;
  private currentReferenceTransactionId: string | null;
  readonly createdAt: Date;

  private currentStatus: WagerTransactionStatus;
  private currentFailureCode: string | null;
  private currentProcessedAt: Date | null;

  private constructor(props: WagerTransactionProps) {
    const requiredFields: Array<[string, string]> = [
      ["id", props.id],
      ["providerId", props.providerId],
      ["externalTransactionId", props.externalTransactionId],
      ["idempotencyKey", props.idempotencyKey],
      ["payloadHash", props.payloadHash],
      ["walletId", props.walletId],
      ["playerId", props.playerId],
      ["roundId", props.roundId],
      ["gameId", props.gameId],
    ];

    for (const [field, value] of requiredFields) {
      if (!value?.trim()) {
        throw new DomainError(
          "INVALID_WAGER_TRANSACTION",
          `${field} is required.`,
        );
      }
    }

    if (props.amount.isNegative() || props.amount.isZero()) {
      throw new DomainError(
        "INVALID_AMOUNT",
        "Transaction amount must be positive.",
      );
    }

    const referenceExternalTransactionId =
      props.referenceExternalTransactionId?.trim() || null;

    const referenceTransactionId = props.referenceTransactionId?.trim() || null;

    if (
      (props.type === WagerTransactionType.REFUND ||
        props.type === WagerTransactionType.ROLLBACK) &&
      !referenceExternalTransactionId
    ) {
      throw new DomainError(
        "REFERENCE_REQUIRED",
        "Refund and rollback transactions require an external reference.",
      );
    }

    if (referenceTransactionId && referenceTransactionId === props.id) {
      throw new DomainError(
        "INVALID_REFERENCE",
        "A transaction cannot reference itself.",
      );
    }

    if (referenceExternalTransactionId === props.externalTransactionId) {
      throw new DomainError(
        "INVALID_REFERENCE",
        "A transaction cannot reference itself externally.",
      );
    }

    if (
      props.payloadHash.length !== 64 ||
      !/^[a-f0-9]{64}$/i.test(props.payloadHash)
    ) {
      throw new DomainError(
        "INVALID_PAYLOAD_HASH",
        "Payload hash must be a SHA-256 hexadecimal string.",
      );
    }

    this.id = props.id.trim();
    this.providerId = props.providerId.trim();
    this.externalTransactionId = props.externalTransactionId.trim();
    this.idempotencyKey = props.idempotencyKey.trim();
    this.payloadHash = props.payloadHash.toLowerCase();
    this.walletId = props.walletId.trim();
    this.playerId = props.playerId.trim();
    this.roundId = props.roundId.trim();
    this.gameId = props.gameId.trim();
    this.type = props.type;
    this.amount = props.amount;
    this.referenceExternalTransactionId = referenceExternalTransactionId;
    this.currentReferenceTransactionId = referenceTransactionId;
    this.currentStatus = props.status;
    this.currentFailureCode = props.failureCode ?? null;
    this.createdAt = new Date(props.createdAt ?? new Date());
    this.currentProcessedAt = props.processedAt
      ? new Date(props.processedAt)
      : null;
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction({
      ...props,
      id: props.id ?? randomUUID(),
      status: WagerTransactionStatus.PENDING,
    });
  }

  static rehydrate(state: WagerTransactionProps): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this.currentStatus;
  }

  get failureCode(): string | null {
    return this.currentFailureCode;
  }

  get processedAt(): Date | null {
    return this.currentProcessedAt ? new Date(this.currentProcessedAt) : null;
  }

  get referenceTransactionId(): string | null {
    return this.currentReferenceTransactionId;
  }

  resolveReference(transactionId: string): void {
    if (!transactionId.trim() || transactionId === this.id) {
      throw new DomainError("INVALID_REFERENCE", "Resolved reference is invalid.");
    }
    this.currentReferenceTransactionId = transactionId;
  }

  markPendingReference(): void {
    this.transitionTo(WagerTransactionStatus.PENDING_REFERENCE);
    this.currentFailureCode = null;
  }

  markProcessed(): void {
    this.transitionTo(WagerTransactionStatus.PROCESSED);
    this.currentFailureCode = null;
    this.currentProcessedAt = new Date();
  }

  markRejected(code: string): void {
    this.validateFailureCode(code);
    this.transitionTo(WagerTransactionStatus.REJECTED);
    this.currentFailureCode = code.trim();
  }

  markFailed(code: string): void {
    this.validateFailureCode(code);
    this.transitionTo(WagerTransactionStatus.FAILED);
    this.currentFailureCode = code.trim();
  }

  private validateFailureCode(code: string): void {
    if (!code.trim()) {
      throw new DomainError(
        "FAILURE_CODE_REQUIRED",
        "A failure code is required.",
      );
    }
  }

  private transitionTo(nextStatus: WagerTransactionStatus): void {
    if (TERMINAL_TRANSACTION_STATUSES.has(this.currentStatus)) {
      throw new DomainError(
        "INVALID_TRANSACTION_TRANSITION",
        `Cannot transition from terminal status ${this.currentStatus}.`,
      );
    }

    this.currentStatus = nextStatus;
  }
}
