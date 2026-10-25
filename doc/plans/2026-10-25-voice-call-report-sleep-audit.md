# Voice call-report scheduling sleep audit

Baseline: voice history retention PR #17583 at
9c38ddfe5349ef1872306a91c7e4c5c1bc083259.
Branch: codex/sleep-25-voice-call-reports.
Status: implementation and local acceptance complete; publication and remote gates pending.

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

## Implementation and acceptance, 2026-10-25

The parent retention repair at `360e1253a0` is incorporated. The report owner now
loads scoped, paged obligations, claims each due attempt before network I/O, and
uses attempt/deadline ownership for settlement. Report writes notify the same
shared coordinator. Existing voice-change producers and the explicit reply
`call_ended` path activate it. App startup registers it once and the final voice
lane is removed from the chat interval. No schema or Cloud eligibility change.

The saved report worker suite passed 13 tests. Initial full integration acceptance
had 136 passes and one failure: an unlocked existing transcript still could not
update because the copied projection omitted the document's base revision ID.
The repair supplies the observed `latestRevisionId`, preserving document locks
and conflict checks. A focused rerun against the already-used full-suite database
verified the document update but failed its global provider-call count because
133 retained fixture calls were eligible; this is not accepted as a clean run.
Final full acceptance uses a new database migrated through the application
migrator. Results are recorded below when terminal.

Earlier worker fixture failures (assignedAgentId vs agentId) and the production
missing `or` import were repaired before the 13-case worker pass. Source wiring
assertions still expecting reconcileMaintenance were updated to require its
removal. Full-suite tests remain Vitest coverage; server tsconfig excludes tests,
so production typecheck is not described as test typechecking.

Parent #17583 at `360e1253a0` has a failed server shard: the Discord rollback/drain
quiet test observes one scoped select after its nextWakeAt becomes null. The job
log is retained at `/tmp/sleep24-review-ci-failure.log`. This needs investigation
at its owning earlier slice and propagation; it is not silently retried or
claimed green. Parent #17580 also has two review findings about cleanup latency
and deletion with unconfirmed provider cleanup. These remain open. The older
#17490 E2E failure and final master reconciliation remain part of completion.

Final local acceptance after the revision fix: 137 full voice/app wiring cases
passed on `paperclip_sleep25_projection_fixed_20261025_test`; 37 report/cleanup/
retention worker cases passed serially on the isolated worker database. Workspace
`pnpm -r typecheck` and `pnpm build` passed. Logs: `/tmp/sleep25-voice-fixed-acceptance.log`,
`/tmp/sleep25-voice-workers-acceptance.log`, `/tmp/sleep25-workspace-types.log`,
and `/tmp/sleep25-workspace-build.log`. These 174 selected cases do not claim the
entire `pnpm test:run` suite passed locally. This host's embedded PostgreSQL test
initialization limitation remains; CI must run the complete relevant gates.

## Publication and parent repairs

Published as #17586. The Discord quiet-test settlement repair is propagated from
#17557 and passes all 41 command ownership tests at the report branch. The inbound
denial latency fix is also propagated; its held-provider regression is included.
After both merges, all 138 full voice/app cases pass on a fresh migrated database
(`/tmp/sleep25-denial-acceptance.log`). The earlier 37 worker cases remain valid;
those worker implementations are unchanged by the parent repairs. Remote checks
and reviews are required for the final pushed head. Parent #17580's company
deletion finding remains unresolved; denial latency finding is resolved.


## Paperclip review: report window index and writer scope

Review findings 4370594150 and 4370594357 identified deployment-contract clarity
and expensive report reconstruction. The supported writer model is now explicit:
one active server process owns voice writes through its DB client. Active-active
servers and independent SQL mutation are unsupported without a separate durable
wake contract. This is a documented scope restriction, not enforcement added by
this PR, and not a claim that startup recovers concurrent foreign writers.

The query finding reproduces on fresh PostgreSQL with 20,001 old sessions and
205 eligible sessions: an actual reconstruction query filters 20,001 historical
rows. The repair adds partial `(ended_at, id)` index 0389 and uses that order and
keyset cursor. The cursor retains PostgreSQL text timestamp precision, so sessions
100 microseconds apart do not repeat or disappear across a page. All 14 report
lifecycle cases pass after the migration; the query-plan regression checks all
three pages and each stays below 1,000 rows removed by filtering. Report scope,
24-hour policy, and provider behavior are unchanged.

The generated migration is concurrent and idempotent and registered with the
application's top-level migration runner. It applies and a second application is
a no-op. Migration numbering/safety checks pass. The generator retained exactly
five snapshots, 0385 through 0389, pruning 0384 per repository policy.

Retained failures: the first probe reused a database with two unrelated eligible
fixture sessions and failed its exact fixture count. It is not performance proof.
A fresh database reproduced the 20,001-row filtering problem. The first migration
invocation used unsupported top-level await in tsx eval and did not apply; its
subsequent test still failed without the index. The corrected chained invocation
applied/replayed successfully and all 14 cases passed. No assertion was relaxed.
Logs: /tmp/sleep25-report-index-before.log (fixture contamination),
/tmp/sleep25-report-index-clean-before.log (cost reproduction),
/tmp/sleep25-report-index-apply.log (invalid invocation),
/tmp/sleep25-report-index-after.log (unapplied index),
/tmp/sleep25-report-index-apply-fixed.log (application/replay),
/tmp/sleep25-report-index-fixed-tests.log (14 pass).
Workspace typecheck and build pass. Fresh full voice integration and app wiring
pass all 138 cases after the index repair. Logs:
/tmp/sleep25-report-review-{types,build,acceptance}.log.
Publish and propagate through Teams #17590/#17592 after acceptance. Fresh remote
review/checks and all prior full-stack requirements remain open.
