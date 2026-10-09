import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  boundHeartbeatRunEventPayloadForStorage,
  heartbeatService,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns runs even when the linked db schema lacks processGroupId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date("2026-04-18T12:00:00Z"),
      nextAction: "continue implementation",
      contextSnapshot: { issueId: randomUUID() },
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(heartbeatRuns, "processGroupId");
    Object.defineProperty(heartbeatRuns, "processGroupId", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const runs = await heartbeatService(db).list(companyId, agentId, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(runId);
      expect(runs[0]?.processGroupId ?? null).toBeNull();
      expect(runs[0]).toMatchObject({
        livenessState: "advanced",
        livenessReason: "run produced action evidence",
        continuationAttempt: 1,
        nextAction: "continue implementation",
      });
      expect(runs[0]?.lastUsefulActionAt).toEqual(new Date("2026-04-18T12:00:00Z"));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(heartbeatRuns, "processGroupId", originalDescriptor);
      } else {
        delete (heartbeatRuns as unknown as Record<string, unknown>).processGroupId;
      }
    }
  });

  it("returns small result json payloads unchanged from getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "done",
        structured: { ok: true },
      },
    });

    const run = await heartbeatService(db).getRun(runId);

    expect(run?.resultJson).toEqual({
      summary: "done",
      structured: { ok: true },
    });
  });

  it.each([false, true])("preserves run ownership in list rows (summary=%s)", async (summary) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      responsibleUserId: "run-owner",
      error: "Failed after doing useful work",
      usageJson: {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 123,
      },
      resultJson: {
        summary: "large run summary",
        stdout: "x".repeat(20_000),
      },
      sessionIdBefore: "session-before",
      sessionIdAfter: "session-after",
      logStore: "local",
      logRef: "logs/run.log",
      logSha256: "abc123",
      externalRunId: "external-run",
      processPid: 12345,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });

    const runs = await heartbeatService(db).list(companyId, undefined, 5, { summary });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      responsibleUserId: "run-owner",
      error: "Failed after doing useful work",
      ...(summary ? {
        usageJson: null,
        resultJson: null,
        sessionIdBefore: null,
        sessionIdAfter: null,
        logStore: null,
        logRef: null,
        logSha256: null,
        externalRunId: null,
        processPid: null,
      } : {}),
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });
  });

  it("bounds the default page and supports stable offset pagination", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runIds = Array.from({ length: 1005 }, () => randomUUID());

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values(
      runIds.map((id, index) => ({
        id,
        companyId,
        agentId,
        invocationSource: "assignment" as const,
        status: "succeeded" as const,
        createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, 0, index)),
      })),
    );

    const service = heartbeatService(db);
    const firstPage = await service.list(companyId, agentId, undefined, {
      summary: true,
    });
    const finalPage = await service.list(companyId, agentId, 10, {
      summary: true,
      offset: 1000,
    });

    expect(firstPage).toHaveLength(200);
    expect(firstPage[0]?.id).toBe(runIds[1004]);
    expect(firstPage[199]?.id).toBe(runIds[805]);
    expect(await service.list(companyId, agentId, 5000, { summary: true })).toHaveLength(1000);
    expect(finalPage.map((run) => run.id)).toEqual(runIds.slice(0, 5).reverse());
    expect(
      finalPage.every(
        (run) => !firstPage.some((firstRun) => firstRun.id === run.id),
      ),
    ).toBe(true);
  });

  it("filters by status before pagination and keeps tied timestamps company and agent scoped", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values([companyId, otherCompanyId].map((id) => ({
      id, name: "Paperclip", issuePrefix: `T${id.slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    })));
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Builder", role: "engineer", adapterType: "codex_local" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "engineer", adapterType: "codex_local" },
    ]);
    const ids = Array.from({ length: 4 }, () => randomUUID()).sort().reverse();
    const createdAt = new Date("2026-08-01T12:00:00Z");
    await db.insert(heartbeatRuns).values([
      ...ids.map((id) => ({ id, companyId, agentId, status: "failed", createdAt })),
      { companyId, agentId, status: "succeeded", createdAt: new Date("2026-08-02T12:00:00Z") },
      { companyId: otherCompanyId, agentId: otherAgentId, status: "failed", createdAt },
    ]);
    const service = heartbeatService(db);
    const firstPage = await service.list(companyId, agentId, 2, { summary: true, status: "failed" });
    const secondPage = await service.list(companyId, agentId, 2, { summary: true, status: "failed", offset: 2 });
    expect(firstPage.map((run) => run.id)).toEqual(ids.slice(0, 2));
    expect(secondPage.map((run) => run.id)).toEqual(ids.slice(2));
    expect(await service.list(otherCompanyId, agentId, 2, { status: "failed" })).toEqual([]);
  });

  it.each([false, true])("preserves the original JSON projections for every JSON value type (summary=%s)", async (summary) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Projection", issuePrefix: "PROJECTION" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reader", role: "engineer", adapterType: "codex_local" });
    const snapshots: unknown[] = [
      undefined, null, {}, [], ["value"], "scalar", 42, true,
      {
        issueId: " task ", taskId: 123, taskKey: { nested: "value" }, commentId: [1, true],
        wakeCommentId: false, wakeReason: null, wakeSource: "", wakeTriggerDetail: "\n wake \n",
        summary: "😀".repeat(600), result: ["value", 2], message: { nested: true }, error: false,
        total_cost_usd: "1.25", cost_usd: 2.5, costUsd: "Infinity",
        privatePayload: "large context".repeat(20_000),
      },
    ];
    await db.insert(heartbeatRuns).values(snapshots.map((value, index) => ({
      companyId, agentId, status: "succeeded", createdAt: new Date(1_700_000_000_000 + index),
      contextSnapshot: value === undefined ? sql`NULL` : sql`${JSON.stringify(value)}::jsonb`,
      resultJson: value === undefined ? sql`NULL` : sql`${JSON.stringify(value)}::jsonb`,
    })));
    // These are the original ->> expressions. Compare their mapped results,
    // including non-object roots, JSON nulls, nested values and multibyte caps.
    const reference = await db.select({
      id: heartbeatRuns.id,
      context: sql<Record<string, string | null>>`jsonb_build_object(
        'issueId', ${heartbeatRuns.contextSnapshot} ->> 'issueId',
        'taskId', ${heartbeatRuns.contextSnapshot} ->> 'taskId',
        'taskKey', ${heartbeatRuns.contextSnapshot} ->> 'taskKey',
        'commentId', ${heartbeatRuns.contextSnapshot} ->> 'commentId',
        'wakeCommentId', ${heartbeatRuns.contextSnapshot} ->> 'wakeCommentId',
        'wakeReason', ${heartbeatRuns.contextSnapshot} ->> 'wakeReason',
        'wakeSource', ${heartbeatRuns.contextSnapshot} ->> 'wakeSource',
        'wakeTriggerDetail', ${heartbeatRuns.contextSnapshot} ->> 'wakeTriggerDetail')`,
      result: sql<Parameters<typeof summarizeHeartbeatRunListResultJson>[0]>`jsonb_build_object(
        'summary', left(${heartbeatRuns.resultJson} ->> 'summary', 500),
        'result', left(${heartbeatRuns.resultJson} ->> 'result', 500),
        'message', left(${heartbeatRuns.resultJson} ->> 'message', 500),
        'error', left(${heartbeatRuns.resultJson} ->> 'error', 500),
        'totalCostUsd', ${heartbeatRuns.resultJson} ->> 'total_cost_usd',
        'costUsd', ${heartbeatRuns.resultJson} ->> 'cost_usd',
        'costUsdCamel', ${heartbeatRuns.resultJson} ->> 'costUsd')`,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
    const runs = await heartbeatService(db).list(companyId, agentId, 100, { summary });
    expect(runs.map(({ id, contextSnapshot, resultJson }) => ({ id, contextSnapshot, resultJson }))).toEqual(
      reference.map(({ id, context, result }) => ({
        id, contextSnapshot: summarizeHeartbeatRunContextSnapshot(context),
        resultJson: summary ? null : summarizeHeartbeatRunListResultJson(result),
      })),
    );
    expect(runs.every(run => run.createdAt instanceof Date && run.updatedAt instanceof Date)).toBe(true);
  });

  it("bounds oversized legacy result json payloads on getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const oversizedStdout = Array.from({ length: 8_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}-${randomUUID()}`,
    ).join("|");
    const oversizedNestedPayload = Array.from({ length: 6_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}:${randomUUID()}`,
    ).join("|");
    // Multibyte diagnostics can exceed the result byte budget while remaining
    // within the adapter's character bounds. Other result fields can do so too.
    const terminalSessionFailure = {
      category: "service",
      title: "HTTP 529: overloaded_error",
      details: `request_id=req_retained\n${"診断".repeat(12_000)}`,
      truncatedFields: ["title"],
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      error: terminalSessionFailure.details,
      resultJson: {
        summary: "completed",
        stdout: oversizedStdout,
        nestedHuge: { payload: oversizedNestedPayload },
        terminalSessionFailure: {
          ...terminalSessionFailure,
          privateMetadata: oversizedNestedPayload,
        },
        instructionSave: {
          state: "unavailable", contract: "agent_files", entryFile: "AGENTS.md",
          errorCode: "AGENT_FILES_LIMIT_EXCEEDED",
          storageWarning: "Agent storage is full. Runs can continue.".repeat(50),
          privateSyncMetadata: oversizedNestedPayload,
        },
        workspaceRestoreFailure: "restore_unsafe_archive",
        finalResponseRecorded: true,
        executionBeforeRestore: { errorCode: "model_error", exitCode: 2, timedOut: false },
      },
    });

    const run = await heartbeatService(db).getRun(runId);
    const result = run?.resultJson as Record<string, unknown> | null;

    expect(result).toMatchObject({
      summary: "completed",
      truncated: true,
      truncationReason: "oversized_result_json",
      stdoutTruncated: true,
      terminalSessionFailure: {
        ...terminalSessionFailure,
        details: expect.stringContaining("request_id=req_retained"),
        retrievalTruncated: true,
      },
      instructionSave: {
        state: "unavailable", contract: "agent_files", entryFile: "AGENTS.md",
        errorCode: "AGENT_FILES_LIMIT_EXCEEDED",
        storageWarning: "Agent storage is full. Runs can continue.".repeat(50).slice(0, 1024),
      },
      workspaceRestoreFailure: "restore_unsafe_archive",
      finalResponseRecorded: true,
      executionBeforeRestore: { errorCode: "model_error", exitCode: 2, timedOut: false },
    });
    expect(typeof result?.stdout).toBe("string");
    expect((result?.stdout as string).length).toBeLessThan(oversizedStdout.length);
    expect(result).not.toHaveProperty("nestedHuge");
    expect(result?.instructionSave).not.toHaveProperty("privateSyncMetadata");
    expect(result?.terminalSessionFailure).not.toHaveProperty("privateMetadata");
    const diagnostic = result?.terminalSessionFailure as { details: string };
    expect(diagnostic.details).toContain("[truncated for run retrieval; full text in run error/transcript]");
    expect(Buffer.byteLength(diagnostic.details)).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    expect(run?.error).toBe(terminalSessionFailure.details);
  });
});

describe("heartbeat run event payload bounding", () => {
  it("truncates oversized adapter metadata before storage", () => {
    const payload = boundHeartbeatRunEventPayloadForStorage({
      adapterType: "codex_local",
      prompt: "x".repeat(40_000),
      context: {
        issueId: "issue-1",
        memory: "y".repeat(40_000),
      },
    });

    expect(payload.adapterType).toBe("codex_local");
    expect(typeof payload.prompt).toBe("string");
    expect((payload.prompt as string).length).toBeLessThan(20_000);
    expect(payload.prompt).toContain("[truncated");
    expect(payload.context).toMatchObject({
      issueId: "issue-1",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(45_000);
  });
});
