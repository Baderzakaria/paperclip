# Instruction recovery sleep audit

Inspected from slice 39 head bd490ee50b303187f0ae6f8fe2aa95477d66a40f.
Master inspected 5a28f7acf8. The following is the initial audit; implementation
and acceptance evidence for slice 40 are recorded below.

The apparent two calls in heartbeat/recovery.ts hide at least three reasons:
1. recoverStopped: collect/dispose registered instruction copies after terminal run
   AND independently established local/remote process stop. Never infer stop from
   terminal status. Temporary staging failure has its own pre-launch guarantee.
2. recoverCaptured pending loop: retry saving durable candidate bytes, state
   pending_commit, attempts <=2, nextAttemptAt null or due. Canonical authorization
   and base comparison remain in agentInstructionRevisionService.commit.
3. recoverCaptured cleanup loop: release temporary agent directories after a
   terminal save receipt plus processStoppedAt, baseline/cleanupPending marker,
   and due nextAttemptAt. Preserve remote identity and cleanup authority.

Keep one reason per PR. Captured commit is the smallest independent next slice;
stopped collection and post-save release must remain on the existing reaper until
separately migrated. Do not retire recoverCaptured wholesale with only save covered.

Durability already exists in agent_instruction_working_copies, defined in
packages/db/src/schema/agent_instruction_revisions.ts. Existing index
agent_instruction_copies_pending_idx(state,next_attempt_at) may suffice; inspect
EXPLAIN before adding an index. No new table needed. Attempts and nextAttemptAt
are business recovery state; do not reset the three-attempt bound.

Producer map:
- agent-instruction-working-copies.ts::patch owns CAS writes with state, attempts,
  baseHash, retainedByRunId predicates. Add before-write signal in short existing/
  new DB transaction, without enclosing file/network work.
- collectStopped captures bytes via patch(pending_commit) before calling commit.
  commitCandidate updates saved/conflict/retry state via patch; resolve also patch.
- prepare inserts preparing rows; no captured work until patch. acknowledgeExplicitSave
  only advances prepared baseline, not pending work.
- agent-directory-working-copies.ts receives patch for ordinary mutations. Its
  direct inserts/adoption/deletes need explicit audit but currently create prepared
  or staging rows, not pending_commit. Do not assume legacy candidate payloads
  and agent-directory receipts have the same semantics.
- Run/company/agent deletion cascades can remove obligations: signal exact scope
  before supported deletion to disarm stale entries.

Concurrency risk to test before relying on events:
A pending_commit write can wake recovery while foreground commit is still active.
Revision commit serializes through its owner and explicitly deduplicates exact
candidate bytes before testing baseline equality. Copy CAS can lose to a competing
attempt counter update; a later worker must recover the receipt without falsely
reporting conflict or saving twice. Test actual producer plus held foreground
commit and verify canonical bytes, one durable activity receipt, and final state.
No transaction should contain process/file collection just to emit a signal.

Stopped-copy producer audit is wider:
- terminal run transitions (including direct recovery writers)
- copies.processStoppedAt and retention/handoff state
- native.local_process_stopped via recordNativeLocalProcessStop in heartbeat,
  native restart recovery, and native-local-process-stop itself
- later process-start/identity events invalidate local stop receipts
- environment lease remoteExecutionTermination receipts and removal/reacquisition
  via environment-runtime, environments, task runtime, workspace recovery/export
- stalled unconfirmed owners are real pending obligations; preserve safe backoff
  or a complete notification replacement. Never claim quiet by dropping them.

Testing planned:
Real managed instruction file and authorization, actual collectStopped producer;
no-config/prepared/history/exhausted/conflict quiet; exact saved deadline; transient
save error; rollback/outer commit; foreground race; restart; drain/standby; shutdown;
more than one page and company fairness. Assert file bytes and save receipts, not
only callback invocation. Existing test harnesses currently require embedded DB;
use guarded external disposable URLs here as needed, maintaining embedded default.

Remaining acceptance of 39 and older stack gates stays outstanding. No merge
is authorized. No claim about host suspension or expanded Cloud alarm coverage.

Baseline acceptance before changing production behavior:
- 20 instruction working-copy tests passed in 6.83 seconds.
- 87 persistent agent-directory tests passed in 18.27 seconds.
- Suites used separate dedicated PostgreSQL databases through the guarded external
  test URL helper. Their embedded default and temporary filesystem isolation remain.
- This only establishes a baseline. No periodic instruction duty is migrated yet.

## Slice 40 implementation: captured commit only

Parent: slice 39 at `ecef7776a4b38e0c7e0b86d7009fcd01ed7658e5`.
Remote master remains `5a28f7acf8a8c86536c4f5c5369bfeb49a46c41a`.

The instruction service owns eligibility, saved retry times, and save attempts.
The existing scoped delivery worker owns coalescing, company-fair batches of 20,
reconstruction, pause/resume, failure backoff, and shutdown. Inventory uses scalar
fields and keyset pages of 100. Candidate bytes are read only for an actual attempt.
No table, migration, provider-specific scheduler, or Cloud alarm contract is added.

The pending predicate remains `state = pending_commit` and `attempts < 3`.
The actual `nextAttemptAt` is used; null means due now. Completed copies,
prepared/live copies, permission conflicts, and exhausted candidates are quiet.
The three-attempt bound and preserved-candidate policy are unchanged. A bounded
business retry is distinct from a database/inventory failure: the latter retains
shared recovery backoff rather than discarding an unconfirmed obligation.

The existing copy mutation boundary emits intent before writes that enter or
leave pending commit. Other copy mutations keep their existing query boundary.
The notification and update share a short transaction, including a caller-owned
outer transaction. Filesystem reads, file replacement, directory merge locks, and
provider transport operations are not enclosed in that new transaction. Company
and agent deletion signal company scope before cascading run deletion. Worktree
execution settings signal reconstruction; the heartbeat facade reads that policy
fresh and gates drain/standby. Local process signals do not cover independent SQL
writers or another replica; this remains the existing supported writer model.

A worker rereads the candidate and atomically claims an attempt using the existing
state, attempt, baseline hash, and retained-owner guards. It also requires the
saved deadline still to be due at claim time. A newer future deadline wins without
consuming an attempt. Manual/startup recovery delegates to this same owner. The
existing revision service retains permission checks, canonical-file locking,
exact-byte replay receipts, and baseline conflicts. Shutdown joins a save already
admitted; it does not discard the persisted candidate to become quiet.

Only the commit portion of `recoverCaptured` is excluded from periodic reaping.
Stopped-copy collection and post-save directory release keep their prior recovery
path for separate slices. The existing directory release after a successful save
remains part of that foreground settlement; its independent crash-recovery sweep
is not claimed migrated.

## Evidence and failure record

- Final instruction suite: 33 passed, including 13 worker cases, in 10.23 seconds.
  Covers quiet prepared/completed/conflict/exhausted history, real capture after a
  filesystem failure, actual saved deadline, restart, drain, standby, outer commit
  and rollback, existing attempt cap, permission conflict, foreground save race,
  shutdown join, newer-deadline race, worktree setting reactivation, and 103 saved
  candidates across multiple inventory pages. Tests verify canonical bytes and
  the save receipt, including one activity receipt after concurrent exact saves.
- Existing directory and startup acceptance: 137 passed on fresh fixtures.
- Final startup and heartbeat instruction-release wiring: 64 passed. Startup is
  counted in both selections; the three final suite groups cover 184 distinct tests.
- Workspace typecheck/build passed. Final server typecheck passed again
  after the manual recovery path adopted the common owner.
- Existing pending-copy index plan: with 10,000 synthetic completed rows and one
  eligible candidate, PostgreSQL used `agent_instruction_copies_pending_idx`, read
  one candidate and filtered two exhausted rows, with five shared buffer hits and
  0.011 ms execution. The fixture transaction rolled back. This only demonstrates
  that completed history need not be scanned; it is not a fleet benchmark or a
  constant-cost claim for arbitrary exhausted-pending history.
- Initial worker run: 26 passed, one drain fixture failed. The fixture disabled
  transaction reconciliation as well as work admission, so the intent hold correctly
  remained active. Drain now permits reconciliation; a separate standby case keeps
  it disabled and verifies no passive SQL while retaining the hold.
- First repeated directory run: 106 passed, 29 failed because its reused external
  database retained rows naming the prior run's removed temporary directories.
  Fresh database plus fresh filesystem fixtures passed all 137 tests. The production
  source was not changed to hide those failures. These filesystem suites require
  a fresh external database for each full run, as embedded mode already provides.
- A new race regression failed with the candidate incorrectly saved before a
  newly postponed deadline. Adding the due-time predicate to the attempt claim
  made the focused regression pass, followed by all 33 instruction cases.

## Boundaries and remaining acceptance

Related warm-directory ownership work: #14695. Its stop/retention guarantees stay
with the directory owner. No terminal status is promoted into process-stop proof.
No provider is launched to recover a captured legacy instruction candidate.

Current PR CI and fresh review are still required. Host suspension, database
suspension, external wake delivery, the two remaining instruction duties, the
other run-reaper duties, and the complete original stack inventory remain open.
This stack has no merge authorization.
