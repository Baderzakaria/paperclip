# Terminal confirmation recovery migration

Date: 2026-10-25. Branch: `codex/sleep-32-terminal-confirmations`.
Parent: [#17649](https://github.com/paperclipai/paperclip/pull/17649) at
`2384384eeec4f32d073242ebf597b81df2df1ccb`.
Status: implemented; focused lifecycle acceptance passes. Full acceptance and remote gates are pending.

## Obligation and existing boundary

The owning implementation is
`server/src/services/chat-channels/telegram/confirmation-actions.ts`.
A Telegram confirmation callback accepts or rejects an interaction through
`issueThreadInteractionService`. Its `afterResolveInTransaction` callback
changes the exact `confirmation_response` action from `issued` to `processing`
in the same transaction as the terminal interaction decision. That action is
already the durable record of unfinished settlement. No additional table is
needed.

`settleTerminalConfirmationAction` completes that saved decision: it marks the
action processed, retires sibling tokens, stages an actionless resolution
publication and (when required) an `interaction_wakeup`, and emits the existing
provider-attributed activity entry. It does not repeat the user's decision or
send provider traffic inside the transaction. Compare-and-set losers accept an
already processed winner, preserving callback/recovery concurrency.

`reconcileTerminalConfirmationActions(limit)` currently scans processing actions
by updatedAt/id. It is invoked by `processPublicationMaintenance` on the periodic
chat path and by the explicit/manual publication queue path. The former is this
slice's target. Preserve the latter's manual recovery contract. Interaction
continuation delivery and GitHub maintenance remain separate reasons/PRs.

## Producer inventory

- [x] Acceptance callback: notify before its processing-action write inside the
  existing `afterResolveInTransaction` owner.
- [x] Rejection callback: same contract, separately exercise the real path.
- [x] Initial action token creation in `chat-interaction-publications.ts` writes
  `issued`; a user still deciding does not owe settlement work. It must be quiet.
- [x] Terminal/supersession publication helpers expire issued sibling tokens;
  inspect their exact predicates before treating them as processing producers.
- [x] Settlement writers move processing actions to processed/failed/expired.
  Preserve publication notifications, activity provenance and continuation order.
- [x] Board-resolution compatibility: current integration coverage fabricates a
  processing action before the board decision. Establish how historical pending
  processing rows reactivate from a later interaction change, without repeatedly
  scanning an unchanged human-wait state.
- [x] Startup reconstructs processing debt. Outer rollback creates no actionable
  debt, ambiguous commit uses the existing transaction signal protocol, and
  first-write drain/resume retains the wake.

## Mechanism and unresolved design checks

Reuse the existing delivery coordinator and action worker registration rather
than adding a new scheduler or teaching app startup Telegram payload semantics.
The provider module owns settlement, malformed token handling, binding checks and
activity attribution. A shared registration may select a normalized action kind
and delegate to it.

Do not merely move the unbounded retry behavior into a new timer. The current
settler returns false for a processing action with no conversation, and for a
still-pending interaction. The oldest unfinished prefix can therefore starve
later candidates under the fixed limit. Separate a genuinely runnable terminal
settlement from a pending interaction; audit the producer that makes the latter
runnable. Preserve explicit failure evidence for malformed bindings rather than
silently deleting work. Bound candidate work and prove progress beyond a denied
or failed prefix. Retrying a failed query is different from polling an unchanged
human decision.

The first notification must not race callback settlement into a duplicate
publication or activity entry. Existing compare-and-set and idempotency keys are
the correctness owners. Future checks should observe the durable result and
provider-visible behavior, not only calls to a notification helper.

## Verification plan

The existing integration test beginning `renders safe Telegram confirmations as
opaque one-use buttons and wakes the resolved task` injects a failure after the
interaction transaction commits but before action settlement. It verifies the
saved decision, recovery publication, provider edit before continuation wake,
one-use token behavior, redelivery deduplication, board-race provenance and
failed continuation handling. Reuse its fixture and assertions rather than
building a parallel authorization fixture.

- [x] Reproduce missed recovery after the real postcommit callback failure when
  periodic/manual maintenance is not invoked.
- [x] Prove committed acceptance and rejection activate recovery from idle.
- [x] Prove first-write drain/resume, stop/restart, failed selection/retry and
  writes during a drain/sweep.
- [x] Verify outer rollback/commit through actual producer ownership where the
  callback service accepts a caller-owned transaction.
- [x] Prove empty state, issued tokens awaiting a person, and completed history
  make no recurring SQL after settlement.
- [x] Prove bounded progress behind pending/malformed/contended candidate prefixes.
- [x] Retain the existing terminal edit-before-continuation behavior, duplicate
  callback handling and board-resolution attribution.
- [x] Register production work and remove only its periodic maintenance call.
- [ ] Complete final server/workspace types/build, full chat/startup acceptance,
  and fresh remote review/checks. Production wiring has a source guard; the
  existing generic action-worker registry is unchanged.

## Scope remains open

No Cloud wake gate, transport ownership, provider deadline, or sleep eligibility
changes are implied. The supported process-local writer model remains explicit.
Every remaining original recurring-server reason and older stack finding stays
in the ledger; this audit does not reduce the requested scope.

## Implementation and boundary decisions

The Telegram owner now exposes only `registerTerminalConfirmationWork` through
its existing callback/service wiring. Shared app startup selects this owner; it
has no Telegram payload or decision policy. The owner reconstructs processing
action IDs from existing rows, using 100-row UUID-keyset pages, and registers
per-action entries with `registerScopedDeadlineWork`. The shared worker attempts
at most 25 entries per sweep, rotates companies, retains commits arriving during
an attempt, and backs off query/settlement failures from 30 seconds to five
minutes. A failed entry does not prevent later entries from progressing.

Successful settlement, already terminal/missing actions, invalid actions that
receive a failure record, and actions still waiting on a pending interaction
remove their scheduled entry. The latter retain their durable processing row;
they wake when the interaction changes. Issued tokens and completed history do
not enter recovery. Missing conversation IDs now receive the existing
`confirmation_action_binding_invalid` failure classification instead of remaining
processing forever. Other invalid-binding and authorization policy stays with the
existing settler.

Both real callback decision transactions await a confirmation intent before
writing processing state. The existing issue/company milestone notification
boundary also emits an identifier-only confirmation hint. This covers board
accept/reject, expiry, withdrawal, supersession and other supported interaction
changes without adding wrappers to each writer. It also means unrelated milestone
changes can cause one scoped reconstruction; an issue hint never restarts a global
inventory. The company/issue query includes orphaned conversation bindings in the
same company so invalid work can receive an explicit failure record. Company-wide
hints and startup reconstruct the full matching processing inventory in bounded
SQL pages; total enumeration and memory are proportional to that inventory, not
capped at 100 rows. No claim of constant startup cost is made.

Only terminal-confirmation reconciliation was removed from periodic publication
maintenance. Explicit `processPendingPublications` maintenance still calls the
existing manual reconciler. Interaction continuation delivery and GitHub duties
are unchanged and remain separate stack reasons. The host sleep gate is unchanged,
including its treatment of durable processing debt. Process-local signals cover
supported writes in this process; independent SQL writers/other replicas require
an ingress protocol. Startup reconstruction remains the recovery path after a
process loss.

## Evidence and retained failures

- `origin/master` refreshed to `1949e726f8515127a04314e3793c427ccfc33c1e`;
  full-stack reconciliation is still outstanding. The exact-obligation GitHub
  search found no competing terminal-confirmation migration.
- `/tmp/sleep32-confirmation-before.log` is an invalid test invocation: the root
  Vitest project filter `server` did not match a named project. No tests ran.
- `/tmp/sleep32-confirmation-before-valid.log` uses the server configuration and
  reproduces the real callback gap: a committed action remains processing instead
  of reaching processed when the new worker has no producer notification.
- `/tmp/sleep32-confirmation-lifecycle.log` initially passed accept, reject and
  restart, but drain and failed-selection tests had not advanced to the retained
  30-second deadline. A failed spy assertion also leaked an unconsumed injected
  error into the following legacy test. The tests now advance exactly to the
  registered deadline and always restore the spy. The worker was not changed to
  conceal those harness failures.
- `/tmp/sleep32-confirmation-lifecycle-fixed.log`: all six cases pass, including
  the existing provider edit-before-continuation and duplicate callback journey.
- `/tmp/sleep32-confirmation-atomic.log`: eight focused cases pass, including the
  startup guard and a real outer commit/rollback of the board-resolution owner.
  The test passes 101 pending and 101 malformed actions, verifies failure evidence,
  parks human-wait debt, and observes no fabricated provider-attributed activity.
- `/tmp/sleep32-confirmation-inflight.log`: a real PostgreSQL row lock holds one
  settlement while a second real callback commits. Releasing it settles both
  actions and returns the worker to quiet. This is a ninth distinct focused case.
- `/tmp/sleep32-types.log`: server typecheck passed before the final in-flight
  concurrency test was added. A final typecheck is still required.
- Quiet assertions advance 120 seconds and count root database select/transaction
  calls after startup and settlement. They do not establish provider suspension.

## Broad verification and test-clock corrections

At implementation head `aeaaed7b3e17e1377433165a38fef558acacb631`, workspace
`pnpm -r typecheck` and `pnpm build` passed. The fresh full chat/startup run passed
1,511 of 1,512 tests in 450.49 seconds (`/tmp/sleep32-full-chat.log`, database
`paperclip_sleep32_full_20261025_test`). Every new confirmation test passed. The
old failed-retry notice test's disabled case captured a real
`CONNECT_TIMEOUT localhost:55438` while its result wait advanced fake time by
30 seconds during DB work. The prior slice had corrected a different wait loop;
this remaining jump is now 10ms, with explicit advancement to the saved resume
deadline. Strict error and quiet assertions remain.

Initial remote CI passed 51 checks but failed server shard 4/12 and the dependent
aggregate. The failed test was `plugin-scheduled-work.test.ts`, independent jobs
while completion persistence is unavailable: it expected two runs and observed
four. Direct job log: `/tmp/sleep32-ci-server4-direct.log`, run 40228214324,
job 121274198575. A controlled test clock at 19:59:55 reproduced an extra run
(`/tmp/sleep32-plugin-hour-boundary-before.log`). Added diagnostic timestamps
showed the same job's original owed timestamp at 19:59:54 and another legitimate
cron occurrence at 20:00:00, rather than replay of one occurrence
(`/tmp/sleep32-plugin-hour-boundary-diagnostic.log`). The CI log did not retain
those per-run scheduled timestamps; the controlled reproduction establishes the
failure mechanism, not every timing detail of that CI execution.

The final plugin correction fixes its test clock at 12:10:00 before each case.
An intermediate experiment also reduced its wait steps to 10ms; that prevented
its existing 30-second startup/retry deadlines from being reached and cascaded
into fixture cleanup failures (27 plugin cases failed in
`/tmp/sleep32-check-fixes.log`). Those step changes were reverted. The same
combined run passed all 13 selected chat lifecycle cases, including the five
corrected retry-notice cases. The final one-line plugin clock fix passes all 28
plugin scheduling tests on fresh `paperclip_sleep32_plugin_fixed_20261025_test`
(`/tmp/sleep32-plugin-fixed.log`). No production scheduling code was changed for
these two test failures. Earlier databases and logs are retained.

The initial implementation received Greptile 5/5 with no inline findings. The
corrected head still requires a fresh full chat/startup run, final typecheck,
and new remote checks/review. No unchanged-job retry was used. The PR is
[#17651](https://github.com/paperclipai/paperclip/pull/17651), still draft.
