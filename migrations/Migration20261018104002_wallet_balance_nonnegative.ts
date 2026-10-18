import { Migration } from "@mikro-orm/migrations";

export class Migration20261018104002_wallet_balance_nonnegative extends Migration {
  override name = "Migration20261018104002_wallet_balance_nonnegative";

  override up(): void {
    this.addSql(`
    ALTER TABLE "wallets"
    ADD CONSTRAINT "wallets_balance_nonnegative_check"
    CHECK ("balance" >= 0);
  `);
  }

  override down(): void {
    this.addSql(`
    ALTER TABLE "wallets"
    DROP CONSTRAINT "wallets_balance_nonnegative_check";
  `);
  }
}
