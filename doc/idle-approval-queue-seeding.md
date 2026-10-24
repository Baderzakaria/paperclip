# Approval queue seeding without retention polling

## Obligation and stack dependency

The attention maintenance scan does two different jobs: retention and automatic
queue membership. Its call to `materializeSeededQueues` adds pending approvals to
the PR queue when the first linked issue has a pull-request work product. Queue
API readers use saved membership; they do not first build the attention feed.
Removing approvals from maintenance therefore lost automatic queue population.
A real PostgreSQL regression reproduced an empty queue with a pending linked
approval and PR work product, without an attention reader.

This slice owns automatic PR-queue membership for approvals. It depends on the
approval producer boundaries introduced in #17497 and is required with that
retention migration before treating the combined behavior as complete. Join
requests have no issue association or matching seed rule. Other attention-source
seed discovery remains in the existing feed scan and must migrate with an
explicit owner before those sources leave that scan.

## Source of truth and ownership

Existing approvals, issue approvals, issue work products, queues, and queue items
are the only durable state. No new table, outbox, external API, or provider branch
is introduced. `approvalQueueSeedingService` selects missing memberships for:

- A pending approval in an active company.
- Its first linked issue, ordered by issue ID, in the same company and eligible
  under the attention feed's execution-issue visibility predicate.
- A pull-request work product belonging to that issue and company.
- A missing PR queue or an enabled seed rule without this approval's membership.

Disabled rules, nonmatching approvals, completed approvals, and existing seeded
history are passive. A pending approval itself prevents its linked Slack/Speko
conversation from projecting as idle, so this source does not depend on every
other conversation-state producer. Hidden/harness/conversation-container issue
changes retain their explicit signals.

The queue service owns seed matching, creation, membership uniqueness, and audit
writes. The feed and worker use the same writer through a small normalized source
contract. A worker does not construct a presentation-layer AttentionItem. Queue
reads keep their existing source authorization checks. A queue-rule update and
seeding serialize on the existing queue row. Existing memberships are not pruned
when an approval resolves. This preserves current behavior; pruning is a separate
change, including the proposal in #13364.

## Producer audit

| Producer | Commit boundary and effect |
| --- | --- |
| Approval create, cancel, revision, resubmit, resolve | `writeApprovalChange` notifies retention and queue seeding before writes in the owning transaction. |
| Shared approval records, budget approvals, formal tool approvals | The same approval notification covers their existing transactions. |
| Issue approval link, unlink, link-many, tool-created links | Existing approval transaction helper. Link removal can expose a different first issue. |
| Issue visibility changes and issue deletion | Existing approval notification before the update or cascading delete. Routine failure cleanup retains this signal. |
| Company activation, pause, archive, deletion and budget pause/resume | Existing company notification wakes both approval consumers. |
| Work-product create, type/issue update, import batch, delete | The owning work-product transaction notifies seeding when a pull-request row is involved. |
| PR queue creation, rule update and manual approval membership removal | The queue mutation transaction notifies seeding. An enabled rule can re-add a still-matching manually removed item, as the old scan did. |

Other direct work-product writes only create artifacts or update title, metadata,
or trust. They cannot create a pull-request match. Supported writes use these
in-process service boundaries. Independent SQL writers and multiple server
replicas are not covered by local transaction signals.

Retention-only keep/archive/revive changes do not create queue projection debt.
The old seed writer ran before retention filtering, so archived or kept approvals
still follow the same seeding rule. User-specific dismissals do not filter the
unscoped maintenance feed. No new deadline is inferred from those display states.

## Worker lifecycle

Startup reconstructs missing memberships. A committed producer wakes the shared
coordinator. Each sweep processes at most 100 approvals, with an ID cursor that
advances past failures and rotates to revisit them. Each row is rechecked under
an approval lock before the queue writer runs. One bad row cannot permanently
hide later candidates. Atomic existing membership uniqueness prevents duplicate
rows and duplicate insertion audit events.

After a sweep, another lookup decides whether actual projection debt remains.
Only that debt or a failed attempt retains a one-second retry. Once reconciled,
there is no deadline and no recurring worker SQL. The shared deadline worker
preserves requested work during drain, does not run passive domain SQL while
paused, and reconstructs from rows after restart. Shutdown aborts between rows
and waits for an admitted transaction; unprocessed rows remain recoverable.
Registration follows the existing heartbeat-maintenance enablement switch.

This slice does not extend Cloud alarm coverage or loosen host sleep admission.
It proves a worker's quiet/reactivation behavior, not deployed host or database
suspension. The remaining attention maintenance interval is still present for
other source owners.

## Verification

- Before the fix, the PostgreSQL regression found no PR queue after the normal
  maintenance path excluded approvals. After the fix, the queue API finds it
  without a full attention read.
- Twenty real-database worker tests cover empty-to-active-to-quiet behavior,
  startup and completed history, actual approval/link/work-product producers,
  batch import, first-link selection, company isolation, hidden targets, queue
  rule enablement, company activation, resubmission, outer commit and rollback,
  first write during drain, database failure through drain, multiple pages,
  failed-page progress and retry, concurrent resolution, archived/kept history, shutdown/restart, and an admitted transaction at shutdown.
- 115 existing tests pass across queue routes, attention, approval retention,
  approval service, work products, and startup wiring. The shared writer still
  passes existing plan/question/PR seed tests and authorization tests.
- Workspace typechecks and the production build pass. Fresh PR checks are
  tracked in the PR and must pass before readiness is claimed.
- The actual pending lookup on 40,000 completed approvals plus one pending PR
  approval uses the existing partial pending-retention index. The probe runs in
  a rolled-back transaction; execution took 0.094 ms on this local fixture. No new index or migration is needed for this case.

The first expanded test run caught two fixture errors: a hand-inserted queue
omitted required creator attribution, and a failure test expected no idle hold
while committed projection work was still unresolved. The corrected test waits
for the active attempt to finish and checks passive SQL directly while preserving
that required hold. Neither required weakening the worker's recovery contract.
