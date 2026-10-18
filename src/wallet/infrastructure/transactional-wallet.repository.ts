import { Injectable, Optional } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";

import { Money } from "../domain/money";
import { Wallet } from "../domain/wallet";
import { WalletEntity } from "./wallet.entity";
import { DomainError } from "../../shared/domain/domain-error";
import { MetricsRegistry } from "../../observability/metrics.registry";

@Injectable()
export class TransactionalWalletRepository {
  constructor(@Optional() private readonly metrics?: MetricsRegistry) {}

  async insert(em: EntityManager, wallet: Wallet): Promise<void> {
    const entity = em.create(WalletEntity, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    try {
      em.persist(entity);
      await em.flush();
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new DomainError(
          "WALLET_ALREADY_EXISTS",
          "A wallet already exists for this player and currency.",
        );
      }
      throw error;
    }
  }

  async findByPlayerIdAndCurrencyForUpdate(
    em: EntityManager,
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const entity = await em.findOne(
      WalletEntity,
      { playerId, currency },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (!entity) {
      return null;
    }

    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.create(entity.balance, entity.currency),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  async findByIdForUpdate(
    em: EntityManager,
    walletId: string,
  ): Promise<Wallet | null> {
    const lockStartedAt = Date.now();
    const entity = await em.findOne(
      WalletEntity,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    const lockWaitMs = Date.now() - lockStartedAt;
    this.metrics?.observe("wallet_lock_wait_ms", lockWaitMs);
    if (lockWaitMs >= 25) this.metrics?.increment("wallet_lock_conflicts_total");

    if (!entity) {
      return null;
    }

    return Wallet.rehydrate({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.create(entity.balance, entity.currency),
      version: entity.version,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });
  }

  async updateBalance(em: EntityManager, wallet: Wallet): Promise<void> {
    const affectedRows = await em.nativeUpdate(
      WalletEntity,
      {
        id: wallet.id,
      },
      {
        balance: wallet.balance.toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );

    if (affectedRows !== 1) {
      throw new Error(
        `Expected to update one wallet, but updated ${affectedRows}.`,
      );
    }
  }
}
