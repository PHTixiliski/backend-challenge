import { randomUUID } from "node:crypto";
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "wallets" })
@Unique({
  name: "wallet_player_currency_unique",
  properties: ["playerId", "currency"],
})
export class WalletEntity {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({ fieldName: "player_id", type: "string", length: 128 })
  playerId!: string;

  @Property({ type: "string", length: 3 })
  currency!: string;

  @Property({
    type: "decimal",
    columnType: "numeric(20,2)",
    default: "0.00",
  })
  balance: string = "0.00";

  @Property({ type: "integer", default: 1 })
  version = 1;

  @Property({ fieldName: "created_at", type: "datetime" })
  createdAt: Date = new Date();

  @Property({
    fieldName: "updated_at",
    type: "datetime",
    onUpdate: () => new Date(),
  })
  updatedAt: Date = new Date();
}
