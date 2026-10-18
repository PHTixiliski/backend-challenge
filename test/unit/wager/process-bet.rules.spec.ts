import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/wallet/domain/money";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { ProcessBetUseCase } from "../../../src/wager/application/process-bet.use-case";
import {
  WagerTransactionStatus,
  WagerTransactionType,
} from "../../../src/wager/domain/wager-transaction.types";
import type { WalletLedgerEntry } from "../../../src/wallet/domain/wallet-ledger-entry";

interface RuleCase {
  name: string;
  kind: WagerTransactionType;
  referenceType?: WagerTransactionType;
  expectedBalance: string;
  expectedLedgerType?: "CREDIT" | "DEBIT";
}

const cases: RuleCase[] = [
  { name: "BET debits the wallet", kind: WagerTransactionType.BET, expectedBalance: "90.00", expectedLedgerType: "DEBIT" },
  { name: "WIN credits the wallet", kind: WagerTransactionType.WIN, expectedBalance: "110.00", expectedLedgerType: "CREDIT" },
  { name: "LOSS records the result without moving the balance", kind: WagerTransactionType.LOSS, expectedBalance: "100.00" },
  { name: "REFUND credits a processed BET", kind: WagerTransactionType.REFUND, referenceType: WagerTransactionType.BET, expectedBalance: "110.00", expectedLedgerType: "CREDIT" },
  { name: "ROLLBACK credits a processed BET", kind: WagerTransactionType.ROLLBACK, referenceType: WagerTransactionType.BET, expectedBalance: "110.00", expectedLedgerType: "CREDIT" },
  { name: "ROLLBACK debits a processed WIN", kind: WagerTransactionType.ROLLBACK, referenceType: WagerTransactionType.WIN, expectedBalance: "90.00", expectedLedgerType: "DEBIT" },
];

describe("ProcessBetUseCase financial rules", () => {
  for (const rule of cases) {
    test(rule.name, async () => {
      const wallet = Wallet.open({
        id: "00000000-0000-4000-8000-000000000001",
        playerId: "player-1",
        initialBalance: Money.create("100.00", "BRL"),
      });
      const ledgerEntries: WalletLedgerEntry[] = [];
      const reference = rule.referenceType
        ? {
            id: "00000000-0000-4000-8000-000000000002",
            providerId: "provider-1",
            externalTransactionId: "reference-1",
            playerId: "player-1",
            walletId: wallet.id,
            currency: "BRL",
            roundId: "round-1",
            amount: "10.00",
            type: rule.referenceType,
            status: WagerTransactionStatus.PROCESSED,
          }
        : null;
      const em = {};
      const transactionManager = {
        execute: async (operation: (manager: object) => Promise<unknown>) => operation(em),
      };
      const walletRepository = {
        findByIdForUpdate: async () => wallet,
        updateBalance: async () => undefined,
      };
      const ledgerRepository = {
        insert: async (_manager: object, entry: WalletLedgerEntry) => { ledgerEntries.push(entry); },
      };
      const wagerRepository = {
        findByProviderAndExternalId: async () => reference,
        hasPriorReversal: async () => false,
        insert: async () => undefined,
      };
      const idempotencyService = {
        hashPayload: () => "a".repeat(64),
        reserve: async () => true,
        updateResponse: async () => undefined,
      };
      const outboxRepository = { enqueue: async () => undefined };
      const useCase = new ProcessBetUseCase(
        transactionManager as never,
        walletRepository as never,
        ledgerRepository as never,
        wagerRepository as never,
        idempotencyService as never,
        outboxRepository as never,
      );

      const result = await useCase.execute({
        providerId: "provider-1",
        externalTransactionId: "transaction-1",
        playerId: "player-1",
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "game-1",
        kind: rule.kind,
        money: { amount: "10.00", currency: "BRL" },
        ...(rule.referenceType ? { referenceExternalTransactionId: "reference-1" } : {}),
        idempotencyKey: "key-1",
      });

      expect(result.status).toBe(WagerTransactionStatus.PROCESSED);
      expect(wallet.balance.toString()).toBe(rule.expectedBalance);
      expect(ledgerEntries).toHaveLength(rule.expectedLedgerType ? 1 : 0);
      if (rule.expectedLedgerType) expect(ledgerEntries[0]?.type).toBe(rule.expectedLedgerType);
    });
  }
});
