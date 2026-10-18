import { describe, expect, mock, test } from "bun:test";
import { ReconcileWalletUseCase } from "../../../src/wallet/application/reconcile-wallet.use-case";
import { MetricsRegistry } from "../../../src/observability/metrics.registry";

describe("ReconcileWalletUseCase", () => {
  test("counts and reports a ledger mismatch", async () => {
    const increment = mock(() => undefined);
    const entityManager = {
      getConnection: () => ({
        execute: async () => [{
          walletId: "wallet-1",
          currency: "BRL",
          storedBalance: "10.00",
          calculatedBalance: "5.00",
          checkedEntries: 1,
        }],
      }),
    };
    const metrics = { increment } as unknown as MetricsRegistry;
    const useCase = new ReconcileWalletUseCase(entityManager as never, metrics);

    const result = await useCase.execute("wallet-1");

    expect(result.consistent).toBe(false);
    expect(result.difference.amount).toBe("-5.00");
    expect(increment).toHaveBeenCalledWith("wallet_reconciliation_mismatches_total");
  });
});
