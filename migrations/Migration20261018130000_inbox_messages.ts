import { Migration } from "@mikro-orm/migrations";

export class Migration20261018130000_inbox_messages extends Migration {
  override name = "Migration20261018130000_inbox_messages";

  override up(): void {
    this.addSql(`
      CREATE TABLE "inbox_messages" (
        "id" uuid NOT NULL,
        "message_id" varchar(256) NOT NULL,
        "event_type" varchar(128) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'PROCESSING',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "processed_at" timestamptz NULL,
        "last_error" text NULL,
        CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "inbox_messages_message_id_unique" UNIQUE ("message_id"),
        CONSTRAINT "inbox_messages_status_check"
          CHECK ("status" IN ('PROCESSING', 'PROCESSED')),
        CONSTRAINT "inbox_messages_processed_at_check"
          CHECK (
            ("status" = 'PROCESSED' AND "processed_at" IS NOT NULL)
            OR
            ("status" = 'PROCESSING' AND "processed_at" IS NULL)
          )
      );
    `);
  }

  override down(): void {
    this.addSql('DROP TABLE IF EXISTS "inbox_messages";');
  }
}
