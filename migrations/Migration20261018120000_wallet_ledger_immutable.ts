import { Migration } from "@mikro-orm/migrations";

export class Migration20261018120000_wallet_ledger_immutable extends Migration {
  override name = "Migration20261018120000_wallet_ledger_immutable";

  override up(): void {
    this.addSql(`CREATE FUNCTION prevent_wallet_ledger_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        RAISE EXCEPTION 'Wallet ledger entries are immutable';
      END;
      $function$;
   `);

    this.addSql(`
  CREATE TRIGGER wallet_ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_wallet_ledger_mutation();
`);

    this.addSql(`
  CREATE TRIGGER wallet_ledger_entries_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT
  EXECUTE FUNCTION prevent_wallet_ledger_mutation();
`);
  }

  override down(): void {
    this.addSql(`DROP TRIGGER IF EXISTS wallet_ledger_entries_no_truncate
      ON wallet_ledger_entries;
   `);

    this.addSql(`
  DROP TRIGGER IF EXISTS wallet_ledger_entries_immutable
  ON wallet_ledger_entries;
`);

    this.addSql(`
  DROP FUNCTION IF EXISTS prevent_wallet_ledger_mutation();
`);
  }
}
