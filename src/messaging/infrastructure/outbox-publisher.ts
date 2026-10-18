import { Injectable, Logger, Optional } from "@nestjs/common";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { OutboxPublisherRepository } from "./outbox-publisher.repository";
import { integrationEventFromOutbox } from "../domain/integration-event";
import { MetricsRegistry } from "../../observability/metrics.registry";

@Injectable()
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly repository: OutboxPublisherRepository,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  async publishBatch(
    queueUrl: string,
    batchSize = 10,
    messageIds?: readonly string[],
  ): Promise<{ published: number; failed: number }> {
    if (!queueUrl.trim()) {
      throw new Error("SQS_QUEUE_URL is required.");
    }

    const messages = await this.repository.claimBatch(batchSize, 60, messageIds);
    let published = 0;
    let failed = 0;

    for (const message of messages) {
      try {
        if (message.created_at) {
          this.metrics?.observe("outbox_lag_ms", Date.now() - new Date(message.created_at).getTime());
        }
        const payload = message.payload;
        const event = integrationEventFromOutbox({
          eventId: message.id,
          eventType: message.event_type,
          aggregateId: message.aggregate_id,
          correlationId: String(payload.correlationId ?? payload.transactionId ?? message.id),
          ...(typeof payload.causationId === "string" ? { causationId: payload.causationId } : {}),
          occurredAt: message.created_at ? new Date(message.created_at) : new Date(),
          data: payload,
        });
        const isFifoQueue = queueUrl.endsWith(".fifo");
        await this.sqsClient.send(
          new SendMessageCommand({
            QueueUrl: queueUrl,
            MessageBody: JSON.stringify(event.toJSON()),
            ...(isFifoQueue
              ? {
                  MessageGroupId: message.aggregate_id,
                  MessageDeduplicationId: message.id,
                }
              : {}),
          }),
        );

        const marked = await this.repository.markPublished(
          message.id,
          message.lock_token,
        );

        if (marked) {
          published++;
          this.metrics?.increment("outbox_published_total", { eventType: event.eventType });
        } else {
          this.logger.warn(
            `Message ${message.id} was sent, but its outbox reservation was lost.`,
          );
          failed++;
        }
      } catch (error: unknown) {
        const reason =
          error instanceof Error ? error.message : "Unknown publishing error";

        try {
          const scheduled = await this.repository.scheduleRetry(
            message.id,
            message.lock_token,
            reason,
          );

          if (!scheduled) {
            this.logger.warn(
              `Could not schedule retry for message ${message.id}: reservation lost.`,
            );
          }
        } catch {
          this.logger.error(
            `Could not schedule retry for message ${message.id}. Its reservation will expire.`,
          );
        }

        this.logger.warn(`Failed to publish outbox message ${message.id}.`);
        this.metrics?.increment("outbox_publish_retries_total");
        failed++;
      }
    }

    return { published, failed };
  }
}
