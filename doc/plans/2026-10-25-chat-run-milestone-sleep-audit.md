# Chat run-milestone projection sleep audit

Baseline: Teams attempt recovery #17592 at f53ae3d6d2.
Branch: codex/sleep-28-chat-run-milestones.
Status: scoped worker and initial real producer signals implemented and locally
verified; complete producer coverage, production registration and final acceptance pending.

## Separate obligations discovered

The app's recurring chat coordinator invokes enqueueChatRunMilestones. The same
method also invokes enqueueSafeNativeChatProgress when the milestone batch does
not fill its limit. These are different reasons and must have separate migrations:

1. Coarse run lifecycle projection: queued, working, waiting for input, completed,
   failed. Existing heartbeat run state plus conversation/continuation lineage
   determines whether a safe milestone is owed. This is slice 28.
2. Native progress-event projection: admitted heartbeat_run_events and current
   run/presentation authority determine which safe progress update is publishable.
   Keep this as the next separate reason; do not silently remove its only sweep.

Both produce existing chat_publications and already notify publication delivery
before insert. No queue table should be introduced merely to migrate projection.
Existing publication identity is run/milestone/endpoint. Respect the existing
24-hour selection window until its semantics are explicitly audited.

## Existing owner and correctness constraints

server/src/services/chat-run-publications.ts owns lineage, source-authorized safe
text, final-comment suppression and GitHub owned-provider-interaction suppression.
Keep this policy there or in cohesive chat publication modules. Shared scheduler
and app wiring must not interpret run/provider payloads. This is projection, not
execution recovery; never dispatch another run to produce a missing notice.

A succeeded run is not eligible until its durable presentation decision exists.
Explicit authored final publications suppress generic completion. Answered
questions, direct interactions, issue monitors and task continuations each supply
lineage. Run state alone is therefore not a complete producer inventory. Audit
writes to those associations, presentation decisions, final publications,
conversation bindings and policy/authority changes before removing the backstop.

The current live-event fast path calls notifyPublications only while not draining
or in standby. It is not a durable commit protocol and can drop a first wake during
drain. Use supported transaction boundaries and the shared coordinator, preserve
outer commit/rollback and uncertain outcomes, and reconstruct existing debt on
startup. A zero inserted count can mean contention or suppression; it is not by
itself proof that no projection remains. Distinguish passive/suppressed history
from recoverable lock contention and dependency changes.

Current pagination uses JavaScript Date for run updated_at and native event
created_at cursors. Audit precision when preserving or replacing it; PostgreSQL
submillisecond values must not duplicate/skip candidates or pin a page. Preserve
company fairness, bounded work and existing publication deduplication.

## Required next investigation

- Enumerate every supported lifecycle/presentation/lineage producer and its
  existing notification/transaction owner. Inspect heartbeat boundary rules.
- Separate the combined function without changing the explicit/manual contract
  or losing native progress while its own migration is pending.
- Define an observable unfinished-work predicate and a scoped candidate loader;
  ordinary settled history must disarm. Avoid global scans for every run hint.
- Prove real normal completion, authored-final suppression, question/direct/monitor
  continuations, configuration changes, backlog fairness, contention retry,
  rollback, startup, drain/resume and shutdown. Keep external source authority.
- Keep current Cloud blockers and external alarm limits. Single active process
  through the owning DB client remains the supported signal model.

All earlier stack remote gates, #17490 E2E cancellation, #17580 unresolved cleanup
policy, and final master reconciliation remain required. No merge authority or
full-goal completion is implied by this audit.


## Projection boundary checkpoint

`enqueueChatRunLifecycleMilestones` now owns only coarse lifecycle projection.
`enqueueSafeNativeChatProgress` exposes the existing native progress owner.
The existing `enqueueChatRunMilestones` entry point still combines them with
lifecycle priority, the same 24-hour default window, and one capped insertion
budget. Production still calls that combined entry point. No periodic owner has
been removed prematurely; this checkpoint is not completion of slice 28.

The lifecycle cursor now carries PostgreSQL's timestamp text through a typed
`(updated_at, run_id, conversation_id)` tuple comparison. With 30 unauthorized
candidates at a submillisecond timestamp, the old Date cursor repeated a page
indefinitely, never reaching valid notices. The test caps candidate page reads
so reproducing the defect cannot leave an asynchronous SQL loop after a timeout.
Native progress has its own timestamp cursor; its precision audit belongs to
that next migration and is still required.

### Producer coverage still to implement

The current readers establish these dependencies. This table identifies signal
owners to audit; it does not claim those signals are already installed.

| Dependency | Owning paths and required wake |
| --- | --- |
| Run admission/status/issue binding/error code | `heartbeat/queue.ts`, `heartbeat/run-lifecycle.ts`, and native/legacy recovery writers. Existing `notifyExecutionRunWork` covers only some paths. Audit raw writes before adding milestone coverage. |
| Presentation decision and native result | `heartbeat/run-completion.ts`, native finalizers, and semantic receipt writers. Succeeded alone is insufficient: presentation may settle later. Source monitor receipts can authorize a successor without changing the successor row. |
| Question response claim and terminal receipt | `question-response-delivery.ts`: claim moves to delivering; `recordTerminal` owns a transaction that records target run/status. A late receipt can redirect an existing run's publication destination. Lease timestamp renewal is not a new presentation obligation. |
| Interaction state and source-run ownership | `issue-thread-interactions.ts`, plus recovery writers. Pending agent-authored questions suppress generic finals even before publication; resolved prompts can retain that suppression. |
| Published prompts, final comments, and close controls | Publication settlement and `issues.ts`. Published prompt receipts enable lineage; authored finals suppress generic completion; a published close requires fresh independently admitted sources before later presentation. Publication notifications must avoid a global scan feedback loop. |
| Inbound comment links and conversation binding | Ingress and conversation owners. The run's source string alone grants no authority. Endpoint assignment, publication mode, conversation state/issue and verified comment links matter. |
| Continuation wake/decision/effect receipts | `native-continuation-delivery.ts` reads applied status decisions, delivered continuation effects, the original wake and dispatched wake, plus responsible-user continuity. Audit their writers; a run notification before these commits is too early. |
| Monitor wake and source semantic receipt | `native-monitor-delivery.ts` requires an admitted monitor wake plus the source run's exact saved `set_task_monitor` receipt. Audit both writers, including late completion. |
| Board reply identity and provider configuration | `slackBoardReplyBindings`, endpoint configuration, and upgraded GitHub configuration affect selection. Scope configuration invalidation to its company/endpoints; preserve each provider's existing policy. |

`resolveChatOriginPublicationBindings` also follows arbitrarily long verified
lineage with cycle rejection. Changing an ancestor can affect a successor; a
strict run-ID-only invalidation is insufficient for all producer families.
Issue-scoped reconstruction is appropriate for lineage changes. Run-only hints
can be used only where the writer cannot affect descendants. Shared scheduling
must not decode provider context or implement this authorization graph.

The coarse projector currently waits on its writes and does not use skip-locked
selection. A zero insertion count may be an authoritative suppression or a
concurrent idempotent insert; database failures must retain retry. Native progress
has different lock/contention behavior and must not inherit that conclusion.

### Verification and failure record

- Initial owner split: nine selected PostgreSQL integration cases passed,
  including separate-owner/combined-budget checks and six provider/surface cases.
- First cursor reproduction incorrectly guarded every `db.select`, including
  legitimate authorization reads, and ran against retained earlier fixtures.
  Both precision variants failed that overly broad guard; this was not evidence
  of the production cursor defect. Log: `/tmp/sleep28-precision-before.log`.
- Corrected guard counts candidate-page reads. In a fresh database the millisecond
  case passed; the submillisecond case failed after 100 repeating pages. Log:
  `/tmp/sleep28-precision-clean-before.log`.
- After retaining PostgreSQL precision, ten selected integration cases passed in
  a fresh database. Log: `/tmp/sleep28-projection-fixed-tests.log`.
- Broader final selection: 31 integration cases passed (1,398 unselected),
  covering milestone authority, native progress, lock contention, question
  continuations and authored finals. Log: `/tmp/sleep28-projection-acceptance.log`.
  These overlap the earlier ten and are not additive.
- All 20 publication policy unit cases passed; server production typecheck passed.
  Logs: `/tmp/sleep28-publication-unit.log`, `/tmp/sleep28-server-typecheck.log`.
  Server typecheck excludes test files. No full-workspace acceptance or new PR
  readiness is claimed for this preparatory checkpoint.

Parent #17592 at `f53ae3d6d27c2642e7dfe647a2c0a9bbf2d582ac` now has passing
Actions/security/Greptile gates, no inline review findings, and a neutral
Paperclip Review result. Neutral is not a completed positive review. #17590 at
`e501d6c99d721d6428f8c490206417765c76f4f6` has passing gates with Paperclip Review
queued at inspection. #17586 also has a neutral Paperclip Review. Final review
acceptance remains separate. Refreshed master is `2e47c42fad`; stack reconciliation
remains required. No stack PR was merged.


## Scoped worker and initial producer checkpoint

`chat-run-milestone-work.ts` now reuses `registerScopedDeadlineWork`. Its loader
shares the lifecycle candidate selector with the explicit projector, retaining
all existing SQL eligibility fences and timestamp precision. It reconstructs
one entry per company/issue, with a bounded 100-publication projection batch.
A full batch remains immediately due; a short batch has exhausted the selector
and disarms, including currently suppressed lineage. Real selection/write
failures retain the shared retry backoff. The scheduler owns coalescing,
company fairness, first writes during drain, concurrent changes, and shutdown.
No new persistent queue or independent timer is introduced.

`notifyChatRunMilestones` carries only company/issue identity through the existing
outer-transaction protocol. Issue-scoped invalidation includes descendants;
company scope is available for broader configuration or lifecycle changes.
Unrelated issues/companies are not reconstructed for an issue hint.

Initial production integrations now await intent before writing:

- `heartbeat/run-lifecycle.ts::writeRunStatus`: both shared status transition
  callers signal the known company in their existing transaction. This is a
  conservative company hint; it is not proof that all raw run writes are covered.
- `heartbeat/run-completion.ts`: the late presentation-decision write now owns
  a short transaction and signals its issue (company fallback when unbound).
  Provider execution and presentation generation remain outside that transaction.
- `question-response-delivery.ts::recordTerminal`: the existing transaction
  signals the issue before recording the durable target run and outcome.

The production app still uses the combined periodic projector. The new worker
is exercised through actual coordinator registration in tests but is not yet
registered by `app.ts`; do not remove the sweep until the remaining producer
families in the table above are implemented. In particular: queue admission and
recovery writers, native finalization and semantic receipts, question claim/retry
transitions, interaction changes, publication settlement, conversation/endpoint
changes, and decision/wake ledger changes remain to be covered. The late legacy
presentation signal is implemented, but its own full completion integration
proof is still required. Current Cloud blockers and single-active-writer limits
remain unchanged.

### Worker and producer verification

15 real-PostgreSQL worker cases pass in
`/tmp/sleep28-worker-question-tests.log`. They cover configured idle/internal
runs/old history, startup and restart, first committed work, outer commit and
nested rollback, first wake during drain, issue/company isolation, suppressed
lineage reactivation, late presentation eligibility, 205 notices plus another
company, selection failure through drain, publication-write retry, a concurrent
commit during projection, shutdown, real cancellation and real question delivery.
Quiet assertions advance two minutes and observe zero DB selects/transactions.
The deadline test verifies no scans during the ten seconds before retry.

The two real producer proofs are causal, not just notification-spy assertions:

- Removing the actual `writeRunStatus` signal makes the cancellation test fail:
  the queued notice exists but the terminal notice is absent. Restoring it passes.
  Log: `/tmp/sleep28-cancellation-without-signal.log`.
- The question test creates and answers a real interaction, supplies a durable
  published prompt, and invokes the real delivery service. Its wake callback
  inserts the continuation without a milestone signal and proves no notice is
  projected yet. The terminal receipt then activates the worker. Removing that
  exact signal strands the notice and fails the assertion. Log:
  `/tmp/sleep28-question-without-signal.log`.

The 31-case existing chat integration selection passes after the selector
refactor and producer additions, including presentation authority and native
progress. Log: `/tmp/sleep28-scoped-acceptance.log`. Expected contention/retry
warnings occurred, with all assertions passing. Server production typecheck
passes in `/tmp/sleep28-producer-typecheck.log`. No full-workspace or PR gate
completion is claimed yet.

Preserved fixture failures:

1. `/tmp/sleep28-worker-tests.log`: all 11 initial cases failed setup because the
   fixture used provider name `slack` as connection transport. The schema requires
   `chat_sdk`; no production transport change was made.
2. `/tmp/sleep28-worker-fixed-tests.log`: ten passed; the same-company isolation
   fixture violated the application-name uniqueness constraint. Fixture names now
   include their identity.
3. `/tmp/sleep28-worker-producer-tests.log`: eleven passed; cancellation required
   a responsible-user membership, and teardown omitted its new run-event rows.
   Both are now represented/cleaned by the fixture.
4. `/tmp/sleep28-worker-producer-fixed-tests.log`: assertions reached cancellation
   projection, but default follow-on recovery admitted another execution and
   teardown deadlocked against it. The test now uses cancellation's existing
   `suppressImmediateRecovery` option to exercise Stop without starting successor
   execution. This does not change the default production recovery policy.
5. All 12 corrected cases passed in `/tmp/sleep28-worker-final-tests.log`; two
   concurrency/retry cases made 14 pass in `/tmp/sleep28-worker-expanded-tests.log`;
   the real question case brings the latest total to 15. These counts overlap.

This checkpoint is progress on slice 28, not a new independently complete reason
or a claim that milestone polling is retired. The original full PR-stack scope,
older unresolved CI/review findings, final master reconciliation and each PR's
latest-head acceptance remain required.


## Native finalization producer checkpoint

Native finalization now registers issue-scoped milestone intent in its existing
transactions before failure recording, committed terminal projection, and the
normal final run projection. All three committed-response repair branches signal
only after their authorization/no-op guards and immediately before comment and
presentation writes. The status arbiter, provider interpretation, and execution
policy remain with their native owners; the milestone signal carries only company
and issue identity.

Governed review-presentation restoration also signals an actual change. Previously
it rewrote identical metadata (including updated_at) on every accepted repair.
The owner now locks the run, compares the exact proposed JSON merge against the
current result, and returns successfully without a write or signal when unchanged.
It still returns true for an already valid projection: callers may need to
materialize the response even when its metadata is already present. Existing
coordinator/proof/digest/company checks remain before this decision.

Evidence at this checkpoint:

- The new real-finalizer regression failed before the signal: a persisted committed
  native cancellation projected its terminal run state but never generated the
  terminal chat notice. Log: `/tmp/sleep28-native-before.log`.
- After wiring, all 16 milestone-worker PostgreSQL cases pass. The new case calls
  the real finalizer without a manual milestone notification and verifies that
  replaying the settled finalization causes no deferred worker SQL. Its input is
  a seeded committed audit-only result; this is a recovery-producer proof, not a
  test of accepting provider results. Log: `/tmp/sleep28-native-worker.log`.
- The new governed-review repair test failed first because an unchanged repair
  advanced updated_at. Log: `/tmp/sleep28-review-before.log`.
- After repair, nine selected real PostgreSQL chat integration cases pass. They
  cover unchanged metadata, changed metadata intent before the write and settlement
  after commit, repeat repair, Slack/Telegram accepted-response recovery, canonical
  response recovery, already-selected/deleted answer protection, contention, and
  review authority changes. Expected contention is retained as retryable.
  Log: `/tmp/sleep28-native-recovery-tests.log` (1,421 cases not selected).
- Server production typecheck passes: `/tmp/sleep28-native-typecheck.log`.
  It excludes test files. No full-workspace or remote PR acceptance is claimed.

The periodic projector remains enabled. Next producer audit: status-decision
commit/replay and pending-effect delivery, then admission/recovery, interaction,
publication, conversation/configuration, and monitor/semantic-receipt writers
from the table above. Signals added here do not establish complete producer
coverage. The full original stack, unresolved earlier gates, and master
reconciliation remain required; no PR has been merged by this checkpoint.
