import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";

import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { WalletLedgerEntryEntity } from "./wallet-ledger-entry.entity";

@Injectable()
export class TransactionalWalletLedgerRepository {
  async insert(em: EntityManager, entry: WalletLedgerEntry): Promise<void> {
    const entity = em.create(WalletLedgerEntryEntity, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      type: entry.type,
      currency: entry.amount.currency,
      amount: entry.amount.toString(),
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      createdAt: entry.createdAt,
    });

    em.persist(entity);
    await em.flush();
  }
}
