import { Injectable } from "@nestjs/common";

interface CounterSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

interface SummarySample {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  max: number;
}

@Injectable()
export class MetricsRegistry {
  private readonly counters = new Map<string, CounterSample>();
  private readonly summaries = new Map<string, SummarySample>();

  increment(name: string, labels: Record<string, string> = {}, amount = 1): void {
    const key = this.key(name, labels);
    const sample = this.counters.get(key) ?? { name, labels: { ...labels }, value: 0 };
    sample.value += amount;
    this.counters.set(key, sample);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = this.key(name, labels);
    const sample = this.summaries.get(key) ?? { name, labels: { ...labels }, count: 0, sum: 0, max: 0 };
    sample.count += 1;
    sample.sum += value;
    sample.max = Math.max(sample.max, value);
    this.summaries.set(key, sample);
  }

  snapshot() {
    return {
      counters: [...this.counters.values()].map((sample) => ({ ...sample, labels: { ...sample.labels } })),
      summaries: [...this.summaries.values()].map((sample) => ({
        ...sample,
        labels: { ...sample.labels },
        average: sample.count === 0 ? 0 : sample.sum / sample.count,
      })),
    };
  }

  private key(name: string, labels: Record<string, string>): string {
    return `${name}:${JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))}`;
  }
}
