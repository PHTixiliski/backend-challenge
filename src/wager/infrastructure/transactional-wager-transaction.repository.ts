import { Injectable } from "@nestjs/common";
import { EntityManager, LockMode } from "@mikro-orm/postgresql";

import { WagerTransaction } from "../domain/wager-transaction";
import { WagerTransactionEntity } from "./wager-transaction.entity";
import { WagerTransactionStatus } from "../domain/wager-transaction.types";
import { DomainError } from "../../shared/domain/domain-error";

@Injectable()
export class TransactionalWagerTransactionRepository {
  async findDuePendingReferenceIds(
    em: EntityManager,
    limit: number,
    transactionIds?: readonly string[],
  ): Promise<string[]> {
    if (transactionIds && transactionIds.length === 0) return [];
    const idFilter = transactionIds
      ? `AND id IN (${transactionIds.map(() => "?").join(", ")})`
      : "";
    const parameters = transactionIds
      ? [WagerTransactionStatus.PENDING_REFERENCE, ...transactionIds, limit]
      : [WagerTransactionStatus.PENDING_REFERENCE, limit];
    const rows = await em.getConnection().execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions
       WHERE status = ? AND reference_next_attempt_at <= NOW()
       ${idFilter}
       ORDER BY reference_next_attempt_at ASC, id ASC
       LIMIT ?`,
      parameters,
    );
    return rows.map((row) => row.id);
  }

  async findByProviderAndExternalId(
    em: EntityManager,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionEntity | null> {
    return em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
  }

  async hasPriorReversal(
    em: EntityManager,
    referenceTransactionId: string,
    type: WagerTransactionEntity["type"],
  ): Promise<boolean> {
    return (await em.count(WagerTransactionEntity, {
      referenceTransactionId,
      type,
      status: WagerTransactionStatus.PROCESSED,
    })) > 0;
  }

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
      referenceAttempts: 0,
      referenceNextAttemptAt: transaction.status === WagerTransactionStatus.PENDING_REFERENCE
        ? new Date(Date.now() + 2000)
        : null,
      createdAt: transaction.createdAt,
      updatedAt: new Date(),
    });

    em.persist(entity);
    try {
      await em.flush();
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505" &&
        "constraint" in error &&
        error.constraint === "wager_transactions_provider_external_id_unique"
      ) {
        throw new DomainError(
          "EXTERNAL_TRANSACTION_ID_REUSED",
          "The provider transaction ID has already been used.",
        );
      }
      throw error;
    }
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
