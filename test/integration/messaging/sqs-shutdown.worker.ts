import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SQSClient } from "@aws-sdk/client-sqs";

import { InboxMessageRepository } from "../../../src/messaging/infrastructure/inbox-message.repository";
import { createSqsClient } from "../../../src/messaging/infrastructure/sqs-client.factory";
import { SqsConsumer } from "../../../src/messaging/infrastructure/sqs-consumer";
import { PostgresTransactionManager } from "../../../src/shared/infrastructure/postgres-transaction-manager";
import { ProcessBetUseCase } from "../../../src/wager/application/process-bet.use-case";
import { WagerTransactionStatus } from "../../../src/wager/domain/wager-transaction.types";

const transactionManager = {
  execute: async (operation: (em: object) => Promise<unknown>) => operation({}),
} as unknown as PostgresTransactionManager;

const inboxRepository = {
  reserve: async () => true,
  markProcessed: async () => undefined,
} as unknown as InboxMessageRepository;

const processBetUseCase = {
  execute: async () => {
    process.stdout.write("PROCESSING_STARTED\n");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    process.stdout.write("PROCESSING_FINISHED\n");
    return {
      transactionId: "shutdown-test-transaction",
      status: WagerTransactionStatus.PROCESSED,
      balance: "99.00",
      failureCode: null,
    };
  },
} as unknown as ProcessBetUseCase;

@Module({
  providers: [
    {
      provide: SQSClient,
      useFactory: createSqsClient,
    },
    {
      provide: PostgresTransactionManager,
      useValue: transactionManager,
    },
    {
      provide: InboxMessageRepository,
      useValue: inboxRepository,
    },
    {
      provide: ProcessBetUseCase,
      useValue: processBetUseCase,
    },
    {
      provide: "SQS_CLIENT_SHUTDOWN",
      inject: [SQSClient],
      useFactory: (client: SQSClient) => ({
        onModuleDestroy: () => client.destroy(),
      }),
    },
    SqsConsumer,
  ],
})
class ShutdownWorkerModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ShutdownWorkerModule, {
    logger: false,
  });
  app.enableShutdownHooks(["SIGTERM"]);
  process.stdout.write("SHUTDOWN_HOOKS_READY\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
