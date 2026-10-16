import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { MikroORM } from "@mikro-orm/postgresql";

import mikroOrmConfig from "../../../src/mikro-orm.config";
import { Money } from "../../../src/wallet/domain/money";
import { Wallet } from "../../../src/wallet/domain/wallet";
import { MikroOrmWalletRepository } from "../../../src/wallet/infrastructure/mikro-orm-wallet.repository";
import { WalletEntity } from "../../../src/wallet/infrastructure/wallet.entity";

describe("MikroOrmWalletRepository (integration)", () => {
  let orm: MikroORM;
  let repository: MikroOrmWalletRepository;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);

    const em = orm.em.fork();

    repository = new MikroOrmWalletRepository(em.getRepository(WalletEntity));
  });

  afterAll(async () => {
    await orm.close(true);
  });

  test("persists and retrieves a wallet", async () => {
    const playerId = `integration-${randomUUID()}`;

    const wallet = new Wallet({
      id: randomUUID(),
      playerId,
      currency: "BRL",
      balance: Money.zero("BRL"),
      version: 0,
    });

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
    expect(retrieved?.version).toBe(0);
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

    const firstWallet = new Wallet({
      id: randomUUID(),
      playerId,
      currency: "BRL",
      balance: Money.zero("BRL"),
      version: 0,
    });

    const secondWallet = new Wallet({
      id: randomUUID(),
      playerId,
      currency: "BRL",
      balance: Money.zero("BRL"),
      version: 0,
    });

    await repository.save(firstWallet);

    await expect(repository.save(secondWallet)).rejects.toMatchObject({
      code: "WALLET_ALREADY_EXISTS",
    });
  });
});
