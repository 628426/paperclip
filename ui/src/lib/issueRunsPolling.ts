import type { RunForIssue } from "../api/activity";

export function issueRunsRefetchInterval(
  hasLiveRuns: boolean,
  runs: ReadonlyArray<Pick<RunForIssue, "status" | "livenessState">> | undefined,
  liveIntervalMs = 5000,
) {
  if (hasLiveRuns) return liveIntervalMs;
  // The server fills historical liveness in the background. Fetch its result
  // before stopping, even when there is no live run or the issue is done.
  return runs?.some(
    (run) => run.status !== "queued" && run.status !== "running" && !run.livenessState,
  ) ? 5000 : false;
}
