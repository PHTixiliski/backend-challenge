import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { DomainError } from "../../shared/domain/domain-error";

interface LedgerCursor {
  createdAt: string;
  id: string;
}

@Injectable()
export class ListWalletLedgerUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async execute(walletId: string, cursor?: string, requestedLimit = 50) {
    const limit = Number.isInteger(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 100))
      : 50;
    let after: LedgerCursor | undefined;
    if (cursor) {
      try {
        after = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as LedgerCursor;
        if (!after.createdAt || !after.id || Number.isNaN(Date.parse(after.createdAt))) throw new Error();
      } catch {
        throw new DomainError("INVALID_LEDGER_CURSOR", "Ledger cursor is invalid.");
      }
    }

    const params: unknown[] = [walletId];
    let cursorClause = "";
    if (after) {
      cursorClause = "AND (created_at, id) < (?, ?::uuid)";
      params.push(after.createdAt, after.id);
    }
    params.push(limit + 1);
    const rows = await this.em.getConnection().execute(
      `SELECT id, transaction_id AS "transactionId", type, currency, amount,
              balance_before AS "balanceBefore", balance_after AS "balanceAfter", created_at AS "createdAt"
       FROM wallet_ledger_entries
       WHERE wallet_id = ? ${cursorClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      params,
    ) as Array<Record<string, unknown>>;

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: new Date(last.createdAt as string).toISOString(), id: last.id }), "utf8").toString("base64url")
      : null;
    return { items, nextCursor };
  }
}
