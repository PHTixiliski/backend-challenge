import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";

import { Money } from "../domain/money";
import { Wallet } from "../domain/wallet";
import { WalletEntity } from "./wallet.entity";

@Injectable()
export class TransactionalWalletRepository {
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

    return new Wallet({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.create(entity.balance, entity.currency),
      version: entity.version,
    });
  }

  async findByIdForUpdate(
    em: EntityManager,
    walletId: string,
  ): Promise<Wallet | null> {
    const entity = await em.findOne(
      WalletEntity,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );

    if (!entity) {
      return null;
    }

    return new Wallet({
      id: entity.id,
      playerId: entity.playerId,
      currency: entity.currency,
      balance: Money.create(entity.balance, entity.currency),
      version: entity.version,
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
        updatedAt: new Date(),
      },
    );

    if (affectedRows !== 1) {
      throw new Error(
        `Expected to update one wallet, but updated ${affectedRows}.`,
      );
    }
  }
}
