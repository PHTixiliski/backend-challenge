import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseFilters,
} from "@nestjs/common";

import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { GetWalletUseCase } from "../application/get-wallet.use-case";
import { DomainExceptionFilter } from "../../shared/http/domain-exception.filter";

@Controller("wallets")
@UseFilters(DomainExceptionFilter)
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: { playerId: string; currency: string }) {
    const wallet = await this.createWallet.execute(body);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
    };
  }

  @Get(":playerId")
  async get(
    @Param("playerId") playerId: string,
    @Query("currency") currency: string,
  ) {
    const wallet = await this.getWallet.execute({ playerId, currency });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
    };
  }
}
