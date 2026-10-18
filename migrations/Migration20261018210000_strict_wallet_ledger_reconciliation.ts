import { Migration } from "@mikro-orm/migrations";

export class Migration20261018210000_strict_wallet_ledger_reconciliation extends Migration {
  override name = "Migration20261018210000_strict_wallet_ledger_reconciliation";

  override up(): void {
    this.addSql(`
      CREATE OR REPLACE FUNCTION assert_wallet_ledger_consistency()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      DECLARE
        target_wallet_id uuid;
        stored_balance numeric(20,2);
        stored_currency varchar(3);
        ledger_balance numeric(20,2);
        currencies_match boolean;
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

        SELECT
          COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END), 0),
          COALESCE(BOOL_AND(currency = stored_currency), TRUE)
        INTO ledger_balance, currencies_match
        FROM wallet_ledger_entries
        WHERE wallet_id = target_wallet_id;

        IF stored_balance <> ledger_balance OR NOT currencies_match THEN
          RAISE EXCEPTION 'Wallet balance does not match its immutable ledger'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $function$;
    `);
  }

  override down(): void {
    this.addSql(`
      CREATE OR REPLACE FUNCTION assert_wallet_ledger_consistency()
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
    `);
  }
}
