import { Migration } from "@mikro-orm/migrations";

export class Migration20261018190000_wallet_initial_version_one extends Migration {
  override name = "Migration20261018190000_wallet_initial_version_one";

  override up(): void {
    // Keep the exact rows needed to reverse this normalization later.
    this.addSql(`
      CREATE TABLE "migration_20261018190000_wallet_versions" (
        "wallet_id" uuid PRIMARY KEY
      );
    `);
    this.addSql(`
      INSERT INTO "migration_20261018190000_wallet_versions" ("wallet_id")
      SELECT "id" FROM "wallets" WHERE "version" = 0;
    `);

    // These triggers correctly enforce normal writes. Temporarily remove them
    // for this metadata-only correction because historical wallets can predate
    // ledger enforcement and the deferred ledger trigger would otherwise reject
    // an unchanged legacy balance.
    this.addSql(`DROP TRIGGER "wallets_version_transition" ON "wallets";`);
    this.addSql(`DROP TRIGGER "wallets_ledger_consistency" ON "wallets";`);
    this.addSql(`UPDATE "wallets" SET "version" = 1 WHERE "version" = 0;`);
    this.addSql(`
      CREATE TRIGGER wallets_version_transition
      BEFORE UPDATE ON "wallets"
      FOR EACH ROW EXECUTE FUNCTION enforce_wallet_version_transition();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency
      AFTER INSERT OR UPDATE ON "wallets"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_consistency();
    `);
  }

  override down(): void {
    this.addSql(`DROP TRIGGER "wallets_version_transition" ON "wallets";`);
    this.addSql(`DROP TRIGGER "wallets_ledger_consistency" ON "wallets";`);
    // Subtract only the migration's one-time version adjustment. Any later
    // balance changes remain reflected in the resulting version.
    this.addSql(`
      UPDATE "wallets" AS wallet
      SET "version" = wallet."version" - 1
      FROM "migration_20261018190000_wallet_versions" AS adjusted
      WHERE wallet."id" = adjusted."wallet_id";
    `);
    this.addSql(`DROP TABLE "migration_20261018190000_wallet_versions";`);
    this.addSql(`
      CREATE TRIGGER wallets_version_transition
      BEFORE UPDATE ON "wallets"
      FOR EACH ROW EXECUTE FUNCTION enforce_wallet_version_transition();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency
      AFTER INSERT OR UPDATE ON "wallets"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_consistency();
    `);
  }
}
