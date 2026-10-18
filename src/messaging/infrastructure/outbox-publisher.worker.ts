import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { OutboxPublisher } from "./outbox-publisher";

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopping = false;
  private activeRun: Promise<void> | undefined;

  private readonly queueUrl = process.env.SQS_OUTBOX_QUEUE_URL;
  private readonly intervalMs = this.readPositiveInteger(
    "OUTBOX_POLL_INTERVAL_MS",
    2000,
  );
  private readonly batchSize = this.readPositiveInteger(
    "OUTBOX_BATCH_SIZE",
    10,
  );

  constructor(private readonly publisher: OutboxPublisher) {}

  onModuleInit(): void {
    if (!this.queueUrl?.trim()) {
      throw new Error(
        "SQS_OUTBOX_QUEUE_URL is required to start the Outbox worker.",
      );
    }

    this.logger.log(
      `Outbox worker started. Poll interval: ${this.intervalMs}ms; batch size: ${this.batchSize}.`,
    );

    this.activeRun = this.runOnce();

    this.timer = setInterval(() => {
      if (this.stopping || this.running) {
        return;
      }

      this.activeRun = this.runOnce();
    }, this.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    await this.activeRun;

    this.logger.log("Outbox worker stopped.");
  }

  private async runOnce(): Promise<void> {
    if (this.running || this.stopping) {
      return;
    }

    this.running = true;

    try {
      const result = await this.publisher.publishBatch(
        this.queueUrl!,
        this.batchSize,
      );

      if (result.published > 0 || result.failed > 0) {
        this.logger.log(
          `Outbox batch finished. Published: ${result.published}; failed: ${result.failed}.`,
        );
      }
    } catch (error: unknown) {
      const reason =
        error instanceof Error ? error.message : "Unknown worker error";

      this.logger.error(`Outbox polling failed: ${reason}`);
    } finally {
      this.running = false;
    }
  }

  private readPositiveInteger(name: string, fallback: number): number {
    const raw = process.env[name];

    if (raw === undefined || raw.trim() === "") {
      return fallback;
    }

    const value = Number(raw);

    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }

    return value;
  }
}
