import { afterEach, describe, expect, mock, test } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { OutboxPublisher } from "../../../src/messaging/infrastructure/outbox-publisher";
import {
  OutboxPublisherRepository,
  type ClaimedOutboxMessage,
} from "../../../src/messaging/infrastructure/outbox-publisher.repository";

const message: ClaimedOutboxMessage = {
  id: "message-123",
  event_type: "WAGER.PROCESSED",
  aggregate_id: "aggregate-123",
  payload: { transactionId: "transaction-123" },
  attempts: 0,
  lock_token: "lock-123",
};

describe("OutboxPublisher", () => {
  afterEach(() => {
    mock.restore();
  });

  test("publishes a message and marks it as published", async () => {
    const send = mock(async () => ({}));
    const claimBatch = mock(async () => [{ ...message }]);
    const markPublished = mock(async () => true);
    const scheduleRetry = mock(async () => true);

    const sqsClient = { send } as unknown as SQSClient;
    const repository = {
      claimBatch,
      markPublished,
      scheduleRetry,
    } as unknown as OutboxPublisherRepository;

    const publisher = new OutboxPublisher(sqsClient, repository);

    const result = await publisher.publishBatch(
      "http://localhost:4566/000000000000/wager-events",
    );

    expect(result).toEqual({ published: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(markPublished).toHaveBeenCalledWith(message.id, message.lock_token);
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  test("schedules a retry when SQS publishing fails", async () => {
    const send = mock(async () => {
      throw new Error("Temporary SQS failure");
    });
    const claimBatch = mock(async () => [{ ...message }]);
    const markPublished = mock(async () => true);
    const scheduleRetry = mock(async () => true);

    const publisher = new OutboxPublisher(
      { send } as unknown as SQSClient,
      {
        claimBatch,
        markPublished,
        scheduleRetry,
      } as unknown as OutboxPublisherRepository,
    );

    const result = await publisher.publishBatch("http://localhost:4566/queue");

    expect(result).toEqual({ published: 0, failed: 1 });
    expect(markPublished).not.toHaveBeenCalled();
    expect(scheduleRetry).toHaveBeenCalledWith(
      message.id,
      message.lock_token,
      "Temporary SQS failure",
    );
  });

  test("counts a message as failed when its reservation is lost", async () => {
    const send = mock(async () => ({}));
    const claimBatch = mock(async () => [{ ...message }]);
    const markPublished = mock(async () => false);
    const scheduleRetry = mock(async () => true);

    const publisher = new OutboxPublisher(
      { send } as unknown as SQSClient,
      {
        claimBatch,
        markPublished,
        scheduleRetry,
      } as unknown as OutboxPublisherRepository,
    );

    const result = await publisher.publishBatch("http://localhost:4566/queue");

    expect(result).toEqual({ published: 0, failed: 1 });
    expect(markPublished).toHaveBeenCalledWith(message.id, message.lock_token);
    expect(scheduleRetry).not.toHaveBeenCalled();
  });

  test("rejects an empty queue URL before claiming messages", async () => {
    const claimBatch = mock(async () => [{ ...message }]);
    const publisher = new OutboxPublisher(
      { send: mock(async () => ({})) } as unknown as SQSClient,
      {
        claimBatch,
        markPublished: mock(async () => true),
        scheduleRetry: mock(async () => true),
      } as unknown as OutboxPublisherRepository,
    );

    await expect(publisher.publishBatch("  ")).rejects.toThrow(
      "SQS_QUEUE_URL is required.",
    );
    expect(claimBatch).not.toHaveBeenCalled();
  });
});
