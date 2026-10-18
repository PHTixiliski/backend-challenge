import { Migration } from '@mikro-orm/migrations';

export class Migration20261016001233_InitialSchema extends Migration {

  override name = 'Migration20261016001233_InitialSchema';

  override up(): void | Promise<void> {
    this.addSql(`create table "idempotency_records" ("id" uuid not null, "scope" varchar(128) not null, "key" varchar(255) not null, "payload_hash" varchar(64) not null, "response" jsonb not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "idempotency_records" add constraint "idempotency_scope_key_unique" unique ("scope", "key");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(128) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" varchar(128) not null, "round_id" varchar(128) not null, "game_id" varchar(128) not null, "type" varchar(16) not null, "currency" varchar(3) not null, "amount" numeric(20,2) not null, "status" varchar(32) not null default 'PENDING', "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "failure_code" varchar(64) null, "processed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wager_transactions_wallet_created_idx" on "wager_transactions" ("wallet_id", "created_at");`);
    this.addSql(`create index "wager_transactions_player_created_idx" on "wager_transactions" ("player_id", "created_at");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_provider_external_id_unique" unique ("provider_id", "external_transaction_id");`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" varchar(128) not null, "currency" varchar(3) not null, "balance" numeric(20,2) not null default '0.00', "version" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallet_player_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "type" varchar(6) not null, "currency" varchar(3) not null, "amount" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_transaction_unique" unique ("transaction_id");`);
  }

  override down(): void {
    this.addSql(`drop table if exists "wallet_ledger_entries";`);
    this.addSql(`drop table if exists "wager_transactions";`);
    this.addSql(`drop table if exists "wallets";`);
    this.addSql(`drop table if exists "idempotency_records";`);
  }

}
