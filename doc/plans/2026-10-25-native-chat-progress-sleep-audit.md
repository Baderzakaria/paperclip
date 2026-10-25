# Native chat progress: sleep migration audit

Parent: #17606 at `ed76256b979541b962fa784016a550c32920d670`.
Branch: `codex/sleep-29-native-chat-progress`.
Status: groundwork verified; production still polls. Do not mark migrated.

## Duty and owner

Native progress is the separate `projectNativeProgress` lane in the one-second
chat reconciliation coordinator. It projects a closed allowlist of durable run
event types into coarse provider-safe phrases. It never copies event messages,
payloads, tool names, arguments, or results into external publications.

`chat-native-progress.ts` owns selection, authority checks and insertion.
`safe-native-chat-progress.ts` owns the normalized allowlist and phrase policy.
`chat-run-publication-policy.ts` holds only the existing projection window and
shared automatic-publication eligibility. The latter preserves the distinction
between upgraded GitHub bots (tool-owned replies) and legacy automatic replies.
The original export and explicit combined lifecycle/progress API stay compatible.
No generic scheduler should interpret provider payloads or decide disclosure.

## Existing durable contract

- Native running run, matching company/agent and bound issue.
- Active/waiting conversation with an automatic endpoint assigned to that agent.
- Existing base working publication in pending/retry/streaming/published state.
- Latest allowlisted event for that run, inside the existing 24-hour window.
- Event time at least 20 seconds after the base working publication.
- Exact current origin/lineage authorization; current provider interaction and
  explicitly authored final output may suppress this optional progress.
- At most one publication per phase. Twenty-second spacing compares the saved
  event time with saved publication times. Passage of wall-clock time does not
  make the same suppressed old event eligible. Do not invent a timer to retry it
  after twenty seconds or change the cadence policy as part of this migration.
- Existing publications provide durable deduplication and outbound delivery.
  Do not introduce another queue table.

## Verified pagination repair

The selector previously round-tripped event timestamps through JavaScript Date.
PostgreSQL microseconds were lost. With a full page of rejected candidates at
one fractional timestamp, every next page selected those same candidates; an
eligible event later in the ordered stream was never reached.

The new regression creates 30 origin-rejected candidates with a microsecond
timestamp and a valid event after them. A query-count guard fails the broken
pagination without leaving an infinite SQL chain after the test timeout.
The fix keeps the timestamp as PostgreSQL text and uses the full timestamp/run/
conversation tuple for continuation, preserving ordering and eligibility.

- `/tmp/sleep29-progress-cursor-before.log`: fails with non-advancing pagination.
- `/tmp/sleep29-progress-cursor-acceptance.log`: 17 selected cases pass after repair.
- `/tmp/sleep29-progress-owner-acceptance.log`: 21 native-progress and combined
  projection cases pass after extracting the owner.
- `/tmp/sleep29-progress-owner-typecheck.log`: server production typecheck passes.
  This excludes test files. No worker-quiet or production migration claim yet.
- Database: isolated external PostgreSQL
  `paperclip_sleep28_review_chat_20261025_test`, through
  `PAPERCLIP_TEST_DATABASE_URL`. Tests retire their publication endpoints.

## Producer audit and remaining implementation

Two event persistence owners need coverage, not just the post-commit live event:

1. `heartbeat-run-events.ts::appendHeartbeatRunEvent`: native ingestion uses its
   transaction/deduplication path. `paperclip-control-plane-port.ts` wraps this
   in an outer transaction with active-authority checks before and after append.
   Intent must precede the event write and follow outer commit/rollback. Duplicate
   replay must not create fresh projection work. Ordinary non-progress log events
   must not acquire a transaction/XID merely for this feature.
2. `native-run-coordinator-store.ts::appendEvent`: directly inserts run events
   after current-run and sequence/duplicate checks. It does not call the generic
   append helper. Cover it explicitly in its existing transaction.

Additional paths found:

- `provider-trace-workspace-diff-reprojection.ts` appends
  `workspace.diff.recorded` through the generic native-source path. Recovery can
  therefore create a new eligible event independently of live runner ingress.
- `heartbeat/run-lifecycle.ts` uses the generic writer for dynamic event types.
  Preserve its redaction/runtime-status responsibilities; do not project raw data.
- Direct insertion in `heartbeat/queue.ts` writes a lifecycle event; it is outside
  the closed progress allowlist. Coordinator-store direct insertion is not.
- Other native helper callers currently append lifecycle, process, cleanup, or
  credential events. Their existence is not permission to signal every log entry.

Eligibility changes can make a saved event actionable without a new event:
run/issue binding and state, conversation state, current identity/membership,
endpoint/connection/resource authority, lineage receipts, interaction arbitration,
and base-publication state. Reuse the existing issue/company-scoped notification
boundary audited in slice 28. Extend that shared boundary once; avoid repeated
recovery wrappers across routes. Inspect all base-publication retry and operator
resolution owners before removing the poll. `notifyChatPublicationWork` already
accepts an optional issue scope for projection-affecting changes; transport claim
bookkeeping intentionally does not invalidate projection.

## Contention and scheduling

The current projector locks issue then run with SKIP LOCKED. This order avoids
inversion with native finalization and publication foreign keys. A zero insert
count currently conflates ordinary suppression, deletion/terminalization, and
lock contention. The polling caller retries all of them later.

Before replacing that caller, expose whether concrete candidates were deferred
by contention. Retain a retry only for unresolved candidates or failure. Recheck
existence/current eligibility so a deleted or terminal run does not become an
endless retry. A later committed event or eligibility change must remain dirty
if it arrives during the current sweep.

Use the shared scoped-deadline worker and delivery coordinator for coalescing,
company fairness, failure backoff, drain/resume and shutdown. Reconstruct relevant
issue scopes at startup. Scope refresh and projection must use the same candidate
contract. A short settled pass disarms; unfinished batches retain work. Preserve
24-hour policy rather than broadening history during this migration.

## Required acceptance before removing periodic dispatch

- Configured idle and retained completed/suppressed history generate no recurring
  worker SQL after startup and settlement.
- Real event producers wake after outer commit, not savepoint release; rollback
  publishes nothing and settles uncertainty through the existing protocol.
- Duplicate native-event replay and irrelevant log entries create no new debt.
- Both event persistence owners and trace reprojection have causal coverage.
- Restored authority/base-publication state wakes saved eligible events.
- Contended issue and run locks retain recovery while unrelated work proceeds;
  terminalization, final answers and changed authority win before retry.
- Full batches, submillisecond cursor progression, cadence and phase deduplication.
- Restart, failure, changes during a pass, drain/resume, and shutdown.
- Assembled startup registers the worker and removes this one periodic lane;
  other chat maintenance lanes remain until their own migrations.
- Current-head checks/review, final base reconciliation, and an accurate PR body.

Process-local signals retain the single active writer model. No Cloud sleep gate
or external alarm coverage changes here; worker quiet is not provider suspension.

## Remote reconciliation note

Fetched master is `e302f2098f` (not merged into this stack yet). Newly landed
#17616 expands native-harness backup expiration to continuity/quarantine evidence
and adds its evidence signal. Its index.ts interval still exists. Audit this newer
contract when migrating that separate retention owner; do not recreate or drop
its preservation guarantees based on the old inventory.
