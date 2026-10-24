# Idle decision-effect recovery

Interrupted decision effects now have a dedicated deadline worker. The main
maintenance tick no longer scans running decisions. Target invalidation remains
in that tick; TTL expiry and continuation delivery have their own workers.

## Obligation and activation

The existing decision row is durable truth. A row with `status = decided` and
`executionStatus = running` owes effect recovery. Its next deadline is
`updatedAt + PAPERCLIP_DECISIONS_RECOVERY_GRACE_MS`, default 60 seconds. Zero is
supported; invalid or negative values retain the existing default. Reads do not
move the timestamp. Open decisions and completed history create no recovery debt.

The existing `notifyDecisionChange` helper adds the recovery topic. Creation,
bundle creation, foreground running claims, effect completion, archive completion
and failure, cancellation, dismissal, expiry, and continuation acknowledgements
already pass through that boundary. Notifications are awaited before writes in
the existing transaction. Outer commit activates work; rollback does not publish
a claim. The additional topic does not wrap provider work or agent wakes in SQL
transactions and does not introduce a new queue table.

The supported writer model is the application DB signal owner and its child pools.
Independent SQL clients and multiple active writers need a separate notification
contract. Startup reconstructs committed claims; it does not observe future writes
from unsupported writers.

## Ownership and recovery

`decision-effect-recovery.ts` owns selection, grace, bounded paging, and earliest
deadline lookup. `decisions.ts` owns execution, current membership, effect claims,
audit, archive policy, and continuation delivery. The worker adapter only binds
that domain contract to the shared coordinator. Startup registers it only when
heartbeat scheduling is enabled. The public combined sweep retains its default
recovery behavior for existing callers.

Each pass honors the existing configured batch size (default 100, finite values
clamped to at least one integer). Its timestamp/ID cursor advances past failed or
invalid candidates and wraps at the end. Failed rows retain their obligation.
Rows without a saved decider are not executed under invented authority. A missing
option produces an error. Both cases remain visible as unfinished work and retain
retry scheduling rather than starving later candidates or being discarded.

The decision service re-reads current status before recovery. Foreground and
recovery execution share the existing per-decision flight scoped to the DB owner.
Individual effects keep their durable records and transaction advisory locks.
Completed effects are not repeated after a failed final decision status write.
Recovery derives authority from the saved decider's current active membership.
It preserves the current authorization intersection and current target checks.

The scheduler has a 30-second minimum retry spacing for pending or failed work.
A first claim or failed retry during drain retains its wake without passive SQL.
Shutdown stops subscriptions and checks cancellation between candidates. An
already admitted effect/continuation is awaited; later candidates remain durable
for restart. No periodic pass remains after all claims settle.

## Existing guarantees and limits

Regular effects preserve their existing per-effect transaction boundaries.
Continuation delivery retains its separate at-least-once wake/acknowledgement
contract. This migration does not establish exactly-once external delivery.

Archive proposals have a separate versioned manifest contract. Recovery still
verifies the saved signature/manifest and current authority. A crash after an
archive commits but before the decision settles can encounter the changed
manifest version on restart. The existing result is a failed decision with an
archive error, while the archive remains committed once. The new worker preserves
and tests that outcome; it does not claim to repair this preexisting atomicity gap.

Cloud sleep guards remain conservative. The internal next deadline is not a
persisted external alarm and does not authorize host sleep with running decisions.
This change establishes worker quiet, not actual instance/database suspension.

## Verification

The new real-PostgreSQL suite covers 17 cases: empty/open/completed-history quiet,
real foreground claim and failed settlement, exact grace and zero override,
restart from a claimed effect, active foreground/recovery overlap, outer commit
and rollback, first claim and failed retry through drain, revoked authority,
continuation failure, aggregate exclusion, fair paging past missing-decider and
malformed claims, archive recovery before and after an archive commit, a claim
created during delivery, and shutdown between candidates. Quiet assertions observe
SQL methods through one hour of fake time after settling.

The combined selection passes 212 tests: the 17 new cases, 50 existing decision
service cases, 14 TTL cases, 39 startup cases, and 92 agent-history route cases.
The first 15-case recovery run also passed. Workspace typecheck/build and the
final server typecheck pass. No failure was suppressed or timeout increased.

Migration 0384 adds one partial index concurrently, with `IF NOT EXISTS`, through
the migration owner's top-level statement path. Generation retains the newest
five schema snapshots. Fresh application, replay, safety, and numbering checks
pass. With 40,000 completed decisions and one running claim, both due selection
and earliest-deadline lookup use the partial index and read two buffers (0.012 ms
and 0.003 ms in the local probe). The probe transaction is rolled back.

Full PR CI and review must pass separately before this slice is ready.

A follow-up regression seeds a legacy invalid claim with a PostgreSQL-generated
microsecond timestamp ahead of a valid claim. With a one-row page, the original
Date cursor selected the invalid claim again and starved the valid effect. That
regression failed before repair. Recovery now retains the timestamp as database
text for cursor comparisons, leaving business grace deadlines unchanged. The
invalid claim remains durable debt and is revisited after paging wraps; the valid
claim progresses without repeating its completed effect.
All 18 effect-recovery lifecycle cases and server typechecking pass after repair.
