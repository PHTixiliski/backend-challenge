import { Inject, Injectable, Optional } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { MetricsRegistry } from "../../observability/metrics.registry";

@Injectable()
export class PostgresTransactionManager {
  constructor(
    @Inject(EntityManager)
    private readonly entityManager: EntityManager,
    @Optional() private readonly metrics?: MetricsRegistry,
  ) {}

  async execute<T>(
    operation: (em: EntityManager) => Promise<T>,
    existingEm?: EntityManager,
  ): Promise<T> {
    if (existingEm) {
      return operation(existingEm);
    }

    const em = this.entityManager.fork();

    try {
      return await em.transactional(async (transactionalEm) =>
        operation(transactionalEm),
      );
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
      if (["40P01", "55P03", "40001"].includes(code)) {
        this.metrics?.increment("database_lock_conflicts_total", { code });
      }
      throw error;
    }
  }
}
