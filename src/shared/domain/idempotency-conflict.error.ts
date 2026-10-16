import { DomainError } from "./domain-error";

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super(
      "IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used with a different payload.",
    );
  }
}
