import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { randomUUID } from "node:crypto";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";
import {
  InboxMessageEntity,
  InboxMessageStatus,
} from "../../../src/messaging/infrastructure/inbox-message.entity";
import { InboxMessageRepository } from "../../../src/messaging/infrastructure/inbox-message.repository";

describe("InboxMessageRepository (integration)", () => {
  let orm: MikroORM;
  let repository: InboxMessageRepository;

  const testNamespace = randomUUID();
  const consumerName = `inbox-test-${testNamespace}`;
  const messageKey = (suffix: string) => `${testNamespace}-${suffix}`;

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(mikroOrmConfig);
    repository = new InboxMessageRepository();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  afterEach(async () => {
    await orm.em.fork().nativeDelete(InboxMessageEntity, {
      messageId: { $like: `${testNamespace}-%` },
    });
  });

  test("reserves a new message", async () => {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      const reserved = await repository.reserve(
        {
          consumerName,
          messageId: messageKey("sqs-message-1"),
          eventType: "WAGER.SUBMITTED",
        },
        tx,
      );

      expect(reserved).toBe(true);
    });

    const persisted = await orm.em.fork().findOneOrFail(InboxMessageEntity, {
      consumerName,
      messageId: messageKey("sqs-message-1"),
    });

    expect(persisted.eventType).toBe("WAGER.SUBMITTED");
    expect(persisted.status).toBe(InboxMessageStatus.PROCESSING);
    expect(persisted.processedAt).toBeNull();
  });

  test("does not reserve the same message twice for the same consumer", async () => {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      expect(
        await repository.reserve(
          {
            consumerName,
            messageId: messageKey("sqs-message-duplicate"),
            eventType: "WAGER.SUBMITTED",
          },
          tx,
        ),
      ).toBe(true);

      expect(
        await repository.reserve(
          {
            consumerName,
            messageId: messageKey("sqs-message-duplicate"),
            eventType: "WAGER.SUBMITTED",
          },
          tx,
        ),
      ).toBe(false);
    });

    const count = await orm.em.fork().count(InboxMessageEntity, {
      consumerName,
      messageId: messageKey("sqs-message-duplicate"),
    });

    expect(count).toBe(1);
  });

  test("allows only one reservation under concurrent transactions", async () => {
    const messageId = messageKey("sqs-message-concurrent");
    const emA = orm.em.fork();
    const emB = orm.em.fork();

    const reserveMessage = (em: typeof emA) =>
      em.transactional((tx) =>
        repository.reserve(
          {
            consumerName,
            messageId,
            eventType: "WAGER.SUBMITTED",
          },
          tx,
        ),
      );

    const results = await Promise.all([
      reserveMessage(emA),
      reserveMessage(emB),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((reserved) => !reserved)).toHaveLength(1);

    const count = await orm.em.fork().count(InboxMessageEntity, {
      consumerName,
      messageId,
    });

    expect(count).toBe(1);
  });

  test("allows the same message ID for different consumers", async () => {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      expect(
        await repository.reserve(
          {
            consumerName: `${testNamespace}-consumer-a`,
            messageId: messageKey("sqs-message-shared"),
            eventType: "WAGER.SUBMITTED",
          },
          tx,
        ),
      ).toBe(true);

      expect(
        await repository.reserve(
          {
            consumerName: `${testNamespace}-consumer-b`,
            messageId: messageKey("sqs-message-shared"),
            eventType: "WAGER.SUBMITTED",
          },
          tx,
        ),
      ).toBe(true);
    });

    const count = await orm.em.fork().count(InboxMessageEntity, {
      messageId: messageKey("sqs-message-shared"),
    });

    expect(count).toBe(2);
  });

  test("marks a reserved message as processed", async () => {
    const em = orm.em.fork();

    await em.transactional(async (tx) => {
      const reserved = await repository.reserve(
        {
          consumerName,
          messageId: messageKey("sqs-message-processed"),
          eventType: "WAGER.SUBMITTED",
        },
        tx,
      );

      expect(reserved).toBe(true);

      await repository.markProcessed(consumerName, messageKey("sqs-message-processed"), tx);
    });

    const persisted = await orm.em.fork().findOneOrFail(InboxMessageEntity, {
      consumerName,
      messageId: messageKey("sqs-message-processed"),
    });

    expect(persisted.status).toBe(InboxMessageStatus.PROCESSED);
    expect(persisted.processedAt).not.toBeNull();
    expect(persisted.lastError).toBeNull();
  });

  test("rolls back the reservation when processing fails", async () => {
    const em = orm.em.fork();

    await expect(
      em.transactional(async (tx) => {
        await repository.reserve(
          {
            consumerName,
            messageId: messageKey("sqs-message-rollback"),
            eventType: "WAGER.SUBMITTED",
          },
          tx,
        );

        throw new Error("Simulated processing failure");
      }),
    ).rejects.toThrow("Simulated processing failure");

    const persisted = await orm.em.fork().findOne(InboxMessageEntity, {
      consumerName,
      messageId: messageKey("sqs-message-rollback"),
    });

    expect(persisted).toBeNull();
  });

  test("rejects marking an unknown message as processed", async () => {
    const em = orm.em.fork();

    await expect(
      em.transactional(async (tx) => {
        await repository.markProcessed(consumerName, messageKey("unknown-message"), tx);
      }),
    ).rejects.toThrow(
      `Could not mark inbox message "${messageKey("unknown-message")}" for consumer "${consumerName}" as processed.`,
    );
  });
});
