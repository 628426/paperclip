import { describe, expect, it } from "vitest";
import { issueRunsRefetchInterval } from "./issueRunsPolling";

describe("issueRunsRefetchInterval", () => {
  it("preserves the chat and ledger live-run refresh intervals", () => {
    expect(issueRunsRefetchInterval(true, undefined, 1000)).toBe(1000);
    expect(issueRunsRefetchInterval(true, undefined)).toBe(5000);
  });

  it("stops for an empty or complete history with no live run", () => {
    expect(issueRunsRefetchInterval(false, undefined)).toBe(false);
    expect(issueRunsRefetchInterval(false, [])).toBe(false);
    expect(issueRunsRefetchInterval(false, [
      { status: "succeeded", livenessState: "advanced" },
      { status: "failed", livenessState: "failed" },
    ])).toBe(false);
  });

  it("waits for historical liveness backfill without busy polling", () => {
    expect(issueRunsRefetchInterval(false, [
      { status: "succeeded", livenessState: "advanced" },
      { status: "failed", livenessState: null },
    ], 1000)).toBe(5000);
  });

  it("does not treat an unresolved active run as historical backfill", () => {
    expect(issueRunsRefetchInterval(false, [
      { status: "queued", livenessState: null },
      { status: "running", livenessState: null },
    ])).toBe(false);
  });
});
