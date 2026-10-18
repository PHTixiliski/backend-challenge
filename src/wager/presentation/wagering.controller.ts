import { Body, Controller, Get, Headers, Param, Post, Res, UseFilters, UseGuards } from "@nestjs/common";

import {
  ProcessBetUseCase,
  type ProcessBetInput,
} from "../application/process-bet.use-case";
import { DomainExceptionFilter } from "../../shared/http/domain-exception.filter";
import { DomainError } from "../../shared/domain/domain-error";
import { OptionalAuthGuard } from "../../shared/http/optional-auth.guard";
import { GetWagerTransactionUseCase } from "../application/get-wager-transaction.use-case";

type ProcessBetRequest = Omit<ProcessBetInput, "idempotencyKey">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_REQUEST_BODY", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function parseWagerRequest(value: unknown): ProcessBetRequest {
  if (!isRecord(value)) {
    throw new DomainError("INVALID_REQUEST_BODY", "Request body must be a JSON object.");
  }
  const request: ProcessBetRequest = {
    providerId: requiredString(value.providerId, "providerId"),
    externalTransactionId: requiredString(value.externalTransactionId, "externalTransactionId"),
    playerId: requiredString(value.playerId, "playerId"),
    walletId: requiredString(value.walletId, "walletId"),
    roundId: requiredString(value.roundId, "roundId"),
    gameId: requiredString(value.gameId, "gameId"),
  };
  if (value.kind !== undefined) request.kind = requiredString(value.kind, "kind") as ProcessBetInput["kind"];
  if (value.referenceExternalTransactionId !== undefined) {
    request.referenceExternalTransactionId = requiredString(value.referenceExternalTransactionId, "referenceExternalTransactionId");
  }
  if (value.money !== undefined) {
    if (!isRecord(value.money)) {
      throw new DomainError("INVALID_REQUEST_BODY", "money must be a JSON object.");
    }
    request.money = {
      amount: requiredString(value.money.amount, "money.amount"),
      currency: requiredString(value.money.currency, "money.currency"),
    };
  } else {
    request.amount = requiredString(value.amount, "amount");
    request.currency = requiredString(value.currency, "currency");
  }
  return request;
}

@Controller()
@UseFilters(DomainExceptionFilter)
@UseGuards(OptionalAuthGuard)
export class WageringController {
  constructor(
    private readonly processBet: ProcessBetUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
  ) {}

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    return this.serialize(await this.getTransaction.byId(transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProviderExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.serialize(await this.getTransaction.byProviderExternalId(providerId, externalTransactionId));
  }

  @Post("wagering/transactions")
  async submit(
    @Body() rawBody: unknown,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Res({ passthrough: true }) response?: { statusCode: number },
  ) {
    const body = parseWagerRequest(rawBody);
    const result = await this.processBet.execute({
      ...body,
      idempotencyKey: idempotencyKey ?? "",
    });
    if (response) {
      response.statusCode = result.idempotentReplay
        ? 200
        : result.status === "PENDING_REFERENCE"
          ? 202
          : result.status === "REJECTED" || result.status === "FAILED"
            ? 422
            : 200;
    }
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance === null ? null : {
        amount: result.balance,
        currency: (body.money?.currency ?? body.currency)?.trim().toUpperCase(),
      },
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay ?? false,
    };
  }

  private serialize(transaction: {
    id: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    type: string;
    currency: string;
    amount: string;
    status: string;
    failureCode: string | null;
    createdAt: Date;
    processedAt: Date | null;
  }) {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      walletId: transaction.walletId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.type,
      money: { amount: transaction.amount, currency: transaction.currency },
      status: transaction.status,
      failureCode: transaction.failureCode,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    };
  }
}
