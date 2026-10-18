export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze({ ...props.data });
  }

  toJSON() {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

type EventData = Record<string, unknown>;
type EventProps = IntegrationEventProps<EventData>;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: "DEBIT" | "CREDIT";
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<EventData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;
  constructor(props: EventProps) { super(props); }
}

export class WagerTransactionRejected extends IntegrationEvent<EventData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;
  constructor(props: EventProps) { super(props); }
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;
  constructor(props: IntegrationEventProps<WalletBalanceChangedData>) { super(props); }
}

export class WagerTransactionPendingReference extends IntegrationEvent<EventData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;
  constructor(props: EventProps) { super(props); }
}

export function integrationEventFromOutbox(
  props: EventProps & { eventType: string },
): IntegrationEvent<EventData> {
  switch (props.eventType) {
    case "WAGER.PROCESSED":
    case "WagerTransactionProcessed":
      return new WagerTransactionProcessed(props);
    case "WAGER.REJECTED":
    case "WagerTransactionRejected":
      return new WagerTransactionRejected(props);
    case "WALLET.BALANCE_CHANGED":
    case "WalletBalanceChanged":
      return new WalletBalanceChanged({
        ...props,
        data: props.data as unknown as WalletBalanceChangedData,
      });
    case "WAGER.PENDING_REFERENCE":
    case "WagerTransactionPendingReference":
      return new WagerTransactionPendingReference(props);
    default:
      throw new Error(`Unsupported outbox event type: ${props.eventType}`);
  }
}
