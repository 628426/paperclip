# Query and polling performance improvements

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
- Sidebar alerts use bounded error existence and budget queries instead of
  calculating a complete dashboard summary. Counts and alert deduplication
  remain unchanged.
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
dashboard recovery counts; sidebar alerts; idle polling; malformed wake IDs;
endpoint mode changes; and task-order parity across filters, ties, company
boundaries and deletion of the newest activity.

Read-only comparisons of the generated SQL returned the same ordered IDs for
wake recovery and broad task lists. In three alternating sample pairs, median
query execution fell from 11.086 to 5.947 ms for wake selection and from
602.416 to 159.925 ms for a 100-row task page. Host load and cache churn were
uncontrolled. These are query samples, not browser latency guarantees.

Focused tests, server TypeScript checking, UI TypeScript checking, the UI build
and token gates passed during development. Full repository checks remain
unverified: generated Runner artifacts block typechecking/building, and the
Windows test wrapper fails with `spawnSync pnpm ENOENT`. Deployment and
end-to-end page measurements remain separate validation steps.
