import type { MikroORM } from "@mikro-orm/postgresql";

/** Removes only financial fixtures whose wallet IDs were created by a test. */
export async function cleanupTestWallets(
  orm: MikroORM,
  walletIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(walletIds)];
  if (ids.length === 0) return;

  await orm.em.fork().transactional(async (em) => {
    const placeholders = ids.map(() => "?").join(", ");
    const transactions = await em.getConnection().execute<
      Array<{ id: string; idempotency_key: string }>
    >(
      `SELECT id, idempotency_key FROM wager_transactions WHERE wallet_id IN (${placeholders})`,
      ids,
    );
    const aggregateIds = [...ids, ...transactions.map(({ id }) => id)];
    const aggregatePlaceholders = aggregateIds.map(() => "?").join(", ");

    await em.getConnection().execute(
      `DELETE FROM outbox_messages WHERE aggregate_id IN (${aggregatePlaceholders})`,
      aggregateIds,
    );

    const idempotencyKeys = transactions.map(({ idempotency_key }) => idempotency_key);
    if (idempotencyKeys.length > 0) {
      const keyPlaceholders = idempotencyKeys.map(() => "?").join(", ");
      await em.getConnection().execute(
        `DELETE FROM idempotency_records WHERE scope = ? AND key IN (${keyPlaceholders})`,
        ["PROCESS_BET", ...idempotencyKeys],
      );
    }

    await em.getConnection().execute(
      "ALTER TABLE wallet_ledger_entries DISABLE TRIGGER wallet_ledger_entries_immutable",
    );
    try {
      await em.getConnection().execute(
        `DELETE FROM wallet_ledger_entries WHERE wallet_id IN (${placeholders})`,
        ids,
      );
    } finally {
      await em.getConnection().execute(
        "ALTER TABLE wallet_ledger_entries ENABLE TRIGGER wallet_ledger_entries_immutable",
      );
    }

    await em.getConnection().execute(
      `DELETE FROM wager_transactions WHERE wallet_id IN (${placeholders})`,
      ids,
    );
    await em.getConnection().execute(
      `DELETE FROM wallets WHERE id IN (${placeholders})`,
      ids,
    );
  });
}
