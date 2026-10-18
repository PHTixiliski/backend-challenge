import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/wallet/domain/money";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { DomainError } from "../../../src/shared/domain/domain-error";

function createWallet(balance = "100.00"): Wallet {
  return Wallet.rehydrate({
    id: "wallet-1",
    playerId: "player-1",
    currency: "BRL",
    balance: Money.create(balance, "BRL"),
    version: 1,
  });
}

describe("Wallet", () => {
  test("debits funds and increments the version", () => {
    const wallet = createWallet();

    const entry = wallet.debit(Money.create("30.00", "BRL"), "transaction-1");

    expect(wallet.balance.toString()).toBe("70.00");
    expect(wallet.version).toBe(2);
    expect(entry.type).toBe("DEBIT");
    expect(entry.balanceAfter.toString()).toBe("70.00");
  });

  test("credits funds and increments the version", () => {
    const wallet = createWallet();

    const entry = wallet.credit(Money.create("25.00", "BRL"), "transaction-2");

    expect(wallet.balance.toString()).toBe("125.00");
    expect(wallet.version).toBe(2);
    expect(entry.type).toBe("CREDIT");
  });

  test("rejects a debit that exceeds the balance", () => {
    const wallet = createWallet();

    expect(() =>
      wallet.debit(Money.create("100.01", "BRL"), "transaction-3"),
    ).toThrow(DomainError);

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects zero-value transactions", () => {
    const wallet = createWallet();

    expect(() =>
      wallet.debit(Money.create("0.00", "BRL"), "transaction-4"),
    ).toThrow(DomainError);

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("rejects transactions in a different currency", () => {
    const wallet = createWallet();

    expect(() =>
      wallet.credit(Money.create("10.00", "USD"), "transaction-5"),
    ).toThrow(DomainError);

    expect(wallet.balance.toString()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("allows a debit equal to the entire balance", () => {
    const wallet = createWallet();

    wallet.debit(Money.create("100.00", "BRL"), "transaction-6");

    expect(wallet.balance.toString()).toBe("0.00");
    expect(wallet.version).toBe(2);
  });

  test("rejects negative initial balances", () => {
    expect(
      () =>
        Wallet.open({
          id: "wallet-2",
          playerId: "player-2",
          initialBalance: Money.create("-1.00", "BRL"),
        }),
    ).toThrow(DomainError);
  });
});
