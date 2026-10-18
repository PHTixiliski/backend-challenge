import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";

import { createSqsClient } from "../../../src/messaging/infrastructure/sqs-client.factory";
import { SqsConsumer } from "../../../src/messaging/infrastructure/sqs-consumer";
import { InboxMessageRepository } from "../../../src/messaging/infrastructure/inbox-message.repository";
import { PostgresTransactionManager } from "../../../src/shared/infrastructure/postgres-transaction-manager";
import { ProcessBetUseCase } from "../../../src/wager/application/process-bet.use-case";

async function createFifoQueue(client: SQSClient, prefix: string): Promise<string> {
  const result = await client.send(new CreateQueueCommand({
    QueueName: `${prefix}-${randomUUID()}.fifo`,
    Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
  }));
  return result.QueueUrl!;
}

async function receiveOne(
  client: SQSClient,
  queueUrl: string,
  waitSeconds: number,
): Promise<Message | undefined> {
  const result = await client.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: waitSeconds,
    VisibilityTimeout: 1,
    MessageSystemAttributeNames: ["ApproximateReceiveCount"],
  }));
  return result.Messages?.[0];
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeConsumer(
  client: SQSClient,
  queueUrl: string,
  dlqUrl: string,
  maxReceiveCount: number,
  processMessage: () => Promise<unknown>,
  counts: { reserved: number; processed: number },
): SqsConsumer {
  process.env.SQS_QUEUE_URL = queueUrl;
  process.env.SQS_DLQ_QUEUE_URL = dlqUrl;
  process.env.SQS_VISIBILITY_TIMEOUT = "1";
  process.env.SQS_MAX_RECEIVE_COUNT = String(maxReceiveCount);

  const transactionManager = {
    execute: async (operation: (em: object) => Promise<unknown>) => operation({}),
  } as unknown as PostgresTransactionManager;
  const inboxRepository = {
    reserve: async () => {
      counts.reserved += 1;
      return true;
    },
    markProcessed: async () => {
      counts.processed += 1;
    },
  } as unknown as InboxMessageRepository;
  const useCase = { execute: processMessage } as unknown as ProcessBetUseCase;

  return new SqsConsumer(client, transactionManager, inboxRepository, useCase);
}

function messageHandler(consumer: SqsConsumer) {
  return (consumer as unknown as {
    handleMessage(message: Message): Promise<void>;
  }).handleMessage.bind(consumer);
}

function wagerMessage(): string {
  const id = randomUUID();
  return JSON.stringify({
    messageId: id,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      providerId: "provider-sqs-retry-test",
      externalTransactionId: `external-${id}`,
      idempotencyKey: `key-${id}`,
      playerId: randomUUID(),
      walletId: randomUUID(),
      roundId: "round-sqs-retry-test",
      gameId: "game-sqs-retry-test",
      kind: "BET",
      money: { amount: "1.00", currency: "BRL" },
    },
  });
}

describe("SQS retry and DLQ (LocalStack integration)", () => {
  let sqsClient: SQSClient;

  beforeAll(() => {
    sqsClient = createSqsClient();
  });

  afterAll(async () => {
    await sqsClient?.destroy();
  });

  test("retries a transient failure and acknowledges a successful redelivery", async () => {
    const sourceUrl = await createFifoQueue(sqsClient, "wagering-retry");
    const dlqUrl = await createFifoQueue(sqsClient, "wagering-retry-dlq");
    const previousEnv = {
      queue: process.env.SQS_QUEUE_URL,
      dlq: process.env.SQS_DLQ_QUEUE_URL,
      visibility: process.env.SQS_VISIBILITY_TIMEOUT,
      maxReceive: process.env.SQS_MAX_RECEIVE_COUNT,
    };
    const counts = { reserved: 0, processed: 0 };
    let attempts = 0;

    try {
      const consumer = makeConsumer(
        sqsClient,
        sourceUrl,
        dlqUrl,
        5,
        async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary database outage");
          return {
            transactionId: randomUUID(),
            status: "PROCESSED",
            balance: "99.00",
            failureCode: null,
          };
        },
        counts,
      );
      const body = wagerMessage();
      const messageId = randomUUID();
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: sourceUrl,
        MessageBody: body,
        MessageGroupId: "retry-test",
        MessageDeduplicationId: messageId,
      }));

      const handle = messageHandler(consumer);
      const first = await receiveOne(sqsClient, sourceUrl, 2);
      expect(first).toBeDefined();
      await handle(first!);
      expect(attempts).toBe(1);
      expect(counts.processed).toBe(0);

      const redelivery = await receiveOne(sqsClient, sourceUrl, 3);
      expect(redelivery?.Attributes?.ApproximateReceiveCount).toBe("2");
      await handle(redelivery!);
      expect(attempts).toBe(2);
      expect(counts.reserved).toBe(2);
      expect(counts.processed).toBe(1);
      expect(await receiveOne(sqsClient, sourceUrl, 1)).toBeUndefined();
      expect(await receiveOne(sqsClient, dlqUrl, 1)).toBeUndefined();
    } finally {
      restoreEnv("SQS_QUEUE_URL", previousEnv.queue);
      restoreEnv("SQS_DLQ_QUEUE_URL", previousEnv.dlq);
      restoreEnv("SQS_VISIBILITY_TIMEOUT", previousEnv.visibility);
      restoreEnv("SQS_MAX_RECEIVE_COUNT", previousEnv.maxReceive);
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: sourceUrl }));
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    }
  });

  test("moves a transiently failing message to DLQ at the configured receive limit", async () => {
    const sourceUrl = await createFifoQueue(sqsClient, "wagering-max-retry");
    const dlqUrl = await createFifoQueue(sqsClient, "wagering-max-retry-dlq");
    const previousEnv = {
      queue: process.env.SQS_QUEUE_URL,
      dlq: process.env.SQS_DLQ_QUEUE_URL,
      visibility: process.env.SQS_VISIBILITY_TIMEOUT,
      maxReceive: process.env.SQS_MAX_RECEIVE_COUNT,
    };
    const counts = { reserved: 0, processed: 0 };
    const body = wagerMessage();
    const messageId = randomUUID();

    try {
      const consumer = makeConsumer(
        sqsClient,
        sourceUrl,
        dlqUrl,
        2,
        async () => {
          throw new Error("persistent transient failure");
        },
        counts,
      );
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: sourceUrl,
        MessageBody: body,
        MessageGroupId: "max-retry-test",
        MessageDeduplicationId: messageId,
      }));

      const handle = messageHandler(consumer);
      const first = await receiveOne(sqsClient, sourceUrl, 2);
      expect(first).toBeDefined();
      await handle(first!);
      const retry = await receiveOne(sqsClient, sourceUrl, 3);
      expect(retry?.Attributes?.ApproximateReceiveCount).toBe("2");
      await handle(retry!);

      const deadLetter = await receiveOne(sqsClient, dlqUrl, 2);
      expect(deadLetter).toBeDefined();
      expect(JSON.parse(deadLetter!.Body!)).toMatchObject({
        sourceMessageId: first!.MessageId,
        failureCode: "MAX_RECEIVE_COUNT_EXCEEDED",
        originalBody: body,
      });
      expect(counts.reserved).toBe(2);
      expect(counts.processed).toBe(0);
      expect(await receiveOne(sqsClient, sourceUrl, 1)).toBeUndefined();
    } finally {
      restoreEnv("SQS_QUEUE_URL", previousEnv.queue);
      restoreEnv("SQS_DLQ_QUEUE_URL", previousEnv.dlq);
      restoreEnv("SQS_VISIBILITY_TIMEOUT", previousEnv.visibility);
      restoreEnv("SQS_MAX_RECEIVE_COUNT", previousEnv.maxReceive);
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: sourceUrl }));
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    }
  });
});
