# Teams abandoned transport-attempt recovery sleep audit

Baseline: consent expiry PR #17590 at 5ddb4543ed.
Branch: codex/sleep-27-teams-attempt-recovery.
Status: implemented; targeted local acceptance and workspace types/build pass; publication and remote gates pending.

## Reason and source of truth

This slice owns only abandoned Teams transport claims. Existing transfer phases
consent_sending, uploading, file_info_sending and conflict with a non-null
attemptExpiresAt carry the obligation. claim() saves attemptId and a 90-second
attempt expiry before provider I/O. Normal settlement clears the attempt. A
conflicting callback can retain an in-flight attempt until it expires.

Recovery rechecks the row under the publication/transfer lock order, clears the
expired claim, and moves a sending phase to its matching unknown outcome. Conflict
stays conflict. It must never resend, manufacture a receipt or treat time as proof
that provider I/O did not occur. Unknown outcome rows without a deadline are
passive review evidence. Unused consent remains owned by #17590.

## Producers and boundary

teamsFileTransferService central update() owns claims, settlement, cancellation,
conflict and operator resolution. Add an awaited attempt signal there, within the
existing transaction. Insert creates consent_pending, not an attempt. Caller-owned
resolution must retain outer transaction settlement. Direct SQL/other processes
remain outside the local signal contract. Startup reconstructs saved attempts.

Use the existing scoped deadline helper in the Teams folder. Expose only a narrow
per-transfer recovery method and worker registration. Shared app wiring supplies
admission gates; provider policy stays in Teams. Remove scheduleTeamsFileMaintenance
and its call from processPublicationMaintenance after both duties have owners.
Keep the explicit combined diagnostic recovery method compatible.

## Verification required

Prove real claim activation and settlement, three sending phases and conflict,
quiet unused/unknown/completed history, saved deadline across restart, no early
SQL, precision, projection rollback, lock contention and fair backlog, first work
during drain, nested rollback/outer commit, changes before deadline, and shutdown.
Exercise production wiring and ensure no periodic Teams scan remains. Keep
provider calls outside transactions and prove recovery makes no new provider call.
No change to external alarms, on-use authority or Cloud sleep eligibility.

## Implementation and local evidence

The new Teams-owned worker registers existing attempt deadlines. The central
versioned update signals both consent and attempt owners before writes. A narrow
recoverAbandonedAttempt method delegates to the original locked recovery logic.
The periodic scheduleTeamsFileMaintenance callback and its orchestration call are
removed. No other chat duty, schema or external wake policy is changed.

- Five real-PostgreSQL/wiring suites pass 220 cases: 77 transfer protocol cases
  and 143 publication, consent, consent-runtime and app cases.
- Fifteen selected production integration cases pass, including actual Board
  claim/receipt activation and the parent expiry case plus existing Teams current
  authority cases. The other 1,411 cases are skipped, not passed.
- These are 235 unique selected passing cases. The production claim test measures
  120 seconds with no select/transaction calls after the receipt settles. The
  102-entry recovery case drains healthy work from two companies while corrupt
  evidence retains recovery. No recovery test causes another provider request.
- Server typecheck passes; workspace typecheck passes. Workspace build passes. Typecheck excludes test files.
- Full local test:run remains unclaimed due to the earlier embedded-PostgreSQL
  host limitation. Full remote gates are required. No live Teams/suspension claim.

Failure ledger: the first five-suite run passed 217 and failed two new assertions.
The drain fixture simulated an interrupted receipt transaction, then incorrectly
counted its pg_xact_status reconciliation as forbidden idle SQL. The rollback
fixture incorrectly rejected any future wake, including the legitimate shared
transaction-resolution deadline. It now reads committed eligibility and verifies
that no provider call occurred. Its asynchronous rejection is joined in finally.
The next run passed 219 and failed the drain fixture's wait for all idle holds to
clear while dispatch was deliberately paused. The final drain fixture uses a real
committed conflicting callback, retains its live claim through a quiet paused
window, and verifies retirement after resume. The interrupted receipt and failed
projection cases remain independently covered. Production behavior was not
relaxed to satisfy these assertions.

Logs: /tmp/sleep27-teams-tests.log (initial failures),
/tmp/sleep27-teams-fixed-tests.log (drain hold assertion),
/tmp/sleep27-teams-final-tests.log (220 pass),
/tmp/sleep27-production-tests.log (15 pass),
/tmp/sleep27-server-types.log, /tmp/sleep27-workspace-types.log and
/tmp/sleep27-workspace-build.log (pass).

## Stack gates

Consent parent #17590 at 5ddb4543ed has Greptile 5/5 with no inline findings;
CI is still running. Voice-report #17586 now has two new Paperclip findings:
explicit single-active-process writer support and indexed report reconstruction.
They require owning-parent review/repair and propagation before stack acceptance.
Older #17490 E2E and #17580 deletion-policy findings and final master reconciliation
remain open. No stack PR is merged or the full objective complete.


Publication: [#17592](https://github.com/paperclipai/paperclip/pull/17592), initial
head 6f2f3951ca. Parent voice-report findings are repaired at 94c60683b8 and both
review threads resolved. The partial index and precise pagination are propagated
through consent parent e501d6c99d. Thirty report-worker/startup cases pass on each
combined Teams child; logs /tmp/sleep26-parent-review-tests.log and
/tmp/sleep27-parent-review-tests.log. Snapshot retention remains five. Fresh
remote gates on the propagated heads remain required; older stack findings remain.
