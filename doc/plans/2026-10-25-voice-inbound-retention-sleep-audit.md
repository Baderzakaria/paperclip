# Inbound voice history retention sleep audit

Baseline: inbound cleanup PR #17580, head
4b4bf2d8af6e08d3859ada4b720e7fbd3ea27e24.
Branch: codex/sleep-24-voice-inbound-retention.
Status: owner audit; implementation, tests, publication and acceptance pending.

## One reason

Remove the remaining recurring inbound history delete. Keep call reports in the
next separate slice. `voiceInboundService.pruneHistory` currently runs from
`voiceSessionService.reconcileMaintenance` in chat's periodic maintenance lane.

The existing retention policy deletes only denied, expired or ended admissions
with no session or intake task, confirmed provider cleanup, and both expiresAt
and updatedAt at least seven days old. Preserve that policy. The actual deletion
deadline is max(expiresAt, updatedAt) + seven days. Never treat unconfirmed cleanup
or a terminal UI label as deletable history.

## Owners and producer boundary

The existing admission rows and cleanup confirmation remain truth. No new table
or row fields are needed. Reuse the scoped deadline worker and register a separate
retention queue. Keep state selection, deadline calculation and deletion in the
voice owner. Startup/app wiring only registers the owner.

All supported admission mutations already use notifyVoiceInbound directly or the
voice-change composition. Extend that boundary to signal the separate retention
queue before writes. This includes signed terminal callbacks, cleanup confirmation,
legacy binding repair, approval/session handoff, expiry and rejection. Bound rows
remain ineligible; their history belongs to their other owners. Company deletion
can remove confirmed unbound history within its existing transaction.

At deletion time, lock and recheck the row and deadline. A cached candidate must
not delete a row that acquired a binding, lost confirmation, or had its updatedAt
moved by a committed write. Preserve fair paging, coalescing, backoff, drain and
shutdown through the existing shared mechanism. Own deletes should retire their
cached entries without starting another periodic scan.

## Required verification

- Configured idle and no eligible history become SQL-quiet.
- Confirmed retained history schedules the exact seven-day deadline and does not
  query before it; restart reconstructs that same deadline.
- Real cleanup confirmation and signed callbacks register retention through their
  transaction boundary; rollback/outer commit behave correctly.
- Unconfirmed cleanup and bound history are never deleted.
- A changed deadline/binding between discovery and deletion is rechecked.
- Paged backlog, first write during drain, failures, and shutdown retain work.
- Existing voice, cleanup, deletion and startup consumers pass.
- Remove only history pruning from recurring maintenance; call reports remain.

No Cloud wake or sleep eligibility expansion is included. The external scheduler
must cover a deadline before that deadline can justify stopping the host.

## Stack state

#17580 is published and attached; 205 selected tests, workspace types/build and
migration checks passed locally. Initial CI run 40181994295 and review run
40181994134 are live on its exact published head. It is mergeable and had no
failures at inspection. Fresh checks/reviews remain required; no merge authority
is implied. #17578 at 90caaf3fa9 has passing checks and exact-head Greptile 5/5;
its latest Paperclip reviewer stopped before completion.

The full original recurring-server ledger, older #17490 E2E failure and final
stack/master reconciliation remain required.

## Implementation and initial evidence

The dedicated voice retention owner now loads eligible deadlines, rounds SQL
submillisecond dates up, and locks/rechecks before deletion. The existing producer
helper signals both voice admission cleanup and retention. App wiring registers
the owner; voice maintenance no longer calls `pruneHistory`. Reports remain in
that lane, and manual diagnostic reconciliation remains compatible.

The initial ten PostgreSQL lifecycle cases had one invalid assertion: an open
transaction was expected to have no coordinator deadline. Intent reconciliation
correctly retains a deadline until settlement. The test now checks invisible
uncommitted state and the row still present within its owning transaction; it
requires deletion only after commit and quiet after rollback. All ten then passed.
An additional real concurrent binding-lock regression and production service
confirmation tests are being verified. Full voice acceptance uses a fresh database
created through the repaired application migrator, not direct SQL replay.

Parent #17580 required repair 4f0364d269: register migration 0388 as top-level
because of its concurrent index. A new migration-runner regression reproduced the
failure, then proved fresh setup, invalid-index repair and concurrent/repeat
replay after the fix. This parent repair was merged into this branch; its fresh
CI is running. See the parent's audit for preserved failure evidence.

## Acceptance evidence

- 11 retention lifecycle tests and 13 parent cleanup tests pass (24 total).
  The added concurrent-binding test holds the real row lock, commits a task
  binding while deletion waits, and proves retention rechecks and keeps the row.
- Full voice integration and app wiring pass 131 cases on a fresh database.
  Two new service tests start retention while the admission is unconfirmed, then
  use a signed terminal callback or real rejection/provider cleanup to establish
  confirmation. Each observes its saved seven-day deadline, SQL quiet before it,
  deletion at it, and quiet afterwards.
- The first acceptance run waited 120 seconds before rejection, exceeding the
  original call's approval window. That correctly rejected the test operation and
  left an unconfirmed fixture affecting two later global cleanup assertions. The
  corrected test checks pre-confirmation quiet for ten seconds and the full suite
  passes on a newly migrated database. Production expiry policy did not change.
- Workspace typecheck and build pass. A final server typecheck covers the last
  added concurrent-binding test. Shared deletion/startup and parent recovery
  checks are tracked below when their current processes finish.
- No repository-wide `pnpm test:run` success is claimed: the local embedded
  PostgreSQL initialization limitation from earlier slices remains. The selected
  database suites use isolated real PostgreSQL; fresh remote CI is required.

Logs: `/tmp/sleep24-retention-cleanup-final.log`,
`/tmp/sleep24-voice-acceptance.log` (preserved initial failure),
`/tmp/sleep24-voice-acceptance-fixed.log`, `/tmp/sleep24-workspace-types.log`,
`/tmp/sleep24-workspace-build.log`, `/tmp/sleep24-final-server-types.log`.

Final local consumer checks pass: 52 company-deletion/startup tests, 11 parent
voice recovery tests, and final server typecheck. Selected nonoverlapping test
coverage totals 218 passing cases. The implementation and local verification are
complete; remote PR CI/review and the rest of the original stack remain pending.

## Review repairs

The first published head 9c38ddfe53 passed all CI and Greptile 5/5. Paperclip
Review found unnecessary endpoint-wide retention refresh on every new call and
missing behavioral coverage of removal from the maintenance lane.

Pre-call admission now allocates its ID before insertion and registers the
existing intent for that admission only. Retention lookup uses the primary key;
new calls no longer scan the endpoint's retained history. Cleanup receives the
same precise hint. Existing endpoint/company configuration changes retain their
scope, and startup still reconstructs eligible history. No schema change.

Two service regressions verify the actual signed pre-call scope and drive the
real chat coordinator/voice maintenance path with due, confirmed history. The row
survives maintenance and is deleted by the retention worker. Temporarily restoring
pruning to voice maintenance makes this latter test fail with the row missing;
restoring the implementation passes. All 133 full voice/app wiring tests and
server typecheck pass after the repair. Logs are /tmp/sleep24-review-acceptance.log,
/tmp/sleep24-review-types.log, /tmp/sleep24-maintenance-mutation.log and
/tmp/sleep24-maintenance-restored.log. Typecheck covers production sources; the
server tsconfig excludes the test directory, whose behavior is verified by Vitest.
Fresh remote checks/review are required on the repaired head.

Parent #17580 has all checks terminal and Greptile 5/5 at 4f0364d269. Its final
Paperclip review added two findings: unresolved cleanup can block deletion, and
rejection awaits provider calls. These require explicit disposition/repair at the
parent; green checks do not resolve them. An arbitrary retry cap or credential
failure is not proof that a provider call ended and must not silently discard the
cleanup obligation. Preserve that requirement while assessing the deletion path.

## Denial worker propagation

The parent denial-latency fix is incorporated. Retention's real cleanup-receipt
producer case now registers the cleanup worker and waits for its confirmed result,
instead of assuming the decision request itself performs provider I/O. Both
retention and denial regression cases are retained. The initial merge verification
failed to parse unresolved conflict markers; no voice cases ran. After preserving
both sides and completing the merge, all 134 voice/app cases passed on that still
unused voice database. Logs: `/tmp/sleep24-denial-acceptance.log` (parse failure),
`/tmp/sleep24-denial-acceptance-fixed.log` (134 pass).
