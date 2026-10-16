import { randomUUID } from "node:crypto";
import {
  Entity,
  PrimaryKey,
  Property,
  Index,
  Unique,
} from "@mikro-orm/decorators/legacy";

import {
  WagerTransactionStatus,
  WagerTransactionType,
} from "../domain/wager-transaction.types";

@Entity({ tableName: "wager_transactions" })
@Unique({
  name: "wager_transactions_provider_external_id_unique",
  properties: ["providerId", "externalTransactionId"],
})
@Index({
  name: "wager_transactions_player_created_idx",
  properties: ["playerId", "createdAt"],
})
@Index({
  name: "wager_transactions_wallet_created_idx",
  properties: ["walletId", "createdAt"],
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({
    fieldName: "provider_id",
    type: "string",
    length: 128,
  })
  providerId!: string;

  @Property({
    fieldName: "external_transaction_id",
    type: "string",
    length: 255,
  })
  externalTransactionId!: string;

  @Property({
    fieldName: "idempotency_key",
    type: "string",
    length: 255,
  })
  idempotencyKey!: string;

  @Property({
    fieldName: "payload_hash",
    type: "string",
    length: 64,
  })
  payloadHash!: string;

  @Property({
    fieldName: "wallet_id",
    type: "uuid",
  })
  walletId!: string;

  @Property({
    fieldName: "player_id",
    type: "string",
    length: 128,
  })
  playerId!: string;

  @Property({
    fieldName: "round_id",
    type: "string",
    length: 128,
  })
  roundId!: string;

  @Property({
    fieldName: "game_id",
    type: "string",
    length: 128,
  })
  gameId!: string;

  @Property({ type: "string", length: 16 })
  type!: WagerTransactionType;

  @Property({ type: "string", length: 3 })
  currency!: string;

  @Property({
    type: "decimal",
    columnType: "numeric(20,2)",
  })
  amount!: string;

  @Property({ type: "string", length: 32 })
  status: WagerTransactionStatus = WagerTransactionStatus.PENDING;

  @Property({
    fieldName: "reference_external_transaction_id",
    type: "string",
    length: 255,
    nullable: true,
  })
  referenceExternalTransactionId: string | null = null;

  @Property({
    fieldName: "reference_transaction_id",
    type: "uuid",
    nullable: true,
  })
  referenceTransactionId: string | null = null;

  @Property({
    fieldName: "failure_code",
    type: "string",
    length: 64,
    nullable: true,
  })
  failureCode: string | null = null;

  @Property({
    fieldName: "processed_at",
    type: "datetime",
    nullable: true,
  })
  processedAt: Date | null = null;

  @Property({ fieldName: "created_at", type: "datetime" })
  createdAt: Date = new Date();

  @Property({
    fieldName: "updated_at",
    type: "datetime",
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
