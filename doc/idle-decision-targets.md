# Idle decision target invalidation

Open decisions no longer require a periodic target scan. The target worker
reconciles committed issue changes and decision creation. Startup reconstructs
open decisions in bounded pages. After reconciliation, valid open decisions and
completed history cause no recurring SQL. TTL expiry, continuation delivery,
interrupted effects, and retention remain separate responsibilities.

## Domain policy

Only strict effect references participate. The existing shared
`decisionEffectTargetIssueIds` helper includes primary and secondary references.
A missing or cancelled target expires a decision with `target_gone`. If all
strict targets are done and at least one was not done in the proposal snapshot,
it expires with `target_completed`. Lenient decisions and proposals intentionally
acting on already-done targets remain open. A target that reopened before
reconciliation is checked in its current state; the notification is not authority
to expire it. The existing open-status compare-and-set arbitrates expiry against
other decision transitions.

`decision-targets.ts` owns this policy and scoped reconciliation. It delegates
expiry, activity, and continuation to the existing expiry owner. The public
combined `sweepExpired` keeps its default behavior for compatibility. Startup
registers the target worker when scheduling is enabled. The main maintenance tick
no longer calls the combined decision sweep at all. No new table or migration is
added.

## Producer audit

| Producer | Intent before write | Scope |
| --- | --- | --- |
| Decision creation, including bundles and caller-owned transactions | Existing creation transaction, before insertion | Decision ID |
| `issueService.update` entering/reasserting done or cancelled | Existing issue update transaction, before the patch | Issue ID |
| Issue removal | Existing removal transaction, before deletion | Full open scan |
| Routine dispatch failure deleting its created issue | Existing dispatch transaction, before deletion | Full open scan |
| Company deletion | Existing deletion transaction, before issue deletion | Full open scan |

The existing target link table supports ordinary issue scopes. Deletion can
cascade away those links before notification delivery, so it requests a full
bounded scan. This rare path must not depend on after-commit links. Company
removal retains all existing restrictive foreign keys; the notification does not
make an otherwise invalid deletion succeed.

Other direct issue writers were inspected: checkout/adoption enter in-progress;
conversation writers enter todo/in-progress/in-review; recovery enters blocked;
release preserves existing terminal status; administrative release changes locks
and assignment. Tree restoration excludes terminal snapshots. Route aliases and
raw privacy SQL do not write terminal status. These paths do not create new
invalidation obligations. They can restore a target before the worker runs; the
worker reads its current status.

The initial decision feature (0197 / commit `9c1f8e7887`) already stored primary
and secondary target links in the creation transaction. The later shared-helper
extraction `ef33c1d9ed` preserved that behavior. There is no newly assumed legacy
secondary-link backfill. Direct SQL writers or damaged/incomplete link data are
outside the supported live writer contract; startup still examines all open rows.

## Scheduling and lifecycle

The owning service holds pending scopes and cursors, not a second durable queue.
The database decisions, options, snapshots, and target rows remain truth. Each
pass examines at most 100 rows/scopes, ordered by expiry and ID using the existing
open-decision index. An empty scope consumes one unit of the pass budget. It
rotates unfinished scopes so a long startup scan does not starve new changes.

A settled notification replaces its scope with a fresh cursor. An admitted pass
cannot delete that replacement when it completes. Failed rows receive individual
retry scopes while later rows continue; query failures retain their scope.
Retries use the coordinator's existing 30-second cadence only while reconciliation
is unfinished. Unknown hints request a bounded full scan. Once all scopes settle,
`hasPending` returns from memory and no future target scan is scheduled.

Intent registration is awaited before writes. Nested writes belong to the outer
transaction. Rollback does not publish a change; ambiguous outcomes retain the
existing XID reconciliation contract. Notifications cover the application's DB
owner and child pools, not arbitrary SQL writers or independent active processes.

Drain preserves pending scopes without passive target SQL. Resume processes them.
Shutdown checks cancellation between rows and awaits admitted expiry/delivery.
Startup reconstructs anything left after process exit. Cloud's conservative
sleep guards are unchanged; this establishes worker quiet, not permission to
sleep with unsupported obligations or proof of host suspension.

## Verification

The initial 17-case real-PostgreSQL target suite passed. The combined selection
passed 233 tests: those 17, 17 effect-recovery cases, 14 TTL cases, 50 decision
service cases, 39 startup cases, 80 routine-service cases, and 16 routine-route
cases. The final target run passed all 18 cases, including a change to the same scope
during reconciliation. In total, 234 selected cases pass across these runs.

Coverage includes actual issue update/removal, decision creation after cancellation,
secondary targets, all-target completion, intentional done targets, lenient history,
outer commit/rollback, startup after deleted links, first change and failed expiry
through drain, reopened targets, scope isolation, more than one page of valid
open rows, failure fairness, creation during delivery, and shutdown. The routine
failure test observes intent and settlement around its real cleanup transaction.
Quiet assertions observe SQL through one hour of fake time after settlement.

Workspace typecheck/build passed before the final test-only addition. No runtime
test failure was suppressed or timeout increased. Existing warnings from startup
fixture signal listeners remain visible. The routine suite now supports the
validated disposable external test database path, so local embedded PostgreSQL
unavailability does not silently skip its 80 cases.

A local query probe with 40,000 completed decisions, one open decision, and 40,001
target links used existing indexes: scoped lookup read five buffers (0.012 ms),
full open-page lookup two (0.003 ms). The probe was rolled back. No new schema
index is needed for this change. Full PR CI and fresh review remain required.

## Review and CI repair

Review found that an absent deletion hint was dropped when the outer transaction
also carried a scoped hint. Both delete-before-update and update-before-delete
regressions reproduced the missing expiry after the target links cascaded away.
Deletion now sends the explicit `all` hint, which survives alongside scoped hints.
The repaired target suite passes 20 cases; the TTL suite passes 14 cases.

The initial CI run failed the TTL worker's drain assertion. It measured SQL
before already-admitted sweeps had finished. The test now joins those specific
sweep promises before measuring passive SQL; unresolved-intent holds remain
intact. Waiting for the entire idle count to reach zero was tested and rejected:
that count correctly includes the retained recovery holds. No production drain
or retry behavior changed for this test repair.
