import { Module } from "@nestjs/common";

import { PostgresTransactionManager } from "../shared/infrastructure/postgres-transaction-manager";
import { TransactionalWalletRepository } from "../wallet/infrastructure/transactional-wallet.repository";
import { TransactionalWalletLedgerRepository } from "../wallet/infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWagerTransactionRepository } from "./infrastructure/transactional-wager-transaction.repository";
import { ProcessBetUseCase } from "./application/process-bet.use-case";

@Module({
  providers: [
    PostgresTransactionManager,
    TransactionalWalletRepository,
    TransactionalWalletLedgerRepository,
    TransactionalWagerTransactionRepository,
    ProcessBetUseCase,
  ],
  exports: [ProcessBetUseCase],
})
export class WagerModule {}
