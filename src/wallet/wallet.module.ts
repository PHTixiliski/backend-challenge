import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { WagerModule } from "../wager/wager.module";
import { PostgresTransactionManager } from "../shared/infrastructure/postgres-transaction-manager";
import { TransactionalWalletRepository } from "./infrastructure/transactional-wallet.repository";
import { TransactionalWalletLedgerRepository } from "./infrastructure/transactional-wallet-ledger.repository";
import { TransactionalWagerTransactionRepository } from "../wager/infrastructure/transactional-wager-transaction.repository";
import { WalletLedgerEntryEntity } from "./infrastructure/wallet-ledger-entry.entity";
import { WagerTransactionEntity } from "../wager/infrastructure/wager-transaction.entity";

import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { GetWalletUseCase } from "./application/get-wallet.use-case";
import { ListWalletLedgerUseCase } from "./application/list-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "./application/reconcile-wallet.use-case";
import { WALLET_REPOSITORY } from "./domain/wallet.repository";
import { WalletEntity } from "./infrastructure/wallet.entity";
import { WalletController } from "./presentation/wallet.controller";
import { MikroOrmWalletRepository } from "./infrastructure/mikro-orm-wallet.repository";
import { OptionalAuthGuard } from "../shared/http/optional-auth.guard";

@Module({
  imports: [MikroOrmModule.forFeature([WalletEntity, WalletLedgerEntryEntity, WagerTransactionEntity]), WagerModule],
  controllers: [WalletController],
  providers: [
    OptionalAuthGuard,
    CreateWalletUseCase,
    GetWalletUseCase,
    ListWalletLedgerUseCase,
    ReconcileWalletUseCase,
    TransactionalWalletRepository,
    TransactionalWalletLedgerRepository,
    TransactionalWagerTransactionRepository,
    PostgresTransactionManager,
    MikroOrmWalletRepository,
    {
      provide: WALLET_REPOSITORY,
      useExisting: MikroOrmWalletRepository,
    },
  ],
  exports: [CreateWalletUseCase, GetWalletUseCase, WALLET_REPOSITORY],
})
export class WalletModule {}
