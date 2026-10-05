import { randomUUID } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, issues,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { wakeIssueIdExpr } from "./wake-issue-id.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("saved wake issue lookup", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-issue-lookup-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("preserves text-join matches, company and assignee boundaries without casting invalid payloads", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = "abcdefab-cdef-abcd-efab-cdefabcdefab";
    await db.insert(companies).values([
      { id: companyId, name: "Wake lookups", issuePrefix: "WAK" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Assignee", role: "engineer", adapterType: "process" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other assignee", role: "engineer", adapterType: "process" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved wake", assigneeAgentId: agentId });
    const matchingWakeId = randomUUID();
    const invalidIds: unknown[] = [
      null, "", "not-a-uuid", issueId.toUpperCase(), issueId.replaceAll("-", ""),
      `{${issueId}}`, ` ${issueId}`, `${issueId}\n`, `${issueId} `,
      42, true, [issueId], { id: issueId },
    ];
    await db.insert(agentWakeupRequests).values([
      { id: matchingWakeId, companyId, agentId, source: "comment", payload: { issueId } },
      ...invalidIds.map((value) => ({ companyId, agentId, source: "comment", payload: { issueId: value } })),
      { companyId, agentId, source: "comment", payload: {} },
      { companyId, agentId, source: "comment", payload: null },
      { companyId: otherCompanyId, agentId: otherAgentId, source: "comment", payload: { issueId } },
      { companyId, agentId: otherAgentId, source: "comment", payload: { issueId } },
    ]);
    const lookup = (indexed: boolean) => db
      .select({ wakeId: agentWakeupRequests.id, issueId: issues.id })
      .from(agentWakeupRequests)
      .innerJoin(issues, and(
        eq(issues.companyId, agentWakeupRequests.companyId),
        eq(issues.assigneeAgentId, agentWakeupRequests.agentId),
        indexed ? eq(issues.id, wakeIssueIdExpr())
          : sql`${issues.id}::text = ${agentWakeupRequests.payload}->>'issueId'`,
      ))
      .orderBy(asc(agentWakeupRequests.id));
    const original = await lookup(false);
    expect(original).toEqual([{ wakeId: matchingWakeId, issueId }]);
    await expect(lookup(true)).resolves.toEqual(original);
  });
});
