import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import { EntityManager } from "@mikro-orm/core";
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(EntityManager)
    private readonly entityManager: EntityManager,
    private readonly sqsClient: SQSClient,
  ) {}

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(): Promise<{
    status: string;
    checks: {
      postgres: string;
      sqs: string;
    };
  }> {
    const checks = {
      postgres: "ok",
      sqs: "ok",
    };

    try {
      await this.entityManager.getConnection().execute("SELECT 1");
    } catch {
      checks.postgres = "unavailable";
    }

    const requiredQueueUrls = [
      process.env.SQS_QUEUE_URL,
      process.env.SQS_OUTBOX_QUEUE_URL,
    ];
    const queueUrls = [
      ...requiredQueueUrls,
      process.env.SQS_DLQ_QUEUE_URL,
    ].filter((url): url is string => Boolean(url?.trim()));

    if (requiredQueueUrls.some((url) => !url?.trim())) {
      checks.sqs = "not_configured";
    } else {
      try {
        await Promise.all(queueUrls.map((queueUrl) => this.sqsClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ["QueueArn"],
          }),
        )));
      } catch {
        checks.sqs = "unavailable";
      }
    }

    const ready = Object.values(checks).every((status) => status === "ok");

    if (!ready) {
      throw new ServiceUnavailableException({
        status: "not_ready",
        checks,
      });
    }

    return {
      status: "ok",
      checks,
    };
  }
}
