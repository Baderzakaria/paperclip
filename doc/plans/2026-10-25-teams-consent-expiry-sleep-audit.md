# Teams unused-consent expiry sleep audit

Baseline: voice call-report PR #17586 at 250fca6cff.
Branch: codex/sleep-26-teams-consent-expiry.
Status: audit; implementation, local acceptance, publication and remote gates pending.

## Separate reasons

The Teams maintenance callback in microsoft-teams/file-delivery.ts runs from
processPublicationMaintenance and repeats a database selection every 30 seconds.
It combines two obligations. This slice owns only unused consent expiry:
consent_pending, awaiting_consent and upload_pending rows become expired at their
existing expiresAt. Abandoned consent_sending/uploading/file_info_sending attempts,
and conflict rows with a retained attempt expiry, belong to the next slice.
Unknown outcomes without a live deadline are passive operator-review evidence;
expiry must not convert them into retries or manufacture delivery receipts.

## Owner and persistence

chatTeamsFileTransfers already owns the phase, expiry, company, endpoint,
publication, version, authority digest and encrypted private state. No schema or
new queue table is needed. teamsFileTransferService is the only production insert
and update owner found by the initial writer search. Its issue() insertion and
central update() helper are the two notification boundaries. Caller-owned
resolveInTransaction uses that helper; its signal must wait for outer commit.
Deletion should simply remove a cached entry on the next owned deadline; it must
not retain a perpetual scan.

The existing lock order is publication -> transfer -> projection policy/source
locks. Expiry rechecks eligibility after those locks and performs no provider
I/O. Integrity checks and projection in the same transaction must remain intact.
Maintenance lock waits are bounded to 250ms, with no-wait publication/transfer
locking. A bad or locked row must not starve other companies or later rows.
Never log private envelopes, SQL parameter errors, provider capabilities or tokens.

## Intended migration

- Reuse scoped deadline work, with paged startup reconstruction and transfer-ID
  hints from committed writes. Register the worker through the Teams owner;
  app wiring only supplies shared lifecycle and admission gates.
- Load only the three unused phases, with ceil(expiresAt milliseconds) so a
  PostgreSQL submillisecond expiry cannot be executed early or spin.
- Recheck and expire one transfer through its owning protocol method, preserving
  atomic publication projection and no-provider-I/O semantics. Result loading
  removes settled/changed rows; failed reconstruction or expiry retains retry.
- Keep explicit manual expireAndRecover compatibility for tests/diagnostics.
  Production aggregate maintenance must select and execute only abandoned
  attempts after this slice. It must not keep expiring unused consent as a hidden
  second owner. That remaining attempt scan is intentionally still pending.
- Preserve configured idle, completed history, unknown outcome and active-attempt
  quiet for this worker. Real outstanding consent remains a future obligation.
- Do not change authority-on-use checks, transport execution, Cloud wake coverage
  or whole-instance sleep eligibility.

## Verification plan

Use the existing real-PostgreSQL Teams protocol fixture, and exercise real issue,
process/consent and cancellation/resolution writers. Cover saved expiry and
restart, first committed transfer, nested commit/rollback, no early reads,
changed phase at claim, provider-call absence, atomic projection rollback,
private-error redaction, lock contention/fair backlog, drain/resume, shutdown,
and submillisecond deadlines. Existing protocol, publication and consent tests
must continue to pass. Exercise production registration and ensure old maintenance
cannot expire consent. Full stack checks and master reconciliation remain required.

## Other outstanding gates

#17586 is published, attached, and locally verified; remote CI/reviews are pending.
#17580's company deletion policy finding and #17490's E2E cancellation failure are
still unresolved. No original recurring-server obligation is removed from scope.
