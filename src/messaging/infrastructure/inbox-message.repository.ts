import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";

export interface ReserveInboxMessageInput {
  consumerName: string;
  messageId: string;
  eventType: string;
}

@Injectable()
export class InboxMessageRepository {
  async reserve(
    input: ReserveInboxMessageInput,
    em: EntityManager,
  ): Promise<boolean> {
    const rows = await em.execute<Array<{ message_id: string }>>(
      `
        INSERT INTO inbox_messages (
          id,
          consumer_name,
          message_id,
          event_type,
          status,
          created_at
        )
        VALUES (gen_random_uuid(), ?, ?, ?, 'PROCESSING', NOW())
        ON CONFLICT (consumer_name, message_id) DO NOTHING
        RETURNING message_id
      `,
      [input.consumerName, input.messageId, input.eventType],
    );

    return rows.length === 1;
  }

  async markProcessed(
    consumerName: string,
    messageId: string,
    em: EntityManager,
  ): Promise<void> {
    const rows = await em.execute<Array<{ message_id: string }>>(
      `
        UPDATE inbox_messages
        SET status = 'PROCESSED',
            processed_at = NOW(),
            last_error = NULL
        WHERE consumer_name = ?
          AND message_id = ?
          AND status = 'PROCESSING'
        RETURNING message_id
      `,
      [consumerName, messageId],
    );

    if (rows.length !== 1) {
      throw new Error(
        `Could not mark inbox message "${messageId}" ` +
          `for consumer "${consumerName}" as processed.`,
      );
    }
  }
}
