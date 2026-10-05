import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns } from "@paperclipai/db";
import type { SidebarBadges } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { getUtcMonthStart } from "./dashboard.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];

function normalizeTimestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isDismissed(
  dismissedAtByKey: ReadonlyMap<string, number>,
  itemKey: string,
  activityAt: Date | string | null | undefined,
) {
  const dismissedAt = dismissedAtByKey.get(itemKey);
  if (dismissedAt == null) return false;
  return dismissedAt >= normalizeTimestamp(activityAt);
}

export function sidebarBadgeService(db: Db) {
  async function getAlerts(companyId: string) {
    const monthStart = getUtcMonthStart(new Date());
    const [row] = await db
      .select({
        hasAgentErrors: sql<boolean>`exists (
          select 1 from ${agents}
          where ${agents.companyId} = ${companyId} and ${agents.status} = 'error'
        )`,
        monthBudgetCents: companies.budgetMonthlyCents,
        monthSpendCents: sql<number>`(
          select coalesce(sum(${costEvents.costCents}), 0)::double precision
          from ${costEvents}
          where ${costEvents.companyId} = ${companyId}
            and ${costEvents.occurredAt} >= ${monthStart.toISOString()}::timestamptz
        )`,
      })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!row) throw notFound("Company not found");
    const utilization = row.monthBudgetCents > 0
      ? Number(((Number(row.monthSpendCents) / row.monthBudgetCents) * 100).toFixed(2))
      : 0;
    return {
      hasAgentErrors: row.hasAgentErrors,
      hasBudgetAlert: row.monthBudgetCents > 0 && utilization >= 80,
    };
  }

  return {
    get: async (
      companyId: string,
      extra?: {
        dismissals?: ReadonlyMap<string, number>;
        joinRequests?: Array<{ id: string; updatedAt: Date | string | null; createdAt: Date | string }>;
        unreadTouchedIssues?: number;
        includeAlerts?: boolean;
      },
    ): Promise<SidebarBadges> => {
      const [approvalRows, latestRunByAgent, alerts] = await Promise.all([
        db
          .select({ id: approvals.id, updatedAt: approvals.updatedAt })
          .from(approvals)
          .where(
            and(
              eq(approvals.companyId, companyId),
              inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
            ),
          ),
        db
          .selectDistinctOn([heartbeatRuns.agentId], {
            id: heartbeatRuns.id,
            runStatus: heartbeatRuns.status,
            createdAt: heartbeatRuns.createdAt,
          })
          .from(heartbeatRuns)
          .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              eq(agents.companyId, companyId),
              not(eq(agents.status, "terminated")),
            ),
          )
          .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)),
        extra?.includeAlerts ? getAlerts(companyId) : Promise.resolve(null),
      ]);
      const actionableApprovals = approvalRows.filter((row) =>
        !isDismissed(extra?.dismissals ?? new Map(), `approval:${row.id}`, row.updatedAt)
      ).length;

      const failedRuns = latestRunByAgent.filter((row) =>
        FAILED_HEARTBEAT_STATUSES.includes(row.runStatus)
        && !isDismissed(extra?.dismissals ?? new Map(), `run:${row.id}`, row.createdAt),
      ).length;

      const joinRequests = (extra?.joinRequests ?? []).filter((row) =>
        !isDismissed(
          extra?.dismissals ?? new Map(),
          `join:${row.id}`,
          row.updatedAt ?? row.createdAt,
        )
      ).length;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      const alertCount = Number(Boolean(alerts?.hasAgentErrors) && failedRuns === 0)
        + Number(Boolean(alerts?.hasBudgetAlert));
      return {
        inbox: actionableApprovals + failedRuns + joinRequests + unreadTouchedIssues + alertCount,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
      };
    },
  };
}
