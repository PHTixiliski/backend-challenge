import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { DomainError } from "../../shared/domain/domain-error";
import { Money } from "../domain/money";
import { MetricsRegistry } from "../../observability/metrics.registry";

@Injectable()
export class ReconcileWalletUseCase {
  private readonly logger = new Logger(ReconcileWalletUseCase.name);

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  async execute(walletId: string) {
    const rows = await this.em.getConnection().execute(
      `SELECT w.id AS "walletId", w.currency,
        w.balance::text AS "storedBalance",
        COALESCE(SUM(CASE WHEN l.type = 'CREDIT' THEN l.amount WHEN l.type = 'DEBIT' THEN -l.amount ELSE 0 END), 0)::text AS "calculatedBalance",
        COUNT(l.id)::int AS "checkedEntries"
       FROM wallets w
       LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
       WHERE w.id = ?
       GROUP BY w.id`,
      [walletId],
    ) as Array<{ walletId: string; currency: string; storedBalance: string; calculatedBalance: string; checkedEntries: number }>;
    const row = rows[0];
    if (!row) throw new DomainError("WALLET_NOT_FOUND", "Wallet was not found.");

    const stored = Money.create(row.storedBalance, row.currency);
    const calculated = Money.create(row.calculatedBalance, row.currency);
    const difference = calculated.subtract(stored);
    const consistent = difference.isZero();
    if (!consistent) {
      this.logger.error(JSON.stringify({ event: "wallet_reconciliation_mismatch", walletId, checkedEntries: row.checkedEntries }));
      this.metrics?.increment("wallet_reconciliation_mismatches_total");
    }

    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: row.checkedEntries,
    };
  }
}
