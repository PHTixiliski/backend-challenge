import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";
import {
  OutboxMessageEntity,
  OutboxMessageStatus,
} from "../../../src/messaging/infrastructure/outbox-message.entity";
import { createSqsClient } from "../../../src/messaging/infrastructure/sqs-client.factory";

const workerPath = join(process.cwd(), "test/integration/messaging/outbox-crash-recovery.worker.ts");

function startWorker(mode: string, queueUrl: string, messageId: string) {
  const child = Bun.spawn(["bun", "run", workerPath, mode, queueUrl, messageId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  const waiters = new Map<string, () => void>();
  const stdoutTask = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      for (const [marker, resolve] of waiters) {
        if (stdout.includes(marker)) {
          waiters.delete(marker);
          resolve();
        }
      }
    }
  })();
  const stderrTask = new Response(child.stderr).text();

  return {
    child,
    stdoutTask,
    stderrTask,
    get stdout() { return stdout; },
    waitFor(marker: string): Promise<void> {
      if (stdout.includes(marker)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(marker);
          reject(new Error(`Worker did not emit ${marker}. Output: ${stdout}`));
        }, 10_000);
        waiters.set(marker, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

describe("Outbox crash recovery (PostgreSQL + LocalStack)", () => {
  let orm: MikroORM;
  let sqsClient: SQSClient;

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(mikroOrmConfig);
    sqsClient = createSqsClient();
  });

  afterAll(async () => {
    await sqsClient?.destroy();
    await orm?.close(true);
  });

  test("a fresh publisher publishes a committed event after the prior process dies", async () => {
    const queueName = `wagering-outbox-recovery-${randomUUID()}.fifo`;
    const queue = await sqsClient.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }));
    const queueUrl = queue.QueueUrl!;
    const messageId = randomUUID();
    const aggregateId = randomUUID();
    const transactionId = randomUUID();
    const em = orm.em.fork();

    try {
      // This committed row represents the financial transaction and its
      // outbox event having committed before the publishing process stopped.
      await em.getConnection().execute(
        `INSERT INTO outbox_messages (
          id, event_type, aggregate_id, payload, status, attempts,
          available_at, published_at, last_error, created_at, lock_token, locked_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          messageId,
          "WagerTransactionProcessed",
          aggregateId,
          JSON.stringify({ transactionId }),
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

      // A real OS process claims the committed row and is killed before it
      // reaches SQS, leaving only its short database lease behind.
      const firstProcess = startWorker("claim-and-wait", "", messageId);
      try {
        await firstProcess.waitFor("OUTBOX_CLAIMED");
        firstProcess.child.kill("SIGKILL");
        expect(await firstProcess.child.exited).toBe(137);
        await Promise.all([firstProcess.stdoutTask, firstProcess.stderrTask]);
        expect(await firstProcess.stderrTask).toBe("");
      } finally {
        if (firstProcess.child.exitCode === null) firstProcess.child.kill("SIGKILL");
      }

      // Model the lock lease expiring during downtime, then publish from a
      // genuinely new process with a fresh ORM pool and SQS client.
      await em.getConnection().execute(
        "UPDATE outbox_messages SET locked_until = ? WHERE id = ?",
        [new Date(Date.now() - 1_000), messageId],
      );
      const restartedProcess = startWorker("publish", queueUrl, messageId);
      const [publishExitCode, publishStderr] = await Promise.all([
        restartedProcess.child.exited,
        restartedProcess.stderrTask,
      ]);
      await restartedProcess.stdoutTask;
      expect(publishExitCode).toBe(0);
      expect(publishStderr).toBe("");
      expect(JSON.parse(restartedProcess.stdout.trim())).toEqual({
        published: 1,
        failed: 0,
      });

      const persisted = await em.findOneOrFail(OutboxMessageEntity, { id: messageId });
      expect(persisted.status).toBe(OutboxMessageStatus.PUBLISHED);
      expect(persisted.lockToken).toBeNull();
      expect(persisted.lockedUntil).toBeNull();

      const received = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }));
      expect(received.Messages).toHaveLength(1);
      expect(JSON.parse(received.Messages![0]!.Body!)).toMatchObject({
        eventId: messageId,
        eventType: "WagerTransactionProcessed",
        aggregateId,
        data: { transactionId },
      });
    } finally {
      await em.nativeDelete(OutboxMessageEntity, { id: messageId });
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  });
});
