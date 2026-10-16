import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from "@mikro-orm/decorators/legacy";

@Entity({ tableName: "idempotency_records" })
@Unique({
  name: "idempotency_scope_key_unique",
  properties: ["scope", "key"],
})
export class IdempotencyRecordEntity {
  @PrimaryKey({ type: "uuid" })
  id!: string;

  @Property({ type: "string", length: 128 })
  scope!: string;

  @Property({ type: "string", length: 255 })
  key!: string;

  @Property({ fieldName: "payload_hash", type: "string", length: 64 })
  payloadHash!: string;

  @Property({ type: "json", columnType: "jsonb" })
  response!: Record<string, unknown>;

  @Property({ fieldName: "created_at", type: "datetime" })
  createdAt: Date = new Date();
}
