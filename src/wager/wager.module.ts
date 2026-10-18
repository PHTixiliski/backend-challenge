import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";

import { PostgresTransactionManager } from "../shared/infrastructure/postgres-transaction-manager";
import { TransactionalWalletRepository } from "../wallet/infrastructure/transactional-wallet.repository";
import { TransactionalWalletLedgerRepository } from "../wallet/infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWagerTransactionRepository } from "./infrastructure/transactional-wager-transaction.repository";
import { ProcessBetUseCase } from "./application/process-bet.use-case";
import { GetWagerTransactionUseCase } from "./application/get-wager-transaction.use-case";
import { TransactionalOutboxRepository } from "../messaging/infrastructure/transactional-outbox.repository";

import { WalletEntity } from "../wallet/infrastructure/wallet.entity";
import { WalletLedgerEntryEntity } from "../wallet/infrastructure/wallet-ledger-entry.entity";
import { WagerTransactionEntity } from "./infrastructure/wager-transaction.entity";
import { OutboxMessageEntity } from "../messaging/infrastructure/outbox-message.entity";
import { IdempotencyRecordEntity } from "../shared/infrastructure/idempotency-record.entity";
import { IdempotencyService } from "../shared/infrastructure/idempotency.service";
import { PendingReferenceWorker } from "./infrastructure/pending-reference.worker";
import { WageringController } from "./presentation/wagering.controller";
import { OptionalAuthGuard } from "../shared/http/optional-auth.guard";

@Module({
  imports: [
    MikroOrmModule.forFeature([
      WalletEntity,
      WalletLedgerEntryEntity,
      WagerTransactionEntity,
      OutboxMessageEntity,
      IdempotencyRecordEntity,
    ]),
  ],
  controllers: [WageringController],
  providers: [
    OptionalAuthGuard,
    PostgresTransactionManager,
    TransactionalWalletRepository,
    TransactionalWalletLedgerRepository,
    TransactionalWagerTransactionRepository,
    TransactionalOutboxRepository,
    IdempotencyService,
    ProcessBetUseCase,
    GetWagerTransactionUseCase,
    PendingReferenceWorker,
  ],
  exports: [
    ProcessBetUseCase,
    PostgresTransactionManager,
    TransactionalOutboxRepository,
  ],
})
export class WagerModule {}
