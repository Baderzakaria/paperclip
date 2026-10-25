# GitHub terminal-response recovery

Slice 35 starts from acknowledgement PR #17656 at
`43900c1f94500af4c4de1987f9608ac4e12feae6`.
The final parent acceptance passed all 1,557 chat/publication/startup tests without
skips in 514.70 seconds. Parent workspace types/build and 69 fast-response tests
also passed. Greptile reviewed that head at 5/5 without findings. Remote CI was
still completing when this slice started; no merge or full-stack completion is
claimed.

## Obligation and ownership

A received acknowledgement and an owed terminal response are different states
of the existing `github_response_comment` action. Slice 34 owns received actions
and retryable failed deliveries. This slice owns processed, nonfinal actions
whose bound request has a terminal outcome or needs a paused notice. Review-check
publication and stale-head projection repair remain independent duties.

The provider owner must determine exact source/run provenance, latest-run
ownership, and whether a real reply is confirmed or uncertain. Keep those queries
and presentation decisions in `chat-channels/github/response-execution.ts`; shared
notification and scheduler code must not interpret GitHub payloads. Existing
principal/configuration checks, provider markers and repository publication leases
remain the authority for sends and receipt writes.

## Passive history is not unfinished delivery

A paused response deliberately remains nonfinal so a later resumed run can answer
it. The old scan repeatedly revisits it, even when it makes no provider mutation.
The replacement needs a saved paused-presentation version in the existing receipt,
written only with confirmed receipt persistence. A changed run or pause state
invalidates that version. No table or separate queue is needed.

An unrelated newer terminal run does not automatically authorize closing every
older request. Resolve native identity and legacy wake-comment provenance using
the existing owner. Passive non-owning rows must be excluded without acquiring
and releasing a publication lease on every wake. That would otherwise create a
self-wake loop through the release notification.

## Producer audit still required

- Run and issue transitions, identity/lineage changes and restored authority use
  the existing milestone notification boundary; extend it once with the narrow
  response-state topic after verifying coverage.
- Response action completion and provider publication/assessment settlement must
  wake affected terminal candidates. Repository lease release is scoped to its
  company, endpoint, repository and PR/issue number.
- An unresolved competing lease owns its saved expiration, not a permanent scan.
- Failed terminal sends remain with the existing acknowledgement retry owner,
  including the current attempt budget and ambiguous-outcome policy.
- Startup reconstructs eligible work; drain/standby/shutdown retain skipped work
  and prevent starting subsequent provider requests.

## Acceptance required before polling removal

Use real PostgreSQL and the existing controlled GitHub fixture. Cover terminal
run producer commit/rollback, native identity, blocked-but-non-owning requests,
paused-history quiet and resume, final/superseded history, lease release and
restart, uncertain reply settlement, admission changes between provider requests,
changes during a sweep, and candidate prefixes across the bounded page size.
Measure actual SQL and HTTP effects while idle, not only timer registration.

Current state: extracting the provider-owned execution decision and persisting
confirmed paused presentation versions. The terminal worker, complete producer
audit, lifecycle tests, startup wiring and recurring-call removal remain pending.

## Implemented worker checkpoint

The provider execution resolver is extracted. Successful paused receipt writes
save `pausedVersion` in the existing result. The scoped worker reconstructs
processed nonfinal candidates in 100-row ID pages, excludes unrelated run
history and unresolved reply owners, and uses real publication-lease expiration
when another writer owns the lane. A settled paused receipt is passive. New
run state invalidates it. The owning acknowledgement service still checks
current authority and stops subsequent provider requests at admission/shutdown.
Failed sends transfer to the existing acknowledgement retry worker.

The response-availability helper now wakes this worker as well as initial
acknowledgements. The milestone boundary wakes it for existing run, identity,
lineage and authority producers. Issue-service status/assignee changes notify
inside their owning transaction. GitHub publication staging, missing-binding
cancellation and scoped lease release also notify. Registration is exposed by
the provider service for tests, but app startup still does not register it and
the old terminal maintenance call remains until the audit below is complete.

New acceptance covers eight cases: startup terminal recovery and settled-history
quiet; outer issue transaction rollback/commit; paused-history quiet and a later
run; restart; drain; standby; native-identity rollback/commit; real repository
lease contention/release. All eight pass in `/tmp/sleep35-lifecycle-coalesced.log`
(21.88 seconds). The SQL-quiet checks advance 120 seconds and inspect real
`select` and `transaction` calls. GitHub HTTP remains controlled.

Server typecheck and build pass at this checkpoint, with logs
`/tmp/sleep35-final-server-types.log` and `/tmp/sleep35-final-server-build.log`.
All GitHub review-workflow acceptance is running in
`/tmp/sleep35-github-acceptance.log`; no broad result is claimed yet.

Material failures retained:

- `/tmp/sleep35-before-producer.log`: all three first cases failed because the
  test coordinator omitted its required `canRun` function. Corrected the fixture.
- `/tmp/sleep35-before-producer-fixed-fixture.log`: startup and paused recovery
  passed, while the real issue commit failed to wake terminal response work.
  The issue owner now signals the response slot before writing its status.
- `/tmp/sleep35-producer-fixed.log`: the producer regression and 15 adjacent
  cases passed; the paused restart assertion observed the legitimate pending
  coalesced lease-release pass rather than waiting for settlement.
- `/tmp/sleep35-lifecycle.log`: four passed and four assertions failed at the
  default one-second poll timeout or before the coalesced pass. The coordinator
  itself coalesces at one second. Explicit five-second observation bounds now
  allow that existing behavior; `/tmp/sleep35-lifecycle-coalesced.log` passes all
  eight. No production delay or retry policy was widened to make tests pass.
- `/tmp/sleep35-owner-extraction.log`: nine existing ownership/paused/native/
  legacy-placeholder cases passed after extraction.

## Direct issue writers found before startup wiring

These are unresolved producer-audit items, not exemptions:

1. `issue-tree-control.ts::restoreIssueStatusesForHold` restores issue status
   directly. Its cancellation path already calls `issueService.update`, but the
   restoration path does not. Test a restored blocked request with existing
   response history and cover its transaction before removing the old sweep.
2. `heartbeat/queue.ts` directly blocks a task whose isolated worktree lacks a
   usable project. This can happen before any run is admitted, so a run-terminal
   notification cannot cover it. Existing assembled coverage is in
   `heartbeat-workspace-branch-containment.test.ts` around the projectless
   isolated-worktree rejection case. Verify this producer's response notification.
3. `execution-recovery-resolution.ts::settleUnrecoverableExecutions` can set
   status blocked after a run was already terminal. It does not currently send
   the response notification. Existing real-database coverage is in
   `native-safe-replacement.test.ts` and run-dispatch adapter tests. Preserve its
   task/coordinator/run lock order and failure rollback when adding the signal.

The native-finalization reconciler's blocked transition calls issueService and
is covered by the new owning boundary. Recovery/service's inspected blocked
transitions also call issueService. Runner goal statuses are session-goal data,
not issue status, and do not independently change this response predicate.
Additional dynamic status writers, lookup/index cost, uncertain-publication
settlement, page fairness, final startup wiring, full acceptance and remote review
still need completion. Do not present this checkpoint as polling removal.

## Production registration and direct-writer repairs

The three direct writers above now notify response availability before their
writes in the existing transactions. Three real-producer regressions reproduce
missing paused response settlement before the change. Tree cancellation continues
to use issueService; restoration now notifies each restored issue. Queue admission
notifies only a transition into blocked. Exhausted recovery does likewise and
retains its existing lock order and failure behavior.

`/tmp/sleep35-direct-producers-before.log` records the missing tree/recovery wakes.
Its workspace case initially failed earlier because the fixture had not enabled
isolated workspaces, so it exercised normal admission instead of the intended
pre-dispatch refusal. The corrected fixture enables and restores the feature,
drains any executions on cleanup, and reproduces the missing workspace wake in
`/tmp/sleep35-workspace-producer-before.log`. The real issue state reaches blocked
before the missing-notice assertion, so the red result establishes the producer
boundary rather than an unrelated setup failure. All eleven producer/lifecycle
cases pass after repair in `/tmp/sleep35-direct-producers-fixed.log`.

The remaining inspected direct status writes in agent-conversations, Slack
lifecycle/state, access reassignment, checkout/release, and native workspace
reconstruction move away from blocked or remove assignment. They do not create
a new paused-response obligation. Execution eligibility is reread before any
send, so an outstanding lease-delayed candidate observes these changes. New
run/lineage changes still go through the milestone boundary. Generic issue-service
assignment/status mutations notify directly. Agent deletion does not restore an
owed response. Goal status fields are separate session state.

Two further cases drive the real review-publication owner through token acquisition,
a terminal run transition and pre-send authority denial. A known-unsent publication
cancels and wakes terminal fallback through lease release. A saved ambiguous write
remains parked, with no repeated SQL over 120 seconds. The latter does not assert
that the provider write failed or relax host safety. Both pass in
`/tmp/sleep35-publication-settlement.log`. The existing eight-attempt acknowledgement
policy remains the owner of actual failed fallback sends.

The app now registers terminal-response work with warm-standby and idle-drain
gates, and recurring GitHub maintenance no longer calls terminal reconciliation.
The explicit/manual combined recovery entry point is preserved. Review-check
publication and stale-head review repair remain separate duties in maintenance.

## Candidate lookup and final acceptance

Generated migration `0391_jittery_norrin_radd.sql` adds a partial index for
processed, nonfinal response actions. It runs concurrently through the existing
top-level migration registry and is idempotent on replay. Snapshot pruning retains
0387 through 0391, exactly five. Application, replay, numbering/safety checks and
PostgreSQL index validity pass. No table or queue storage was added.

The worker pages candidates by ID, then asks the GitHub owner to resolve actual
run provenance and reply state. This has per-candidate read cost at startup or
an affected scope change; it does not scan while settled. Issue/delivery/repository
hints narrow normal wakes. A 101-row prefix of unrelated retained requests cannot
hide the owed terminal response and does not publish those unrelated requests.
The shared helper provides fair 25-entry dispatch batches after reconstruction.

A rollback-only experiment inserted 10,000 completed actions. The candidate index
query read four eligible rows using an index-only scan and four shared buffers.
See `/tmp/sleep35-index-plan.sql` and `/tmp/sleep35-index-plan.log`. This proves
completed-history exclusion for the candidate access path, not whole-worker latency
or fleet savings. The lifecycle tests prove settled SQL quiet separately.

Verification:

- The earlier extracted-owner GitHub acceptance passed 194 cases in 140.71 seconds
  (`/tmp/sleep35-github-acceptance.log`) before the three direct-writer repairs.
- Final focused selection passes 15 cases: fourteen new terminal-worker cases
  plus one existing matching case (`/tmp/sleep35-wired-focused.log`, 46.15 seconds).
  The startup source suite did not match this focused selector and is included
  in the full run below; it is not claimed passed by that focused command.
- Workspace typecheck and build pass after final source/wiring/index changes
  (`/tmp/sleep35-workspace-types.log`, `/tmp/sleep35-workspace-build.log`).
- Fresh complete chat/publication/startup acceptance is running on
  `paperclip_sleep35_full_20261025_test`, log `/tmp/sleep35-full-chat.log`.
  Its expected count is 1,571. Do not claim completion before its terminal result.
- Remote checks/review and any resulting repairs remain required.

Independent SQL writers and multiple replicas gain no new wake protocol. Cloud
alarm coverage and sleep admission are unchanged. The full recurring-server stack,
older failed gates/review findings and final master reconciliation remain open.
