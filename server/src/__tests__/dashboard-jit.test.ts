import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "@paperclipai/db";
import * as schema from "@paperclipai/db/schema/index";
import { dashboardService } from "../services/dashboard.js";
import { executionIssueCondition } from "../services/issue-visibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type TxConfig = Parameters<Db["transaction"]>[1];
type ConnectionState = { jit: string; readOnly: string; pid: number };

describePostgres("dashboard task-count JIT scope", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let client: Db["$client"];
  let db: Db;
  let inTaskTransaction = false;
  const records: Array<{ query: string; params: unknown[]; inTaskTransaction: boolean }> = [];
  const companyId = randomUUID();
  const foreignCompanyId = randomUUID();
  const agentId = randomUUID();
  const idleSlackIssueId = randomUUID();
  const activeSlackIssueId = randomUUID();

  const connectionState = async (connection: Db | Tx): Promise<ConnectionState> =>
    (await connection.execute<ConnectionState>(sql`SELECT current_setting('jit') AS jit,
      current_setting('transaction_read_only') AS "readOnly", pg_backend_pid() AS pid`))[0];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("dashboard-jit");
    // One physical connection makes leak checks deterministic. These settings
    // belong only to this disposable test connection, never a role/database.
    client = createDb(database.connectionString, { maxConnections: 1, prepare: false }).$client;
    db = drizzle(client, {
      schema,
      logger: { logQuery(query, params) { records.push({ query, params, inTaskTransaction }); } },
    });
    await client.unsafe("SET jit = on; SET jit_above_cost = 0; SET jit_inline_above_cost = 1000000000; SET jit_optimize_above_cost = 1000000000");
    await db.insert(schema.companies).values([
      { id: companyId, name: "Dashboard", issuePrefix: "JIT" },
      { id: foreignCompanyId, name: "Other company", issuePrefix: "JITOTHER" },
    ]);
    await db.insert(schema.agents).values({ id: agentId, companyId, name: "Reader", role: "engineer", adapterType: "codex_local", status: "idle" });
    await db.insert(schema.issues).values([
      ...["backlog", "todo", "in_progress", "blocked", "in_review", "done", "cancelled"].map((status) => ({ companyId, title: status, status })),
      { companyId, title: "Hidden", status: "todo", hiddenAt: new Date() },
      { companyId, title: "Harness", status: "todo", harnessKind: "terminal_bench" },
      { companyId, title: "Agent conversation", status: "in_review", conversationAgentId: agentId,
        conversationUserId: "board-operator", conversationState: "active", assigneeAgentId: agentId },
      { id: idleSlackIssueId, companyId, title: "Idle Slack", status: "in_review", assigneeAgentId: agentId },
      { id: activeSlackIssueId, companyId, title: "Active Slack", status: "in_review", assigneeAgentId: agentId },
      { companyId: foreignCompanyId, title: "Foreign task", status: "todo" },
    ]);
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const endpointId = randomUUID();
    await db.insert(schema.toolApplications).values({ id: applicationId, companyId, name: "Slack", type: "chat" });
    await db.insert(schema.toolConnections).values({ id: connectionId, companyId, applicationId, name: "Slack", uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel" });
    await db.insert(schema.chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "slack", publicId: endpointId, assignedAgentId: agentId, status: "active" });
    await db.insert(schema.chatConversations).values([idleSlackIssueId, activeSlackIssueId].map((issueId) => ({
      companyId, endpointId, issueId, externalConversationId: "channel", externalThreadId: issueId,
      externalLabel: "#test", state: "waiting" as const,
    })));
    await db.insert(schema.heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: activeSlackIssueId } });
    await db.insert(schema.approvals).values({ companyId, type: "hire_agent", status: "pending", payload: {} });
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await client?.end({ timeout: 0 });
    await database?.cleanup();
  });

  it("runs only the unchanged task query with JIT off on one read-only transaction connection", async () => {
    const before = await connectionState(db);
    expect(before).toMatchObject({ jit: "on", readOnly: "off" });
    const originalQuery = db.select({ status: schema.issues.status, count: sql<number>`count(*)` })
      .from(schema.issues)
      .where(and(eq(schema.issues.companyId, companyId), executionIssueCondition()))
      .groupBy(schema.issues.status).toSQL();
    const transaction = db.transaction.bind(db);
    let inside!: ConnectionState;
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(
      async <T>(body: (tx: Tx) => Promise<T>, config?: TxConfig): Promise<T> => transaction(async (tx) => {
        inTaskTransaction = true;
        let result: T;
        try { result = await body(tx); } finally { inTaskTransaction = false; }
        inside = await connectionState(tx);
        return result;
      }, config),
    );
    records.length = 0;
    try {
      const summary = await dashboardService(db).summary(companyId);
      expect(summary.tasks).toEqual({ open: 6, inProgress: 1, blocked: 1, done: 1 });
      expect(summary.agents).toEqual({ active: 1, running: 0, paused: 0, error: 0 });
      expect(summary.pendingApprovals).toBe(1);
      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(transactionSpy.mock.calls[0][1]).toEqual({ accessMode: "read only" });
      const scoped = records.filter((record) => record.inTaskTransaction);
      expect(scoped).toHaveLength(2);
      expect(scoped[0].query).toBe("SET LOCAL jit = off");
      expect(scoped[1]).toMatchObject({ query: originalQuery.sql, params: originalQuery.params });
      expect(inside).toEqual({ jit: "off", readOnly: "on", pid: before.pid });
      expect(await connectionState(db)).toEqual(before);

    } finally { transactionSpy.mockRestore(); }
  }, 60_000);

  it("allows normal JIT compilation again after the dashboard transaction", async ({ skip }) => {
    const [{ available }] = await db.execute<{ available: boolean }>(sql`SELECT pg_jit_available() AS available`);
    if (!available) skip("The embedded PostgreSQL build has no LLVM JIT implementation");
    await dashboardService(db).summary(companyId);
    const plan = await db.execute<{ "QUERY PLAN": Array<{ JIT?: { Functions: number } }> }>(sql`EXPLAIN (ANALYZE, FORMAT JSON) SELECT status, count(*) FROM issues GROUP BY status`);
    expect(plan[0]["QUERY PLAN"][0].JIT?.Functions).toBeGreaterThan(0);
  }, 60_000);

  it.each(["setting", "task query"])("propagates a %s failure and restores normal JIT after ROLLBACK", async (failurePoint) => {
    const before = await connectionState(db);
    const failure = new Error(`dashboard ${failurePoint} failure`);
    const transaction = db.transaction.bind(db);
    let taskQueryAttempted = false;
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(
      async <T>(body: (tx: Tx) => Promise<T>, config?: TxConfig): Promise<T> => transaction(async (tx) => {
        const selectSpy = vi.spyOn(tx, "select").mockImplementation(() => {
          taskQueryAttempted = true;
          throw failure;
        });
        const executeSpy = failurePoint === "setting"
          ? vi.spyOn(tx, "execute").mockImplementation(() => { throw failure; })
          : null;
        try { return await body(tx); } finally { selectSpy.mockRestore(); executeSpy?.mockRestore(); }
      }, config),
    );
    try {
      await expect(dashboardService(db).summary(companyId)).rejects.toBe(failure);
      expect(taskQueryAttempted).toBe(failurePoint === "task query");
      expect(await connectionState(db)).toEqual(before);
    } finally { transactionSpy.mockRestore(); }
  });
});
