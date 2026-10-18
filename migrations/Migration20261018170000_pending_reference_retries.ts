import { Migration } from "@mikro-orm/migrations";

export class Migration20261018170000_pending_reference_retries extends Migration {
  override name = "Migration20261018170000_pending_reference_retries";

  override up(): void {
    this.addSql(`
      ALTER TABLE "wager_transactions"
        ADD COLUMN "reference_attempts" integer NOT NULL DEFAULT 0,
        ADD COLUMN "reference_next_attempt_at" timestamptz NULL;
    `);
    this.addSql(`
      UPDATE "wager_transactions"
      SET "reference_next_attempt_at" = NOW()
      WHERE "status" = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX "wager_transactions_pending_reference_due_idx"
      ON "wager_transactions" ("reference_next_attempt_at", "id")
      WHERE "status" = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql(`DROP INDEX "wager_transactions_pending_reference_due_idx";`);
    this.addSql(`
      ALTER TABLE "wager_transactions"
        DROP COLUMN "reference_next_attempt_at",
        DROP COLUMN "reference_attempts";
    `);
  }
}
