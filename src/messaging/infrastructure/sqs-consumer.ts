import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { DomainError } from "../../shared/domain/domain-error";
import { PostgresTransactionManager } from "../../shared/infrastructure/postgres-transaction-manager";
import { ProcessBetUseCase } from "../../wager/application/process-bet.use-case";
import { WagerTransactionStatus, WagerTransactionType } from "../../wager/domain/wager-transaction.types";
import { InboxMessageRepository } from "./inbox-message.repository";
import { parseWagerTransactionMessage } from "../application/parse-wager-transaction-message";
import { MetricsRegistry } from "../../observability/metrics.registry";

@Injectable()
export class SqsConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumer.name);
  private readonly queueUrl = process.env.SQS_QUEUE_URL;
  private readonly dlqQueueUrl = process.env.SQS_DLQ_QUEUE_URL;
  private readonly consumerName =
    process.env.SQS_CONSUMER_NAME ?? "wager-transaction-consumer";
  private readonly visibilityTimeout = Number(
    process.env.SQS_VISIBILITY_TIMEOUT ?? 60,
  );
  private readonly retryBaseDelaySeconds = Number(
    process.env.SQS_RETRY_BASE_DELAY_SECONDS ?? 1,
  );
  private readonly retryMaxDelaySeconds = Number(
    process.env.SQS_RETRY_MAX_DELAY_SECONDS ?? 300,
  );

  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private polling = false;

  constructor(
    @Inject(SQSClient)
    private readonly sqsClient: SQSClient,
    private readonly transactionManager: PostgresTransactionManager,
    private readonly inboxRepository: InboxMessageRepository,
    private readonly processBetUseCase: ProcessBetUseCase,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  onModuleInit(): void {
    if (!this.queueUrl?.trim()) {
      throw new Error("SQS_QUEUE_URL is required to start the SQS consumer.");
    }
    if (this.dlqQueueUrl && this.dlqQueueUrl === this.queueUrl) {
      throw new Error("SQS_DLQ_QUEUE_URL must be different from SQS_QUEUE_URL.");
    }

    if (
      !Number.isInteger(this.visibilityTimeout) ||
      this.visibilityTimeout < 1 ||
      this.visibilityTimeout > 43_200
    ) {
      throw new Error("SQS_VISIBILITY_TIMEOUT must be an integer between 1 and 43200.");
    }
    if (
      !Number.isInteger(this.retryBaseDelaySeconds) ||
      this.retryBaseDelaySeconds < 1 ||
      !Number.isInteger(this.retryMaxDelaySeconds) ||
      this.retryMaxDelaySeconds < this.retryBaseDelaySeconds ||
      this.retryMaxDelaySeconds > 43_200
    ) {
      throw new Error("SQS retry delay settings must be integers between 1 and 43200, with max >= base.");
    }
    const maxReceiveCount = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5);
    if (!Number.isSafeInteger(maxReceiveCount) || maxReceiveCount < 1) {
      throw new Error("SQS_MAX_RECEIVE_COUNT must be a positive integer.");
    }

    this.stopping = false;
    this.schedulePoll(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopping) return;

    this.timer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopping || this.polling) return;

    this.polling = true;

    try {
      const response = await this.sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 10,
          VisibilityTimeout: this.visibilityTimeout,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
        }),
      );

      for (const message of response.Messages ?? []) {
        // Finish messages already received, even during graceful shutdown.
        await this.handleMessage(message);
      }
    } catch (error: unknown) {
      this.logger.error(
        "Failed while polling SQS.",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.polling = false;
      this.schedulePoll(this.stopping ? 0 : 250);
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle || !message.Body) {
      this.logger.error(
        `Received SQS message without a body or receipt handle: ${message.MessageId ?? "unknown"}`,
      );
      return;
    }

    const heartbeat = setInterval(() => {
      void this.sqsClient.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: this.visibilityTimeout,
      })).catch(() => {
        this.logger.warn(JSON.stringify({
          event: "sqs_visibility_heartbeat_failed",
          messageId: message.MessageId ?? "unknown",
        }));
      });
    }, Math.max(1000, Math.floor(this.visibilityTimeout * 500)));
    heartbeat.unref?.();

    try {
      const event = parseWagerTransactionMessage(message.Body);
      const sqsMessageId = message.MessageId;

      if (!sqsMessageId) {
        throw new DomainError(
          "INVALID_SQS_MESSAGE",
          "SQS message does not contain MessageId.",
        );
      }

      let processingContext: Record<string, string> | undefined;
      await this.transactionManager.execute(async (em) => {
        const reserved = await this.inboxRepository.reserve(
          {
            consumerName: this.consumerName,
            messageId: sqsMessageId,
            eventType: event.type,
          },
          em,
        );

        if (!reserved) {
          // The message was already committed by this consumer.
          return;
        }

        const result = await this.processBetUseCase.execute(
          {
            providerId: event.data.providerId,
            externalTransactionId: event.data.externalTransactionId,
            playerId: event.data.playerId,
            walletId: event.data.walletId,
            roundId: event.data.roundId,
            gameId: event.data.gameId,
            currency: event.data.money.currency,
            amount: event.data.money.amount,
            kind: event.data.kind as WagerTransactionType,
            referenceExternalTransactionId: event.data.referenceExternalTransactionId,
            idempotencyKey: event.data.idempotencyKey,
          },
          em,
        );
        processingContext = {
          correlationId: event.messageId,
          messageId: sqsMessageId,
          transactionId: result.transactionId,
          walletId: event.data.walletId,
          providerId: event.data.providerId,
          status: result.status,
        };

        if (
          result.status !== WagerTransactionStatus.PROCESSED &&
          result.status !== WagerTransactionStatus.REJECTED &&
          result.status !== WagerTransactionStatus.FAILED
          && result.status !== WagerTransactionStatus.PENDING_REFERENCE
        ) {
          throw new Error(
            `Unexpected terminal status "${result.status}" for SQS message.`,
          );
        }

        await this.inboxRepository.markProcessed(
          this.consumerName,
          sqsMessageId,
          em,
        );
      });

      if (processingContext) {
        this.logger.log(JSON.stringify({ event: "wager_message_processed", ...processingContext }));
      }

      // Delete only after the database transaction has committed.
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error: unknown) {
      const receiveCount =
        message.Attributes?.ApproximateReceiveCount ?? "unknown";
      const attempts = Number(receiveCount);
      const maxReceiveCount = Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5);
      const permanent = error instanceof DomainError;
      const attemptsExhausted = Number.isFinite(attempts) && attempts >= maxReceiveCount;
      if (permanent || attemptsExhausted) {
        const deadLettered = await this.moveToDeadLetter(message, error);
        if (deadLettered) {
          this.metrics?.increment("sqs_messages_dlq_total");
          return;
        }
      } else {
        this.metrics?.increment("sqs_message_retries_total");
        await this.scheduleRetry(message, attempts);
      }

      this.logger.warn(JSON.stringify({
        event: permanent || attemptsExhausted ? "sqs_message_dead_letter_pending_redrive" : "sqs_message_retry_scheduled",
        correlationId: message.MessageId ?? "unknown",
        messageId: message.MessageId ?? "unknown",
        receiveCount,
        errorCode: error instanceof DomainError ? error.code : "TRANSIENT_PROCESSING_ERROR",
      }));

      // Do not delete on failure. SQS will redeliver after visibility timeout
      // and eventually route messages to the configured DLQ.
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async scheduleRetry(message: Message, attempts: number): Promise<void> {
    if (!message.ReceiptHandle) return;
    const exponent = Math.max(0, Math.min(30, (Number.isFinite(attempts) ? attempts : 1) - 1));
    const visibilityTimeout = Math.min(
      this.retryMaxDelaySeconds,
      this.retryBaseDelaySeconds * 2 ** exponent,
    );
    try {
      await this.sqsClient.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: visibilityTimeout,
      }));
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({
        event: "sqs_retry_backoff_failed",
        messageId: message.MessageId ?? "unknown",
        errorCode: error instanceof Error ? error.name : "UNKNOWN",
      }));
    }
  }

  private async moveToDeadLetter(message: Message, error: unknown): Promise<boolean> {
    if (!this.dlqQueueUrl || !message.ReceiptHandle || !message.Body) return false;
    const messageId = message.MessageId ?? "unknown";
    try {
      const fifo = this.dlqQueueUrl.endsWith(".fifo");
      await this.sqsClient.send(new SendMessageCommand({
        QueueUrl: this.dlqQueueUrl,
        MessageBody: JSON.stringify({
          sourceMessageId: messageId,
          failureCode: error instanceof DomainError ? error.code : "MAX_RECEIVE_COUNT_EXCEEDED",
          failedAt: new Date().toISOString(),
          originalBody: message.Body,
        }),
        ...(fifo ? { MessageGroupId: messageId, MessageDeduplicationId: messageId } : {}),
      }));
      await this.sqsClient.send(new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }));
      return true;
    } catch (dlqError: unknown) {
      this.logger.error(JSON.stringify({
        event: "sqs_dead_letter_publish_failed",
        messageId,
        errorCode: dlqError instanceof Error ? dlqError.name : "UNKNOWN",
      }));
      return false;
    }
  }
}
