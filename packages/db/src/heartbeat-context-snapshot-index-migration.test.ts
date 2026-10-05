import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("heartbeat context_snapshot expression index migration", () => {
  it("applies full migration chain and uses the new indexes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap16575-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('heartbeat_runs','agent_wakeup_requests')`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_task_created_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_taskkey_created_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_paperclip_issue_created_idx");
    expect(names).toContain("agent_wakeup_requests_company_payload_issue_idx");

    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'issueId' = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("heartbeat_runs_company_ctx_issue_created_idx");

    const taskPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'taskId' = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const taskText = taskPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(taskText).toContain("heartbeat_runs_company_ctx_task_created_idx");

    // The productivity-review run scope ORs issueId/taskId/taskKey; all three
    // expression indexes must exist so the planner can BitmapOr at real row
    // counts instead of detoasting every run snapshot for the agent. An empty
    // table plans a single index scan, so assert the taskKey index directly.
    const taskKeyPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'taskKey' = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const taskKeyText = taskKeyPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(taskKeyText).toContain("heartbeat_runs_company_ctx_taskkey_created_idx");

    // run-secret-redaction valuesForIssue ORs issueId with paperclipIssue.id.
    // The second branch needs its own expression index. Without it the planner
    // cannot BitmapOr the two branches, so the whole OR falls back to a
    // sequential scan that detoasts every context_snapshot on every issue read.
    // This query omits ORDER BY because valuesForIssue does not sort. The
    // three assertions above sort, because their callers do.
    const paperclipIssuePlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot -> 'paperclipIssue' ->> 'id' = 'x'",
    );
    const paperclipIssueText = paperclipIssuePlan.map((r) => Object.values(r)[0]).join("\n");
    expect(paperclipIssueText).toContain("heartbeat_runs_company_ctx_paperclip_issue_created_idx");

    const wakePlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM agent_wakeup_requests WHERE company_id = '00000000-0000-0000-0000-000000000001' AND status = 'deferred_issue_execution' AND payload ->> 'issueId' = 'x' LIMIT 1",
    );
    const wakeText = wakePlan.map((r) => Object.values(r)[0]).join("\n");
    expect(wakeText).toContain("agent_wakeup_requests_company_payload_issue_idx");

    // Idempotency: re-running the migration statements against an already
    // migrated database must be a no-op, not an error.
    for (const migration of [
      "./migrations/0209_heartbeat_context_snapshot_indexes.sql",
      "./migrations/0210_heartbeat_context_taskkey_index.sql",
      "./migrations/0284_heartbeat_context_paperclip_issue_index.sql",
    ]) {
      const migrationSql = await readFile(
        fileURLToPath(new URL(migration, import.meta.url)),
        "utf8",
      );
      const statements = migrationSql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    }

    // Model startup on an existing release database: 0283 is recorded, while
    // 0284 and its index have not been applied. Keep every run intact.
    const migrationSql = await readFile(new URL("./migrations/0284_heartbeat_context_paperclip_issue_index.sql", import.meta.url), "utf8");
    const hash = createHash("sha256").update(migrationSql).digest("hex");
    await sql`INSERT INTO companies(id, name, issue_prefix) VALUES ('00000000-0000-4000-8000-000000000001', 'Index test', 'IDX')`;
    await sql`INSERT INTO agents(id, company_id, name, role, adapter_type) VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'Reader', 'engineer', 'codex_local')`;
    await sql`INSERT INTO heartbeat_runs(company_id, agent_id, context_snapshot)
      SELECT '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
        jsonb_build_object('issueId', CASE WHEN n = 1 THEN 'target' ELSE 'other-' || n END,
          'paperclipIssue', jsonb_build_object('id', CASE WHEN n = 2 THEN 'target' ELSE 'legacy-' || n END),
          'paperclipSecretRedactions', '[]'::jsonb)
      FROM generate_series(1, 512) AS n`;
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
    await sql`DROP INDEX heartbeat_runs_company_ctx_paperclip_issue_created_idx`;
    const pending = await inspectMigrations(dbh.connectionString);
    expect(pending.status).toBe("needsMigrations");
    if (pending.status !== "needsMigrations") throw new Error("Expected the index migration to be pending");
    expect(pending.pendingMigrations).toEqual(["0284_heartbeat_context_paperclip_issue_index.sql"]);
    await applyPendingMigrations(dbh.connectionString);
    expect((await inspectMigrations(dbh.connectionString)).status).toBe("upToDate");
    const [created] = await sql`SELECT indexrelid, indisvalid, indisready FROM pg_index WHERE indexrelid = 'heartbeat_runs_company_ctx_paperclip_issue_created_idx'::regclass`;
    expect(created.indisvalid).toBe(true);
    expect(created.indisready).toBe(true);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM heartbeat_runs`;
    expect(count).toBe(512);

    await sql`ANALYZE heartbeat_runs`;
    const combinedPlan = await sql`EXPLAIN SELECT jsonb_build_object('paperclipSecretRedactions', context_snapshot -> 'paperclipSecretRedactions')
      FROM heartbeat_runs WHERE company_id = '00000000-0000-4000-8000-000000000001'
        AND (context_snapshot ->> 'issueId' = 'target' OR context_snapshot -> 'paperclipIssue' ->> 'id' = 'target')`;
    const combinedText = combinedPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(combinedText).toContain("BitmapOr");
    expect(combinedText).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(combinedText).toContain("heartbeat_runs_company_ctx_paperclip_issue_created_idx");

    // Repeated startup leaves the valid index in place. A preinstalled index
    // with missing history is reconciled without rebuilding it either.
    await applyPendingMigrations(dbh.connectionString);
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
    await applyPendingMigrations(dbh.connectionString);
    expect((await inspectMigrations(dbh.connectionString)).status).toBe("upToDate");
    const [retained] = await sql`SELECT indexrelid FROM pg_index WHERE indexrelid = 'heartbeat_runs_company_ctx_paperclip_issue_created_idx'::regclass`;
    expect(retained.indexrelid).toBe(created.indexrelid);
  }, 240_000);
});
