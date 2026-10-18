import { Migration } from "@mikro-orm/migrations";

export class Migration20261018180000_financial_schema_invariants extends Migration {
  override name = "Migration20261018180000_financial_schema_invariants";

  override up(): void {
    this.addSql(`
      ALTER TABLE "wallets"
        ADD CONSTRAINT "wallets_currency_format_check"
          CHECK ("currency" ~ '^[A-Z]{3}$');

      ALTER TABLE "wager_transactions"
        ADD CONSTRAINT "wager_transactions_amount_positive_check"
          CHECK ("amount" > 0),
        ADD CONSTRAINT "wager_transactions_currency_format_check"
          CHECK ("currency" ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT "wager_transactions_type_check"
          CHECK ("type" IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        ADD CONSTRAINT "wager_transactions_status_check"
          CHECK ("status" IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        ADD CONSTRAINT "wager_transactions_reference_required_check"
          CHECK ("type" NOT IN ('REFUND', 'ROLLBACK') OR "reference_external_transaction_id" IS NOT NULL),
        ADD CONSTRAINT "wager_transactions_reference_retry_state_check"
          CHECK (
            ("status" = 'PENDING_REFERENCE' AND "reference_external_transaction_id" IS NOT NULL AND "reference_next_attempt_at" IS NOT NULL)
            OR
            ("status" <> 'PENDING_REFERENCE' AND "reference_next_attempt_at" IS NULL)
          ),
        ADD CONSTRAINT "wager_transactions_reference_attempts_nonnegative_check"
          CHECK ("reference_attempts" >= 0);

      ALTER TABLE "wallet_ledger_entries"
        ADD CONSTRAINT "wallet_ledger_type_check"
          CHECK ("type" IN ('CREDIT', 'DEBIT')),
        ADD CONSTRAINT "wallet_ledger_currency_format_check"
          CHECK ("currency" ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT "wallet_ledger_amount_positive_check"
          CHECK ("amount" > 0),
        ADD CONSTRAINT "wallet_ledger_balances_nonnegative_check"
          CHECK ("balance_before" >= 0 AND "balance_after" >= 0),
        ADD CONSTRAINT "wallet_ledger_arithmetic_check"
          CHECK (
            ("type" = 'CREDIT' AND "balance_after" = "balance_before" + "amount")
            OR
            ("type" = 'DEBIT' AND "balance_after" = "balance_before" - "amount")
          );

      ALTER TABLE "outbox_messages"
        ADD CONSTRAINT "outbox_status_check"
          CHECK ("status" IN ('PENDING', 'PUBLISHED')),
        ADD CONSTRAINT "outbox_attempts_nonnegative_check"
          CHECK ("attempts" >= 0),
        ADD CONSTRAINT "outbox_published_at_check"
          CHECK (("status" = 'PUBLISHED' AND "published_at" IS NOT NULL) OR ("status" = 'PENDING' AND "published_at" IS NULL));
    `);

    this.addSql(`
      CREATE FUNCTION enforce_wallet_version_transition()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.balance IS DISTINCT FROM OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'Wallet version must increment exactly once when balance changes'
              USING ERRCODE = '23514';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'Wallet version may change only when balance changes'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $function$;

      CREATE TRIGGER wallets_version_transition
      BEFORE UPDATE ON "wallets"
      FOR EACH ROW EXECUTE FUNCTION enforce_wallet_version_transition();
    `);

    this.addSql(`
      CREATE FUNCTION assert_wallet_ledger_consistency()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      DECLARE
        target_wallet_id uuid;
        stored_balance numeric(20,2);
        stored_currency varchar(3);
        opening_balance numeric(20,2);
        ledger_balance numeric(20,2);
        currencies_match boolean;
        has_entries boolean;
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN
          target_wallet_id := NEW.id;
        ELSE
          target_wallet_id := NEW.wallet_id;
        END IF;

        SELECT balance, currency
        INTO stored_balance, stored_currency
        FROM wallets
        WHERE id = target_wallet_id;

        IF NOT FOUND THEN
          RETURN NULL;
        END IF;

        SELECT balance_before
        INTO opening_balance
        FROM wallet_ledger_entries
        WHERE wallet_id = target_wallet_id
        ORDER BY created_at ASC, id ASC
        LIMIT 1;
        has_entries := FOUND;

        IF NOT has_entries THEN
          -- Permit legacy/test wallet seeds on INSERT. Application-created
          -- funded wallets always include OPENING and subsequent updates must
          -- be backed by ledger entries.
          IF TG_TABLE_NAME = 'wallets' AND TG_OP = 'INSERT' THEN
            RETURN NULL;
          END IF;
          IF stored_balance = 0 THEN
            RETURN NULL;
          END IF;
          RAISE EXCEPTION 'Non-zero wallet balance requires a ledger entry'
            USING ERRCODE = '23514';
        END IF;

        SELECT
          COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END), 0),
          COALESCE(BOOL_AND(currency = stored_currency), TRUE)
        INTO ledger_balance, currencies_match
        FROM wallet_ledger_entries
        WHERE wallet_id = target_wallet_id;

        IF stored_balance <> opening_balance + ledger_balance OR NOT currencies_match THEN
          RAISE EXCEPTION 'Wallet balance does not match its immutable ledger'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $function$;

      CREATE CONSTRAINT TRIGGER wallets_ledger_consistency
      AFTER INSERT OR UPDATE ON "wallets"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_consistency();

      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency
      AFTER INSERT ON "wallet_ledger_entries"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION assert_wallet_ledger_consistency();
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TRIGGER IF EXISTS ledger_wallet_consistency ON "wallet_ledger_entries";
      DROP TRIGGER IF EXISTS wallets_ledger_consistency ON "wallets";
      DROP FUNCTION IF EXISTS assert_wallet_ledger_consistency();
      DROP TRIGGER IF EXISTS wallets_version_transition ON "wallets";
      DROP FUNCTION IF EXISTS enforce_wallet_version_transition();

      ALTER TABLE "outbox_messages"
        DROP CONSTRAINT IF EXISTS "outbox_published_at_check",
        DROP CONSTRAINT IF EXISTS "outbox_attempts_nonnegative_check",
        DROP CONSTRAINT IF EXISTS "outbox_status_check";
      ALTER TABLE "wallet_ledger_entries"
        DROP CONSTRAINT IF EXISTS "wallet_ledger_arithmetic_check",
        DROP CONSTRAINT IF EXISTS "wallet_ledger_balances_nonnegative_check",
        DROP CONSTRAINT IF EXISTS "wallet_ledger_amount_positive_check",
        DROP CONSTRAINT IF EXISTS "wallet_ledger_currency_format_check",
        DROP CONSTRAINT IF EXISTS "wallet_ledger_type_check";
      ALTER TABLE "wager_transactions"
        DROP CONSTRAINT IF EXISTS "wager_transactions_reference_attempts_nonnegative_check",
        DROP CONSTRAINT IF EXISTS "wager_transactions_reference_retry_state_check",
        DROP CONSTRAINT IF EXISTS "wager_transactions_reference_required_check",
        DROP CONSTRAINT IF EXISTS "wager_transactions_status_check",
        DROP CONSTRAINT IF EXISTS "wager_transactions_type_check",
        DROP CONSTRAINT IF EXISTS "wager_transactions_currency_format_check",
        DROP CONSTRAINT IF EXISTS "wager_transactions_amount_positive_check";
      ALTER TABLE "wallets"
        DROP CONSTRAINT IF EXISTS "wallets_currency_format_check";
    `);
  }
}
