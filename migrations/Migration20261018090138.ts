import { Migration } from "@mikro-orm/migrations";

export class Migration20261018090138 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "outbox_messages"
      ADD COLUMN "lock_token" uuid NULL,
      ADD COLUMN "locked_until" timestamptz NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "outbox_messages"
      DROP COLUMN "locked_until",
      DROP COLUMN "lock_token";
    `);
  }
}
