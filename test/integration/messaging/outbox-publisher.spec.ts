import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from "../../../src/messaging/infrastructure/outbox-message.entity";
import { OutboxPublisher } from "../../../src/messaging/infrastructure/outbox-publisher";
import { OutboxPublisherRepository } from "../../../src/messaging/infrastructure/outbox-publisher.repository";
import { createSqsClient } from "../../../src/messaging/infrastructure/sqs-client.factory";

describe("OutboxPublisher (integration)", () => {
  let orm: MikroORM;
  let sqsClient: SQSClient;
  let repository: OutboxPublisherRepository;
  let publisher: OutboxPublisher;
  let queueUrl: string;
  const createdMessageIds: string[] = [];

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(mikroOrmConfig);
    sqsClient = createSqsClient();
    repository = new OutboxPublisherRepository(orm.em.fork());
    publisher = new OutboxPublisher(sqsClient, repository);
  });

  afterAll(async () => {
    await sqsClient?.destroy();
    await orm?.close(true);
  });

  beforeEach(async () => {
    const queue = await sqsClient.send(new CreateQueueCommand({
      QueueName: `wagering-outbox-publisher-${randomUUID()}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }));
    queueUrl = queue.QueueUrl!;
  });

  afterEach(async () => {
    for (const id of createdMessageIds.splice(0)) {
      await orm.em.fork().nativeDelete(OutboxMessageEntity, { id });
    }
    if (queueUrl) {
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      queueUrl = "";
    }
  });

  async function createPendingMessage() {
    const id = randomUUID();
    const aggregateId = randomUUID();
    const transactionId = randomUUID();

    await orm.em
      .fork()
      .getConnection()
      .execute(
        `
        INSERT INTO outbox_messages (
          id, event_type, aggregate_id, payload, status,
          attempts, available_at, published_at, last_error,
          created_at, lock_token, locked_until
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          id,
          "WagerTransactionProcessed",
          aggregateId,
          JSON.stringify({
            eventId: id,
            eventType: "WagerTransactionProcessed",
            aggregateId,
            version: 1,
            data: { transactionId },
          }),
          OutboxMessageStatus.PENDING,
          0,
          new Date(Date.now() - 1_000),
          null,
          null,
          new Date(),
          null,
          null,
        ],
      );
    createdMessageIds.push(id);

    return { id, aggregateId, transactionId };
  }

  test("publishes to LocalStack and marks the outbox row as published", async () => {
    const created = await createPendingMessage();

    const result = await publisher.publishBatch(queueUrl, 10, [created.id]);

    expect(result).toEqual({ published: 1, failed: 0 });

    const persisted = await orm.em
      .fork()
      .findOneOrFail(OutboxMessageEntity, { id: created.id });

    expect(persisted.status).toBe(OutboxMessageStatus.PUBLISHED);
    expect(persisted.publishedAt).not.toBeNull();
    expect(persisted.lockToken).toBeNull();
    expect(persisted.lockedUntil).toBeNull();

    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }),
    );

    const messages = response.Messages ?? [];
    expect(messages).toHaveLength(1);

    const body = JSON.parse(messages[0]!.Body!);

    expect(body).toMatchObject({
      eventId: created.id,
      eventType: "WagerTransactionProcessed",
      aggregateId: created.aggregateId,
      version: 1,
      data: {
        eventId: created.id,
        eventType: "WagerTransactionProcessed",
        aggregateId: created.aggregateId,
        version: 1,
        data: { transactionId: created.transactionId },
      },
    });
    expect(body.occurredAt).toBeString();
    expect(body.correlationId).toBe(created.id);
  });

  test("does not publish the same outbox row twice after successful publication", async () => {
    const created = await createPendingMessage();

    const first = await publisher.publishBatch(queueUrl, 10, [created.id]);
    const second = await publisher.publishBatch(queueUrl, 10, [created.id]);

    expect(first).toEqual({ published: 1, failed: 0 });
    expect(second).toEqual({ published: 0, failed: 0 });

    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }),
    );

    expect(response.Messages).toHaveLength(1);
  });

  test("two concurrent publishers claim and publish a row only once", async () => {
    const created = await createPendingMessage();
    const secondPublisher = new OutboxPublisher(
      sqsClient,
      new OutboxPublisherRepository(orm.em.fork()),
    );

    const results = await Promise.all([
      publisher.publishBatch(queueUrl, 10, [created.id]),
      secondPublisher.publishBatch(queueUrl, 10, [created.id]),
    ]);

    expect(results.reduce((count, result) => count + result.published, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.failed, 0)).toBe(0);

    const persisted = await orm.em
      .fork()
      .findOneOrFail(OutboxMessageEntity, { id: created.id });
    expect(persisted.status).toBe(OutboxMessageStatus.PUBLISHED);

    const response = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 2,
      }),
    );
    expect(response.Messages).toHaveLength(1);
    expect(JSON.parse(response.Messages![0]!.Body!).eventId).toBe(created.id);
  });
});
