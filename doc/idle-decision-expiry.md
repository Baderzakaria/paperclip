# Decision TTL expiry while idle

Open decisions already contain an `expiresAt` deadline. The expiry worker now
uses that timestamp instead of scanning TTL candidates on each maintenance tick.
This slice owns time-based expiry only. Target invalidation, interrupted effect
recovery, and retention remain separate duties.

## Producers and transaction ownership

Creation and bundle creation notify before the decision insert in their existing
transaction. Existing decision updates share `notifyDecisionChange`, which now
signals expiry as well as continuation delivery. Cancellation, dismissal, and
execution claims therefore remove obsolete expiry deadlines. All production
inserts and updates are in the decision owner; acknowledgement only changes
terminal delivery metadata and cannot change an open expiry. No supported API
currently edits an existing decision's expiry timestamp. A future such writer
must use this same notification boundary.

The helper adds no recovery wrappers to routes. Outer transactions and nested
savepoints retain the shared commit/rollback and uncertain-outcome protocol.
Creation without a committed row cannot publish a business deadline. Startup
reconstructs saved deadlines, including already-overdue work. Independent SQL
writers and another active server process need their own wake contract.

`decision-expiry.ts` owns due selection, the next deadline, and expiry settlement.
`decisions.ts` delegates expiry-on-use and the existing target-driven expiration
transition to that owner. Target selection remains outside the TTL worker.
Startup registers TTL work before the combined decision sweep. The periodic
combined sweep opts out of TTL selection and cannot expire a row merely because
its TTL elapsed. Its public default still includes TTL and preserves the
configured combined-sweep batch limit.

## Deadline, settlement, and recovery

The next deadline is the earliest open `expiresAt`. A partial index on
`(expires_at, id)` covers open decisions. The query selects one indexed row;
retained terminal history does not enlarge the deadline lookup. Expiry is due
when `expiresAt <= now`, including equality. The old combined path skipped the
exact equality despite selecting that row; this migration fixes that boundary.

Each worker pass attempts at most 100 candidates ordered by expiry and ID.
Its in-memory cursor advances across failures and wraps after the last page.
Remaining overdue work retains a retry through the saved earliest deadline.
Failures retain the existing 30-second retry throttle. New earlier creation or
resolution of the earliest decision causes deadline reconciliation. When only a
future expiry remains, the worker does not query again until that deadline or a
committed change. No open decisions means no recurring expiry work.

Settlement requires the row to remain open. TTL settlement also rechecks that
the saved deadline is due. Metadata is merged into the current row. The existing
expiry activity and origin continuation are preserved. A deadline-driven expiry
records `ttl`; target-driven expiration retains its own reason. When both causes
are possible, the first successful terminal transition determines the reason.
Continuation failures belong to the continuation worker after the decision is
expired. Neither owner replays decision effects.

Drain and standby defer dispatch while retaining the request. The worker checks
the coordinator's AbortSignal between candidates. Shutdown finishes the admitted
expiry and leaves untouched candidates for restart. It does not process the
whole backlog before stopping. There is no new queue table or permanent DB
listener, and no provider call is held inside a new transaction.

## Limits

The disabled-heartbeat branch keeps its existing behavior and does not register
this worker. Expiry-on-use remains enforced independently of background work.
The in-process deadline is not an external Cloud alarm. Existing conservative
sleep blockers remain; this migration does not permit an instance to sleep with
unsupported future obligations. Worker quiet is not proof of host or database
suspension.

## Verification

The combined selection passes 103 tests: 14 new real-PostgreSQL expiry worker
cases, 50 decision service/continuation cases, and 39 startup cases. It covers
empty and terminal-history quiet, actual create and bundle producers, exact
expiry, moving the next deadline earlier, cancellation, restart, outer rollback
and commit, first creation during drain, failed retry through drain, failed wake
delivery, separate aggregate/TTL ownership, 101 candidates with a failed first
row, creation during delivery, and shutdown/restart with outstanding candidates.
The parent archive race and bounded continuation shutdown regressions also pass.

The first selection had 97 passes and one fixture failure. The fault test cleared
its error collector before an already-admitted failed query had finished. It now
checks all collected causes after recovery settles. The next selection passed
101 cases; after the parent review repairs and bounded expiry/shutdown coverage,
all 103 pass. No production hold, retry, or timeout was weakened.

Migration 0383 applies and replays successfully. With 40,000 synthetic decisions
and one open row, the next-deadline query uses the partial index, reads two shared
buffers, and executes in 0.022 ms locally. The probe transaction rolls back. This
is query evidence, not a production latency or savings claim. Workspace
typecheck and build pass on the combined branch. Full PR CI and fresh review
remain required before readiness.
