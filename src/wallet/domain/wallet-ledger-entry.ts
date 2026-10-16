import { randomUUID } from "node:crypto";
import { Money } from "./money";

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

  constructor(props: WalletLedgerEntryProps) {
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
}
