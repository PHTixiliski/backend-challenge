import { Migration } from "@mikro-orm/migrations";

export class Migration20261018083333 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE "outbox_messages" (
        "id" uuid NOT NULL,
        "event_type" varchar(128) NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "payload" jsonb NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'PENDING',
        "attempts" integer NOT NULL DEFAULT 0,
        "available_at" timestamptz NOT NULL,
        "published_at" timestamptz NULL,
        "last_error" text NULL,
        "created_at" timestamptz NOT NULL,
        PRIMARY KEY ("id")
      );
    `);

    this.addSql(`
      CREATE INDEX "outbox_messages_status_available_at_idx"
      ON "outbox_messages" ("status", "available_at");
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS "outbox_messages";');
  }
}
