import { SQSClient } from "@aws-sdk/client-sqs";

export function createSqsClient(): SQSClient {
  const region = process.env.AWS_REGION;
  const endpoint = process.env.SQS_ENDPOINT;

  if (!region) {
    throw new Error("AWS_REGION is required.");
  }

  return new SQSClient({
    region,
    ...(endpoint ? { endpoint } : {}),
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  });
}
