import { Module } from "@nestjs/common";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { SQSClient } from "@aws-sdk/client-sqs";

import { WagerModule } from "../wager/wager.module";
import { createSqsClient } from "./infrastructure/sqs-client.factory";
import { OutboxPublisherRepository } from "./infrastructure/outbox-publisher.repository";
import { OutboxPublisher } from "./infrastructure/outbox-publisher";
import { OutboxPublisherWorker } from "./infrastructure/outbox-publisher.worker";
import { InboxMessageEntity } from "./infrastructure/inbox-message.entity";
import { InboxMessageRepository } from "./infrastructure/inbox-message.repository";
import { SqsConsumer } from "./infrastructure/sqs-consumer";

@Module({
  imports: [MikroOrmModule.forFeature([InboxMessageEntity]), WagerModule],
  providers: [
    {
      provide: SQSClient,
      useFactory: createSqsClient,
    },
    OutboxPublisherRepository,
    OutboxPublisher,
    OutboxPublisherWorker,
    InboxMessageRepository,
    SqsConsumer,
  ],
  exports: [
    SQSClient,
    OutboxPublisherRepository,
    OutboxPublisher,
    InboxMessageRepository,
  ],
})
export class MessagingModule {}
