import { drizzle } from "drizzle-orm/postgres-js";
import type { Db } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { heartbeatService } from "../services/heartbeat.js";

async function captureList(encoding: string, summary: boolean, failure?: Error) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[]) {
      statements.push({ sql: query, params });
      const result = Promise.resolve([{ server_encoding: encoding }]);
      return Object.assign(result, {
        values: () => failure ? Promise.reject(failure) : Promise.resolve([]),
      });
    },
  };
  const db = drizzle(client as unknown as Db["$client"]) as unknown as Db;
  await heartbeatService(db).list("00000000-0000-4000-8000-000000000001", undefined, 100, { summary });
  return statements.find(statement => statement.sql.includes('from "heartbeat_runs"'))!;
}

describe("heartbeat list JSON decoding", () => {
  it.each([
    ["UTF8", true, 1],
    ["UTF8", false, 2],
    ["SQL_ASCII", true, 1],
    ["SQL_ASCII", false, 1],
  ] as const)("decodes only needed records (encoding=%s, summary=%s)", async (encoding, summary, records) => {
    const { sql } = await captureList(encoding, summary);
    expect(sql.match(/jsonb_to_record/g)).toHaveLength(records);
    expect(sql).not.toContain(" ->> ");
    if (records === 1) expect(sql).not.toContain('"result_json"');
    expect(sql).toContain('order by "heartbeat_runs"."created_at" desc, "heartbeat_runs"."id" desc limit');
  });

  it("propagates database read errors", async () => {
    const failure = new Error("Run history read failed");
    await expect(captureList("UTF8", false, failure)).rejects.toMatchObject({ cause: failure });
  });
});
