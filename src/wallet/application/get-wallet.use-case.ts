import { Inject, Injectable } from "@nestjs/common";
import { DomainError } from "../../shared/domain/domain-error";
import { Wallet } from "../domain/wallet";
import {
  WALLET_REPOSITORY,
  type WalletRepository,
} from "../domain/wallet.repository";

export interface GetWalletInput {
  playerId: string;
  currency: string;
}

@Injectable()
export class GetWalletUseCase {
  constructor(
    @Inject(WALLET_REPOSITORY)
    private readonly walletRepository: WalletRepository,
  ) {}

  async execute(input: GetWalletInput): Promise<Wallet> {
    const playerId = input.playerId.trim();

    if (!playerId) {
      throw new DomainError("INVALID_PLAYER_ID", "Player ID is required.");
    }

    const wallet = await this.walletRepository.findByPlayerIdAndCurrency(
      playerId,
      input.currency,
    );

    if (!wallet) {
      throw new DomainError(
        "WALLET_NOT_FOUND",
        "Wallet was not found for this player and currency.",
      );
    }

    return wallet;
  }
}
