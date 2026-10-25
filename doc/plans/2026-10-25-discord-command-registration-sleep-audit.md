# Discord command-registration scheduling audit

Parent: tool-health PR #17554, head `2ca12f806399cfcef1a474453301534f4b96c1ef`.
The parent has 770 selected passing local tests, passing workspace typecheck and
build, and live remote CI/review. It is not accepted or merged. This branch owns
one newly separated reason from the existing chat-runtime inventory.

## Evidence and boundary

`app.ts` calls `reconcileProviderRuntimes` from its recurring chat maintenance
lane. That service discovers eligible Discord and Photon endpoints, restores
runtime ownership, and calls `discord/runtime-reconciliation.ts`. The latter
calls `reconcileDiscordCommands` before inspecting registered command state and
runtime capabilities. Thus removing runtime inventory polling without another
owner would also remove command-registration recovery.

The command protocol and authorization already live in
`chat-channels/discord/commands.ts`. Durable state is in existing `chat_actions`
with kind `discord_command_registration`, owned by
`chat-discord-command-registration-store.ts`. The store already has retryAt and
retryIndefinite outcomes. Registered state and an indefinite hold must not cause
periodic discovery simply because an endpoint is configured. Inspect the full
state protocol before deciding which attempted/unknown states may replay.

This slice should give command registration its own committed-change/deadline
worker and remove command reconciliation from recurring runtime maintenance.
Keep provider protocol, native identity/credential fences, and command receipt
validation in the Discord owner. Do not copy command HTTP behavior into startup
or the generic scheduler. Keep direct setup/foreground calls compatible.

## Required producer and lifecycle audit

- Endpoint creation/configure/reconnect/resume, identity/guild changes, credential
  rotation, removal, and connection disable/health quarantine.
- All registration-store claims, attempted/unknown/registered commits, recorded
  retry outcomes, legacy restoration, and operator force/reset paths.
- Existing registered command receipt publication and runtime capability refresh:
  establish a committed completion trigger without continuing a periodic scan.
- Shared receiver-ownership loss and lease contention: identify which operations
  require an owned runtime, a credential lease, or only an eligible endpoint.
- Configuration changes arriving during provider work must retain the existing
  generation/fingerprint fence and schedule the latest state after settlement.
- Startup reconstruction must discover missing registration state in bounded
  pages, without letting early failures starve later eligible endpoints.
- Empty, inactive, registered, and indefinite-hold states must become quiet.
  Due retries remain durable, respect Retry-After, survive restart, and retain
  deferred work through drain. Join admitted provider work at shutdown.
- Verify normal and ambiguous provider outcomes through the existing protocol
  tests; never replay an uncertain create merely to clear a scheduling blocker.

## Separate remaining duties

Runtime inventory discovery is still a separate migration. Its existing
eligibility is Discord/Photon, endpoint status verifying/active/attention,
active enabled connection, and no attention plus failed-health combination.
The shared receiver owner keeps a 15-second lease and renews an active listener
at one-third of its TTL. Those live-resource renewals are not empty discovery.
A standby must use the actual observed lease expiry for takeover, and local
ownership loss needs a callback that retains a wake after stop settlement.
Persistent transports remain host-sleep limitations even after discovery is quiet.

`app.ts` also invokes `chatChannels.voice.reconcile()` and Teams maintenance in
this lane. Voice, Teams, milestones, wake notices, terminal confirmations,
interaction continuations, and GitHub history recovery remain distinct duties.
No existing backstop is removed by this audit. No implementation or passing
regression is claimed for slice 19 yet.
