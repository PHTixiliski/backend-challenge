import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

/**
 * Authentication is intentionally out of scope for the challenge. Replace this
 * guard with an OIDC-backed provider identity guard without changing routes.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
