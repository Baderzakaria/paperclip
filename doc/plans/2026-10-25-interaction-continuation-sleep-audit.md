# Interaction continuation delivery migration

Date: 2026-10-25. Inspected parent implementation at aeaaed7b3e17e1377433165a38fef558acacb631 (#17651). This is an owner audit, not an implemented migration.

## Obligation

`chat-channels/interactions/continuations.ts` owns durable `chat_actions.kind = interaction_wakeup` delivery. The existing row already stores issue, interaction, assignee, actor provenance, source comment/run, and optional plan-review context. No table is needed.

Current selector: issued with null result is due now; issued with result is due at updatedAt + CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS (currently 30,000ms); processing is reclaimable at updatedAt + 30,000ms. Claim repeats the predicate. A valid result marks processed; invalid payload marks failed; invalid current issue/interaction/assignee marks processed with an explicit no-longer-applicable code. A refused wake returns issued/deferred. Exceptions return issued/failed with an incremented attemptCount. Existing acceptance deliberately retries beyond five failures; do not silently cap/discard it.

The owner coalesces against an existing non-failed/non-cancelled/non-skipped `agent_wakeup_requests` row with interaction-specific idempotency. A different current durable agent recipient is accounted for as reassignment coalescing. It retains actor provenance, inbound comment lineage, forced fresh-session plan context, and source run/comment. These are not scheduler responsibilities.

## Actual producers

1. `enqueueTerminalIssueInteractionChatPublications` in `chat-interaction-publications.ts` creates issued actions. It is used inside interaction resolution transactions, native review retirement transactions, and callback race handling. The helper inserts continuation state before it iterates terminal publication inserts. Audit every caller's transaction ownership; do not emit a root post-write hint and assume those writes are atomic.
2. `createTelegramConfirmationActions(...).settleTerminalConfirmationAction` inserts the same issued action in its settlement transaction. Its interaction-resolution publication insert is in that transaction too. It can lose insert ownership to the generic producer; onConflictDoNothing is intentional.
3. The continuation worker's claims, deferrals, failures and completion mutate scheduling state. Explicit/manual recovery may run beside the registered worker. Preserve CAS and stale-claim deadlines across those paths and transaction failure.

Search found no other non-test insertion of interaction_wakeup. Native question answers have a separate question-delivery owner and the generic producer explicitly excludes answered ask_user_questions.

## Existing invocation and ordering

`processPublicationMaintenance` still calls `processPendingInteractionWakeups` after scheduling GitHub maintenance. The explicit publication queue calls it only when maintenance=true, after awaiting all publication tasks owned by that invocation. Production publication scheduling uses maintenance=false. Remove only the periodic continuation call; preserve the explicit/manual contract.

Do not merely start an independent action worker on insert: a continuation can become visible in the same commit as a still-pending resolution card. Existing Telegram acceptance asserts the provider card edit happens before the continuation wake. The current periodic path is not itself proof that this ordering is robust. Establish an explicit owner predicate/receipt for owed publication delivery, together with its terminal, cancelled, ambiguous, retry, removed-binding and no-publication cases. Waiting on publication completion must use its committed changes rather than repeatedly poll it. The owner must allow continuation when the prompt was never externally visible and no resolution publication is owed. Avoid turning permanent publication failure into indefinite loss of the user's accepted decision.

The shared `notifyChatPublicationWork(tx, optionalIssueScope)` already signals delivery changes, and terminal publication transitions often supply the issue scope. Audit all release/resolution writers before depending on that fanout. `onPublicationsSettled` currently stores only one callback used by publication refill; do not overwrite it with another consumer.

## Mechanism and verification still to choose

Reuse the shared coordinator/scheduler. Keep action eligibility, publication sequencing and dispatch in the continuation owner; app startup only registers it. Scope committed hints by issue/company (or exact action when useful), restore existing issued/processing debt at startup, retain work during drain and changes during a sweep, and register actual existing claim/retry deadlines. Do not scan completed history periodically.

Tests should use the real accept/reject/board producers and preserve existing provider edit-before-wake, duplicate durable request, reassignment coalescing, deferred delivery, repeated failures and plan/source provenance assertions. Add idle first-write, no recurring SQL after settlement, rollback/outer commit, restart, failed attempt retry, paused/drain resume, bounded progress, and changed publication state wake coverage. Inspect current code again before implementation.

## Independent scopes

GitHub history maintenance remains another PR. Host sleep proof currently fails closed on any retained chat action/publication/delivery rows; this worker migration does not relax that gate or claim external Cloud alarm coverage. All earlier stack findings and final-master checks remain required.

## Ordering refinement from the current queue

The explicit publication queue only attempts eligible, due work, then wakes continuations. A retry with a future deadline, paused/attention endpoint, explicit-publication endpoint, or unrelated FIFO blocker can be skipped. Therefore requiring every resolution publication to become `published` would strengthen the old behavior into an indefinite agent-wake dependency and could lose useful functionality. Preserve the opportunity for ready resolution publication before the wake while leaving provider retry and ambiguous-delivery recovery with the publication owner.

A concrete option to evaluate is a narrowly scoped queue drain for the continuation's issue/interaction before claiming its action. Reuse the queue's eligibility, FIFO, endpoint slots and waitForCompletion contract; do not call provider transport directly or start a second dispatcher. Keep the drain bounded and scoped so an unrelated failing provider cannot block all interaction wakes. Do it before the 30-second action claim so a slow provider attempt does not expire a newly acquired action claim. The generic and Telegram continuation producers must signal before their writes inside existing transactions. Inspect all caller transaction ownership and prove the real callback path before removing maintenance.

## Slice 33 implementation

Implemented on parent `8b43e6222706491f2d8044af3bf86358085069af`.
The owner now registers a scoped deadline worker. It restores issued/processing
rows in 100-row UUID pages, attempts up to 25 entries per sweep with company
rotation, and schedules existing retry and stale-claim deadlines. Completed
history has no recurring deadline. Total startup inventory and memory still grow
with unfinished actions; page size bounds individual reads, not total inventory.

Both enqueue producers register intent before inserting. The generic producer
uses a nested transaction around its action insert, preserving caller-owned
outer commit and also supporting its existing root-client contract. All 20
production call sites of the generic helper pass a transaction. Telegram
settlement already owns a transaction. The continuation owner uses one local
transaction helper for claim, failure, deferral, and settlement writes, with an
exact action hint. Provider publication and heartbeat dispatch stay outside
these transactions. Signals add opted-in transaction/XID work; they are not free
or a cross-process notification mechanism.

The publication queue gained an optional company/endpoint/conversation scope.
Its existing eligibility, FIFO, credential fencing, endpoint concurrency and
ambiguity quarantine remain authoritative. Registered continuation recovery
attempts up to 25 ready publications in the originating conversation before
claiming the action. It waits for that endpoint's existing task when necessary,
without joining unrelated endpoint work merely because the scoped queue is
empty. Shared endpoint capacity can still require waiting for a slot. This is
not a guarantee that every card in an arbitrary backlog becomes published before
wake. Paused/attention, future retry, explicit mode, and FIFO-blocked publications
retain the old queue semantics and do not indefinitely block continuation.
The explicit/manual publication-maintenance contract remains unchanged. Only
the recurring continuation invocation was removed.

The continuation worker rechecks drain/cancellation after publication preparation
before taking a new action claim. Interrupted dispatch and provider ambiguity
remain governed by existing claims, idempotency, and publication recovery. No
new table, expiry policy, attempt cap, or host-sleep exemption was added.

## Verification evidence

- `/tmp/sleep33-missing-signal.log`: the real callback commits its response and
  then hits the existing injected settlement crash. Before enqueue notifications
  are added, the durable continuation remains issued instead of processed.
- `/tmp/sleep33-signaled.log`: the new regression plus existing comprehensive
  Telegram acceptance pass (2 cases). Existing acceptance includes card edit
  before continuation, duplicate callbacks, board attribution, durable wake
  coalescing, deferral, and more than five failures.
- `/tmp/sleep33-lifecycle.log`: 65 selected integration cases pass, including
  seven new lifecycle modes. The two other named suites were filtered out by
  the test-name selection and are not claimed as run.
- `/tmp/sleep33-transactions.log`: 10 new cases pass: accept/reject, drain,
  restart, dispatch deferral/failure, paused endpoint, future publication retry,
  stale processing claim, and outer transaction rollback/commit. Idle assertions
  advance 120 seconds with no root selects or transactions. Server typecheck
  passed before this command.
- `/tmp/sleep33-concurrent.log`: 101 malformed issued actions are explicitly
  failed; valid continuation work progresses. A second real callback commits
  while the first dispatch is blocked; both continuations settle and become
  quiet. This is one additional case.

Full acceptance, workspace typecheck/build, and remote review/checks are still
required. These local results do not prove actual hosting or database suspension.

## Review correction: stop before each publication

At implementation head `6d01f4c730`, workspace typecheck/build passed. Full chat
and startup acceptance passed 1,523 tests in 465.91 seconds, but the 14 standalone
publication tests skipped because their suite supported only embedded PostgreSQL.
This is not evidence those 14 tests passed. The suite now accepts an explicitly
named disposable `_test` external database and closes its own client afterward.

Greptile review was 4/5 and found a valid stop-boundary gap: the continuation
checked cancellation/admission after preparing publications, but that preparation
could start another send after drain, standby, or shutdown began. The three new
real-queue regressions each reproduced the second publication becoming published
when it should remain pending (`/tmp/sleep33-stop-before.log`). They hold the
first provider edit in flight, change the lifecycle state, and release the edit.

The existing queue now accepts an optional `canContinue` callback. The
continuation owner passes its current admission/abort check through preparation.
The queue checks before entry, each batch, each reservation, and each newly
started send. Already-started work is joined and settled. Deferred actions and
publications survive resume/restart. Default callers retain their current
behavior, with shutdown also checked before invoking a reserved send.

All 14 new continuation cases pass after this correction
(`/tmp/sleep33-stop-fixed.log`). The previously skipped publication suite and
startup guards pass separately, 27 cases total
(`/tmp/sleep33-publication-startup.log`). Fresh broad acceptance and remote gates
on the corrected head remain required. No failed run has been relabelled passing.
