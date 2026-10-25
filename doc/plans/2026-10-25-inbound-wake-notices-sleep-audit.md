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
