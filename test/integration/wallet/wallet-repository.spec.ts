import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../../src/mikro-orm.config";
import { assertIntegrationDatabaseConfigured } from "../assert-integration-database";
import { Money } from "../../../src/wallet/domain/money";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { MikroOrmWalletRepository } from "../../../src/wallet/infrastructure/mikro-orm-wallet.repository";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";

describe("MikroOrmWalletRepository (integration)", () => {
  let orm: MikroORM;
  let repository: MikroOrmWalletRepository;
  const testWalletIds: string[] = [];

  beforeAll(async () => {
    assertIntegrationDatabaseConfigured();
    orm = await MikroORM.init(mikroOrmConfig);
    const em = orm.em.fork();
    repository = new MikroOrmWalletRepository(em.getRepository(WalletEntity));
  });

  afterAll(async () => {
    await orm.close(true);
  });

  afterEach(async () => {
    for (const id of testWalletIds.splice(0)) {
      await orm.em.fork().nativeDelete(WalletEntity, { id });
    }
  });

  test("persists and retrieves a wallet", async () => {
    const playerId = `integration-${randomUUID()}`;

    const wallet = Wallet.rehydrate({
      id: randomUUID(),
      playerId,
      currency: "BRL",
      balance: Money.zero("BRL"),
      version: 1,
    });

    testWalletIds.push(wallet.id);
    await repository.save(wallet);

    const retrieved = await repository.findByPlayerIdAndCurrency(
      playerId,
      "BRL",
    );

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(wallet.id);
    expect(retrieved?.playerId).toBe(playerId);
    expect(retrieved?.currency).toBe("BRL");
    expect(retrieved?.balance.toString()).toBe("0.00");
    expect(retrieved?.version).toBe(1);
  });

  test("returns null when the wallet does not exist", async () => {
    const result = await repository.findByPlayerIdAndCurrency(
      `missing-${randomUUID()}`,
      "BRL",
    );

    expect(result).toBeNull();
  });

  test("rejects a duplicate wallet for the same player and currency", async () => {
    const playerId = `duplicate-${randomUUID()}`;

    const firstWallet = Wallet.rehydrate({
      id: randomUUID(),
      playerId,
      currency: "BRL",
      balance: Money.zero("BRL"),
      version: 1,
    });

    const secondWallet = Wallet.rehydrate({
      id: randomUUID(),
      playerId,
      currency: "BRL",
      balance: Money.zero("BRL"),
      version: 1,
    });

    testWalletIds.push(firstWallet.id);
    await repository.save(firstWallet);

    await expect(repository.save(secondWallet)).rejects.toMatchObject({
      code: "WALLET_ALREADY_EXISTS",
    });
  });

  test("rejects a wallet with a negative balance at the database level", async () => {
    const em = orm.em.fork();
    const walletId = randomUUID();
    const now = new Date();

    await expect(
      em.insert(WalletEntity, {
        id: walletId,
        playerId: `negative-balance-${randomUUID()}`,
        currency: "BRL",
        balance: "-1.00",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  test("rejects a funded wallet without an opening ledger entry at the database level", async () => {
    const em = orm.em.fork();
    const now = new Date();

    await expect(
      em.insert(WalletEntity, {
        id: randomUUID(),
        playerId: `missing-opening-ledger-${randomUUID()}`,
        currency: "BRL",
        balance: "10.00",
        version: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  test("rejects an initial wallet version below one at the database level", async () => {
    const em = orm.em.fork();
    const now = new Date();

    await expect(
      em.insert(WalletEntity, {
        id: randomUUID(),
        playerId: `invalid-version-${randomUUID()}`,
        currency: "BRL",
        balance: "0.00",
        version: 0,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow();
  });
});
