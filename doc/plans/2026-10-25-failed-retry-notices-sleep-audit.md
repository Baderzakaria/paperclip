# Failed-run retry notice migration

Date: 2026-10-25. Branch: `codex/sleep-31-failed-retry-notices`.
Parent: [#17647](https://github.com/paperclipai/paperclip/pull/17647),
`fee07f3fa8cbc489cb9bbf657a6065c6e00748c3`.
This is slice 31 of the recurring-server-work stack. No production worker is
registered yet, and the periodic retry-notice pass remains until producer and
lifecycle acceptance is complete. No PR has been opened for this slice yet.

## Obligation and boundary

A failed-run retry may have a durable wake receipt but no admitted run. Its
existing `chat_actions` row has kind `failed_run_retry`; the same-ID,
same-company `agent_wakeup_requests` row is authoritative for whether the retry
waits or was declined. The notice is eligible while `runId` is null and the
receipt is deferred, cancelled, failed, or skipped. A matching existing
publication discharges that state. Queued and not-started are separate saved
states; a later cancellation can owe a second notice.

The retry service owns current source/batch authorization, task Retry generation,
original principal, retained source digest, endpoint reach, provider binding,
execution containment, and retry admission. The new projection module receives
a narrow authorization callback returning the destination, task and source
comment IDs. It does not reproduce that policy or add provider branches.
Existing publication transport still authorizes immediately before I/O.

The new projection module is `chat-channels/failed-retry-notices.ts`. It owns
candidate selection, receipt locking, deduplicated insertion, exact cursor
precision and scoped reconciliation. The service retains its existing public
combined manual notice API. Nothing adds a database table or a framework adapter.

## Current implementation and evidence

- The manual cursor previously converted `createdAt` to JavaScript Date. A full
  denied page with PostgreSQL microseconds was selected repeatedly, starving
  a later valid retry. The regression reproduces through the public combined
  API in `/tmp/sleep31-cursor-before-public-api.log`: the second call inserts
  zero instead of the expected one notice.
- `/tmp/sleep31-cursor-before.log` is an invalid first reproduction that attempted
  to call a private service method. It is retained as failure evidence, not
  evidence of the cursor defect.
- Cursors now use PostgreSQL `timestamp::text` plus the UUID tiebreaker. Manual
  selection retains its existing maximum batch of 50; scoped reconciliation
  bounds candidate authorization work, not successful publications.
- Permanent authority rejection settles the pass. Actual PostgreSQL/authority
  contention is returned separately for the future worker to retain. Unknown
  errors propagate. Run-bound and already projected states leave no candidates.
- Five integration cases pass in `/tmp/sleep31-scoped-notices.log`: manual/scoped
  denied-prefix pagination, scoped isolation and receipt contention/cancellation,
  and the existing Slack/Telegram queued/working/selected-final identities.
  The scoped cursor test observes exactly 50 then one candidate transaction.
- Server typecheck passes in `/tmp/sleep31-scoped-typecheck.log`.
  This establishes the projection contract, not idle worker behavior or host
  suspension. Full acceptance, worker registration, CI and review remain open.

## Producer audit to complete

- [ ] Receipt admission/defer: trace actual heartbeat and wake-queue writers,
  including the ordinary task Retry intent and the chat action receipt. A
  callback returning a truthy result is not sufficient persistence evidence.
- [ ] Receipt cancellation/failure: task tree, agent, budget, company, Slack Stop,
  deferred queue writers, and retry-specific authorization denial. Reuse the
  existing transaction signals where possible; test outer rollback and commit.
- [ ] Admission/promotion and settlement: run-bound receipts stop owing notices;
  retain notification ordering through transaction commit and failure.
- [ ] Retry action lifecycle: staged, claimed, processed, failed, cancelled,
  recovered, and superseded generations; determine which transitions can make
  current source authorization succeed or fail.
- [ ] Current authority restoration: endpoint/provider runtime, resources,
  linked identity, membership, task/project privacy and explicit grants, and
  original source/run lineage. Use existing eligibility signals rather than
  scattering new wrappers through these owners.
- [ ] Source and generation changes: inspect task Retry intent rewrites,
  recovery completion, preserved source metadata, and repaired delivery records.
- [ ] Mixed ordinary/retry receipt ownership: `findExistingDeferredWake` does
  not exclude a failed-retry owner by kind. A retry's own `allowRunCoalescing:
  false` does not establish what a later ordinary wake can select. The ordinary
  retirement path requires an exact visible queued publication; retry-owned
  publication authorization additionally requires its comment ID to equal the
  final original retry source comment. Establish the reachable combinations with
  real admission before exempting the retry denial writer from ordinary signals.
- [ ] Independent clients/replicas: current process-local signals cover only the
  supported owning application client and child pools. Do not claim external
  SQL or another replica is observed.

## Worker and acceptance still required

- [ ] Register a scoped deadline worker using the shared coordinator, retaining
  exact page cursors and contention across pages. Committed invalidation must
  restart a cursor so restored earlier candidates are revisited.
- [ ] Empty/configured-idle/retained-history quiet, real first admission, actual
  producer cancellation, denied history, lock contention, retry after failure,
  rollback/outer commit, restart, drain/resume, shutdown, and writes arriving
  during selection and pagination.
- [ ] Preserve all existing provider identity and authorization acceptance.
- [ ] Remove only retry notices from periodic maintenance after the above passes.
- [ ] Full required verification, template PR, latest-head checks and fresh 5/5
  review with no unresolved findings. Do not merge the stack.

No change to Cloud sleep-safety gates or external wake coverage is proposed.
Terminal confirmations, interaction continuations and GitHub maintenance remain
separate duties. The rest of the original migration ledger remains in scope.


## Broader acceptance and retained failure evidence

Server build passed in `/tmp/sleep31-scoped-build.log`. Broader selection
`retry|Retry|pre-run FIFO` first finished with 180 passing and one failing case
in `/tmp/sleep31-retry-acceptance.log`. The failing test injects the first
transactional agent-status read error while publishing a selected final. It
instead reached retry-notice maintenance because the reused test database still
contained two deferred retry candidates from the deliberate failing reproductions.
Direct SQL identified those candidates at 13:33:57 and 13:34:35, matching the
invalid first reproduction and the valid before-fix cursor reproduction. Neither
had a publication. This is fixture contamination, not an inferred flake from a
later success.

The cursor fixture now removes its own original staged action/receipt as well
as its denied clones in `finally`, including on a failed assertion. The original
database is retained as evidence. After applying migrations to a fresh isolated
`paperclip_sleep31_retry_acceptance_20261025_test`, all 181 selected cases pass
in `/tmp/sleep31-retry-acceptance-fresh.log`. No production error handling was
relaxed to bypass the failure. The local timestamp/fixture evidence is test-only.

Additional producer audit findings to resolve before wiring:

- The admission reader can select a previously deferred retry as a later
  ordinary wake's owner; the current ordinary publication path requires a
  matching visible original queue notice, while retry-owned transport requires
  its original final source comment. Reachability must be established, not
  assumed from the retry's own no-coalescing option.
- Wake-queue `cancelDeferredWake` and `failDeferredWake` signal the ordinary
  inbound-notice helper rather than the broader milestone helper. A retry
  notification added only to milestones would miss those real writers.
- `normalizeDeferredWakeCommentIds` changes the saved payload without a notice
  signal. Check whether removing merged/deleted input restores a retry's exact
  source eligibility before classifying it as harmless bookkeeping.
- `retireSupersededTaskRetry`, `requestTaskRetry`, and retry reconciliation write
  the separate task-intent receipt. The notice candidate uses the chat-action
  receipt; examine generation/source authorization before adding blanket wakes
  to all intent timestamp writes.
