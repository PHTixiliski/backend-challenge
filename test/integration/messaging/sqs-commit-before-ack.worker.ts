import "reflect-metadata";
import {
  DeleteMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";

import config from "../../../src/mikro-orm.config";
import { InboxMessageRepository } from "../../../src/messaging/infrastructure/inbox-message.repository";
import { createSqsClient } from "../../../src/messaging/infrastructure/sqs-client.factory";
import { SqsConsumer } from "../../../src/messaging/infrastructure/sqs-consumer";
import { IdempotencyService } from "../../../src/shared/infrastructure/idempotency.service";
import { PostgresTransactionManager } from "../../../src/shared/infrastructure/postgres-transaction-manager";
import { ProcessBetUseCase } from "../../../src/wager/application/process-bet.use-case";
import { TransactionalWagerTransactionRepository } from "../../../src/wager/infrastructure/transactional-wager-transaction.repository";
import { TransactionalOutboxRepository } from "../../../src/messaging/infrastructure/transactional-outbox.repository";
import { TransactionalWalletLedgerRepository } from "../../../src/wallet/infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWalletRepository } from "../../../src/wallet/infrastructure/transactional-wallet.repository";

async function main(): Promise<void> {
  const [mode] = Bun.argv.slice(2);
  if (mode !== "pause-before-ack" && mode !== "ack") {
    throw new Error(`Unknown worker mode: ${mode}`);
  }

  const orm = await MikroORM.init(config);
  const sqsClient = createSqsClient();
  const realClient = sqsClient;
  const instrumentedClient = {
    send: async (command: unknown) => {
      if (command instanceof DeleteMessageCommand && mode === "pause-before-ack") {
        process.stdout.write("DATABASE_COMMITTED_BEFORE_ACK\n");
        await new Promise<void>(() => {});
      }

      const response = await realClient.send(command as never);
      if (command instanceof DeleteMessageCommand && mode === "ack") {
        process.stdout.write("ACK_COMPLETED\n");
        setTimeout(() => process.exit(0), 25);
      }
      return response;
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
    instrumentedClient,
    new PostgresTransactionManager(orm.em.fork()),
    new InboxMessageRepository(),
    useCase,
  );
  consumer.onModuleInit();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
