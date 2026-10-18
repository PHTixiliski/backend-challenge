import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createSqsClient } from "../../../src/messaging/infrastructure/sqs-client.factory";

const workerPath = join(process.cwd(), "test/integration/messaging/sqs-shutdown.worker.ts");

describe("SQS graceful shutdown (LocalStack integration)", () => {
  let sqsClient: SQSClient;

  beforeAll(() => {
    sqsClient = createSqsClient();
  });

  afterAll(async () => {
    await sqsClient?.destroy();
  });

  test("SIGTERM waits for an in-flight message to finish and acknowledge", async () => {
    const queue = await sqsClient.send(new CreateQueueCommand({
      QueueName: `wagering-shutdown-${randomUUID()}.fifo`,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }));
    const queueUrl = queue.QueueUrl!;
    const messageId = randomUUID();
    const child = Bun.spawn(["bun", "run", workerPath], {
      env: {
        ...process.env,
        SQS_QUEUE_URL: queueUrl,
        SQS_VISIBILITY_TIMEOUT: "4",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let stdout = "";
    let stderr = "";
    let resolveStarted!: () => void;
    let resolveHooksReady!: () => void;
    const processingStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const shutdownHooksReady = new Promise<void>((resolve) => {
      resolveHooksReady = resolve;
    });
    const stdoutTask = (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
        if (stdout.includes("PROCESSING_STARTED")) resolveStarted();
        if (stdout.includes("SHUTDOWN_HOOKS_READY")) resolveHooksReady();
      }
    })();
    const stderrTask = new Response(child.stderr).text().then((value) => {
      stderr = value;
    });

    try {
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "provider-shutdown-test",
            externalTransactionId: `external-${messageId}`,
            idempotencyKey: `key-${messageId}`,
            playerId: randomUUID(),
            walletId: randomUUID(),
            roundId: "round-shutdown-test",
            gameId: "game-shutdown-test",
            kind: "BET",
            money: { amount: "1.00", currency: "BRL" },
          },
        }),
        MessageGroupId: "shutdown-test",
        MessageDeduplicationId: messageId,
      }));

      await Promise.race([
        Promise.all([processingStarted, shutdownHooksReady]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Worker did not become ready.")), 10_000),
        ),
      ]);
      child.kill("SIGTERM");

      const exitCode = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Worker did not exit after SIGTERM.")), 10_000),
        ),
      ]);
      await Promise.all([stdoutTask, stderrTask]);

      // Nest completes its lifecycle hooks and then re-raises SIGTERM so the
      // operating system still observes signal-based termination (143).
      expect(exitCode).toBe(143);
      expect(stdout).toContain("PROCESSING_FINISHED");
      expect(stderr).toBe("");

      const remaining = await sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 3,
        VisibilityTimeout: 1,
      }));
      expect(remaining.Messages).toBeUndefined();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.allSettled([stdoutTask, stderrTask]);
      await sqsClient.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  });
});
