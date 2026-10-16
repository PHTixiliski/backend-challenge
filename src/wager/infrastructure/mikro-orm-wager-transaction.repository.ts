import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@mikro-orm/nestjs";
import { EntityRepository } from "@mikro-orm/postgresql";

import { Money } from "../../wallet/domain/money";
import { WagerTransaction } from "../domain/wager-transaction";
import type { WagerTransactionRepository } from "../domain/wager-transaction.repository";
import {
  WagerTransactionStatus,
  WagerTransactionType,
} from "../domain/wager-transaction.types";
import { WagerTransactionEntity } from "./wager-transaction.entity";

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(
    @InjectRepository(WagerTransactionEntity)
    private readonly transactionEntityRepository: EntityRepository<WagerTransactionEntity>,
  ) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const entity = await this.transactionEntityRepository.findOne({ id });

    return entity ? this.toDomain(entity) : null;
  }

  async save(transaction: WagerTransaction): Promise<void> {
    const entity = this.transactionEntityRepository.create({
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      type: transaction.type,
      currency: transaction.amount.currency,
      amount: transaction.amount.toString(),
      status: transaction.status,
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      failureCode: transaction.failureCode,
      processedAt: transaction.processedAt,
      createdAt: transaction.createdAt,
      updatedAt: new Date(),
    });

    await this.transactionEntityRepository.insert(entity);
  }

  private toDomain(entity: WagerTransactionEntity): WagerTransaction {
    return new WagerTransaction({
      id: entity.id,
      providerId: entity.providerId,
      externalTransactionId: entity.externalTransactionId,
      idempotencyKey: entity.idempotencyKey,
      payloadHash: entity.payloadHash,
      walletId: entity.walletId,
      playerId: entity.playerId,
      roundId: entity.roundId,
      gameId: entity.gameId,
      type: entity.type,
      amount: Money.create(entity.amount, entity.currency),
      status: entity.status,
      referenceExternalTransactionId:
        entity.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: entity.referenceTransactionId ?? undefined,
      failureCode: entity.failureCode ?? undefined,
      createdAt: entity.createdAt,
      processedAt: entity.processedAt ?? undefined,
    });
  }
}
