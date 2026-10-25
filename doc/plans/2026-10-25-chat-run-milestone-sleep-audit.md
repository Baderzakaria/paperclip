# Chat run-milestone projection sleep audit

Baseline: Teams attempt recovery #17592 at f53ae3d6d2.
Branch: codex/sleep-28-chat-run-milestones.
Status: initial owner inspection; producer audit, implementation and acceptance pending.

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
