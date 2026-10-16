import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";

import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionEntity } from "./wager-transaction.entity";

@Injectable()
export class TransactionalWagerTransactionRepository {
  async insert(
    em: EntityManager,
    transaction: WagerTransaction,
  ): Promise<void> {
    const entity = em.create(WagerTransactionEntity, {
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
        transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      processedAt: transaction.processedAt ?? null,
      createdAt: transaction.createdAt,
      updatedAt: new Date(),
    });

    em.persist(entity);
    await em.flush();
  }

  async findById(
    em: EntityManager,
    transactionId: string,
  ): Promise<WagerTransactionEntity | null> {
    return em.findOne(
      WagerTransactionEntity,
      { id: transactionId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
  }
}
