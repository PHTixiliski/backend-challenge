import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from "../../../src/messaging/infrastructure/outbox-message.entity";
import { OutboxPublisherRepository } from "../../../src/messaging/infrastructure/outbox-publisher.repository";

describe("OutboxPublisherRepository (integration)", () => {
  let orm: MikroORM;
  let repository: OutboxPublisherRepository;
  const createdMessageIds: string[] = [];

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(mikroOrmConfig);
    repository = new OutboxPublisherRepository(orm.em.fork());
  });

  afterAll(async () => {
    await orm.close(true);
  });

  afterEach(async () => {
    for (const id of createdMessageIds.splice(0)) {
      await orm.em.fork().nativeDelete(OutboxMessageEntity, { id });
    }
  });

  async function createMessage() {
    const id = randomUUID();
    const em = orm.em.fork();

    await em.getConnection().execute(
      `
      INSERT INTO outbox_messages (
        id,
        event_type,
        aggregate_id,
        payload,
        status,
        attempts,
        available_at,
        published_at,
        last_error,
        created_at,
        lock_token,
        locked_until
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        id,
        "WAGER.PROCESSED",
        randomUUID(),
        JSON.stringify({ transactionId: randomUUID() }),
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

    return id;
  }

  test("claims a pending message and persists its reservation", async () => {
    const messageId = await createMessage();

    const claimed = await repository.claimBatch(10, 60, [messageId]);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(messageId);
    expect(claimed[0]?.lock_token).toBeTruthy();

    const persisted = await orm.em
      .fork()
      .findOneOrFail(OutboxMessageEntity, { id: messageId });

    expect(persisted.lockToken).toBe(claimed[0]?.lock_token);
    expect(persisted.lockedUntil).not.toBeNull();
  });

  test("does not claim a message that is already reserved", async () => {
    const messageId = await createMessage();

    const first = await repository.claimBatch(10, 60, [messageId]);
    const second = await repository.claimBatch(10, 60, [messageId]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  test("does not publish with an incorrect lock token", async () => {
    const messageId = await createMessage();
    const claimed = await repository.claimBatch(10, 60, [messageId]);

    expect(claimed).toHaveLength(1);

    const published = await repository.markPublished(messageId, randomUUID());

    expect(published).toBe(false);

    const persisted = await orm.em
      .fork()
      .findOneOrFail(OutboxMessageEntity, { id: messageId });

    expect(persisted.status).toBe(OutboxMessageStatus.PENDING);
  });

  test("publishes a message using its valid lock token", async () => {
    const messageId = await createMessage();
    const claimed = await repository.claimBatch(10, 60, [messageId]);
    const lockToken = claimed[0]!.lock_token;

    const published = await repository.markPublished(messageId, lockToken);

    expect(published).toBe(true);

    const persisted = await orm.em
      .fork()
      .findOneOrFail(OutboxMessageEntity, { id: messageId });

    expect(persisted.status).toBe(OutboxMessageStatus.PUBLISHED);
    expect(persisted.publishedAt).not.toBeNull();
    expect(persisted.lockToken).toBeNull();
    expect(persisted.lockedUntil).toBeNull();
  });

  test("releases the reservation and schedules a retry", async () => {
    const messageId = await createMessage();
    const claimed = await repository.claimBatch(10, 60, [messageId]);
    const lockToken = claimed[0]!.lock_token;

    const scheduled = await repository.scheduleRetry(
      messageId,
      lockToken,
      "Temporary SQS failure",
    );

    expect(scheduled).toBe(true);

    const persisted = await orm.em
      .fork()
      .findOneOrFail(OutboxMessageEntity, { id: messageId });

    expect(persisted.attempts).toBe(1);
    expect(persisted.lastError).toBe("Temporary SQS failure");
    expect(persisted.lockToken).toBeNull();
    expect(persisted.lockedUntil).toBeNull();
    expect(persisted.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("recovers a message after its reservation expires", async () => {
    const messageId = await createMessage();

    const first = await repository.claimBatch(10, 60, [messageId]);
    expect(first).toHaveLength(1);

    await orm.em
      .fork()
      .nativeUpdate(
        OutboxMessageEntity,
        { id: messageId },
        { lockedUntil: new Date(Date.now() - 1_000) },
      );

    const second = await repository.claimBatch(10, 60, [messageId]);

    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(messageId);
    expect(second[0]?.lock_token).not.toBe(first[0]?.lock_token);
  });
});
