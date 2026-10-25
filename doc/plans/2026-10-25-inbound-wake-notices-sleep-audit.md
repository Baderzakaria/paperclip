# Inbound wake notices: sleep migration audit

Parent: #17639 at `34df8b0d0116a14d414a70d29f64a16c5672a335`.
Branch: `codex/sleep-30-inbound-wake-notices`.
Status: owner/producer audit in progress. Production still polls this duty.

## One reason and its adjacent owners

This slice owns the safe pre-run notices for admitted inbound chat messages:
queued, not started, and removed. The existing owner is
`chat-channels/inbound/wakeup-notices.ts`. These are projections of admission
receipts, not a second scheduler for executing the admitted task.

`chat-channels.ts::processPublicationMaintenance` calls the notice scan on every
chat maintenance pass. The explicit/manual `processPendingPublications` API also
calls it when maintenance is enabled. Production queued-publication delivery
already has a maintenance-free path, which should stay independent.

The current `enqueueInboundWakeupPublications` first invokes
`enqueueFailedChatRetryPublications`. That projects failed-run retry receipts,
with a separate authorization contract in `failed-run-retry.ts`. Separate this
adjacent reason rather than claiming both migrated by moving a compound call.
Terminal confirmation actions, interaction continuations, and GitHub maintenance
are additional separate reasons and remain pending.

## Durable contract

Existing `chat_actions`, `agent_wakeup_requests`, `chat_deliveries`, source
comments, publications and message links own the obligation. No new table is
needed. A normal inbound action must be processed or failed and have the exact
admission receipt. A coalesced receipt must resolve to a matching canonical owner.
Queued requires deferred execution without a run; a failed/cancelled/skipped
receipt must not be presented as a queue wait.

A not-started/removed follow-up can retire only the exact previously visible
queued notice. The published provider message ID and outbound message link are
part of that proof. Deleting one coalesced source must not erase a surviving
batch's response. Promotion, questions, selected final answers and replacement
provider lanes retain precedence. Text remains the existing closed phrases:
no input text, internal scheduler failure, queue position, ETA or model content.

`currentInboundWakeNotice` owns current issue, endpoint, identity and receipt
checks. It takes the existing nonblocking locks to avoid inversion with ingress
and scheduling. Preserve this authorization at projection and again at delivery.
A denied candidate is settled until a relevant mutation; lock contention is
unresolved work and needs a retry. The current catch treats both as zero inserted,
so a count-only return is insufficient once the permanent poll disappears.

## Selector and lifecycle work required

The current owner stores a process-global Date/UUID cursor between bounded calls.
That cursor belongs neither to a company nor to an issue and loses PostgreSQL
microsecond precision. Do not reuse it as a scoped worker cursor. Use stable SQL
precision and a complete per-pass continuation, advance past suppressed rows,
and preserve a concrete obligation when a page or lock remains unfinished.

Use the existing scoped-deadline worker. Startup reconstructs saved work; scoped
commits refresh only matching work; empty or settled history disarms. Retry only
contention, failed reconciliation and unfinished batches. Changes during a pass,
first writes during drain, failed startup, resume and shutdown require the same
shared lifecycle contract as earlier slices.

## Producer audit: do not remove the poll yet

- `inbound/wakeups.ts` settles actual accepted actions. It signals lifecycle
  projection for processed actions, but failed actions can also change notices.
  Preserve the distinction between durable admission and a callback returning.
- `heartbeat/queue.ts` creates deferred receipts, coalesces requests, promotes
  owners and changes terminal receipt status. Existing milestone signals cover
  some run transitions, not every receipt-only mutation. Inspect the existing
  writer transaction owners before adding a notification contract.
- `execution-wait.ts` can persist skipped admission without creating a run.
  Determine which transitions can create or retire an eligible notice.
- `issue-tree-control.ts` cancels queued/deferred receipts without runs.
  Its current notification is for terminal workspace cleanup, not these notices.
- `chat-channels/slack/session-stop.ts` can cancel a queued receipt. A signal for
  the stop-action worker is not automatically a notice wake.
- `companies.ts` cancels queued/deferred/claimed receipts during company state
  changes. Preserve company visibility and disablement behavior.
- Source-comment removal and later receipt promotion can retire a visible notice;
  audit `issues.ts`, message lifecycle owners and queued-comment control paths.
- Publication success/message-link persistence can make a retirement eligible.
  The existing issue-scoped publication notification is a possible shared
  invalidation boundary; ordinary lease/claim bookkeeping must remain narrow.
- Endpoint, connection, resource, identity, membership and task visibility can
  restore authority. Reuse the existing eligibility contract only after checking
  these notice predicates; lifecycle projection coverage is not proof by itself.
- Remaining production receipt writers include heartbeat run control/lifecycle,
  retries, recovery, task retry, human-directed work, native status decisions,
  continuations and provider-capacity retry. Classify supported notice-producing
  paths explicitly. A search hit alone is neither coverage nor a required wake.

Notifications must precede the write and follow the existing outer transaction.
Do not create an external call or a recovery object at every route. Do not wake
for unchanged health checks or claim renewal. Process-local signals retain the
single active writer model; external writers require their own integration.

## Acceptance

Existing integration fixtures `deferredChatQueueFixture` and its pre-run FIFO
cases exercise coalescing, restart, successor reuse, exact final/question lanes,
revoked reach, source deletion, identity/session changes, canonical owner IDs,
and receipt-lock contention. Establish that baseline, then add real-producer
worker tests with no manual projection call or periodic backstop.

New cases must prove configured-idle/history quiet, first durable admission,
outer commit/rollback, receipt-only cancellation, source removal after promotion,
visible-queue receipt ordering, restoration of authority, suppressed full pages,
scoping/fairness, lock retries, drain/resume, concurrent changes and shutdown.
Do not turn queued work into periodic notice polling after its notice is saved.

This audit changes no runtime behavior or Cloud eligibility. Exact implementation,
producer coverage and acceptance remain required before a migration PR is ready.

## Groundwork evidence

The existing 22 FIFO/notice integration cases pass in
`/tmp/sleep30-inbound-notice-baseline.log`. A new regression then reproduces the
cursor defect: 50 authority-rejected actions share a PostgreSQL microsecond
timestamp before one valid admitted action; two bounded passes both return zero.
Evidence: `/tmp/sleep30-notice-cursor-before.log`.

Preserving the timestamp as PostgreSQL text repairs that defect without changing
eligibility or batching. All 23 notice cases pass in
`/tmp/sleep30-notice-cursor-fixed.log` on a fresh isolated external PostgreSQL
fixture database. Production typecheck passes in
`/tmp/sleep30-cursor-typecheck.log`. The new test deletes its artificial candidates
so they cannot starve later tests. Scoped worker ownership and complete producer
coverage remain unimplemented; this is groundwork, not a polling-removal claim.

## Scoped owner and first producers (2026-10-25)

Parent notification repair `3447973f6f` is merged into this local branch.
The owner now exposes scoped candidate reconstruction and normal-notice-only
reconciliation. Each scoped pass has its own microsecond-precise keyset cursor,
advances past suppressed pages, and reports actual lock contention separately
from settled authorization denial. The manual API retains its bounded cursor
and combined failed-run retry behavior. The new scoped-deadline worker is
implemented but **not yet wired into production startup**; the periodic backstop
remains until all producer and lifecycle coverage is complete.

The existing lifecycle/authority notification boundary now also invalidates
normal inbound notices. Real chat admission wakes the worker after a quiet
startup, and settled/published history becomes quiet again. Removing that
notification makes the acceptance case fail (no queued publication), proving
the case exercises the producer rather than a manual scan.

Task-tree cancellation and source-comment tombstoning each reproduced a missed
retirement wake. Tree cancellation now registers intent inside its transaction;
caller-owned transactions retain outer commit/rollback semantics. Tombstoning
reads and locks the still-live comment's company/task binding before registering
intent and updating it; already deleted/missing comments remain no-ops. These
changes preserve existing notice text and current authorization. Tests deliver
the queued publication with maintenance disabled, perform real service mutations
inside a rolled-back outer transaction and then a committed transaction, and
observe the existing provider message being edited once. Two minutes of fake
idle time cause no further root select/transaction calls.

29 scoped/manual/admission/retirement integration cases passed in
`/tmp/sleep30-notice-producer-acceptance.log`. Producer regression evidence:
`/tmp/sleep30-notice-worker-before-producer.log`,
`/tmp/sleep30-notice-tree-cancel-before.log`, and
`/tmp/sleep30-notice-source-removal-before.log`. Initial worker-test failures
were missing `canRun` in its coordinator fixture and a wait that checked only
the timer while a sweep was still running; the corrected wait also requires
idle-work settlement. These fixture failures are not production defects.
Server typecheck passed in `/tmp/sleep30-notice-producer-typecheck.log`.

Still required: remaining receipt/cancellation writers (including budget, agent,
company and Slack stop paths), admission-failure settlement, authority changes
not already covered by shared notifications, batching/scoping/lifecycle tests,
production registration, and removal of only this duty from the maintenance
loop. Fresh PR creation and all checks remain outstanding for slice 30.

## Receipt audit refinement (in progress)

Do not mechanically notify every `agent_wakeup_requests` write. The normal
notice predicate requires an exact `inbound_wakeup` action, matching durable
receipt/canonical owner, and current source/destination authority. A first queued
notice requires an unadmitted deferred owner. A not-started retirement requires
both receipt and owner to have no run. Removed-source retirement instead requires
the exact visible queued message and a soft-deleted source; it can remain eligible
after surviving coalesced input promotes.

- First durable chat receipt insertion is followed by the existing
  `inbound/wakeups.ts` processed-action settlement, now carrying notice intent.
  Failed action settlement is still an explicit gap to address. Do not assume
  the earlier admission transaction alone establishes a processed action.
- `execution-wait.ts` increments counters on an already-skipped receipt or
  inserts a new skipped receipt. The counter update does not change notice
  eligibility; first-admission terminal settlement belongs to the action owner.
- `heartbeat/queue.ts` periodic `updatedAt` touches (queued-comment interrupt and
  stranded-queue inspection) and `run-control.ts` retry cursor touches must not
  wake notice reconciliation. `executionWait` explanatory-message-only updates
  do not change the closed notice text or eligibility.
- `explicit-native-continuation.ts` and `fresh-workspace-continuation.ts` change
  the task-retry workspace strategy only; no notice wake follows from that field.
- `human-directed-work.ts::retainBacklogHumanAssignment` inserts a completed
  board-provenance receipt, not a deferred inbound-chat admission.
- `setWakeupStatus` call sites found in heartbeat queue/control/completion,
  recovery and retries operate on a run's receipt. Recheck any exceptional
  run-less caller before adding a broad signal: a receipt with a run cannot
  produce not-started, and source tombstoning owns removed-source activation.
- Explicit cancellation paths still needing integration/tests include
  `run-control.ts::cancelPendingWakeupsForBudgetScope`, `cancelPendingWakeupsForAgentsInternal`, company archive cascade,
  Slack session stop, and queue replay paths that decline an unadmitted receipt.
- `issues.ts` reassignment cancels user receipts in the issue-update transaction;
  it currently signals lifecycle only for unhide, so that signal is not coverage
  of reassignment. Current-authority restoration and mutation ordering need an
  explicit test.
- Dot/Muse follow-up consumption changes deferred receipt payloads and can bind
  them to an already-running turn. Audit their provider-lane precedence rather
  than emitting a false not-started notice for consumed input.
- Task-retry and failed-run-retry generations have separate notice policy. Check
  whether normal inbound receipts may reference their canonical owners before
  deciding which writes belong to this reason or the next failed-retry slice.

The full chat integration suite was launched at local branch `c579148977` on a
fresh `paperclip_sleep30_full_chat_20261025_test` database, with output at
`/tmp/sleep30-full-chat-acceptance.log`; its result must be read before claiming
acceptance. Typecheck after merging the second parent repair passed in
`/tmp/sleep30-after-parent-typecheck.log`.

## Producer and lifecycle completion (2026-10-25)

The full chat suite at `c579148977` finished successfully: 1,458 tests in
`/tmp/sleep30-full-chat-acceptance.log`. This was the baseline before the
cancellation and privacy changes below, not acceptance of later edits.

Real service regressions reproduced stale visible queue notices after agent
cancellation, budget cancellation, and company archival. Signals now belong to
those owners' transactions, as well as Slack Stop and deferred queue cancellation
and failure. Agent cancellation now rechecks pending status and absence of a run
at update time, so it cannot cancel a receipt promoted after candidate selection.
Caller-owned transactions preserve outer commit and rollback. Company lifecycle
intentionally owns its root transaction; its test respects that contract.

Task status/assignment changes and privacy changes can restore eligibility.
Task privacy can affect descendants, so it invalidates the company scope. Explicit
task grants and private-project membership use their existing persistence owners;
the project-member helper owns a small transaction that also nests under callers.
Project visibility changes use the existing project transaction. Shared chat
identity, endpoint, resource and membership signals already cover the other
current-authority predicates. Ordinary health refreshes and receipt cursor touches
do not signal this worker. Run-bound settlement and Dot/Muse consumption do not
create a not-started notice; their existing response/progress owners retain that
policy. Failed-run retry notices remain a separate owner.

Failed inbound-action settlement and repaired delivery acceptance now invalidate
normal notices when a valid durable request exists. Preparing actions whose
underlying deliveries were rejected cannot satisfy the notice predicate and do
not acquire a notice obligation. Publication completion already signals the task
inside the transaction that saves the provider receipt and message link. A new
race test holds provider I/O, removes the source, observes the notice worker
settle before the receipt exists, and proves that the eventual receipt commit
reactivates the removed-source edit.

The app now registers `chatInboundWakeNoticeWork` with the existing coordinator.
`processPublicationMaintenance` retains only the separate failed-run retry notice
pass, plus its other unmigrated duties. The explicit/manual combined
`enqueueInboundWakeupPublications` API remains available.

Focused acceptance at the current source passes 42 cases in
`/tmp/sleep30-wired-acceptance.log`. These include actual admission after idle,
scoped/manual cursor pagination, denied history, receipt-lock contention,
transaction rollback and commit, queue rejection/failure, agent/budget/company
cancellation, privacy restoration through task grants and project membership,
signed Slack Stop, late provider receipt, restart deduplication, writes after
shutdown, first write and failed selection during drain, and a commit arriving
while an empty selection returns. Quiet assertions observe root SQL entry points
after advancing fake time by two minutes. The lifecycle tests do not prove host
or database suspension, and no Cloud sleep-safety blocker is relaxed.

Preserved failures and fixture corrections:
- `/tmp/sleep30-cancellation-before.log`: agent cancellation missed its wake;
  an attempted agent reassignment fixture was rejected by the existing external
  channel binding rule. The unsupported fixture was removed, not bypassed.
- `/tmp/sleep30-budget-company-before.log`: budget cancellation missed its wake;
  company lifecycle correctly rejected a caller transaction. The root-company
  reproduction in `/tmp/sleep30-company-root-before.log` then showed its missing
  wake. All five initial retirement cases passed after the repair.
- `/tmp/sleep30-notice-privacy-before.log`: opening a private task did not wake
  its saved notice. The repair passes. Initial grant tests used an unlinked
  external principal as a user; corrected fixtures establish a linked board user
  through the normal chat setup before admission.
- The first signed Stop fixture had an invalid Slack channel ID and a verifying,
  rather than qualified active, endpoint. Correcting both makes the signed event
  reach cancellation. `/tmp/sleep30-signed-stop-qualified.log` passes.

Workspace typecheck/build, full acceptance after startup wiring, PR publication,
and latest-head CI/review are still required before this slice is ready.


The first workspace-wide typecheck and build at `d4f7426bb4` found a missing
required limit in the newly separated failed-retry maintenance call (TS2554).
The corrected call passes 50, preserving the old combined wrapper's default.
The full chat run at that revision was deliberately interrupted (exit 130) after
this compiler evidence; it is not acceptance. Its log remains at
`/tmp/sleep30-wired-full-chat.log`. Fresh verification is required after repair.


## Bounded candidate passes after review

At `87f5c827b0`, workspace typecheck and build passed, and the full chat plus
startup-gate selection passed all 1,486 tests in
`/tmp/sleep30-final-full-chat.log`. CI subsequently passed every code gate;
Greptile found a real fairness defect (comment 4371894496): the reconciliation
limit counted inserted notices rather than candidates authorized, so a denied
history could monopolize one pass.

The new regression fails before repair in `/tmp/sleep30-fairness-before.log`:
a requested 50-candidate pass opens more than 50 candidate transactions. The
repair returns a precise continuation cursor after at most the requested page
size. The notice worker retains that cursor between scheduler passes. It also
retains contention from earlier pages and, after reaching the end, revisits it
from the beginning rather than silently discarding locked work. A committed
scope invalidation reconstructs the entry with a fresh cursor; no shared
scheduler or authorization policy changes are needed.

All 44 selected integration cases pass in
`/tmp/sleep30-fairness-acceptance.log`, including a 150-row denied backlog,
an unrelated task completing between bounded passes, contention on the first
page surviving a later page, and a real privacy-restoration write while a page
is in flight. The latter revisits the formerly denied prefix, publishes exactly
once, and then performs no root SQL for two minutes of fake idle time. Manual
pagination remains separate and retains PostgreSQL microsecond precision.
Server typecheck passed after the cursor contract change. Full latest-head
remote checks and review must be revalidated after pushing the repair.

The next owner audit must explicitly trace ordinary receipts coalesced into a
failed-run retry receipt: `findExistingDeferredWake` does not itself exclude a
retry owner. `allowRunCoalescing: false` on the retry's own admission is not
proof that a later ordinary admission cannot select it. In particular, inspect
the retry authorization-denial write before assuming it can only affect retry
notices. This is an open producer-audit question, not a verified exemption.
