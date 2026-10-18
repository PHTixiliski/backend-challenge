import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@mikro-orm/nestjs";
import { EntityRepository } from "@mikro-orm/postgresql";
import { DomainError } from "../../shared/domain/domain-error";
import { WagerTransactionEntity } from "../infrastructure/wager-transaction.entity";

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(
    @InjectRepository(WagerTransactionEntity)
    private readonly transactions: EntityRepository<WagerTransactionEntity>,
  ) {}

  async byId(transactionId: string): Promise<WagerTransactionEntity> {
    const transaction = await this.transactions.findOne({ id: transactionId });
    if (!transaction) {
      throw new DomainError("WAGER_TRANSACTION_NOT_FOUND", "Wager transaction was not found.");
    }
    return transaction;
  }

  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionEntity> {
    const transaction = await this.transactions.findOne({ providerId, externalTransactionId });
    if (!transaction) {
      throw new DomainError("WAGER_TRANSACTION_NOT_FOUND", "Wager transaction was not found.");
    }
    return transaction;
  }
}
