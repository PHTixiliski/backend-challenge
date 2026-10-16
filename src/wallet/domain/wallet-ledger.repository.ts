import { WalletLedgerEntry } from "./wallet-ledger-entry";

export const WALLET_LEDGER_REPOSITORY = Symbol("WALLET_LEDGER_REPOSITORY");

export interface WalletLedgerRepository {
  save(entry: WalletLedgerEntry): Promise<void>;
}
