# Approval retention without idle polling

This slice removes approval retention from the recurring attention-feed sweep.
It does not migrate the other attention source kinds or establish host sleep.

## Obligation and owner

A pending approval in an active company is eligible for automatic archiving
90 days after its last approval activity, unless kept or already archived.
This is a presentation/attention archive: it does not approve, reject, cancel,
or delete the approval. The deadline and policy are unchanged.

Approval rows are the source of truth, including those never viewed in the
attention UI. Scheduling only existing `decision_retention` rows would miss
unseen approvals because the old feed reader materializes those rows lazily.
`approval-retention.ts` discovers eligible approvals directly and registers
the earliest actual deadline with the existing delivery coordinator.

The query retains the attention feed's first-linked-issue rule and consumes
`executionIssueCondition` from the issue visibility owner. Hidden, harness and
agent-conversation tasks remain excluded. A waiting external conversation with
a linked pending approval is active under that same shared visibility policy;
its chat state alone cannot hide this approval. Tests exercise the Slack case.

Each pass visits at most 100 candidates in activity/id order. The cursor keeps
the database timestamp as text so sub-millisecond precision cannot repeat a
failed page. A failed row does
not prevent later pages from progressing. The failed durable record remains
eligible for recovery. Each candidate is re-read and locked before archiving,
so a resubmission committed while the worker waited cannot archive the new
activity using an old selection. Existing retention version, keep and archive
compare-and-set checks remain authoritative. This does not add cross-table
serializability for concurrent link/visibility/company policy changes.

## Producer coverage

| Supported producer | Notification boundary |
| --- | --- |
| Approval create, cancel, revision, resubmit | SQL write transaction in approval records |
| Approval resolution, including hire lifecycle | SQL write, retaining the caller's outer transaction |
| Hard budget approval and budget resolution | Existing accounting transaction |
| Formal tool approval and issue link | SQL write transaction; provider work is outside it |
| Link, unlink and bulk link | Issue approval write transaction |
| Issue visibility changes and deletion | Existing issue mutation transaction |
| Routine creation rollback cleanup | Existing transaction before cascading issue deletion |
| Company activation, pause, archive and deletion | Existing company/accounting transaction |
| Keep, manual archive, revive and accepted archive manifest | Existing retention mutation transaction |
| Retention materialization or source activity change | Signal only when inserting or changing actual state |

Approval comments do not change approval activity under the existing policy.
Company portability imports do not write approvals; restored durable records
are reconstructed at startup. Signals belong to the application DB owner and
its dedicated child pools. Independent SQL writers or another active process
need explicit integration; this change does not claim to observe them.

## Shared contracts and lifecycle

The main maintenance feed excludes the approval source before collecting it.
Public attention reads keep their existing default behavior. Other attention
sources remain in the aggregate sweep until separately migrated.

The retention service accepts the source fields it actually uses rather than
requiring fabricated full UI attention items. Its existing versioned state,
audit writes, authorization and archive-notification outbox are reused. No new
queue table is introduced. Transaction-aware notifications retain intent until
the outer transaction settles, including nested writes and rollback.

The deadline worker uses the shared scheduler's generation and drain behavior.
Startup reconstructs pending work; idle drain retains requests without passive
SQL; resume reconciles them. Failed work retains a 30-second recovery spacing.
No eligible approval means no recurring deadline or query. Completed history,
kept/archived approvals, and inactive companies are quiet until a supported
mutation changes eligibility. Shutdown joins admitted work and stops between
candidates. Notification delivery remains owned by the separate archive worker.

A pending-only `(updated_at, id)` index bounds deadline lookup independently of
resolved approval history. The migration uses concurrent, idempotent creation
and the existing migration runner's nontransactional execution list.

## Verification and limits

Real-Postgres lifecycle tests cover unseen sources, future deadlines, retained
history, keep/unkeep, archive/revive, revision/resubmission, company activity,
linked issue visibility/deletion/order, normal versus maintenance attention
reads, nested commits/rollback, startup and first-write drain, failed database
writes through drain, bounded progress past failure, shutdown, and a concurrent
resubmission. The waiting-Slack case also checks durable notification creation.

Existing approval, attention, retention, budget, tool-gateway and startup suites
are relevant consumers. Track final results and any failures in the PR and the
[stack ledger](plans/2026-10-24-recurring-server-sleep-stack.md).

The Cloud sleep guards are unchanged. An in-process deadline cannot wake stopped
compute, and this approval deadline has not been added to Cloud's durable wake
contract. This proves only the named worker's quiet/reactivation behavior.
