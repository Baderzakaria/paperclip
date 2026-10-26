# Next instruction recovery slices

Inspected from slice 39 head bd490ee50b303187f0ae6f8fe2aa95477d66a40f.
Master inspected 5a28f7acf8. Audit only; no implementation or acceptance claim.

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
