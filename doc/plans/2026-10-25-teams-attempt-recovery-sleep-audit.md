# Teams abandoned transport-attempt recovery sleep audit

Baseline: consent expiry PR #17590 at 5ddb4543ed.
Branch: codex/sleep-27-teams-attempt-recovery.
Status: owner audit; implementation and verification pending.

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
