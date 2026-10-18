import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";

export interface ClaimedOutboxMessage {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  lock_token: string;
  created_at?: Date;
}

@Injectable()
export class OutboxPublisherRepository {
  constructor(private readonly em: EntityManager) {}

  async claimBatch(
    batchSize: number,
    lockDurationSeconds = 60,
    messageIds?: readonly string[],
  ): Promise<ClaimedOutboxMessage[]> {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("batchSize must be a positive integer.");
    }

    if (!Number.isInteger(lockDurationSeconds) || lockDurationSeconds < 1) {
      throw new Error("lockDurationSeconds must be a positive integer.");
    }
    if (messageIds && messageIds.length === 0) {
      return [];
    }

    const lockToken = randomUUID();
    const idFilter = messageIds
      ? `AND id IN (${messageIds.map(() => "?").join(", ")})`
      : "";
    const parameters = messageIds
      ? [...messageIds, batchSize, lockToken, lockDurationSeconds]
      : [batchSize, lockToken, lockDurationSeconds];

    return this.em.transactional(async (em) => {
      const rows = await em.getConnection().execute<ClaimedOutboxMessage[]>(
        `
          WITH picked AS (
            SELECT id
            FROM outbox_messages
            WHERE status = 'PENDING'
              AND available_at <= NOW()
              AND (
                locked_until IS NULL
                OR locked_until <= NOW()
              )
              ${idFilter}
            ORDER BY created_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ?
          )
          UPDATE outbox_messages AS message
          SET lock_token = ?,
              locked_until =
                NOW() + (? * INTERVAL '1 second')
          FROM picked
          WHERE message.id = picked.id
          RETURNING
            message.id,
            message.event_type,
            message.aggregate_id,
            message.payload,
            message.attempts,
            message.lock_token
            , message.created_at
        `,
        parameters,
      );

      return rows;
    });
  }

  async markPublished(messageId: string, lockToken: string): Promise<boolean> {
    const rows = await this.em.getConnection().execute<Array<{ id: string }>>(
      `
      UPDATE outbox_messages
      SET status = 'PUBLISHED',
          published_at = NOW(),
          lock_token = NULL,
          locked_until = NULL,
          last_error = NULL
      WHERE id = ?
        AND status = 'PENDING'
        AND lock_token = ?
      RETURNING id
    `,
      [messageId, lockToken],
    );

    return rows.length === 1;
  }

  async scheduleRetry(
    messageId: string,
    lockToken: string,
    error: string,
  ): Promise<boolean> {
    const rows = await this.em.getConnection().execute<Array<{ id: string }>>(
      `
      UPDATE outbox_messages
      SET attempts = attempts + 1,
          available_at = NOW() + (
            LEAST(
              300,
              2 * POWER(2, LEAST(attempts, 7))
            ) * INTERVAL '1 second'
          ),
          last_error = LEFT(?, 2000),
          lock_token = NULL,
          locked_until = NULL
      WHERE id = ?
        AND status = 'PENDING'
        AND lock_token = ?
      RETURNING id
    `,
      [error, messageId, lockToken],
    );

    return rows.length === 1;
  }
}
