import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@mikro-orm/nestjs";
import { EntityRepository } from "@mikro-orm/postgresql";

import type { WalletLedgerRepository } from "../domain/wallet-ledger.repository";
import { WalletLedgerEntry } from "../domain/wallet-ledger-entry";
import { WalletLedgerEntryEntity } from "./wallet-ledger-entry.entity";

@Injectable()
export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(
    @InjectRepository(WalletLedgerEntryEntity)
    private readonly ledgerEntityRepository: EntityRepository<WalletLedgerEntryEntity>,
  ) {}

  async save(entry: WalletLedgerEntry): Promise<void> {
    const entity = this.ledgerEntityRepository.create({
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

    await this.ledgerEntityRepository.insert(entity);
  }
}
