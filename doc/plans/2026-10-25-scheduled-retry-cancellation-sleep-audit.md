# Scheduled retry cancellation sleep audit

Slice 39, based on `d8e1bd97f530fc7a5119549a35b871b7b3d9f737` from
[#17666](https://github.com/paperclipai/paperclip/pull/17666).
Inspected remote master: `5a28f7acf8a8c86536c4f5c5369bfeb49a46c41a`.
This slice owns only interrupted cancellation of parked scheduled retries.
The other orphan-run recovery duties remain separate work.

## Obligation and owner

A scheduled retry has no active executor to finish a Stop request if the final
status write fails after the cancellation fence commits. The old orphan reaper
queried for these rows on every heartbeat. It inspected only the first 20 rows,
so malformed intents could also hide valid work behind that prefix.

The source of truth remains `heartbeat_runs`: status `scheduled_retry`, an object
at `result_json.startupCancellation`, and a cancellation accepted by the existing
`readRunCancellation` parser with `expected: true`. No table is added. A correlated
Stop reservation without valid cancellation evidence is not an instruction to
cancel. The worker neither launches a provider nor replaces run-control policy.

`heartbeat/scheduled-retry-cancellation.ts` owns candidate discovery and delegates
to the existing cancellation owner. Cancellation keeps its expected-status guard,
issue/wakeup settlement, budget markers, and original result metadata. Inventory
queries select only cancellation evidence. A selected candidate is read with its
full result before delegation. Every candidate is reread before execution.

Startup and explicit manual reaping retain the compatibility sweep. The periodic
reaper skips this duty after its dedicated worker is registered. Registration
retains the heartbeat scheduler toggle, warm-standby and idle-drain behavior.

## Producers and invalidation

| Owner | Relevant write and signal |
| --- | --- |
| Run control | Ordinary cancellation fence, guarded handoff fence, and budget cancellation fanout signal before their writes. The ordinary fence gains a short transaction; no provider call is enclosed. Existing budget transaction ownership is reused. |
| Native cancellation request | Correlated Stop reservation signals its exact run. The worker still requires valid expected cancellation evidence. |
| Run lifecycle | Transitions from or to scheduled retry signal the exact run in the existing transaction. |
| Queue cancellation | Direct stale scheduled-retry cancellation signals its exact run. |
| Dispatch adapter | Promotion, gate suppression, and queued-to-scheduled cleanup deferral signal the exact run. Deferral can preserve an already-written cancellation intent. |
| Instance settings | Worktree execution enablement changes signal reconstruction. The worker reads this policy fresh; ordinary callers retain the existing cache. |
| Agent/company deletion | Company-scoped invalidation precedes deletion of run records. |

New retry insertion paths in heartbeat retries, recovery service, native provider
capacity retry, and native safe replacement do not copy cancellation intents.
They create no work for this owner until a supported cancellation producer writes
its fence. Retained completed history and ordinary pending retries are quiet.

The supported writer model is the existing single process using the instrumented
DB client. Independent SQL writers and other replicas do not produce these local
signals. This PR does not add cross-process ingress or claim those writers are
covered. Startup reconstruction recovers saved work after restart.

## Shared scheduling and lifecycle

The existing transaction signal boundary tracks intent before writes, including
outer commit/rollback and ambiguous outcome reconciliation. Signals are hints,
not a replacement for durable rows. No caller-managed counters are added.

The shared scoped worker reconstructs candidates in keyset pages of 100 and
processes company-fair batches of 20. It retries concrete failures after 30 seconds,
with exponential backoff capped at five minutes. Settled work removes its deadline.
Malformed evidence is not actionable, and pagination continues past it.

A small shared-helper change handles a per-owner admission gate that is closed
while the coordinator is otherwise running. Pending scopes and deadlines remain
in memory and get a 30-second admission recheck, without SQL. This avoids a tight
loop over an already-due deadline. Existing GitHub helper consumers were tested.
With no pending entries or dirty scopes there is no admission timer either.

Worktree suppression returns no executable work. Its settings writer reactivates
the worker on enablement. Fresh reads propagate failures into recovery instead of
silently treating an unavailable setting as permanent disablement. Task drain uses
the synchronous admission gate so a temporary pause cannot discard durable work.
Shutdown joins active reads and does not start a cancellation after admission closes.

## Migration

`0394_breezy_mongu.sql` creates a partial ID index for scheduled retries with an
object cancellation fence. It uses concurrent, idempotent creation and is listed
in the client's top-level migration set. It changes no rows or API contracts.
The migration was generated through `pnpm db:generate`. Journal entries and SQL
history remain intact; snapshots 0390 through 0394 are the retained newest five.
Migration application, explicit replay, and migration validation passed.

A rolled-back synthetic fixture with 10,000 completed rows and one candidate
used the new index: one row, two shared buffer hits, 0.013 ms execution. This is
local query-plan evidence, not a production performance or fleet savings claim.

## Verification and failure record

Local PostgreSQL 17 databases are dedicated test databases. The route, run-control,
dispatch, and recovery suites accept guarded external test URLs; embedded fallback
is unchanged. Never point these destructive fixture suites at a shared service DB.

- Retry route suite: 30 passed, including 16 worker lifecycle cases. Covers quiet
  history, real Stop with failed terminal write, lost response after commit,
  dispatch cleanup deferral, metadata preservation, outer rollback/commit,
  restart, drain/standby, actual task-drain release and expiry, worktree enablement,
  concurrent intent, foreground race, shutdown, and fair paginated draining.
- Recovery module suite: all 34 passed on a fresh database.
- Existing shared-helper GitHub consumers: 20 passed.
- Workspace typecheck/build passed before the final test-only additions. Server
  typecheck passed again with the final tests. Migration validation/replay passed.
- Initial owner acceptance was 138 passed and 26 skipped, not 164 passes. External
  recovery support enabled those 26. Its first run had 33 passes and one fixture
  failure: a second client still referenced the embedded connection. Updating it
  to use the same external URL produced 34 passes.
- Initial worker selection had eight passes and one incorrect standby assertion.
  Standby correctly retained the unresolved transaction hold. The corrected test
  proves no passive SQL and eventual recovery without asserting away that hold.
- Removing run-control notifications made the committed-fence lost-response test
  fail: the retry remained scheduled. Restoring the producer signal fixes it.
- A metadata regression test failed when recovery omitted the old full result
  argument. Passing the candidate's full saved result preserves budget/operator
  metadata and fixes the regression.
- A subsequent combined owner run had 95 passes and 69 failures in dispatch
  fixture cleanup. Its shared database contained browser sessions from run-control;
  the foreign key blocked issue deletion. Dispatch now has its own database for
  acceptance. This was test-command isolation, not a production source repair.
  The corrected combined acceptance result is recorded below when complete.

## Limits and remaining work

This proves the changed worker can become quiet and reactivate. It does not prove
host or database suspension, extend the Cloud alarm contract, or relax idle-safety
blockers. The scheduler cannot wake stopped compute by itself. Other run reaper
queries, scheduled retry dispatch, task recovery, and the original inventory remain
unfinished. This slice and its parent stack are not authorized for merge.

Final combined owner acceptance passed all 164 tests in five suites, with no
skips, in 41.14 seconds using separate dispatch and recovery databases. Together
with the 30 retry-route tests this covers 194 tests. Remote PR gates remain pending.
