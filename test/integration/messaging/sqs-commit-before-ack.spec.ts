import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MikroORM } from "@mikro-orm/postgresql";

import config from "../../../src/mikro-orm.config";
import { InboxMessageEntity, InboxMessageStatus } from "../../../src/messaging/infrastructure/inbox-message.entity";
import { InboxMessageRepository } from "../../../src/messaging/infrastructure/inbox-message.repository";
import { createSqsClient } from "../../../src/messaging/infrastructure/sqs-client.factory";
import { SqsConsumer } from "../../../src/messaging/infrastructure/sqs-consumer";
import { TransactionalOutboxRepository } from "../../../src/messaging/infrastructure/transactional-outbox.repository";
import { PostgresTransactionManager } from "../../../src/shared/infrastructure/postgres-transaction-manager";
import { IdempotencyService } from "../../../src/shared/infrastructure/idempotency.service";
import { ProcessBetUseCase } from "../../../src/wager/application/process-bet.use-case";
import { TransactionalWagerTransactionRepository } from "../../../src/wager/infrastructure/transactional-wager-transaction.repository";
import { TransactionalWalletLedgerRepository } from "../../../src/wallet/infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWalletRepository } from "../../../src/wallet/infrastructure/transactional-wallet.repository";
import { WalletLedgerEntryEntity } from "../../../src/wallet/infrastructure/wallet-ledger-entry.entity";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";
import { cleanupTestWallets } from "../cleanup-test-wallets";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";
import { createTestWallet } from "../wager/process-bet.test-helpers";

const workerPath = join(process.cwd(), "test/integration/messaging/sqs-commit-before-ack.worker.ts");

function startConsumerWorker(mode: "pause-before-ack" | "ack", queueUrl: string) {
  const child = Bun.spawn(["bun", "run", workerPath, mode], {
    env: {
      ...process.env,
      SQS_QUEUE_URL: queueUrl,
      SQS_VISIBILITY_TIMEOUT: "2",
    },
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
          reject(new Error(`Consumer did not emit ${marker}. Output: ${stdout}`));
        }, 10_000);
        waiters.set(marker, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

describe("SQS commit-before-ack recovery (integration)", () => {
  let orm: MikroORM;
  let sqsClient: SQSClient;

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(config);
    sqsClient = createSqsClient();
  });

  afterAll(async () => {
    await sqsClient?.destroy();
    await orm?.close(true);
  });

  test("redelivery after a failed delete does not apply the committed wager twice", async () => {
    const queueName = `wagering-commit-ack-${randomUUID()}.fifo`;
    const queue = await sqsClient.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }));
    const queueUrl = queue.QueueUrl!;
    const oldQueueUrl = process.env.SQS_QUEUE_URL;
    const oldVisibility = process.env.SQS_VISIBILITY_TIMEOUT;
    process.env.SQS_QUEUE_URL = queueUrl;
    process.env.SQS_VISIBILITY_TIMEOUT = "2";

    const em = orm.em.fork();
    let playerId: string | undefined;
    let walletId: string | undefined;
    let sqsMessageId: string | undefined;
    const eventId = randomUUID();

    try {
      const wallet = await createTestWallet(em, {
        playerId: `commit-before-ack-${randomUUID()}`,
        balance: "100.00",
      });
      playerId = wallet.playerId;
      walletId = wallet.walletId;
      const message = {
        messageId: eventId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "provider-commit-ack",
          externalTransactionId: `external-${eventId}`,
          idempotencyKey: `key-${eventId}`,
          playerId,
          walletId,
          roundId: "round-commit-ack",
          gameId: "game-commit-ack",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
      };

      await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: walletId,
        MessageDeduplicationId: eventId,
      }));

      let failDeleteOnce = true;
      const deleteFailsOnceClient = {
        send: async (command: unknown) => {
          if (failDeleteOnce && command instanceof DeleteMessageCommand) {
            failDeleteOnce = false;
            throw new Error("simulated connection loss before SQS ack");
          }
          return sqsClient.send(command as never);
        },
      } as unknown as SQSClient;

      const useCase = new ProcessBetUseCase(
        new PostgresTransactionManager(orm.em.fork()),
        new TransactionalWalletRepository(),
        new TransactionalWalletLedgerRepository(),
        new TransactionalWagerTransactionRepository(),
        new IdempotencyService(),
        new TransactionalOutboxRepository(),
      );
      const consumer = new SqsConsumer(
        deleteFailsOnceClient,
        new PostgresTransactionManager(orm.em.fork()),
        new InboxMessageRepository(),
        useCase,
      );
      const handleMessage = (consumer as unknown as {
        handleMessage(message: NonNullable<Awaited<ReturnType<SQSClient["send"]>>["Messages"]>[number]): Promise<void>;
      }).handleMessage.bind(consumer);

      const firstDelivery = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 2,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }));
      expect(firstDelivery.Messages).toHaveLength(1);
      sqsMessageId = firstDelivery.Messages![0]!.MessageId!;
      await handleMessage(firstDelivery.Messages![0]!);

      const committedWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
      expect(committedWallet.balance).toBe("75.00");
      expect(await em.count(WalletLedgerEntryEntity, { walletId })).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 2200));
      const redelivery = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 2,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }));
      expect(redelivery.Messages).toHaveLength(1);
      expect(redelivery.Messages![0]!.Attributes?.ApproximateReceiveCount).toBe("2");
      await handleMessage(redelivery.Messages![0]!);

      const inbox = await em.findOneOrFail(InboxMessageEntity, {
        consumerName: "wager-transaction-consumer",
        messageId: sqsMessageId,
      });
      const finalWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
      expect(inbox.status).toBe(InboxMessageStatus.PROCESSED);
      expect(finalWallet.balance).toBe("75.00");
      expect(await em.count(WalletLedgerEntryEntity, { walletId })).toBe(2);
    } finally {
      if (walletId && playerId) {
        await cleanupTestWallets(orm, [walletId]);
        await em.transactional(async (tx) => {
          await tx.execute(`DELETE FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`, [
            "wager-transaction-consumer",
            sqsMessageId ?? eventId,
          ]);
        });
      }
      process.env.SQS_QUEUE_URL = oldQueueUrl;
      process.env.SQS_VISIBILITY_TIMEOUT = oldVisibility;
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  });

  test("a killed worker is redelivered after commit and before ACK without a duplicate debit", { timeout: 15_000 }, async () => {
    const queueName = `wagering-killed-before-ack-${randomUUID()}.fifo`;
    const queue = await sqsClient.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }));
    const queueUrl = queue.QueueUrl!;
    const eventId = randomUUID();
    const em = orm.em.fork();
    let walletId: string | undefined;
    let sqsMessageId: string | undefined;
    let firstWorker: ReturnType<typeof startConsumerWorker> | undefined;
    let retryWorker: ReturnType<typeof startConsumerWorker> | undefined;

    try {
      const wallet = await createTestWallet(em, {
        playerId: `killed-before-ack-${randomUUID()}`,
        balance: "100.00",
      });
      walletId = wallet.walletId;
      const message = await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          messageId: eventId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "provider-killed-before-ack",
            externalTransactionId: `external-${eventId}`,
            idempotencyKey: `key-${eventId}`,
            playerId: wallet.playerId,
            walletId,
            roundId: "round-killed-before-ack",
            gameId: "game-killed-before-ack",
            kind: "BET",
            money: { amount: "25.00", currency: "BRL" },
          },
        }),
        MessageGroupId: walletId,
        MessageDeduplicationId: eventId,
      }));
      sqsMessageId = message.MessageId!;

      firstWorker = startConsumerWorker("pause-before-ack", queueUrl);
      await firstWorker.waitFor("DATABASE_COMMITTED_BEFORE_ACK");
      firstWorker.child.kill("SIGKILL");
      expect(await firstWorker.child.exited).toBe(137);
      await Promise.all([firstWorker.stdoutTask, firstWorker.stderrTask]);
      expect(await firstWorker.stderrTask).toBe("");

      // The killed process cannot renew visibility. A separate process
      // receives the same SQS message and completes the inbox dedupe + ACK.
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      retryWorker = startConsumerWorker("ack", queueUrl);
      const [retryExitCode, retryStderr] = await Promise.all([
        retryWorker.child.exited,
        retryWorker.stderrTask,
      ]);
      await retryWorker.stdoutTask;
      expect(retryExitCode).toBe(0);
      expect(retryStderr).toBe("");
      expect(retryWorker.stdout).toContain("ACK_COMPLETED");

      const finalWallet = await em.findOneOrFail(WalletEntity, { id: walletId });
      const ledgerEntries = await em.find(WalletLedgerEntryEntity, { walletId });
      const inbox = await em.findOneOrFail(InboxMessageEntity, {
        consumerName: "wager-transaction-consumer",
        messageId: sqsMessageId,
      });
      expect(finalWallet.balance).toBe("75.00");
      expect(ledgerEntries).toHaveLength(2);
      expect(ledgerEntries.filter((entry) => entry.type === "DEBIT")).toHaveLength(1);
      expect(inbox.status).toBe(InboxMessageStatus.PROCESSED);

      const remaining = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      }));
      expect(remaining.Messages).toBeUndefined();
    } finally {
      if (firstWorker?.child.exitCode === null) firstWorker.child.kill("SIGKILL");
      if (retryWorker?.child.exitCode === null) retryWorker.child.kill("SIGKILL");
      if (sqsMessageId) {
        await em.nativeDelete(InboxMessageEntity, {
          consumerName: "wager-transaction-consumer",
          messageId: sqsMessageId,
        });
      }
      if (walletId) await cleanupTestWallets(orm, [walletId]);
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  });
});
