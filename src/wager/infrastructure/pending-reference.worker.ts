import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ProcessBetUseCase } from "../application/process-bet.use-case";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopping = false;
  private activeRun: Promise<void> | undefined;
  private readonly intervalMs = this.readPositiveInteger("REFERENCE_POLL_INTERVAL_MS", 1000);
  private readonly batchSize = this.readPositiveInteger("REFERENCE_BATCH_SIZE", 25);

  constructor(private readonly processWager: ProcessBetUseCase) {}

  onModuleInit(): void {
    this.activeRun = this.runOnce();
    this.timer = setInterval(() => {
      if (!this.running && !this.stopping) this.activeRun = this.runOnce();
    }, this.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeRun;
  }

  private async runOnce(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const processed = await this.processWager.retryPendingReferences(this.batchSize);
      if (processed > 0) this.logger.log(JSON.stringify({ event: "pending_reference_batch", processed }));
    } catch (error: unknown) {
      this.logger.error("Pending reference retry failed.", error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  private readPositiveInteger(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw?.trim()) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    return value;
  }
}
