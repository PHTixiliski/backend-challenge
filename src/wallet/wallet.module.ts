import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";

import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { GetWalletUseCase } from "./application/get-wallet.use-case";
import { WALLET_REPOSITORY } from "./domain/wallet.repository";
import { WalletEntity } from "./infrastructure/wallet.entity";
import { WalletController } from "./presentation/wallet.controller";
import { MikroOrmWalletRepository } from "./infrastructure/mikro-orm-wallet.repository";

@Module({
  imports: [MikroOrmModule.forFeature([WalletEntity])],
  controllers: [WalletController],
  providers: [
    CreateWalletUseCase,
    GetWalletUseCase,
    MikroOrmWalletRepository,
    {
      provide: WALLET_REPOSITORY,
      useExisting: MikroOrmWalletRepository,
    },
  ],
  exports: [CreateWalletUseCase, GetWalletUseCase, WALLET_REPOSITORY],
})
export class WalletModule {}
