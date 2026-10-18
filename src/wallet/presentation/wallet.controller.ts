import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseFilters,
  UseGuards,
} from "@nestjs/common";

import { CreateWalletUseCase } from "../application/create-wallet.use-case";
import { GetWalletUseCase } from "../application/get-wallet.use-case";
import { DomainExceptionFilter } from "../../shared/http/domain-exception.filter";
import { ListWalletLedgerUseCase } from "../application/list-wallet-ledger.use-case";
import { ReconcileWalletUseCase } from "../application/reconcile-wallet.use-case";
import { DomainError } from "../../shared/domain/domain-error";
import { OptionalAuthGuard } from "../../shared/http/optional-auth.guard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_REQUEST_BODY", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

@Controller("wallets")
@UseFilters(DomainExceptionFilter)
@UseGuards(OptionalAuthGuard)
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly listLedger: ListWalletLedgerUseCase,
    private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  @Post()
  async create(@Body() body: unknown) {
    if (!isRecord(body)) {
      throw new DomainError("INVALID_REQUEST_BODY", "Request body must be a JSON object.");
    }
    const playerId = requiredString(body.playerId, "playerId");
    const currency = body.currency === undefined
      ? undefined
      : requiredString(body.currency, "currency");
    let initialBalance: { amount: string; currency: string } | undefined;
    if (body.initialBalance !== undefined) {
      if (!isRecord(body.initialBalance)) {
        throw new DomainError("INVALID_REQUEST_BODY", "initialBalance must be a JSON object.");
      }
      initialBalance = {
        amount: requiredString(body.initialBalance.amount, "initialBalance.amount"),
        currency: requiredString(body.initialBalance.currency, "initialBalance.currency"),
      };
    }
    const wallet = await this.createWallet.execute({ playerId, currency, initialBalance });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: { amount: wallet.balance.toString(), currency: wallet.currency },
      version: wallet.version,
    };
  }

  @Get(":walletId")
  async get(
    @Param("walletId") walletId: string,
    @Query("currency") currency?: string,
  ) {
    const wallet = await this.getWallet.execute({ walletId, currency });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: { amount: wallet.balance.toString(), currency: wallet.currency },
      version: wallet.version,
    };
  }

  @Get(":walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.listLedger.execute(walletId, cursor, limit ? Number(limit) : 50);
  }

  @Post(":walletId/reconciliation")
  async reconcile(@Param("walletId") walletId: string) {
    return this.reconcileWallet.execute(walletId);
  }
}
