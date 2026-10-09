import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import * as schema from "@paperclipai/db/schema/index";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Config = Parameters<Db["transaction"]>[1];
type State = { jit: string; readOnly: string; pid: number };

(support.supported ? describe : describe.skip)("issue list/count JIT scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let client: Db["$client"];
  let scoped = false;
  const queries: Array<{ query: string; scoped: boolean }> = [];
  const companyId = randomUUID();
  const foreignCompanyId = randomUUID();
  const visibleIds = [randomUUID(), randomUUID()];
  const state = async (connection: Db | Tx) => (await connection.execute<State>(sql`SELECT
    current_setting('jit') AS jit, current_setting('transaction_read_only') AS "readOnly", pg_backend_pid() AS pid`))[0];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("issue-read-jit");
    client = createDb(database.connectionString, { maxConnections: 1, prepare: false }).$client;
    db = drizzle(client, { schema, logger: { logQuery(query) { queries.push({ query, scoped }); } } });
    await client.unsafe("SET jit = on");
    await db.insert(schema.companies).values([
      { id: companyId, name: "Issue reads", issuePrefix: "JITISSUE" },
      { id: foreignCompanyId, name: "Other", issuePrefix: "JITFOREIGN" },
    ]);
    await db.insert(schema.issues).values([
      { id: visibleIds[0], companyId, title: "Open", status: "todo" },
      { id: visibleIds[1], companyId, title: "Done", status: "done" },
      { companyId, title: "Hidden", hiddenAt: new Date() },
      { companyId: foreignCompanyId, title: "Foreign" },
    ]);
  }, 90_000);

  afterAll(async () => { vi.restoreAllMocks(); await client?.end({ timeout: 0 }); await database?.cleanup(); });

  const read = (kind: "list" | "count") => kind === "list"
    ? issueService(db).list(companyId, { limit: 100, sortField: "updated", sortDir: "desc" })
    : issueService(db).count(companyId);

  it.each(["list", "count"] as const)("isolates only the %s query and restores JIT on the same connection", async (kind) => {
    const before = await state(db);
    const transaction = db.transaction.bind(db);
    let inside!: State;
    const spy = vi.spyOn(db, "transaction").mockImplementation(
      async <T>(body: (tx: Tx) => Promise<T>, config?: Config): Promise<T> => transaction(async (tx) => {
        scoped = true;
        let value: T;
        try { value = await body(tx); } finally { scoped = false; }
        inside = await state(tx);
        return value;
      }, config),
    );
    queries.length = 0;
    try {
      const result = await read(kind);
      if (Array.isArray(result)) {
        expect(result.map((row) => row.id).sort()).toEqual([...visibleIds].sort());
        expect(result.every((row) => row.createdAt instanceof Date && row.updatedAt instanceof Date)).toBe(true);
      } else expect(result).toBe(2);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toEqual({ accessMode: "read only" });
      const scopedQueries = queries.filter((query) => query.scoped);
      expect(scopedQueries).toHaveLength(2);
      expect(scopedQueries[0].query).toBe("SET LOCAL jit = off");
      expect(scopedQueries[1].query).toMatch(/^(select|with)/i);
      expect(inside).toEqual({ jit: "off", readOnly: "on", pid: before.pid });
      expect(await state(db)).toEqual(before);
    } finally { spy.mockRestore(); }
  });

  it.each(["list", "count"] as const)("propagates a %s failure and rolls back local settings", async (kind) => {
    const before = await state(db);
    const failure = new Error(`${kind} read failed`);
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementation(
      async <T>(body: (tx: Tx) => Promise<T>, config?: Config): Promise<T> => transaction(async (tx) => {
        const select = vi.spyOn(tx, "select").mockImplementation(() => { throw failure; });
        try { return await body(tx); } finally { select.mockRestore(); }
      }, config),
    );
    try {
      await expect(read(kind)).rejects.toBe(failure);
      expect(await state(db)).toEqual(before);
    } finally { spy.mockRestore(); }
  });

  it.each([
    ["list", "on"], ["count", "on"], ["list", "off"], ["count", "off"],
  ] as const)("restores the caller transaction after %s (JIT=%s)", async (kind, jit) => {
    const before = await state(db);
    await db.transaction(async (outer) => {
      await outer.execute(sql`SELECT set_config('jit', ${jit}, true)`);
      const caller = await state(outer);
      const svc = issueService(outer as unknown as Db);
      const result = kind === "list" ? await svc.list(companyId, { limit: 100 }) : await svc.count(companyId);
      expect(Array.isArray(result) ? result.length : result).toBe(2);
      expect(await state(outer)).toEqual(caller);
      // A borrowed read must also retain the caller's write capability.
      await outer.update(schema.companies).set({ name: "Issue reads" }).where(sql`${schema.companies.id} = ${companyId}`);
    });
    expect(await state(db)).toEqual(before);
  });

  it.each(["list", "count"] as const)("restores the caller transaction after a %s failure", async (kind) => {
    await db.transaction(async (outer) => {
      const caller = await state(outer);
      const failure = new Error("Nested issue read failed");
      const transaction = outer.transaction.bind(outer);
      const spy = vi.spyOn(outer, "transaction").mockImplementation(
        async <T>(body: (tx: Tx) => Promise<T>): Promise<T> => transaction(async (tx) => {
          const select = vi.spyOn(tx, "select").mockImplementation(() => { throw failure; });
          try { return await body(tx); } finally { select.mockRestore(); }
        }),
      );
      try {
        const svc = issueService(outer as unknown as Db);
        await expect(kind === "list" ? svc.list(companyId, { limit: 100 }) : svc.count(companyId)).rejects.toBe(failure);
        expect(await state(outer)).toEqual(caller);
      } finally { spy.mockRestore(); }
    });
  });
});
