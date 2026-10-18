import { Migration } from "@mikro-orm/migrations";

export class Migration20261018200000_wallet_version_minimum_one extends Migration {
  override name = "Migration20261018200000_wallet_version_minimum_one";

  override up(): void {
    this.addSql(`
      ALTER TABLE "wallets"
      ADD CONSTRAINT "wallets_version_minimum_one_check"
      CHECK ("version" >= 1);
    `);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE "wallets"
      DROP CONSTRAINT "wallets_version_minimum_one_check";
    `);
  }
}
