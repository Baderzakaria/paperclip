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


## Native decision and effect-receipt checkpoint

`commitNativeStatusDecision` registers company/issue milestone intent after the
existing committed/replayed-decision exits, before inserting or applying a new
decision and its effects. `dispatchPendingNativeStatusEffects` registers intent
only when pending/failed effects exist and their targets have passed validation,
before their delivered receipt and run effect metadata are written. Both use the
existing owning transactions; no caller wrapper or new persistence is needed.
Pure committed replay and an empty pending-effect set remain unsignalled.

Why the effect receipt matters: `readNativeContinuationSource` requires the
applied decision, delivered same-agent continuation effect, original wake intent,
dispatched wake, and responsible-user continuity. A target run can already exist
while its missing delivered receipt prevents publication. A notification only at
run insertion cannot recover that later eligibility transition.

Two new PostgreSQL regressions failed before these integrations:
`/tmp/sleep28-native-effects-before.log`. One observed no milestone intent in the
real decision transaction; the other committed a real effect-delivery receipt but
still had no successor notice. After the repair all 18 milestone worker cases
pass (`/tmp/sleep28-native-effects-tests.log`). The new cases exercise the real
committer and effect dispatcher, outer-commit settlement, committed replay, late
lineage admission and quiet repeated recovery. The continuation is initially
suppressed even though its run and dispatch already exist, and becomes publishable
only after the real receipt producer runs. Fixtures preserve real foreign keys.

All nine selected native chat integration cases still pass after the committer
change (`/tmp/sleep28-native-effects-acceptance.log`); expected lock contention
remains retryable. Server production typecheck passes
(`/tmp/sleep28-native-effects-typecheck.log`). These are local checks, not full
workspace or PR acceptance, and do not include test-file typechecking.

Next concrete audit is heartbeat queue admission, coalescing, cancellation,
claim/release and wake-receipt writers in `heartbeat/queue.ts`, then the other
recovery writers. Some run mutations still use the root DB directly; place any
new transaction at the narrow mutation owner rather than wrapping execution or
provider I/O. Avoid signalling no-op periodic inspections and lease renewals.
Remaining interaction, publication, conversation/configuration, question
claim/retry, and monitor/semantic-receipt dependencies still require coverage.
The new worker is still not production-registered, and the periodic combined
projector remains until that audit and its real producer tests are complete.


## Queue admission, claim, release and coalescence checkpoint

The issue-bound admission transaction signals before inserting its run. Ordinary,
legacy-comment and queued-comment claims signal before changing run/wake state.
Queued-comment discard and committed chat-close cancellation branches also signal
before their terminal writes. The native review claim owner signals after its
review/ownership checks and before changing the run to running. No claim inspection
or admission-marker-only update gets a signal merely because it was inspected.

Drain release now selects and locks the still-running candidate in its existing
transaction, obtains its scope, then registers intent before releasing the run,
wake and issue lock. A repeated release after the run is queued returns without
an intent or update. The added selection follows the same run-first locking order
as the previous UPDATE; it is not a periodic discovery query.

The wake-queue PostgreSQL admission adapter owns coalesced run-context writes and
signals from that existing transaction. Its port carries company identity, so
this writer uses company-scoped reconstruction rather than adding feature fields
to the module contract or interpreting chat/provider payloads. The actual
conversation/lineage decision remains in the chat projection owner.

The fallback company-run admission/coalescing branch of `heartbeat/queue.ts` is
outside the issue-bound path and cannot create a chat milestone. It intentionally
has no new notification or wrapper. Any later task-binding writer still needs
its own signal. This is separate from claiming a historically bound run, for
which a missing context issue ID conservatively uses company scope.

Verification and failures:

- Initial claim fixtures incorrectly inserted a run before its referenced wake.
  Three failed on the real FK, while the drain-release missing-wake regression
  failed at its publication assertion. `/tmp/sleep28-queue-claim-before.log`.
  Fixing insertion and cleanup dependency order required no production change.
- With valid fixtures, all four claim/release regressions failed at the missing
  notice assertion before wiring: `/tmp/sleep28-queue-claim-corrected-before.log`.
  After repair all 22 then-current worker cases passed:
  `/tmp/sleep28-queue-claim-tests.log`.
- Real issue admission during a held execution drain and the actual PostgreSQL
  coalescing writer each reproduced a missing notice independently before their
  notification was added: `/tmp/sleep28-queue-admission-before.log` and
  `/tmp/sleep28-coalescing-before.log`.
- All 24 worker cases now pass: `/tmp/sleep28-queue-producers-tests.log`. Queue
  tests call the actual admission/claim/release implementations and database;
  dependency callbacks hold execution and prevent provider dispatch. The
  coalescing case exercises the actual adapter inside an outer transaction.
  These do not claim provider execution or a full native reviewer admission test.
- All 92 existing queue-module and wake-admission policy tests pass:
  `/tmp/sleep28-queue-module-tests.log`. The queue module now accepts the standard
  guarded external test URL through `PAPERCLIP_QUEUE_TEST_DATABASE_URL`; its
  destructive per-case fixture reset ran only on the new isolated database
  `paperclip_sleep28_queue_claim_20261025_test`. Embedded tests remain the default.
- Server production typecheck passes: `/tmp/sleep28-queue-producers-typecheck.log`.
  This excludes test files and is not workspace/PR acceptance.

Remaining queue producer audit is explicit: the general chat-control recovery
gate's terminal write, early case-handoff cancellation, stale retry/reassignment
cancellation, native status-wake dispatch receipts, deferred-run promotion in the
wake-queue adapter, queued-comment mutations and run-dispatch cancellation. The
native review claim signal also needs its dedicated real admission acceptance
case before final slice acceptance. Other recovery, interaction, presentation,
conversation/configuration, question claim/retry and monitor/semantic receipt
writers from the dependency table remain. Production still uses the periodic
combined projector; the new worker is not registered yet. No original inventory
or PR-stack acceptance requirement is removed by this checkpoint.


## Retry promotion and recovery admission checkpoint

The run-dispatch PostgreSQL adapter now signals before due-retry promotion,
suppressed-retry cancellation, and stale-run cancellation. Its existing locked
state/gate checks still own authorization and no-op exits. Promotion passes the
already-resolved issue identity to its private writer; no application port or
provider contract changes. Missing issue identity uses company reconstruction.
Repeated attempts after settlement do not schedule another milestone sweep.

The wake-queue transaction now signals before deferred promotion inserts its
run and before immediate recovery inserts its wake/run pair. The existing issue
lock, deferred claim, run linkage, and execution lock remain atomic. Tests use
these real adapter ports; external host dependencies return fixture values and
no provider execution is started. Notice creation occurs only after commit.

Evidence:

- `/tmp/sleep28-run-dispatch-before.log`: both real retry paths committed their
  expected status but failed the missing-notice assertion. The first stale-run
  fixture failed earlier because chat comments intentionally bypass terminal
  task status; no production policy was changed to accommodate that fixture.
- `/tmp/sleep28-staleness-corrected-before.log`: a max-turn continuation correctly
  cancelled but its terminal notice was absent before the signal was added.
- `/tmp/sleep28-wake-recovery-before.log`: both deferred and immediate admission
  created their queued runs but failed the missing-notice assertions.
- `/tmp/sleep28-recovery-producers-tests.log`: all 166 selected cases pass,
  comprising 29 milestone worker cases and existing run-dispatch/wake-queue
  application and run-dispatch policy suites. Earlier 97-case verification
  overlaps this set and is not an additional unique count.
- `/tmp/sleep28-recovery-producers-typecheck.log`: server production types pass;
  test files are excluded from that command. `git diff --check` passes.

Queued-comment changes, raw queue cancellation and wake-receipt writers, native
review admission acceptance, and remaining dependency producers are still open.
The periodic combined projector remains in production; this checkpoint does
not claim slice publication, full-suite/PR acceptance, or instance sleep.


## Native wake dispatch receipt checkpoint

`dispatchPendingNativeStatusWakeups` now registers milestone intent when it
repairs an interrupted dispatch receipt, coalesces another same-scope intent,
or records the result of fresh admission. Each receipt UPDATE has a narrow
transaction; enqueue/provider execution remains outside it. Existing status,
claim, provenance, and update guards are unchanged. The parsed issue identity
already owned by this dispatcher scopes the notification (company fallback
when absent). Claims, retry timestamps, and rejected targets do not acquire
milestone intent just because they were inspected.

The existing continuation reader requires both the delivered decision effect
and the coalesced original wake plus matching dispatch receipt. Consequently,
the run-admission notification alone is insufficient: it can be consumed while
the original intent is still claimed. The new normal-dispatch regression forces
that ordering using the dispatch suppression callback, then verifies the final
receipt reactivates projection without starting provider execution.

Evidence and limitations:

- `/tmp/sleep28-native-wake-receipt-before.log`: interrupted dispatch recovery
  linked the run successfully but its queued notice remained absent.
- `/tmp/sleep28-native-wake-fresh-without-signal.log`: removing only the final
  receipt notification reproduced a missing notice after the early admission
  sweep. The production signal was restored in a finally block.
- `/tmp/sleep28-native-wake-restored-tests.log`: all 56 milestone/queue cases
  pass (31 milestone cases, 25 existing queue cases), including normal and
  recovered receipts, repeat recovery quiet, and drain-held dispatch.
- `/tmp/sleep28-native-wake-dependency-tests.log`: all 13 existing dependency
  scheduling cases pass on a new isolated PostgreSQL database. The suite logs
  responsible-user setup denial for some existing fixture paths; this is not
  evidence of successful provider execution or full product acceptance.
- The dependency suite now accepts guarded `PAPERCLIP_DEPENDENCY_TEST_DATABASE_URL`
  and removes its fixed fixture user/closes its client during teardown. Its
  existing broad cleanup must run only on a dedicated database. Initial reuse
  retained the old fixture user; a manual cleanup command used the wrong physical
  table name, and the following run failed in setup with duplicate `user_pkey`:
  `/tmp/sleep28-native-wake-dependency-final.log`. Corrected teardown removed the
  fixture; a fresh read confirmed zero rows before the successful four native
  cases in `/tmp/sleep28-native-wake-dependency-clean.log` (nine unselected).
- Server production typecheck passes: `/tmp/sleep28-native-wake-typecheck.log`.
  Test files remain outside that typecheck. No whole-slice PR acceptance claimed.

Raw queue cancellation, queued-comment/lineage changes, native reviewer claim
acceptance, and the remaining dependency producer audit still prevent retiring
the production periodic projector. All original stack scope remains required.


## Remaining queue cancellation writers

The general chat-control recovery gate now registers intent before its guarded
terminal write, after the existing proof/no-op decisions. Invalid admission at
dispatch still fails closed and never calls the provider callback. Repeated
attempts against a settled run exit before signaling.

Superseded case handoffs previously cancelled with a root-client UPDATE. That
single status change now owns a narrow transaction, locks/selects the still-queued
run, and registers company-scoped intent before updating it. The company scope
avoids trusting a superseded handoff's issue identity as the run's current chat
binding. Status/company guards and the existing post-update wake-status callback
remain unchanged. A repeated claim finds no queued row and creates no intent.
The added run-first lock does not enclose provider I/O or introduce an issue lock.

Admission's stale scheduled-retry and reassigned execution-owner cancellations
also signal before their existing transaction writes. Those transactions may
later insert/notify a replacement run, but that later intent is insufficient for
the protocol's before-first-write requirement. Company/issue identity comes from
the owning admission state; no new module port or provider branch is added.

Evidence:

- `/tmp/sleep28-case-handoff-before.log` reproduces committed cancellation with
  no terminal notice before the fix.
- `/tmp/sleep28-chat-control-before.log` reproduces the same gap for a failed
  recovery gate; the repaired case-handoff regression passes in that run.
- Both gate tests verify no provider execution and quiet repeated attempts.
- The two real replacement-admission cases cover queued and scheduled-retry
  predecessors, their distinct cancellation codes, the old run's terminal notice,
  and the drain-held replacement. These are behavioral coverage, not claimed
  missing-notice-before reproductions: later admission signaling can also wake
  the same issue. Their early intent placement is established by code audit.
- `/tmp/sleep28-cancellation-final-tests.log`: all 60 milestone/queue cases pass,
  including 35 milestone worker cases. Earlier 58-case and two-case runs overlap.
- `/tmp/sleep28-cancellation-final-typecheck.log`: server production types pass.
  Test files are excluded. `git diff --check` passes. No PR acceptance claimed.

The identified raw queue cancellation and native wake receipt writers are now
covered. Still required: queued-comment/lineage mutations, native reviewer claim
acceptance, publication and interaction changes, conversation/configuration,
question claim/retry, and monitor/semantic receipt dependencies. Production still
uses the combined periodic projector until those producers are complete.


## Queued-comment lineage and native reviewer claim coverage

The queued-comment PostgreSQL adapter now signals before rewriting a run's
canonical comment IDs, deleting a queued comment, or cancelling its emptied
queued run. Its private transaction builder receives the already-locked issue
identity; exported application ports and caller wrappers are unchanged. Body-only
edits, issue timestamp touches, and wake-payload bookkeeping do not independently
signal: milestone binding reads comment identities/links and run lineage, not the
queued message text. The same transaction's run rewrite owns the wake for reorder
or nonempty discard; deletion owns the first intent for discard.

The reconstruction regression deliberately starts with the saved queue and run
context out of sync. The real reorder use case reprojects the run context from
that authoritative queue. It is recovery/compatibility coverage, not a claim that
ordinary reordering introduces new comment identities. The discard regression
uses the actual use case and adapter inside a caller-owned transaction and proves
that intent settles only at outer commit. Existing adapter tests retain rollback
and company/issue authorization coverage. Reference/external-object callbacks in
these fixtures are no-ops; this does not claim their integration behavior.

The previously outstanding native-review claim test now exercises the real
PostgreSQL claim against a seeded valid review assignment: applied decision,
matching projected status version, pending confirmation with a separate reviewer,
source native run, queued reviewer run and matching wake. It checks issue/run/wake
ownership and the working notice, then verifies repeated claim is quiet. This
covers claim/notification integration, not the entire review-creation workflow.

Evidence:

- `/tmp/sleep28-queued-comment-before.log`: reconstructed lineage failed to wake
  its notice; discard emitted no transaction intent. Both failed before repair.
- `/tmp/sleep28-native-review-claim-without-signal.log`: removing the real claim
  notification reproduced the missing working notice. The signal was restored
  in finally; no production native-claim edit remains in this checkpoint.
- `/tmp/sleep28-lineage-final-tests.log`: all 74 selected cases pass across the
  38 milestone worker tests, queued-comment adapter/use cases, and native review
  participant policy. Earlier 51-case and targeted native-claim runs overlap.
- `/tmp/sleep28-queued-comment-typecheck.log`: server production types pass;
  test files are outside that command. `git diff --check` passes.
- The existing queued-comment adapter tests now accept guarded
  `PAPERCLIP_QUEUED_COMMENT_TEST_DATABASE_URL` and close their client. Their broad
  fixture cleanup ran only on freshly created/migrated
  `paperclip_sleep28_queued_comment_20261025_test`; embedded mode remains default.

The queued-comment producer and native reviewer claim gaps are closed for this
slice. Publication/interaction, conversation/configuration, question claim/retry,
and monitor/semantic receipt producers still need their own audit and proof.
The production periodic projector remains; no slice publication or full-goal
completion is claimed.

## Question claim and retry checkpoint

Question response claim state is publication lineage, not merely delivery
bookkeeping. A delivering answer can temporarily bind its source run to an
already published prompt on another conversation. Returning that claim to
pending restores the original chat lineage and can make a previously suppressed
working notice eligible.

The question service now registers issue-scoped milestone intent before entering
that claim state and before an owned retry releases it. Retry release locks and
rechecks the existing attempt generation before signaling or updating; exhausted
claims retain ownership until the existing terminal receipt commits. Stale-claim
reset locks the actual stale rows, signals their distinct issue scopes, and resets
only those rows in the same transaction. Updates use batches of 500 IDs to avoid
an unbounded statement parameter count. This preserves the existing reset-all
semantics; it does not make the stale-row scan itself bounded. Live lease renewal,
still-owned exhausted claims and no-op claim attempts add no milestone wake.
Provider cancellation and execution remain outside these transactions.

Verification:

- `/tmp/sleep28-question-retry-corrected-before.log` reproduces a missing working
  notice after real delivery retry. The callback captures observations for
  assertions outside the service's error handler so assertions cannot be swallowed.
- `/tmp/sleep28-question-claims-before.log`: retry and stale reset fail before
  the fix; a live claim remains unchanged and emits no notification.
- `/tmp/sleep28-question-final-tests.log`: 76 pass, one test expectation failed:
  rollback emits settlement again when shared XID reconciliation confirms abort.
  State and publication assertions passed. The corrected test checks intent,
  eventual settlement, preserved claim, absent notice and subsequent idle quiet
  without assuming settlement notifications are delivered exactly once.
- `/tmp/sleep28-question-final-fixed-tests.log`: all 77 cases pass: 42 milestone
  worker cases plus 35 existing question-delivery cases, including lease renewal,
  stale-worker fencing, retries and adapter behavior.
- `/tmp/sleep28-question-typecheck.log`: server production typecheck passed.
  Test files are outside that compiler configuration. `git diff --check` passed.

Existing question-delivery tests now support guarded
`PAPERCLIP_QUESTION_DELIVERY_TEST_DATABASE_URL`, retaining embedded mode by default
and closing their client. Their broad cleanup ran only on the dedicated migrated
`paperclip_sleep28_question_delivery_20261025_test` database. Milestone fixtures
used their separate dedicated database.

Fresh origin/master inspected at `8c6bd5a83b`; reconciliation of the stack remains
outstanding. Publication/interaction, conversation/configuration and monitor
receipt producers remain under audit. Production registration and periodic-loop
removal are still pending, so this checkpoint is not a completed migration PR.

## Monitor receipt ordering checkpoint

The normal native monitor owner does not need another milestone signal when it
saves a schedule. `PaperclipRunnerToolAuthority.#setTaskMonitor` writes the issue
monitor and its semantic tool receipt inside the same `#withMutationReceipt`
transaction. The future deadline cannot be consumed before that commit. A later
monitor wake's real queue admission already signals the issue scope, and the
projector validates the committed receipt through `readNativeMonitorSource`.
Do not add a redundant signal to the generic semantic tool wrapper merely because
the projector reads a receipt.

The new test executes the actual `set_task_monitor` tool authority, then admits
the due wake through the real heartbeat queue after the source has finished. It
checks the queued notice and idle quiet. Source completion is fixture-controlled
and provider execution is held by task drain; this is receipt/admission/lineage
coverage, not full monitor scheduler or harness acceptance. Alternate monitor
wake rewrites and recovery paths still require audit before the whole producer
family is declared complete.

The initial proposed late-receipt test seeded an admitted wake before creating
its future monitor, which did not represent the normal ordering. Its first run
also failed the actual future-deadline validator after advancing the test clock
(`/tmp/sleep28-monitor-receipt-before.log`). That failure was a fixture problem,
not a production regression. The replacement follows the real ownership order
instead of manufacturing a missing signal for an unsupported ordering.

- `/tmp/sleep28-monitor-admission-tests.log`: targeted real producer path passes.
- `/tmp/sleep28-monitor-final-tests.log`: all 43 milestone worker cases pass.
- No production monitor code changed; `git diff --check` passed.

Remote gates refreshed at this checkpoint: #17490 at `31bcd1988823` still has
failed E2E shard 3 and aggregate checks; #17590 at `e501d6c99d72` still has queued
Paperclip Review; #17592 at `f53ae3d6d27c` still has neutral Paperclip Review.
These are not claimed ready and no merge was attempted.
