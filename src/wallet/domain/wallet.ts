import { Money } from "./money";
import {
  WalletLedgerEntry,
  type WalletLedgerEntryType,
} from "./wallet-ledger-entry";
import { DomainError } from "../../shared/domain/domain-error";

export interface WalletProps {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Wallet {
  private currentBalance: Money;
  private currentVersion: number;
  private currentUpdatedAt: Date;

  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly createdAt: Date;

  private constructor(props: WalletProps) {
    if (!props.id.trim() || !props.playerId.trim()) {
      throw new DomainError(
        "INVALID_WALLET",
        "Wallet ID and player ID are required.",
      );
    }

    if (props.balance.currency !== props.currency) {
      throw new DomainError(
        "CURRENCY_MISMATCH",
        "Wallet balance currency must match wallet currency.",
      );
    }

    if (props.balance.isNegative()) {
      throw new DomainError(
        "INVALID_WALLET_BALANCE",
        "Wallet balance cannot be negative.",
      );
    }

    if (!Number.isSafeInteger(props.version) || props.version < 0) {
      throw new DomainError(
        "INVALID_WALLET_VERSION",
        "Wallet version must be a non-negative safe integer.",
      );
    }

    this.id = props.id;
    this.playerId = props.playerId;
    this.currency = props.currency;
    this.currentBalance = props.balance;
    this.currentVersion = props.version;
    this.createdAt = new Date(props.createdAt ?? new Date());
    this.currentUpdatedAt = new Date(props.updatedAt ?? this.createdAt);
  }

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
    });
  }

  static rehydrate(state: WalletProps): Wallet {
    return new Wallet(state);
  }

  get updatedAt(): Date {
    return new Date(this.currentUpdatedAt);
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  debit(amount: Money, transactionId: string): WalletLedgerEntry {
    this.ensureValidAmount(amount);

    if (this.currentBalance.subtract(amount).isNegative()) {
      throw new DomainError(
        "INSUFFICIENT_FUNDS",
        "Wallet balance is insufficient.",
      );
    }

    return this.applyMovement("DEBIT", amount, transactionId);
  }

  credit(amount: Money, transactionId: string): WalletLedgerEntry {
    this.ensureValidAmount(amount);

    return this.applyMovement("CREDIT", amount, transactionId);
  }

  private applyMovement(
    type: WalletLedgerEntryType,
    amount: Money,
    transactionId: string,
  ): WalletLedgerEntry {
    const previousBalance = this.currentBalance;

    const nextBalance =
      type === "CREDIT"
        ? previousBalance.add(amount)
        : previousBalance.subtract(amount);

    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      type,
      amount,
      balanceBefore: previousBalance,
      balanceAfter: nextBalance,
    });

    this.currentBalance = nextBalance;
    this.currentVersion += 1;
    this.currentUpdatedAt = new Date();

    return entry;
  }

  private ensureValidAmount(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new DomainError(
        "CURRENCY_MISMATCH",
        "Transaction currency must match wallet currency.",
      );
    }

    if (amount.isNegative() || amount.isZero()) {
      throw new DomainError(
        "INVALID_AMOUNT",
        "Transaction amount must be positive.",
      );
    }
  }
}
