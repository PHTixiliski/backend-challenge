import { randomUUID } from "node:crypto";
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from "@mikro-orm/decorators/legacy";

export enum InboxMessageStatus {
  PROCESSING = "PROCESSING",
  PROCESSED = "PROCESSED",
}

@Entity({ tableName: "inbox_messages" })
@Unique({
  name: "inbox_messages_consumer_message_unique",
  properties: ["consumerName", "messageId"],
})
export class InboxMessageEntity {
  @PrimaryKey({ type: "uuid" })
  id: string = randomUUID();

  @Property({
    fieldName: "message_id",
    type: "string",
    length: 256,
  })
  messageId!: string;

  @Property({
    fieldName: "event_type",
    type: "string",
    length: 128,
  })
  eventType!: string;

  @Property({
    type: "string",
    length: 16,
    default: "PROCESSING",
  })
  status: InboxMessageStatus = InboxMessageStatus.PROCESSING;

  @Property({
    fieldName: "created_at",
    type: "datetime",
    defaultRaw: "now()",
  })
  createdAt: Date = new Date();

  @Property({
    fieldName: "processed_at",
    type: "datetime",
    nullable: true,
  })
  processedAt: Date | null = null;

  @Property({
    fieldName: "last_error",
    type: "text",
    nullable: true,
  })
  lastError: string | null = null;

  @Property({
    fieldName: "consumer_name",
    type: "string",
    length: 128,
  })
  consumerName!: string;
}
