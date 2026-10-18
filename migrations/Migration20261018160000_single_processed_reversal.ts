import { Migration } from "@mikro-orm/migrations";

export class Migration20261018160000_single_processed_reversal extends Migration {
  override name = "Migration20261018160000_single_processed_reversal";

  override up(): void {
    this.addSql(`
      CREATE UNIQUE INDEX "wager_transactions_one_processed_reversal_idx"
      ON "wager_transactions" ("reference_transaction_id", "type")
      WHERE "reference_transaction_id" IS NOT NULL
        AND "type" IN ('REFUND', 'ROLLBACK')
        AND "status" = 'PROCESSED';
    `);
  }

  override down(): void {
    this.addSql(`DROP INDEX "wager_transactions_one_processed_reversal_idx";`);
  }
}
