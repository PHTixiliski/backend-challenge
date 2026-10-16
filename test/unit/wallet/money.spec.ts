import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/wallet/domain/money';
import { DomainError } from '../../../src/shared/domain/domain-error';

describe('Money', () => {
  test('creates a money value with two decimal places', () => {
    const money = Money.create('125.50', 'BRL');

    expect(money.toString()).toBe('125.50');
    expect(money.currency).toBe('BRL');
  });

  test('adds decimal values without floating-point errors', () => {
    const first = Money.create('0.10', 'BRL');
    const second = Money.create('0.20', 'BRL');

    expect(first.add(second).toString()).toBe('0.30');
  });

  test('subtracts values correctly', () => {
    const balance = Money.create('100.00', 'BRL');
    const wager = Money.create('80.00', 'BRL');

    expect(balance.subtract(wager).toString()).toBe('20.00');
  });

  test('does not mutate the original value', () => {
    const original = Money.create('100.00', 'BRL');

    original.subtract(Money.create('30.00', 'BRL'));

    expect(original.toString()).toBe('100.00');
  });

  test('rejects values with more than two decimal places', () => {
    expect(() => Money.create('10.123', 'BRL')).toThrow(DomainError);
  });

  test('rejects invalid currency codes', () => {
    expect(() => Money.create('10.00', 'brl')).toThrow(DomainError);
  });

  test('rejects operations between different currencies', () => {
    const reais = Money.create('10.00', 'BRL');
    const dollars = Money.create('10.00', 'USD');

    expect(() => reais.add(dollars)).toThrow(DomainError);
  });

  test('identifies negative values', () => {
    const money = Money.create('-10.00', 'BRL');

    expect(money.isNegative()).toBe(true);
  });

  test('creates a zero value for a currency', () => {
    expect(Money.zero('BRL').toString()).toBe('0.00');
  });
});
