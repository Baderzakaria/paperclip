# Voice call-report scheduling sleep audit

Baseline: voice history retention PR #17583 at
9c38ddfe5349ef1872306a91c7e4c5c1bc083259.
Branch: codex/sleep-25-voice-call-reports.
Status: owner audit; implementation, verification and publication remain required.

## The obligation

`voiceSessionService.reconcileReports` is the final voice duty called from the
chat maintenance cadence. It scans terminal sessions with a provider call ID and
endedAt within the last 24 hours. A missing report is immediately due; an existing
report uses nextCheckAt. The existing exponential retry is 30 * 2^attempts seconds,
capped at one hour. Its first post-fetch retry is 60 seconds.

The current policy deliberately revisits even available reports during that
24-hour window. Do not assume available means no future obligation: later provider
reports can update transcript and billing, and delivery diagnostics may still
need their final snapshot. The provider parser's complete flag only means the
response has a report object. It is not an explicit final-and-immutable promise.
Preserve this finite refresh window while replacing the repeated global scan.
No recording URL or provider metadata is stored; the provider parser allowlists
spoken turns and safe billing/duration values.

## Ownership and implementation direction

Existing chat_voice_sessions and chat_voice_reports remain durable truth. Keep
selection, refresh policy, fetch, result ordering and projection within the voice
owner. Use the scoped deadline helper for coalescing, fair batches, backoff, drain
and shutdown. Register a report topic on the existing voice-change composition;
do not add caller recovery wrappers or a queue table.

- Startup loads paged terminal-session candidates and actual nextCheckAt values.
- Missing reports are due at terminal transition. Future nextCheckAt remains
  unchanged across inspection/restart.
- A report entry also has a finite window end. Expire its cached obligation when
  the 24-hour window ends, even if its next attempt would be later. Define SQL
  timestamp precision and inclusive boundary consistently; do not spin at cutoff.
- Lock/recheck current session eligibility and report deadline before reserving
  an attempt. Save retry intent before network I/O. Provider GET remains outside
  database transactions. Inspect whether a concurrent manual reconciliation or
  callback can invalidate a result; use existing persisted fields for ownership
  where sufficient. Do not add speculative leases or schema without evidence.
- Preserve providerUpdatedAt ordering. An incomplete or older response must not
  replace a newer available report. Stale responses must still back off.
- Preserve the guest-task transcript projection, its advisory lock, low-trust
  quarantine check, owner access, and activity log. A saved report is not proof
  that projection completed. Preserve retry after a projection failure.
- Preserve bounded diagnostic attempts and never replay speech. Diagnostic
  failure must not prevent transcript/history reconciliation.
- Keep explicit one-shot diagnostic reconciliation compatible. Remove the
  recurring voice lane only after all report producers are covered.

## Producer audit

- `voice-inbound-service.ts` signed terminal and report callbacks call
  notifyVoiceChange before the session update and report upsert. Existing reports
  get nextCheckAt = now, which may advance a scheduled refresh.
- `voice-session-service.ts` close and inspect paths use withVoiceSessionChange.
- `voice-session-recovery.ts` uses full voice-change notification for terminal
  inspection results. Healthy inspection and error-only updates intentionally
  notify only recovery; do not make those trigger empty report scans.
- `voice-reply-push.ts` handles HTTP 409 by writing state=ended and endedAt. It
  currently notifies reply, recovery and inbound explicitly; report notification
  must be included before this terminal write.
- Configuration/authority/company changes use notifyVoiceChange composition.
- The existing report loop inserts and updates report rows without transaction
  notifications. Move that ownership into the new report service. Account for
  callbacks during an in-flight provider response and for any remaining direct
  writes discovered in the full source audit.

## Verification required

- Configured idle, live calls, old terminal history and calls without provider IDs
  are SQL/network quiet after startup.
- Real session end, signed callbacks, and reply call-ended results wake reports.
- Saved refresh deadlines survive restart; no early reads, bounded failures, and
  final window expiry disarm. Available reports retain the existing window.
- Nested commit/rollback, moved-earlier callback deadlines, concurrent writes,
  first work during drain, failed work entering drain, and shutdown keep work.
- Multi-page backlog and per-company fairness do not starve later calls.
- Provider failure, incomplete responses, older provider timestamps, guest
  transcript projection failures and diagnostic behavior retain correct data.
- Existing full voice integration/history/access tests pass on a fresh database.

No Cloud alarm coverage or sleep-eligibility expansion is authorized by this
migration. A future in-process refresh cannot wake stopped compute. Preserve
current external-wake limitations explicitly.

## Parent state

#17583 is published and attached. Its 218 selected tests, workspace types/build,
and final server typecheck pass locally; fresh CI/reviews are running.
#17580 migration-runner repair 4f0364d269 has fresh Greptile 5/5. At the last
inspection it had no failing checks and three pending checks. Its prior database
setup failure and regression/repair evidence remain in its audit.

The complete original recurring-server ledger, older #17490 E2E failure,
remaining PR reviews and final master/stack reconciliation remain required.
