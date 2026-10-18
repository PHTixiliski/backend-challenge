import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";

import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from "./outbox-message.entity";

export interface EnqueueOutboxMessageInput {
  id?: string;
  eventType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class TransactionalOutboxRepository {
  async enqueue(
    em: EntityManager,
    input: EnqueueOutboxMessageInput,
  ): Promise<void> {
    const message = em.create(OutboxMessageEntity, {
      ...(input.id ? { id: input.id } : {}),
      eventType: input.eventType,
      aggregateId: input.aggregateId,
      payload: input.payload,
      status: OutboxMessageStatus.PENDING,
      attempts: 0,
      availableAt: new Date(),
      publishedAt: null,
      lastError: null,
      createdAt: new Date(),
    });

    em.persist(message);
    await em.flush();
  }
}
