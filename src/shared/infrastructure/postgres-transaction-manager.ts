import { Injectable } from "@nestjs/common";
import { InjectEntityManager } from "@mikro-orm/nestjs";
import { EntityManager } from "@mikro-orm/postgresql";

@Injectable()
export class PostgresTransactionManager {
  constructor(
    @InjectEntityManager("default")
    private readonly entityManager: EntityManager,
  ) {}

  async execute<T>(operation: (em: EntityManager) => Promise<T>): Promise<T> {
    const em = this.entityManager.fork();

    return em.transactional(async (transactionalEm) =>
      operation(transactionalEm),
    );
  }
}
