import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it } from "vitest";
import { heartbeatService } from "../services/heartbeat.js";
import { clearAllHeartbeatRunRuntimeStatuses, getHeartbeatRunRuntimeStatus } from "../services/heartbeat-run-runtime-status.js";

afterEach(clearAllHeartbeatRunRuntimeStatuses);

function fixture() {
  const id = randomUUID();
  const companyId = randomUUID();
  const agentId = randomUUID();
  let rows: unknown[][] = [[id, companyId, agentId, "running"]];
  let failure: Error | undefined;
  const statements: Array<{ query: string; params: unknown[] }> = [];
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe(query: string, params: unknown[]) {
      statements.push({ query, params });
      return Object.assign(Promise.resolve([]), {
        values: () => failure ? Promise.reject(failure) : Promise.resolve(rows),
      });
    },
  };
  const db = drizzle(client as unknown as Db["$client"]) as unknown as Db;
  return {
    id, companyId, agentId, statements, service: heartbeatService(db),
    caller: { id, companyId: randomUUID(), agentId: randomUUID(), status: "running", contextSnapshot: null },
    setStatus(status: string | null) { rows = status ? [[id, companyId, agentId, status]] : []; },
    fail(error: Error) { failure = error; },
  };
}

describe("runtime progress status query", () => {
  it.each(["running", "queued"])("reads fresh database identity and status without stored payloads (%s)", async (status) => {
    const f = fixture();
    f.setStatus(status);
    const issueId = randomUUID();
    const result = await f.service.recordRuntimeProgress(f.caller, { phase: "config_sync", message: "Syncing" }, issueId);
    expect(result).toMatchObject({ runId: f.id, companyId: f.companyId, agentId: f.agentId, issueId, message: "Syncing" });
    expect(f.statements).toEqual([{
      query: 'select "id", "company_id", "agent_id", "status" from "heartbeat_runs" where "heartbeat_runs"."id" = $1',
      params: [f.id],
    }]);
  });

  it("skips the read when the caller already knows the run is terminal", async () => {
    const f = fixture();
    expect(await f.service.recordRuntimeProgress({ ...f.caller, status: "succeeded" }, { phase: "finalize", message: "Late update" }, null)).toBeNull();
    expect(f.statements).toHaveLength(0);
  });

  it.each([null, "succeeded", "failed", "cancelled", "timed_out"])("clears stale progress for a missing or terminal run (%s)", async (status) => {
    const f = fixture();
    await f.service.recordRuntimeProgress(f.caller, { phase: "config_sync", message: "Syncing" }, null);
    expect(getHeartbeatRunRuntimeStatus(f.id)).not.toBeNull();
    f.setStatus(status);
    expect(await f.service.recordRuntimeProgress(f.caller, { phase: "finalize", message: "Late update" }, null)).toBeNull();
    expect(getHeartbeatRunRuntimeStatus(f.id)).toBeNull();
  });

  it("propagates a failed status read", async () => {
    const f = fixture();
    const failure = new Error("Status read failed");
    f.fail(failure);
    await expect(f.service.recordRuntimeProgress(f.caller, { phase: "config_sync", message: "Syncing" }, null))
      .rejects.toMatchObject({ cause: failure });
    expect(getHeartbeatRunRuntimeStatus(f.id)).toBeNull();
  });
});
