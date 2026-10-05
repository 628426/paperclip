import { sql } from "drizzle-orm";
import { agentWakeupRequests } from "@paperclipai/db";

/** Match the exact lowercase UUID text previously compared with issues.id::text. */
export function wakeIssueIdExpr() {
  const issueId = sql`${agentWakeupRequests.payload}->>'issueId'`;
  return sql<string | null>`CASE
    WHEN length(${issueId}) = 36
      AND ${issueId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (${issueId})::uuid
    ELSE NULL
  END`;
}
