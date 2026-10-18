import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@mikro-orm/nestjs";
import { EntityRepository } from "@mikro-orm/postgresql";

import { Money } from "../domain/money";
import { Wallet } from "../domain/wallet";
import type { WalletRepository } from "../domain/wallet.repository";
import { WalletEntity } from "./wallet.entity";
import { DomainError } from "../../shared/domain/domain-error";

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    @InjectRepository(WalletEntity)
    private readonly walletEntityRepository: EntityRepository<WalletEntity>,
  ) {}

  async findById(walletId: string): Promise<Wallet | null> {
    const entity = await this.walletEntityRepository.findOne({ id: walletId });
    return entity ? this.toDomain(entity) : null;
  }

  async findByPlayerIdAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | null> {
    const entity = await this.walletEntityRepository.findOne({
      playerId,
      currency,
    });

    if (!entity) {
      return null;
    }

    return this.toDomain(entity);
  }

  async save(wallet: Wallet): Promise<void> {
    const entity = this.walletEntityRepository.create({
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });

    try {
      await this.walletEntityRepository.insert(entity);
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

  private toDomain(entity: WalletEntity): Wallet {
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
}
