import Decimal from 'decimal.js';
import { DomainError } from '../../shared/domain/domain-error';

const MONEY_SCALE = 2;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private readonly amount: Decimal;
  readonly currency: string;

  private constructor(amount: Decimal, currency: string) {
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  static create(amount: string, currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new DomainError(
        'INVALID_CURRENCY',
        'Currency must be a three-letter uppercase code.',
      );
    }

    if (!amount.trim() || !/^-?\d+(?:\.\d{1,2})?$/.test(amount)) {
      throw new DomainError(
        'INVALID_MONEY_AMOUNT',
        'Money amount cannot be empty.',
      );
    }

    let parsedAmount: Decimal;

    try {
      parsedAmount = new Decimal(amount);
    } catch {
      throw new DomainError(
        'INVALID_MONEY_AMOUNT',
        'Money amount must be a valid decimal string.',
      );
    }

    if (!parsedAmount.isFinite()) {
      throw new DomainError(
        'INVALID_MONEY_AMOUNT',
        'Money amount must be finite.',
      );
    }

    if (parsedAmount.decimalPlaces() > MONEY_SCALE) {
      throw new DomainError(
        'INVALID_MONEY_PRECISION',
        'Money amount cannot have more than two decimal places.',
      );
    }

    return new Money(parsedAmount, currency);
  }

  static zero(currency: string): Money {
    return Money.create('0.00', currency);
  }

  add(other: Money): Money {
    this.ensureSameCurrency(other);

    return new Money(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.ensureSameCurrency(other);

    return new Money(this.amount.minus(other.amount), this.currency);
  }

  isNegative(): boolean {
    return this.amount.isNegative();
  }

  isPositive(): boolean {
    return this.amount.isPositive();
  }

  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  isLessThan(other: Money): boolean {
    this.ensureSameCurrency(other);
    return this.amount.lessThan(other.amount);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.amount.equals(other.amount)
    );
  }

  toString(): string {
    return this.amount.toFixed(MONEY_SCALE);
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }

  private ensureSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'Cannot operate on money values with different currencies.',
      );
    }
  }
}
