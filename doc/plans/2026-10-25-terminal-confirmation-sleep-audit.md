# Terminal confirmation recovery migration

Date: 2026-10-25. Branch: `codex/sleep-32-terminal-confirmations`.
Parent: [#17649](https://github.com/paperclipai/paperclip/pull/17649) at
`2384384eeec4f32d073242ebf597b81df2df1ccb`.
Status: owner audit only; no worker migration or PR yet.

## Obligation and existing boundary

The owning implementation is
`server/src/services/chat-channels/telegram/confirmation-actions.ts`.
A Telegram confirmation callback accepts or rejects an interaction through
`issueThreadInteractionService`. Its `afterResolveInTransaction` callback
changes the exact `confirmation_response` action from `issued` to `processing`
in the same transaction as the terminal interaction decision. That action is
already the durable record of unfinished settlement. No additional table is
needed.

`settleTerminalConfirmationAction` completes that saved decision: it marks the
action processed, retires sibling tokens, stages an actionless resolution
publication and (when required) an `interaction_wakeup`, and emits the existing
provider-attributed activity entry. It does not repeat the user's decision or
send provider traffic inside the transaction. Compare-and-set losers accept an
already processed winner, preserving callback/recovery concurrency.

`reconcileTerminalConfirmationActions(limit)` currently scans processing actions
by updatedAt/id. It is invoked by `processPublicationMaintenance` on the periodic
chat path and by the explicit/manual publication queue path. The former is this
slice's target. Preserve the latter's manual recovery contract. Interaction
continuation delivery and GitHub maintenance remain separate reasons/PRs.

## Producer inventory

- [ ] Acceptance callback: notify before its processing-action write inside the
  existing `afterResolveInTransaction` owner.
- [ ] Rejection callback: same contract, separately exercise the real path.
- [ ] Initial action token creation in `chat-interaction-publications.ts` writes
  `issued`; a user still deciding does not owe settlement work. It must be quiet.
- [ ] Terminal/supersession publication helpers expire issued sibling tokens;
  inspect their exact predicates before treating them as processing producers.
- [ ] Settlement writers move processing actions to processed/failed/expired.
  Preserve publication notifications, activity provenance and continuation order.
- [ ] Board-resolution compatibility: current integration coverage fabricates a
  processing action before the board decision. Establish how historical pending
  processing rows reactivate from a later interaction change, without repeatedly
  scanning an unchanged human-wait state.
- [ ] Startup reconstructs processing debt. Outer rollback creates no actionable
  debt, ambiguous commit uses the existing transaction signal protocol, and
  first-write drain/resume retains the wake.

## Mechanism and unresolved design checks

Reuse the existing delivery coordinator and action worker registration rather
than adding a new scheduler or teaching app startup Telegram payload semantics.
The provider module owns settlement, malformed token handling, binding checks and
activity attribution. A shared registration may select a normalized action kind
and delegate to it.

Do not merely move the unbounded retry behavior into a new timer. The current
settler returns false for a processing action with no conversation, and for a
still-pending interaction. The oldest unfinished prefix can therefore starve
later candidates under the fixed limit. Separate a genuinely runnable terminal
settlement from a pending interaction; audit the producer that makes the latter
runnable. Preserve explicit failure evidence for malformed bindings rather than
silently deleting work. Bound candidate work and prove progress beyond a denied
or failed prefix. Retrying a failed query is different from polling an unchanged
human decision.

The first notification must not race callback settlement into a duplicate
publication or activity entry. Existing compare-and-set and idempotency keys are
the correctness owners. Future checks should observe the durable result and
provider-visible behavior, not only calls to a notification helper.

## Verification plan

The existing integration test beginning `renders safe Telegram confirmations as
opaque one-use buttons and wakes the resolved task` injects a failure after the
interaction transaction commits but before action settlement. It verifies the
saved decision, recovery publication, provider edit before continuation wake,
one-use token behavior, redelivery deduplication, board-race provenance and
failed continuation handling. Reuse its fixture and assertions rather than
building a parallel authorization fixture.

- [ ] Reproduce missed recovery after the real postcommit callback failure when
  periodic/manual maintenance is not invoked.
- [ ] Prove committed acceptance and rejection activate recovery from idle.
- [ ] Prove first-write drain/resume, stop/restart, failed selection/retry and
  writes during a drain/sweep.
- [ ] Verify outer rollback/commit through actual producer ownership where the
  callback service accepts a caller-owned transaction.
- [ ] Prove empty state, issued tokens awaiting a person, and completed history
  make no recurring SQL after settlement.
- [ ] Prove bounded progress behind pending/malformed/contended candidate prefixes.
- [ ] Retain the existing terminal edit-before-continuation behavior, duplicate
  callback handling and board-resolution attribution.
- [ ] Register production work and remove only its periodic maintenance call.
- [ ] Update startup/action-worker tests and run targeted PostgreSQL acceptance,
  server types/build, required full acceptance and fresh remote review/checks.

## Scope remains open

No Cloud wake gate, transport ownership, provider deadline, or sleep eligibility
changes are implied. The supported process-local writer model remains explicit.
Every remaining original recurring-server reason and older stack finding stays
in the ledger; this audit does not reduce the requested scope.
