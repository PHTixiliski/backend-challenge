import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { SqsConsumer } from "../../../src/messaging/infrastructure/sqs-consumer";
import { PostgresTransactionManager } from "../../../src/shared/infrastructure/postgres-transaction-manager";
import { ProcessBetUseCase } from "../../../src/wager/application/process-bet.use-case";
import { InboxMessageRepository } from "../../../src/messaging/infrastructure/inbox-message.repository";

describe("SqsConsumer", () => {
  afterEach(() => {
    mock.restore();
  });

  test("does not delete a message when processing fails", async () => {
    const originalQueueUrl = process.env.SQS_QUEUE_URL;
    const originalRetryBase = process.env.SQS_RETRY_BASE_DELAY_SECONDS;
    const originalRetryMax = process.env.SQS_RETRY_MAX_DELAY_SECONDS;
    process.env.SQS_QUEUE_URL =
      "http://localhost:4566/000000000000/wager-transactions.fifo";
    process.env.SQS_RETRY_BASE_DELAY_SECONDS = "2";
    process.env.SQS_RETRY_MAX_DELAY_SECONDS = "10";

    try {
      const sentCommands: unknown[] = [];

      const send = mock(async (command: unknown) => {
        sentCommands.push(command);
        return {};
      });

      const transactionManager = {
        execute: mock(async (operation: (em: object) => Promise<unknown>) =>
          operation({}),
        ),
      };

      const inboxRepository = {
        reserve: mock(async () => true),
        markProcessed: mock(async () => undefined),
      };

      const processBetUseCase = {
        execute: mock(async () => {
          throw new Error("Database temporarily unavailable");
        }),
      };

      const consumer = new SqsConsumer(
        { send } as unknown as SQSClient,
        transactionManager as unknown as PostgresTransactionManager,
        inboxRepository as unknown as InboxMessageRepository,
        processBetUseCase as unknown as ProcessBetUseCase,
      );

      const message: Message = {
        MessageId: "sqs-message-123",
        ReceiptHandle: "receipt-handle-123",
        Body: JSON.stringify({
          messageId: "event-123",
          type: "WagerTransactionRequested",
          occurredAt: "2026-10-18T12:00:00.000Z",
          data: {
            providerId: "provider-test",
            externalTransactionId: "transaction-test-123",
            idempotencyKey: "provider-test:transaction-test-123",
            playerId: "player-test-123",
            walletId: "00000000-0000-4000-8000-000000000001",
            roundId: "round-test-123",
            gameId: "game-test",
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          },
        }),
        Attributes: { ApproximateReceiveCount: "3" },
      };

      await (
        consumer as unknown as {
          handleMessage: (message: Message) => Promise<void>;
        }
      ).handleMessage(message);

      expect(inboxRepository.reserve).toHaveBeenCalledTimes(1);
      expect(processBetUseCase.execute).toHaveBeenCalledTimes(1);
      expect(inboxRepository.markProcessed).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      expect(sentCommands).toHaveLength(1);
      expect(sentCommands[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
      expect(sentCommands[0]).toMatchObject({
        input: {
          QueueUrl: "http://localhost:4566/000000000000/wager-transactions.fifo",
          ReceiptHandle: "receipt-handle-123",
          VisibilityTimeout: 8,
        },
      });
    } finally {
      if (originalQueueUrl === undefined) {
        delete process.env.SQS_QUEUE_URL;
      } else {
        process.env.SQS_QUEUE_URL = originalQueueUrl;
      }
      if (originalRetryBase === undefined) delete process.env.SQS_RETRY_BASE_DELAY_SECONDS;
      else process.env.SQS_RETRY_BASE_DELAY_SECONDS = originalRetryBase;
      if (originalRetryMax === undefined) delete process.env.SQS_RETRY_MAX_DELAY_SECONDS;
      else process.env.SQS_RETRY_MAX_DELAY_SECONDS = originalRetryMax;
    }
  });

  test("deletes the SQS message after successful processing", async () => {
    const originalQueueUrl = process.env.SQS_QUEUE_URL;
    process.env.SQS_QUEUE_URL =
      "http://localhost:4566/000000000000/wager-transactions.fifo";

    try {
      const sentCommands: unknown[] = [];

      const send = mock(async (command: unknown) => {
        sentCommands.push(command);
        return {};
      });

      const transactionManager = {
        execute: mock(async (operation: (em: object) => Promise<unknown>) =>
          operation({}),
        ),
      };

      const inboxRepository = {
        reserve: mock(async () => true),
        markProcessed: mock(async () => undefined),
      };

      const processBetUseCase = {
        execute: mock(async () => ({
          transactionId: "transaction-123",
          status: "PROCESSED",
          balance: "90.00",
          failureCode: null,
        })),
      };

      const consumer = new SqsConsumer(
        { send } as unknown as SQSClient,
        transactionManager as unknown as PostgresTransactionManager,
        inboxRepository as unknown as InboxMessageRepository,
        processBetUseCase as unknown as ProcessBetUseCase,
      );

      const message: Message = {
        MessageId: "sqs-message-success-123",
        ReceiptHandle: "receipt-handle-success-123",
        Body: JSON.stringify({
          messageId: "event-success-123",
          type: "WagerTransactionRequested",
          occurredAt: "2026-10-18T12:00:00.000Z",
          data: {
            providerId: "provider-test",
            externalTransactionId: "transaction-success-123",
            idempotencyKey: "provider-test:transaction-success-123",
            playerId: "player-test-123",
            walletId: "00000000-0000-4000-8000-000000000001",
            roundId: "round-test-123",
            gameId: "game-test",
            kind: "BET",
            money: {
              amount: "10.00",
              currency: "BRL",
            },
          },
        }),
      };

      await (
        consumer as unknown as {
          handleMessage: (message: Message) => Promise<void>;
        }
      ).handleMessage(message);

      expect(inboxRepository.reserve).toHaveBeenCalledTimes(1);
      expect(processBetUseCase.execute).toHaveBeenCalledTimes(1);
      expect(inboxRepository.markProcessed).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(sentCommands).toHaveLength(1);

      const command = sentCommands[0];

      expect(command).toBeInstanceOf(DeleteMessageCommand);
      expect(command).toMatchObject({
        input: {
          QueueUrl:
            "http://localhost:4566/000000000000/wager-transactions.fifo",
          ReceiptHandle: "receipt-handle-success-123",
        },
      });
    } finally {
      if (originalQueueUrl === undefined) {
        delete process.env.SQS_QUEUE_URL;
      } else {
        process.env.SQS_QUEUE_URL = originalQueueUrl;
      }
    }
  });

  test("deletes a duplicate message without processing it again", async () => {
    const originalQueueUrl = process.env.SQS_QUEUE_URL;
    process.env.SQS_QUEUE_URL =
      "http://localhost:4566/000000000000/wager-transactions.fifo";

    try {
      const sentCommands: unknown[] = [];

      const send = mock(async (command: unknown) => {
        sentCommands.push(command);
        return {};
      });

      const transactionManager = {
        execute: mock(async (operation: (em: object) => Promise<unknown>) =>
          operation({}),
        ),
      };

      const inboxRepository = {
        reserve: mock(async () => false),
        markProcessed: mock(async () => undefined),
      };

      const processBetUseCase = {
        execute: mock(async () => ({
          transactionId: "transaction-123",
          status: "PROCESSED",
          balance: "90.00",
          failureCode: null,
        })),
      };

      const consumer = new SqsConsumer(
        { send } as unknown as SQSClient,
        transactionManager as unknown as PostgresTransactionManager,
        inboxRepository as unknown as InboxMessageRepository,
        processBetUseCase as unknown as ProcessBetUseCase,
      );

      const message: Message = {
        MessageId: "sqs-message-duplicate-123",
        ReceiptHandle: "receipt-handle-duplicate-123",
        Body: JSON.stringify({
          messageId: "event-duplicate-123",
          type: "WagerTransactionRequested",
          occurredAt: "2026-10-18T12:00:00.000Z",
          data: {
            providerId: "provider-test",
            externalTransactionId: "transaction-duplicate-123",
            idempotencyKey: "provider-test:transaction-duplicate-123",
            playerId: "player-test-123",
            walletId: "00000000-0000-4000-8000-000000000001",
            roundId: "round-test-123",
            gameId: "game-test",
            kind: "BET",
            money: {
              amount: "10.00",
              currency: "BRL",
            },
          },
        }),
      };

      await (
        consumer as unknown as {
          handleMessage: (message: Message) => Promise<void>;
        }
      ).handleMessage(message);

      expect(inboxRepository.reserve).toHaveBeenCalledTimes(1);
      expect(processBetUseCase.execute).not.toHaveBeenCalled();
      expect(inboxRepository.markProcessed).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);

      expect(sentCommands[0]).toBeInstanceOf(DeleteMessageCommand);
      expect(sentCommands[0]).toMatchObject({
        input: {
          QueueUrl:
            "http://localhost:4566/000000000000/wager-transactions.fifo",
          ReceiptHandle: "receipt-handle-duplicate-123",
        },
      });
    } finally {
      if (originalQueueUrl === undefined) {
        delete process.env.SQS_QUEUE_URL;
      } else {
        process.env.SQS_QUEUE_URL = originalQueueUrl;
      }
    }
  });

  test("moves an invalid JSON message to DLQ before deleting it", async () => {
    const originalQueueUrl = process.env.SQS_QUEUE_URL;
    const originalDlqQueueUrl = process.env.SQS_DLQ_QUEUE_URL;
    process.env.SQS_QUEUE_URL =
      "http://localhost:4566/000000000000/wager-transactions.fifo";
    process.env.SQS_DLQ_QUEUE_URL =
      "http://localhost:4566/000000000000/wager-transactions-dlq.fifo";

    try {
      const sentCommands: unknown[] = [];

      const send = mock(async (command: unknown) => {
        sentCommands.push(command);
        return {};
      });

      const transactionManager = {
        execute: mock(async (operation: (em: object) => Promise<unknown>) =>
          operation({}),
        ),
      };

      const inboxRepository = {
        reserve: mock(async () => true),
        markProcessed: mock(async () => undefined),
      };

      const processBetUseCase = {
        execute: mock(async () => ({
          transactionId: "transaction-123",
          status: "PROCESSED",
          balance: "90.00",
          failureCode: null,
        })),
      };

      const consumer = new SqsConsumer(
        { send } as unknown as SQSClient,
        transactionManager as unknown as PostgresTransactionManager,
        inboxRepository as unknown as InboxMessageRepository,
        processBetUseCase as unknown as ProcessBetUseCase,
      );

      const message: Message = {
        MessageId: "sqs-message-invalid-json",
        ReceiptHandle: "receipt-handle-invalid-json",
        Body: '{"messageId":',
        Attributes: { ApproximateReceiveCount: "1" },
      };

      await (
        consumer as unknown as {
          handleMessage: (message: Message) => Promise<void>;
        }
      ).handleMessage(message);

      expect(transactionManager.execute).not.toHaveBeenCalled();
      expect(inboxRepository.reserve).not.toHaveBeenCalled();
      expect(processBetUseCase.execute).not.toHaveBeenCalled();
      expect(inboxRepository.markProcessed).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(2);
      expect(sentCommands).toHaveLength(2);
      expect(sentCommands[0]).toBeInstanceOf(SendMessageCommand);
      expect(sentCommands[0]).toMatchObject({
        input: {
          QueueUrl:
            "http://localhost:4566/000000000000/wager-transactions-dlq.fifo",
          MessageGroupId: "sqs-message-invalid-json",
          MessageDeduplicationId: "sqs-message-invalid-json",
        },
      });
      expect(sentCommands[1]).toBeInstanceOf(DeleteMessageCommand);
      expect(sentCommands[1]).toMatchObject({
        input: {
          QueueUrl:
            "http://localhost:4566/000000000000/wager-transactions.fifo",
          ReceiptHandle: "receipt-handle-invalid-json",
        },
      });
    } finally {
      if (originalQueueUrl === undefined) {
        delete process.env.SQS_QUEUE_URL;
      } else {
        process.env.SQS_QUEUE_URL = originalQueueUrl;
      }
      if (originalDlqQueueUrl === undefined) {
        delete process.env.SQS_DLQ_QUEUE_URL;
      } else {
        process.env.SQS_DLQ_QUEUE_URL = originalDlqQueueUrl;
      }
    }
  });
});
