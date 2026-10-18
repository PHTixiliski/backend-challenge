import { randomUUID } from "node:crypto";
import {
  Entity,
  PrimaryKey,
  Property,
  Index,
} from "@mikro-orm/decorators/legacy";

export enum OutboxMessageStatus {
  PENDING = "PENDING",
  PUBLISHED = "PUBLISHED",
}

@Entity({ tableName: "outbox_messages" })
@Index({
  name: "outbox_messages_status_available_at_idx",
  properties: ["status", "availableAt"],
})
export class OutboxMessageEntity {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({
    fieldName: "event_type",
    type: "string",
    length: 128,
  })
  eventType!: string;

  @Property({
    fieldName: "aggregate_id",
    type: "uuid",
  })
  aggregateId!: string;

  @Property({
    type: "json",
  })
  payload!: Record<string, unknown>;

  @Property({
    type: "string",
    length: 16,
  })
  status: OutboxMessageStatus = OutboxMessageStatus.PENDING;

  @Property({
    type: "integer",
  })
  attempts = 0;

  @Property({
    fieldName: "available_at",
    type: "datetime",
  })
  availableAt: Date = new Date();

  @Property({
    fieldName: "published_at",
    type: "datetime",
    nullable: true,
  })
  publishedAt: Date | null = null;

  @Property({
    fieldName: "last_error",
    type: "text",
    nullable: true,
  })
  lastError: string | null = null;

  @Property({
    fieldName: "created_at",
    type: "datetime",
  })
  createdAt: Date = new Date();

  @Property({ fieldName: "lock_token", type: "uuid", nullable: true })
  lockToken: string | null = null;

  @Property({
    fieldName: "locked_until",
    type: "datetime",
    nullable: true,
  })
  lockedUntil: Date | null = null;
}
