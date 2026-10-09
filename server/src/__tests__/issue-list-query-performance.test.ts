import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import type { Db } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { issueService } from "../services/issues.js";

type Filters = Parameters<ReturnType<typeof issueService>["list"]>[1];
const routeDefaults = {
  includeRoutineExecutions: true, excludeRoutineExecutions: false,
  includePluginOperations: false, includeBlockedBy: false,
  includeBlockedInboxAttention: false, includeLiveDescendantSummary: false,
};

async function listSql(filters: Filters) {
  let captured: string | undefined;
  const statements: Array<{ query: string; transactional: boolean }> = [];
  const stop = new Error("Query captured");
  const capture = (query: string, transactional: boolean) => {
    statements.push({ query, transactional });
    if (/^set /i.test(query)) return Promise.resolve([]);
    captured = query;
    throw stop;
  };
  const transactionClient = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string) { return capture(query, true); },
  };
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string) { return capture(query, false); },
    async begin<T>(body: (connection: typeof transactionClient) => Promise<T>) { return body(transactionClient); },
  };
  const db = drizzle(client as unknown as ReturnType<typeof postgres>) as unknown as Db;
  try {
    await issueService(db).list("00000000-0000-4000-8000-000000000001", filters);
  } catch (error) {
    if (!captured) throw error;
  }
  expect(captured).toBeDefined();
  expect(statements).toEqual([
    { query: "set transaction read only", transactional: true },
    { query: "SET LOCAL jit = off", transactional: true },
    { query: captured, transactional: true },
  ]);
  return captured!;
}

describe("issue list activity query selection", () => {
  it.each([false, true])("pages IDs before descriptions with route defaults (descendants: %s)", async (descendants) => {
    const query = await listSql({
      ...routeDefaults, includeLiveDescendantSummary: descendants,
      limit: 100, offset: 0, sortField: "updated", sortDir: "desc",
    });
    expect(query).toContain('with "issue_list_activity_page"');
    expect(query).toContain('"issue_list_comment_activity"');
    expect(query).toContain('"issue_list_log_activity"');
    expect(query.indexOf("convert_to")).toBeGreaterThan(query.indexOf("limit"));
  });

  it.each([
    { status: "todo" }, { q: "needle" }, { touchedByUserId: "reader" },
    { excludeRoutineExecutions: true }, { includePluginOperations: true },
    { sortField: "id" as const },
  ])("retains the selective query for %j", async (filters) => {
    const query = await listSql({ ...routeDefaults, limit: 100, ...filters });
    expect(query).not.toContain('"issue_list_activity_page"');
    expect(query).not.toContain('"issue_list_comment_activity"');
  });
});
