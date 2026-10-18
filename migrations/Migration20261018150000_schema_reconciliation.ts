import { Migration } from "@mikro-orm/migrations";

export class Migration20261018150000_schema_reconciliation extends Migration {
  override name = "Migration20261018150000_schema_reconciliation";

  override up(): void {
    this.addSql(`
      CREATE TABLE "migration_20261018150000_ownership" (
        "object_name" varchar(128) PRIMARY KEY
      );
    `);

    // Add balance_before only when missing. Track ownership so down()
    // never drops a column that existed before this migration.
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'wallet_ledger_entries'
            AND column_name = 'balance_before'
        ) THEN
          ALTER TABLE "wallet_ledger_entries"
            ADD COLUMN "balance_before" numeric(20,2);

          INSERT INTO "migration_20261018150000_ownership"
            ("object_name")
          VALUES ('column:balance_before');
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'wallet_ledger_entries'
            AND column_name = 'balance_before'
            AND data_type = 'numeric'
            AND numeric_precision = 20
            AND numeric_scale = 2
        ) THEN
          RAISE EXCEPTION
            'wallet_ledger_entries.balance_before must be numeric(20,2)';
        END IF;

        IF EXISTS (
          SELECT 1
          FROM wallet_ledger_entries
          WHERE balance_before IS NULL
            AND type NOT IN ('CREDIT', 'DEBIT')
        ) THEN
          RAISE EXCEPTION
            'Cannot backfill balance_before: unknown ledger entry type';
        END IF;

        UPDATE wallet_ledger_entries
        SET balance_before = CASE
          WHEN type = 'CREDIT' THEN balance_after - amount
          WHEN type = 'DEBIT' THEN balance_after + amount
        END
        WHERE balance_before IS NULL;

        IF EXISTS (
          SELECT 1
          FROM wallet_ledger_entries
          WHERE balance_before IS NULL OR balance_before < 0
        ) THEN
          RAISE EXCEPTION
            'Cannot reconcile balance_before: NULL or negative balance found';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM migration_20261018150000_ownership
          WHERE object_name = 'column:balance_before'
        ) AND EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'wallet_ledger_entries'
            AND column_name = 'balance_before'
            AND is_nullable = 'YES'
        ) THEN
          INSERT INTO migration_20261018150000_ownership
            (object_name)
          VALUES ('column:balance_before_not_null');
        END IF;

        ALTER TABLE wallet_ledger_entries
          ALTER COLUMN balance_before SET NOT NULL;
      END $$;
    `);

    // Create each FK only when absent. Existing constraints are validated
    // against the expected definition and are not claimed by this migration.
    this.addSql(`
      DO $$
      DECLARE
        actual_definition text;
      BEGIN
        SELECT pg_get_constraintdef(oid)
        INTO actual_definition
        FROM pg_constraint
        WHERE conname = 'wager_transactions_wallet_fk'
          AND conrelid = 'wager_transactions'::regclass;

        IF actual_definition IS NULL THEN
          ALTER TABLE wager_transactions
            ADD CONSTRAINT wager_transactions_wallet_fk
            FOREIGN KEY (wallet_id) REFERENCES wallets(id)
            ON DELETE RESTRICT;

          INSERT INTO migration_20261018150000_ownership
            VALUES ('fk:wager_transactions_wallet_fk');
        ELSIF actual_definition <>
          'FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT'
        THEN
          RAISE EXCEPTION 'Unexpected definition for wager_transactions_wallet_fk';
        END IF;

        actual_definition := NULL;
        SELECT pg_get_constraintdef(oid)
        INTO actual_definition
        FROM pg_constraint
        WHERE conname = 'wager_transactions_reference_fk'
          AND conrelid = 'wager_transactions'::regclass;

        IF actual_definition IS NULL THEN
          ALTER TABLE wager_transactions
            ADD CONSTRAINT wager_transactions_reference_fk
            FOREIGN KEY (reference_transaction_id)
            REFERENCES wager_transactions(id)
            ON DELETE RESTRICT;

          INSERT INTO migration_20261018150000_ownership
            VALUES ('fk:wager_transactions_reference_fk');
        ELSIF actual_definition <>
          'FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions(id) ON DELETE RESTRICT'
        THEN
          RAISE EXCEPTION 'Unexpected definition for wager_transactions_reference_fk';
        END IF;

        actual_definition := NULL;
        SELECT pg_get_constraintdef(oid)
        INTO actual_definition
        FROM pg_constraint
        WHERE conname = 'wallet_ledger_wallet_fk'
          AND conrelid = 'wallet_ledger_entries'::regclass;

        IF actual_definition IS NULL THEN
          ALTER TABLE wallet_ledger_entries
            ADD CONSTRAINT wallet_ledger_wallet_fk
            FOREIGN KEY (wallet_id) REFERENCES wallets(id)
            ON DELETE RESTRICT;

          INSERT INTO migration_20261018150000_ownership
            VALUES ('fk:wallet_ledger_wallet_fk');
        ELSIF actual_definition <>
          'FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE RESTRICT'
        THEN
          RAISE EXCEPTION 'Unexpected definition for wallet_ledger_wallet_fk';
        END IF;

        actual_definition := NULL;
        SELECT pg_get_constraintdef(oid)
        INTO actual_definition
        FROM pg_constraint
        WHERE conname = 'wallet_ledger_transaction_fk'
          AND conrelid = 'wallet_ledger_entries'::regclass;

        IF actual_definition IS NULL THEN
          ALTER TABLE wallet_ledger_entries
            ADD CONSTRAINT wallet_ledger_transaction_fk
            FOREIGN KEY (transaction_id) REFERENCES wager_transactions(id)
            ON DELETE RESTRICT;

          INSERT INTO migration_20261018150000_ownership
            VALUES ('fk:wallet_ledger_transaction_fk');
        ELSIF actual_definition <>
          'FOREIGN KEY (transaction_id) REFERENCES wager_transactions(id) ON DELETE RESTRICT'
        THEN
          RAISE EXCEPTION 'Unexpected definition for wallet_ledger_transaction_fk';
        END IF;
      END $$;
    `);
  }

  override down(): void {
    // Drop only the FKs created by this migration.
    this.addSql(`
      DO $$
      BEGIN
        IF to_regclass('public.migration_20261018150000_ownership') IS NULL THEN
          RETURN;
        END IF;

        IF EXISTS (
          SELECT 1 FROM migration_20261018150000_ownership
          WHERE object_name = 'fk:wager_transactions_reference_fk'
        ) THEN
          ALTER TABLE wager_transactions
            DROP CONSTRAINT IF EXISTS wager_transactions_reference_fk;
        END IF;

        IF EXISTS (
          SELECT 1 FROM migration_20261018150000_ownership
          WHERE object_name = 'fk:wager_transactions_wallet_fk'
        ) THEN
          ALTER TABLE wager_transactions
            DROP CONSTRAINT IF EXISTS wager_transactions_wallet_fk;
        END IF;

        IF EXISTS (
          SELECT 1 FROM migration_20261018150000_ownership
          WHERE object_name = 'fk:wallet_ledger_transaction_fk'
        ) THEN
          ALTER TABLE wallet_ledger_entries
            DROP CONSTRAINT IF EXISTS wallet_ledger_transaction_fk;
        END IF;

        IF EXISTS (
          SELECT 1 FROM migration_20261018150000_ownership
          WHERE object_name = 'fk:wallet_ledger_wallet_fk'
        ) THEN
          ALTER TABLE wallet_ledger_entries
            DROP CONSTRAINT IF EXISTS wallet_ledger_wallet_fk;
        END IF;

        IF EXISTS (
          SELECT 1 FROM migration_20261018150000_ownership
          WHERE object_name = 'column:balance_before'
        ) THEN
          ALTER TABLE wallet_ledger_entries
            DROP COLUMN IF EXISTS balance_before;
        ELSIF EXISTS (
          SELECT 1 FROM migration_20261018150000_ownership
          WHERE object_name = 'column:balance_before_not_null'
        ) THEN
          ALTER TABLE wallet_ledger_entries
            ALTER COLUMN balance_before DROP NOT NULL;
        END IF;

        DROP TABLE migration_20261018150000_ownership;
      END $$;
    `);
  }
}
