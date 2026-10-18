import { Migration } from "@mikro-orm/migrations";

export class Migration20261018140000_inbox_consumer_name extends Migration {
  override name = "Migration20261018140000_inbox_consumer_name";

  override up(): void {
    this.addSql(`
      ALTER TABLE "inbox_messages"
      ADD COLUMN "consumer_name" varchar(128)
    `);

    this.addSql(`
      UPDATE "inbox_messages"
      SET "consumer_name" = 'legacy-consumer'
      WHERE "consumer_name" IS NULL
    `);

    this.addSql(`
      ALTER TABLE "inbox_messages"
      ALTER COLUMN "consumer_name" SET NOT NULL
    `);

    this.addSql(`
      ALTER TABLE "inbox_messages"
      DROP CONSTRAINT "inbox_messages_message_id_unique"
    `);

    this.addSql(`
      ALTER TABLE "inbox_messages"
      ADD CONSTRAINT "inbox_messages_consumer_message_unique"
      UNIQUE ("consumer_name", "message_id")
    `);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE "inbox_messages"
      DROP CONSTRAINT "inbox_messages_consumer_message_unique"
    `);

    this.addSql(`
      ALTER TABLE "inbox_messages"
      ADD CONSTRAINT "inbox_messages_message_id_unique"
      UNIQUE ("message_id")
    `);

    this.addSql(`
      ALTER TABLE "inbox_messages"
      DROP COLUMN "consumer_name"
    `);
  }
}
