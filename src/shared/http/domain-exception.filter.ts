import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import { DomainError } from "../domain/domain-error";

const DOMAIN_ERROR_STATUS: Record<string, number> = {
  INVALID_PLAYER_ID: HttpStatus.BAD_REQUEST,
  INVALID_CURRENCY: HttpStatus.BAD_REQUEST,
  INVALID_MONEY_AMOUNT: HttpStatus.BAD_REQUEST,
  INVALID_MONEY_PRECISION: HttpStatus.BAD_REQUEST,
  INVALID_WALLET: HttpStatus.BAD_REQUEST,
  INVALID_WALLET_BALANCE: HttpStatus.BAD_REQUEST,
  INVALID_WALLET_VERSION: HttpStatus.BAD_REQUEST,
  INVALID_AMOUNT: HttpStatus.BAD_REQUEST,
  CURRENCY_MISMATCH: HttpStatus.BAD_REQUEST,
  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
  INSUFFICIENT_FUNDS: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const status =
      DOMAIN_ERROR_STATUS[exception.code] ?? HttpStatus.BAD_REQUEST;

    response.status(status).json({
      statusCode: status,
      code: exception.code,
      message: exception.message,
    });
  }
}
