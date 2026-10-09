# Query and polling performance improvements

The branch starts at the exact `v2026.1005.0` release commit,
`467125fafb47a8520856504fecc48d6e32055db1`. It carries the outstanding performance
changes from `Paperclip-v2026.1001.0-performance-improvements` at `e5cf8e440`.
The legacy issue index migration is numbered 0294, after this release's migration
history. Its SQL remains idempotent for databases that already have the index.

## Release comparison

The release already contains
[#14727](https://github.com/paperclipai/paperclip/pull/14727), which renders saved
task content before supporting history finishes and loads run projections in
parallel. Those changes are preserved. The existing batched redaction and
registry-only projection from
[#13174](https://github.com/paperclipai/paperclip/pull/13174) are also retained.
They are upstream behavior, not additional changes in this branch.

The release also removes dashboard-derived badge alerts while enforcing Mine
visibility in [#14572](https://github.com/paperclipai/paperclip/pull/14572).
That makes the previous replacement alert query unnecessary. This port retains
those counts and privacy rules and only parallelizes the remaining badge reads.

The remaining changes still differ from the release:

| Area | Carried improvement |
| --- | --- |
| Retention | Configurable background decision-retention sweep |
| Failed runs | Bounded newer-run probes with original matching rules |
| Redaction | Index for legacy `paperclipIssue.id` lookups, migration 0294 |
| Workspaces | Terminal-state gating and backoff before background Git scans |
| Issue run history | Shared indexed lookup for history and liveness backfill |
| Run lists | Bounded API history and paginated agent/audit views |
| Wake recovery | UUID joins that preserve malformed-ID behavior |
| Dashboard | Chart-window filtering and bounded retry ancestry |
| Sidebar | Parallel approval/run badge reads, preserving release visibility and counts |
| Issue polling | Stop completed history polling after liveness is populated |
| Chat projection | Skip milestone scans without an automatic endpoint |
| Task lists | Batched activity ordering and ID pagination, including route defaults |

The port retains the release's explicit work-mode semantics, responsible-user
filtering in Mine, and canonical issue query references. Regression expectations
follow those release contracts. No application was deployed or live database
modified during this port.

These changes reduce repeated history reads and query work while preserving
company boundaries, recovery predicates and task activity ordering. They add
no schema, migration, index or trigger. The performance branch separately
includes the previously imported run-redaction index from
[#12499](https://github.com/paperclipai/paperclip/pull/12499).

## Run history and polling

`GET /api/companies/{companyId}/heartbeat-runs` defaults to 200 rows and accepts
`limit` (1–1000), `offset` (a non-negative integer) and an optional valid run
`status`. Invalid pagination or status values return HTTP 400. Company and
agent restrictions apply before pagination. Ordering is creation time, then
run ID, both descending. The array response and summary option are retained.
Clients needing older history must request subsequent pages.

Agent and audit history load 25 rows at a time. Audit status filtering happens
on the server. A selected agent run can be fetched independently of the loaded
pages. Rows are deduplicated by ID; offset pagination can still skip rows when
new runs arrive between requests.

Issue history polling stops once there are no live runs and completed-run
liveness has been populated. Live chat and ledger polling retain their
one-second and five-second intervals respectively. Missing historical
liveness is retried every five seconds, including for completed issues.

## Server query changes

- Dashboard charts restrict recent runs to the chart window and follow retry
  ancestry in one query, preserving unique recovered-run counts.
- Sidebar approval and latest-run badge reads execute in parallel. The release
  already removes full-dashboard alert reads; its responsible-user filtering
  and badge counts remain unchanged.
- Wake recovery joins keep `issues.id` as UUID and cast the saved payload only
  after validating its exact lowercase, dashed representation. Values that did
  not match the former text join remain non-matches without cast errors.
- External chat milestone projection checks for an automatic endpoint before
  querying lifecycle and native progress. The check runs each invocation so
  endpoint changes are observed. Other reconciliation lanes remain independent.
- Broad task lists aggregate company-scoped comment and non-local activity
  timestamps, then paginate IDs before reading wide issue fields. Selective
  filters, searches, ID ordering and unknown filters retain the existing query
  path. Priority, activity, update time and ID ordering are preserved, including
  the four excluded local inbox actions and deletion semantics.

The task-list approach still scans company history. It is a query-only
alternative to the stored timestamp proposal in
[#13803](https://github.com/paperclipai/paperclip/pull/13803); reconcile overlap
before submitting an upstream PR.

## Verification

Regression coverage includes history limits, offsets and status validation;
dashboard recovery counts; Mine badge visibility; idle polling; malformed wake IDs;
endpoint mode changes; and task-order parity across filters, ties, company
boundaries and deletion of the newest activity.

On the previous release branch, read-only comparisons of the generated SQL
returned the same ordered IDs for
wake recovery and broad task lists. In three alternating sample pairs, median
query execution fell from 11.086 to 5.947 ms for wake selection and from
602.416 to 159.925 ms for a 100-row task page. Host load and cache churn were
uncontrolled. These are query samples, not browser latency guarantees.

The previous release branch passed 101 focused tests across
six files, including the merged run-route validation and regenerated
migration snapshot. The route suite was rerun with a 60-second CLI timeout after
its initial module load exceeded the default test timeout. Server and UI
TypeScript checking, the UI production build, migration checks and token gates
also passed.

Those earlier results are not verification of this release port. Current checks
are reported separately in the branch handoff. Full repository checks on the
previous Windows workspace were limited: the native
Runner toolchain is unavailable, and the normal test wrapper previously failed
with `spawnSync pnpm ENOENT`. Deployment and end-to-end page measurements remain
separate validation steps. This port does not include deployment files or a
Docker image build.

### Release port verification (2026-10-09)

- Direct server, UI and database TypeScript checks passed.
- The UI production build passed. Its four regression files passed 141 tests.
- Migration numbering, safety, schema snapshot drift, index creation, upgrade
  and idempotency checks passed.
- The activity, Mine badge and targeted task-order rerun passed 22 tests. The
  concurrent workspace sweep test passed after its fixture timestamp was made
  independent of PostgreSQL/JavaScript clock precision.
- The other focused suites cover failed-run attention, dashboard recovery,
  bounded history routes, wake IDs, idle chat projection and redaction.

Full repository gates remain limited on this Windows host:

- The normal test launcher fails with `spawnSync pnpm ENOENT`; focused Vitest
  suites were invoked directly.
- The runtime-service activation race test times out waiting for its child
  process marker. The same test fails with untouched release workspace code.
- Recursive typecheck stops because the Rust `cargo` toolchain is unavailable.
- The full build stops in the unchanged Runner workflow-traceability checker
  because it imports a Windows absolute path without a `file:` URL.
- Token gates report 109 violations already present in release files. Three
  occur in the changed issue-detail test, but those exact lines are unchanged
  from the release. The port adds no violating line.

Generated-file checks required LF checkout line endings locally. No Runner
source or generated catalog change is included in this branch. These checks do
not establish full CI or upstream merge readiness.
