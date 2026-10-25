# Chat receiver discovery sleep migration audit

Parent: Discord command registration #17557, head d3187f76a4.
Master refreshed during this continuation: e6ec781a1a.
Branch: codex/sleep-20-chat-runtime-discovery.
Status: owner audit; no implementation or passing migration claim yet.

## One reason for this PR

Remove recurring inventory discovery for leased chat receivers from the aggregate
chat maintenance timer. Preserve receipt projection, credential fencing, runtime
initialization, takeover, and stop semantics. Discord command registration belongs
to the parent; voice reconciliation, publication maintenance, milestones, Teams,
and GitHub recovery remain separate migration reasons.

`server/src/app.ts` currently invokes `chatChannels.reconcileProviderRuntimes()`
and `chatChannels.voice.reconcile()` in the same recurring maintenance lane.
The receiver method in `services/chat-channels.ts` queries every eligible Discord
or iMessage Photon endpoint, stops local ownership missing from that inventory,
then calls `runtimeFor` and `reconcileDiscordRuntime` for each eligible endpoint.
This query runs even when there are no receivers. Separating voice is necessary
before removing this callback from the maintenance lane; removing both would lose
an unmigrated obligation.

## Durable truth and owner boundaries

Existing `chat_endpoints`, `tool_connections`, and `chat_endpoint_leases` contain
the necessary configuration and ownership. No additional durable queue table is
needed. The receiver owner must retain the current eligibility policy: supported
leased provider; verifying/active/attention endpoint; active, enabled connection;
and exclusion of attention plus failed connection health.

The receiver provider policy currently lives in `leasedChatProvider` in
`chat-channels.ts` and the lease-key selection inside `runtime/ownership.ts`.
Centralize that existing policy with the chat provider/receiver owner before
adding another independent Discord/Photon switch in scheduling. Shared delivery
coordination should consume normalized receiver identities and deadlines, not
provider protocols, credentials, or command-registration rules.

`runtime/ownership.ts` owns acquisition, renewal, token fencing, and stop order.
Acquisition uses insert or expired-token CAS; background acquisition attempts once.
Foreground configuration can wait up to twenty seconds, checking every 100 ms.
That bounded active-operation wait is separate from idle inventory polling.
The current default live lease lasts fifteen seconds and renews every five
seconds while owned. These renewals are required active transport work and are
not removed in this slice. Existing inbound admission reclaims the exact token
after expiry before accepting buffered callbacks; preserve that safety boundary.

## Proposed wake contract to verify in code

- Reconstruct eligible receiver obligations at startup with bounded UUID pages.
- Notify before supported endpoint/connection eligibility or credential changes
  in their existing transactions. Decode scoped hints only at the notification
  boundary; narrow normal refreshes to an endpoint or connection.
- Keep locally owned healthy receivers in the inventory cache even when they have
  no discovery deadline. Otherwise later removal cannot identify the runtime that
  must stop. A cache of only future deadlines is insufficient for this duty.
- A locally healthy unchanged receiver needs no periodic rediscovery query. Its
  active lease renewal and socket lifecycle remain owned by the receiver runtime.
- On a concrete foreign lease, schedule the saved expiry as the next takeover
  attempt. Reload current authority at that time; a renewed foreign lease yields
  its new expiry. This is a configured receiver's takeover obligation, not proof
  that a standby with such an obligation can sleep indefinitely.
- Initialization/credential/database failures retain scoped retry/backoff. One
  failed receiver must not starve independent companies or a healthy due backlog.
- After ownership loss, finish listener fencing/stop and lease release, then wake
  discovery for that endpoint. Do not reinitialize before the old listener stops.
  Avoid a callback cycle on shutdown or a permanent retry after disable/removal.
- Preserve a change arriving during refresh, drain, or stop. Use the existing
  coordinator's settled hints and memory-only pending predicate; no passive SQL
  during drain. Join admitted work before returning from shutdown.
- Retain the explicit/manual reconciliation entry point used by current callers,
  or update those callers and their assertions deliberately. Do not leave a
  second automatic periodic entry point invoking the old full inventory query.

## Producer audit still required before implementation is accepted

Existing helpers are starting points, not proof of complete coverage:

1. `chat-work-notifications.ts:notifyChatEndpointWork` already covers shared
   connection-origin delivery/command wakes. Inspect its callers individually.
2. `chat-channels/configuration.ts`: configure, reconnect, resume, pause, remove,
   activation and rollback, including foreground acquisition and ownership waits.
3. `chat-channels/setup-probes.ts`, `provider-effects.ts`, resource reconciliation,
   publication failures, and inbound activation: eligibility/health transitions.
4. Generic tool access, removal, health observations, credential/binding changes,
   membership removal, and company deletion: these can change a receiver without
   calling the endpoint configuration service.
5. `runtime/ownership.ts`: renewal failure, token loss, failed initialization,
   runtime invalidation, lease release, and shutdown. A direct callback is suitable
   for process-local completion; do not invent a SQL row for that callback.
6. Photon runtime callbacks and configuration: independently verify these paths;
   the Discord parent producer audit is not evidence of Photon coverage.
7. Existing live replica/independent-writer assumptions: process-local transaction
   hints cannot discover another process's arbitrary configuration writes. Retain
   or explicitly integrate the supported cross-process wake contract rather than
   silently removing its only recovery path.

## Required evidence

Start with a failing empty-instance regression proving that the aggregate chat
cadence repeatedly queries receiver inventory. Then verify:

- empty, disabled, and retained-history states have no discovery SQL after startup;
- actual first configure/reconnect/disable/remove producers wake or cancel work;
- healthy local ownership adds no inventory scan beyond explicit mutations;
- foreign lease expiry, extension, and takeover preserve single ownership;
- renewal failure triggers bounded recovery only after fencing the old runtime;
- old buffered messages remain fenced after token or credential generation change;
- Photon and Discord preserve their existing distinct transport behavior;
- scoped changes, company deletion, nested transaction commit/rollback, uncertain
  commit, page boundaries, failure isolation, concurrent changes, restart,
  drain/resume, and shutdown retain obligations;
- shared coordinator behavior without this worker remains unchanged;
- the existing command-registration cases retain saved verification deadlines.

Use real PostgreSQL for lease CAS and transaction ownership, and controlled local
runtime/provider fixtures for lifecycle effects. Existing chat integration tests
exercise manual reconciliation, foreign ownership, credential rotations, and
Photon restart. Inspect those cases before designing fixtures. SQL silence must
be measured after both tracked work and scheduler settlement; a null next-wake
value alone can occur during an admitted reload.

## Sleep limits and remaining stack gates

Active receiver sockets and lease renewals remain physical sleep blockers. Cloud
alarm coverage and admission/sleep-safety proof do not change. This migration
removes idle discovery activity, not the receiver's live transport obligation.
The full original recurring-server inventory remains in scope in the stack ledger.

At audit creation, health #17554 has a passing security scan on 9ef6e4f4c8 but
other current-head checks remain running. Company cleanup #17561 is e8febb30eb.
Discord #17557 is d3187f76a4 with fresh checks required after its failure-path and
CI fixture repairs. The older #17490 E2E cancellation failure, final reconciliation
with master, and all fresh review/check gates remain outstanding. No stack PR was
merged and no new merge authority is implied.
