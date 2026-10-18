import { Migration } from "@mikro-orm/migrations";

export class Migration20261018100425_wallet_version_default_zero extends Migration {
  override up(): void {
    this.addSql('ALTER TABLE "wallets" ALTER COLUMN "version" SET DEFAULT 0;');
  }

  override down(): void {
    // The initial schema already defines version with DEFAULT 0.
    this.addSql('ALTER TABLE "wallets" ALTER COLUMN "version" SET DEFAULT 0;');
  }
}
