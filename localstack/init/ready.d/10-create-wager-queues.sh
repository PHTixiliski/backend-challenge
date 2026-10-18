#!/bin/bash
set -euo pipefail

max_receive_count="${SQS_MAX_RECEIVE_COUNT:-5}"
if ! [[ "$max_receive_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "SQS_MAX_RECEIVE_COUNT must be a positive integer" >&2
  exit 1
fi

dlq_name="wager-transactions-dlq.fifo"
queue_name="wager-transactions.fifo"
events_name="wager-events.fifo"

dlq_url="$(awslocal sqs create-queue \
  --queue-name "$dlq_name" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' \
  --query QueueUrl --output text)"
dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text)"

redrive_policy="$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' \
  "$dlq_arn" "$max_receive_count")"
attributes="$(python3 -c 'import json, sys; print(json.dumps({
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "60",
  "RedrivePolicy": sys.argv[1],
}))' "$redrive_policy")"

awslocal sqs create-queue \
  --queue-name "$queue_name" \
  --attributes "$attributes" >/dev/null

awslocal sqs create-queue \
  --queue-name "$events_name" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}' >/dev/null

echo "Initialized $queue_name with redrive to $dlq_name (maxReceiveCount=$max_receive_count) and $events_name."
