import { Migration } from "@mikro-orm/migrations";

export class Migration20261018110000_wallet_version_default_one extends Migration {
override up(): void {
this.addSql(
'ALTER TABLE "wallets" ALTER COLUMN "version" SET DEFAULT 1;',
);
}

override down(): void {
this.addSql(
'ALTER TABLE "wallets" ALTER COLUMN "version" SET DEFAULT 0;',
);
}
}
