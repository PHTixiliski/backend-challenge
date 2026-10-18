import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../../src/mikro-orm.config";
import { PostgresTransactionManager } from "../../../src/shared/infrastructure/postgres-transaction-manager";
import { IdempotencyService } from "../../../src/shared/infrastructure/idempotency.service";
import { TransactionalOutboxRepository } from "../../../src/messaging/infrastructure/transactional-outbox.repository";
import { TransactionalWalletLedgerRepository } from "../../../src/wallet/infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWalletRepository } from "../../../src/wallet/infrastructure/transactional-wallet.repository";
import { ProcessBetUseCase, type ProcessBetInput } from "../../../src/wager/application/process-bet.use-case";
import { TransactionalWagerTransactionRepository } from "../../../src/wager/infrastructure/transactional-wager-transaction.repository";

const [mode, raw] = Bun.argv.slice(2);

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);
  try {
    const useCase = new ProcessBetUseCase(
      new PostgresTransactionManager(orm.em.fork()),
      new TransactionalWalletRepository(),
      new TransactionalWalletLedgerRepository(),
      new TransactionalWagerTransactionRepository(),
      new IdempotencyService(),
      new TransactionalOutboxRepository(),
    );

    if (mode === "submit") {
      const result = await useCase.execute(JSON.parse(raw!) as ProcessBetInput);
      console.log(JSON.stringify(result));
    } else if (mode === "retry") {
      const input = JSON.parse(raw ?? "{}") as { transactionIds?: string[] };
      const processed = await useCase.retryPendingReferences(25, input.transactionIds);
      console.log(JSON.stringify({ processed }));
    } else {
      throw new Error(`Unknown worker mode: ${mode}`);
    }
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
