# Post-save agent-directory cleanup

Date: 2026-10-25. Parent: captured instruction commit PR #17670 at
`03e1b3cd7270c7438a47562b170b3a9b2dbf112e`.

## One reason and its owner

A stopped agent-directory copy may have saved its files but still owe deletion
of its temporary local or remote materialization. Previously every orphan-reaper
pass called the cleanup portion of `recoverCaptured`, including with no cleanup
owed. This slice moves that reason to the existing delivery coordinator and
scheduler. Captured instruction commits remain the separate parent slice;
stopped instruction collection remains in the reaper for a subsequent slice.

`agent-instruction-working-copies.ts` owns discovery, scheduling and copy writes.
`agent-directory-working-copies.ts` continues to own filesystem serialization,
stop proof, materialization identity, remote lease checks, and physical deletion.
The worker calls that owner; it does not move provider behavior into startup or
the scheduler. No new table, independent timer, or provider branch is added.

## Durable obligation and deadline

The existing copy row owes this cleanup when all of these hold:

- State is saved, unchanged, resolved or unavailable.
- `processStoppedAt` records stop proof.
- Receipt schema is `paperclip.agent-files.v1`.
- Ownership has not transferred through `retainedByRunId`.
- Receipt has a baseline or `cleanupPending: true`, and is not final with
  `cleanupPending: false`.

A final false flag stays final even if an old receipt retains a baseline. This
matches the directory owner's existing no-op rule. Preparation and live warm
copies are not stop proof. Candidate bytes, saved canonical files, storage
warnings, conflict policy and retention semantics are unchanged.

Startup reconstructs pending identifiers and saved `nextAttemptAt` in keyset
pages of 100. It does not transfer baseline JSON or candidate bytes into the
scheduler. Fair batches execute at most 20 entries per pass. The scheduler
retains identifiers for all outstanding entries; memory scales with actual debt.

A due check rereads current state and reserves the existing 30-second retry with
the copy CAS and a due-time guard before I/O. A concurrent later deadline wins.
Physical release joins the existing canonical directory lock and rereads its
current owner. Completion is established by the saved receipt, not a void return
from release. Deferred remote cleanup remains scheduled. If no future retry was
saved, an error retains the shared bounded backoff rather than an immediate loop
or forgotten entry. Failed entries do not prevent other admitted entries from
being attempted. Manual/startup `recoverCaptured` preserves its default behavior
and per-row error handling; only its migrated periodic caller skips this lane.

## Producers and transaction boundary

The common copy patch boundary signals before writes that enter, change or leave
cleanup eligibility. It reuses the short transaction introduced for captured
commits. File operations, merge locks and remote calls stay outside that new
transaction. Nested use retains the existing outer-commit and uncertain-outcome
protocol. A signal only requests inspection of authoritative records.

The producer audit found only these two copy-table owners. Directory preparation
inserts preparing rows; warm handoff inserts prepared successors and supersedes
prior warm rows. Direct adoption requires `unchanged_turn` and no stop proof.
Those direct writes cannot create this post-save obligation. Eligible transitions
use the shared patch. Agent/company deletion invalidates the corresponding
company before run cascades. Worktree execution policy changes reactivate the
worker through the existing settings transaction. Changes to remote termination
proof can make existing pending cleanup executable; the pending row's retry
retains coverage without requiring an independent lease-table scan.

The supported model remains one process with instrumented writes. Independent
SQL writers and additional replicas need their own integration. This PR does
not claim those writers are observed by local notifications.

## Lifecycle and resource safety

Drain and standby retain requested scopes/deadlines without recurring SQL. The
heartbeat facade applies the existing worktree execution policy and task-drain
gate; enabling worktree execution signals a fresh reconstruction. Startup
registration follows existing recovery and respects scheduler disablement.
Shutdown joins admitted cleanup, including a held real filesystem deletion.

Remote cleanup still requires the exact current lease, materialization path and
termination evidence. It never acquires a replacement environment to perform
cleanup. Unknown ownership remains pending. A returned cleanup promise is not
proof that the provider released its resource. Cached transports cannot override
current lease state. Existing owner tests retain these fences.

No host-sleep safety check or Cloud wake capability is relaxed. This migration
establishes worker quiet for settled directory history, not deployed suspension
or measured cost savings.

## Index and migration

Migration 0395 adds a partial `agent_instruction_copies_cleanup_idx` on the
existing table. Its predicate matches discovery and excludes final history.
The migration uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS` and the existing
nontransactional runner, including interrupted-index repair. Schema generation
retains snapshots 0391 through 0395 and preserves all executable migrations.

A rolled-back PostgreSQL fixture with 10,000 added completed records and one
pending record used this index: one row, three shared-buffer hits, 0.005 ms local
execution time. This establishes that this plan skips completed history; it is
not a production latency guarantee or constant-cost claim for arbitrary pending
work.

## Verification and failures preserved

- Full directory suite: 101 passed, including 14 new lifecycle/worker cases,
  against fresh PostgreSQL with real temporary files (26.68 seconds).
- Startup suite: 52 passed, including enabled/disabled registration and removal
  of this lane from the periodic reaper.
- Existing captured instruction and heartbeat release consumers: 47 passed
  against a fresh PostgreSQL database (17.03 seconds).
- Workspace typecheck and build passed. Remote CI/review remain to be recorded.
- Migration applied to fresh databases, resumed after a failed application, and
  runner replay passed. Query-plan fixture rolled back.

The first focused worker run had 7 passing and 3 failing cases because the test
imported `idleWorkSnapshot` from the wrong module. The import now uses its owning
`task-admission` module. The first concurrent migration attempt failed because
0395 was not yet registered with the nontransactional runner; registration was
added, then application resumed successfully.

The first full owner/startup run had 148 passing and one failing case. The existing
reservation-failure test intercepted `db.update`, which no longer receives that
write after it moved into a transaction. Its injection now fails the reservation
transaction. The same substantive assertions remain: the first receipt and files
stay intact, and the next copy cleans successfully. The final 101-case owner run
passes this check. New coverage also proves reservation-failure backoff, a later
deadline winning the claim, real collection racing recovery with one deletion,
unknown remote ownership, and actual worktree setting reactivation.

Filesystem suites use fresh databases per full invocation: their teardown removes
temporary roots, so reused retained rows would refer to deleted fixture paths.
The baseline and failure logs are retained under `/tmp/sleep41-*` locally; the PR
records the outcomes for reviewers without requiring access to those files.
