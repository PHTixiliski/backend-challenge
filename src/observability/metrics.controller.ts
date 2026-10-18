import { Controller, Get } from "@nestjs/common";
import { MetricsRegistry } from "./metrics.registry";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: MetricsRegistry) {}

  @Get()
  getMetrics() {
    return this.metrics.snapshot();
  }
}
