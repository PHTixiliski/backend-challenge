import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '../../shared/domain/domain-error';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from '../domain/wallet.repository';

export interface CreateWalletInput {
  playerId: string;
  currency: string;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY)
    private readonly walletRepository: WalletRepository,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const playerId = input.playerId.trim();
    const currency = input.currency;

    if (!playerId) {
      throw new DomainError(
        'INVALID_PLAYER_ID',
        'Player ID is required.',
      );
    }

    // Validate the currency and create the initial zero balance.
    const initialBalance = Money.zero(currency);

    const existingWallet =
      await this.walletRepository.findByPlayerIdAndCurrency(
        playerId,
        currency,
      );

    if (existingWallet) {
      throw new DomainError(
        'WALLET_ALREADY_EXISTS',
        'A wallet already exists for this player and currency.',
      );
    }

    const wallet = new Wallet({
      id: randomUUID(),
      playerId,
      currency,
      balance: initialBalance,
      version: 0,
    });

    await this.walletRepository.save(wallet);

    return wallet;
  }
}
