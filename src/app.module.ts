import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { WalletModule } from "./wallet/wallet.module";
import { WagerModule } from "./wager/wager.module";

import mikroOrmConfig from "./mikro-orm.config";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), WalletModule, WagerModule],
  controllers: [HealthController],
})
export class AppModule {}
