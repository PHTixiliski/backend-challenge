import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { OutboxPublisher } from "../../../src/messaging/infrastructure/outbox-publisher";
import { OutboxPublisherRepository } from "../../../src/messaging/infrastructure/outbox-publisher.repository";
import { createSqsClient } from "../../../src/messaging/infrastructure/sqs-client.factory";

async function main(): Promise<void> {
  const [mode, queueUrl, messageId] = Bun.argv.slice(2);
  if (!mode || !messageId) throw new Error("mode and messageId are required");

  const orm = await MikroORM.init(mikroOrmConfig);
  let sqsClient: SQSClient | undefined;
  try {
    const repository = new OutboxPublisherRepository(orm.em.fork());
    if (mode === "claim-and-wait") {
      const claimed = await repository.claimBatch(1, 1, [messageId]);
      if (claimed.length !== 1) throw new Error("Outbox row was not claimed");
      process.stdout.write("OUTBOX_CLAIMED\n");
      await new Promise<void>((resolve) => setTimeout(resolve, 120_000));
      return;
    }

    if (mode === "publish") {
      if (!queueUrl) throw new Error("queueUrl is required for publishing");
      sqsClient = createSqsClient();
      const result = await new OutboxPublisher(sqsClient, repository)
        .publishBatch(queueUrl, 1, [messageId]);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    throw new Error(`Unknown mode: ${mode}`);
  } finally {
    await sqsClient?.destroy();
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
