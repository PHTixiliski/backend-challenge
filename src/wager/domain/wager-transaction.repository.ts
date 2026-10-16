import { WagerTransaction } from "./wager-transaction";

export const WAGER_TRANSACTION_REPOSITORY = Symbol(
  "WAGER_TRANSACTION_REPOSITORY",
);

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;

  save(transaction: WagerTransaction): Promise<void>;
}
