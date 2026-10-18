import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { WalletModule } from "./wallet/wallet.module";
import { WagerModule } from "./wager/wager.module";
import { MessagingModule } from "./messaging/messaging.module";

import mikroOrmConfig from "./mikro-orm.config";
import { HealthController } from "./health/health.controller";
import { ObservabilityModule } from "./observability/observability.module";

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    MessagingModule,
    WalletModule,
    WagerModule,
    ObservabilityModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
