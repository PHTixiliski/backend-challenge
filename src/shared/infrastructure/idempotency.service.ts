import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";

import { IdempotencyRecordEntity } from "./idempotency-record.entity";

export interface StoredIdempotencyResponse {
  payloadHash: string;
  response: Record<string, unknown>;
}

@Injectable()
export class IdempotencyService {
  hashPayload(payload: unknown): string {
    const canonicalPayload = this.canonicalize(payload);

    return createHash("sha256").update(canonicalPayload).digest("hex");
  }

  async find(
    em: EntityManager,
    scope: string,
    key: string,
  ): Promise<StoredIdempotencyResponse | null> {
    const record = await em.findOne(IdempotencyRecordEntity, {
      scope,
      key,
    });

    if (!record) {
      return null;
    }

    return {
      payloadHash: record.payloadHash,
      response: record.response,
    };
  }

  async save(
    em: EntityManager,
    scope: string,
    key: string,
    payloadHash: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const record = em.create(IdempotencyRecordEntity, {
      id: crypto.randomUUID(),
      scope,
      key,
      payloadHash,
      response,
      createdAt: new Date(),
    });

    em.persist(record);
    await em.flush();
  }

  async reserve(
    em: EntityManager,
    scope: string,
    key: string,
    payloadHash: string,
  ): Promise<boolean> {
    const id = crypto.randomUUID();

    const result = await em.getConnection().execute(
      `INSERT INTO idempotency_records
   (id, scope, key, payload_hash, response, created_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT (scope, key) DO NOTHING
   RETURNING id`,
      [id, scope, key, payloadHash, JSON.stringify({}), new Date()],
      "all",
      em.getTransactionContext(),
    );

    return Array.isArray(result) && result.length > 0;
  }

  async updateResponse(
    em: EntityManager,
    scope: string,
    key: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await em.nativeUpdate(
      IdempotencyRecordEntity,
      { scope, key },
      { response },
    );
  }

  private canonicalize(value: unknown): string {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map((item) => this.canonicalize(item)).join(",")}]`;
    }

    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();

    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${this.canonicalize(object[key])}`)
      .join(",")}}`;
  }
}
