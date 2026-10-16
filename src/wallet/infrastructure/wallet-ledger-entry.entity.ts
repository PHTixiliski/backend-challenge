import { randomUUID } from "node:crypto";
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
  Index,
} from "@mikro-orm/decorators/legacy";

import type { WalletLedgerEntryType } from "../domain/wallet-ledger-entry";

@Entity({ tableName: "wallet_ledger_entries" })
@Unique({
  name: "wallet_ledger_transaction_unique",
  properties: ["transactionId"],
})
@Index({
  name: "wallet_ledger_wallet_created_idx",
  properties: ["walletId", "createdAt"],
})
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ fieldName: "wallet_id", type: "uuid" })
  walletId!: string;

  @Property({
    fieldName: "transaction_id",
    type: "uuid",
  })
  transactionId!: string;

  @Property({ type: "string", length: 6 })
  type!: WalletLedgerEntryType;

  @Property({ type: "string", length: 3 })
  currency!: string;

  @Property({
    type: "decimal",
    columnType: "numeric(20,2)",
  })
  amount!: string;

  @Property({
    fieldName: "balance_before",
    type: "decimal",
    columnType: "numeric(20,2)",
  })
  balanceBefore!: string;

  @Property({
    fieldName: "balance_after",
    type: "decimal",
    columnType: "numeric(20,2)",
  })
  balanceAfter!: string;

  @Property({ fieldName: "created_at", type: "datetime" })
  createdAt: Date = new Date();
}
