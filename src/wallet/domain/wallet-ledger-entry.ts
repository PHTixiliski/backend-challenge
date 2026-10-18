import { randomUUID } from "node:crypto";
import { Money } from "./money";
import { DomainError } from "../../shared/domain/domain-error";

export type WalletLedgerEntryType = "CREDIT" | "DEBIT";

export interface WalletLedgerEntryProps {
  id?: string;
  walletId: string;
  transactionId: string;
  type: WalletLedgerEntryType;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly type: WalletLedgerEntryType;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;

  private constructor(props: WalletLedgerEntryProps) {
    if (!props.walletId.trim()) {
      throw new Error("Wallet ID cannot be empty.");
    }

    if (!props.transactionId.trim()) {
      throw new Error("Transaction ID cannot be empty.");
    }

    if (props.amount.isNegative() || props.amount.isZero()) {
      throw new Error("Ledger entry amount must be positive.");
    }

    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new Error("Ledger balance cannot be negative.");
    }

    if (
      props.amount.currency !== props.balanceBefore.currency ||
      props.amount.currency !== props.balanceAfter.currency
    ) {
      throw new Error("Ledger entry currencies must match.");
    }

    const expectedAfter = props.type === "CREDIT"
      ? props.balanceBefore.add(props.amount)
      : props.balanceBefore.subtract(props.amount);
    if (!expectedAfter.equals(props.balanceAfter)) {
      throw new DomainError(
        "UNBALANCED_LEDGER_ENTRY",
        "Ledger balance after must equal balance before adjusted by the entry.",
      );
    }

    this.id = props.id ?? randomUUID();
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.type = props.type;
    this.amount = props.amount;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this.createdAt = new Date(props.createdAt ?? new Date());

    Object.freeze(this);
  }

  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(props);
  }

  static rehydrate(state: WalletLedgerEntryProps & { id: string }): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }
}
