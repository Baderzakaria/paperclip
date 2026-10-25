# Inbound voice admission cleanup sleep audit

Baseline: voice reply PR #17578, head 439d0a86eb75c129c30742a8cc24bf18e2a6ebf3.
Branch: codex/sleep-23-voice-inbound-cleanup.
Status: owner audit; implementation and verification remain required.

## One reason in this slice

Remove recurring discovery of expired inbound admissions and unfinished provider
termination. Keep inbound history retention and call reports as separate PRs.
The current `voiceInboundService.reconcile` combines a seven-day delete with a
25-row expiry/provider scan. `voiceSessionService.reconcileMaintenance` invokes
it from the remaining one-second chat lane.

Existing `chat_voice_inbound_calls` rows own admission state, expiresAt, updatedAt,
providerSessionId, generation, credential fingerprint, requested issue, caller,
and optional bound voice session/intake task. Existing voice sessions own the
bound call's execution and current authorization. Do not add a table per timer.
Decide and document the handoff between those existing owners before coding.

## Current behavior and supported producers

- Signed `call.pre_call` inserts an awaiting-approval admission with a two-minute
  expiry, or a guest-intake admission with a ten-minute expiry. The endpoint lock
  serializes the quota check and insertion. Repeated provider identities are
  deduplicated; changed replay content is rejected.
- `pendingTool` can mark an expired admission as expired. Guest submit_request
  creates a low-trust task and active voice session, then saves the session/task
  binding in the same transaction. These writes must wake the appropriate owner.
- `decide` locks the admission and validates current caller, endpoint, credential,
  approval code, expiry, and task authority. It writes approving or denied/ended.
  Provider inspection and session start occur afterward. Final approved binding
  is currently a standalone update guarded only by state=approving.
- Signed lifecycle/report callbacks lock admission before session and mark the
  admission ended. Preserve that order and the callback receipt's replay fence.
- The expiry sweep scans guest_intake, awaiting_approval, approving, denied, and
  expired rows only once their expiresAt is past. It inspects the exact saved
  provider call, marks ended if inspection confirms termination, otherwise marks
  expired and requests termination. Errors only update updatedAt.
- No production admission writers were found outside voice-inbound-service.ts.
  Session handoff/approval recovery must also inspect voice-session-store.reserve.

## Correctness questions that the migration must resolve

1. **Discovery is not an execution claim.** A row read by cleanup can change before
   provider I/O. Recheck/claim current due state under the owning row lock. Never
   overwrite a newer approved or terminal state from a stale candidate snapshot.
2. **Approval handoff has a crash window.** Inbound start commits an authorized
   session with the existing provider ID and returns without creating a new call.
   The admission's final approved update follows in a different transaction.
   Expiry or a crash can occur between these writes. Determine whether existing
   binding evidence should complete handoff or retain cleanup; do not end a valid
   handed-off call based on an older approving snapshot. Test the exact race.
3. **Termination requested is not termination confirmed.** Speko endSession returns
   confirmed=false for status=ending and true only for already_ended. Keep cleanup
   debt until an inspect/callback/end receipt establishes termination. Never create
   or redial a provider call in recovery.
4. **Guest denial currently writes ended before provider confirmation.** Without a
   bound session, a failed end request can lose its cleanup obligation. With a
   session, live-session recovery also owns ending. Preserve one explicit owner
   for unfinished termination; do not treat a terminal UI label as physical proof.
5. **Bound guest calls have two current scanners.** Admission expiry and live-session
   recovery can inspect/end the same exact call. Define the handoff and admission
   settlement contract so a scheduler migration does not create two uncoordinated
   provider workers for one resource.
6. **Retention currently precedes cleanup.** The seven-day delete can remove denied
   or expired rows with no session/task binding before provider termination is
   proved. Keep history retention separate, but do not allow it to erase newly
   explicit unfinished cleanup debt. Record any required narrow predicate change
   with this slice and keep the retention scheduling migration in its own PR.
7. **Configuration and credentials.** Cleanup must remain possible after feature
   disable and endpoint/credential changes. Do not use a replacement credential
   to act on an unrelated provider call. Read the existing provider/account
   identity and deletion contracts before selecting recovery scope.

## Intended scheduler contract

The inbound owner exposes normalized identities and actual deadlines to the
existing delivery coordinator. The initial deadline comes from saved admission
expiry; explicit rejection requests immediate cleanup through the same owner.
Unconfirmed termination or errors retain a bounded retry. Completed history and
no admissions leave no cleanup deadline. Startup reconstructs saved obligations.
Notifications precede writes in existing transaction ownership and cover all
producer paths above. No provider request is made inside a SQL transaction.

Preserve scope coalescing, per-obligation failure isolation, fair bounded batches,
startup paging, drain/resume, concurrent changes during a sweep, and shutdown
joining in-flight work. Keep public/manual reconciliation compatible while
separating the retention operation from the scheduled cleanup operation.

## Required proof

- No configuration, configured idle, and confirmed terminal history become quiet.
- Real signed pre-call after quiet registers its original expiry.
- First guest intake, approval/denial, pending-tool expiry, and lifecycle callbacks
  signal their existing transactions; outer rollback and commit behave correctly.
- Approval completes during cleanup discovery without stale termination or state
  overwrite. A crash between session binding and final approval remains recoverable.
- End receipts with confirmed=false, provider failure, missing callbacks, and restart
  retain the exact-call obligation without redial or silent deletion.
- Bound guest termination has one explicit owner and settles admission history.
- Retention cannot erase unfinished provider cleanup.
- Backlog, failure isolation, drain/resume, and shutdown behave as claimed.
- Existing full voice, reply, and call-report cases continue to pass. Use separate
  PostgreSQL databases for suites that retain fixtures and global-idle suites.

## Parent and full-stack obligations

#17578 is published and attached. Local evidence covers 786 selected tests,
workspace typecheck and build. CI run 40179014816 and PR review 40179014437 were
live at publication; no check failure was present at the latest inspection.
Latest-head checks, Greptile score and review findings still require acceptance.
No stack PR is authorized for merge by the active goal. The remaining original
ledger, older #17490 failure, and final master reconciliation remain required.
