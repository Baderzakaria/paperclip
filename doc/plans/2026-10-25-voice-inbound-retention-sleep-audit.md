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
