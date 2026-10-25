# Tool connection health sleep migration audit

Parent: plugin scheduling #17518, local head `faac1bf85c`.
Fresh master inspected during this continuation: `71f06d84dc`.
Branch: `codex/sleep-18-tool-connection-health`.
This is an in-progress audit and failing baseline, not a completed migration.

## Obligation and observed blocker

The aggregate heartbeat calls `tools.sweepConnectionHealth()` at startup and on
its recurring maintenance tick. The health owner selects due connection IDs even
when no eligible connections exist. Its default freshness threshold is fifteen
minutes and its page size is 25. The startup regression on the unchanged worker
expected one startup call after two maintenance ticks and observed three calls.
The recorded command is:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/server-startup-feedback-export.test.ts \
  -t 'does not rescan idle tool health' --maxWorkers=1
```

The baseline failed with `expected 3 to be 1`. This proves aggregate activation;
real database worker tests must separately prove quiet SQL, deadlines, and producer
reactivation after implementation. A removed startup callback alone is not proof.

## Ownership and policy

`tool-access/catalog/health.ts` owns provider health policy and delegates actual
provider behavior through existing discovery, credential, catalog, and runtime
owners. Preserve this boundary. Shared scheduling must not branch on provider
names or decode their credential payloads.

Existing `tool_connections.health_checked_at` and connection eligibility are the
persistent source of truth. No additional health queue table is needed. Keep the
manual `checkHealth` API and normal use/refresh health updates working. Preserve
the current proactive fifteen-minute policy for eligible external checks unless
a provider's existing event/replay contract makes a check unnecessary. Clearly
name that retained external obligation: scheduling the next real check removes
empty scans but does not make a configured external source network-quiet forever.
Do not extend Cloud alarm coverage or remove active-connection sleep blockers in
this slice.

The current SQL excludes `chat_sdk`, `runtime_auth`, and applications of type
`paperclip_plugin`. The schema couples AI purpose to `runtime_auth`, and
`checkConnectionHealth` returns immediately for AI purpose. Do not claim AI rows
are an uncovered polling case without evidence of supported legacy rows outside
those constraints. PR #14638 separately covers AI health behavior.

Audit voice eligibility, experimental connector disablement, and exceptions before
the existing health update: a skipped check that leaves its timestamp unchanged
must not starve later candidates or cause an immediate retry loop. Keep admission
and authorization failures with their owners. Do not silently disable or delete
connections to manufacture quiet.

## Producer inventory to finish

This list identifies writer families; it does not yet certify complete coverage.
Classify each write by changes to eligibility, saved deadline, or relevant probe
configuration before adding a notification. Excluded transport writers need no
health wake merely because they share a table.

- `tool-access.ts`: direct create/update, examples, gallery install/finalization,
  legacy imports, application replacement/deletion, and credential configuration.
- `tool-access/connections/installs.ts` and `removal.ts`: enablement, removal,
  restore paths, existing transaction ownership and downstream cleanup.
- `tool-access/catalog/health.ts`, `publication.ts`, `discovery.ts`, and
  `aggregator-accounts.ts`: successful and failed probe/catalog results and
  eligibility changes. Health writes must move or cancel the recorded deadline.
- `tool-access/oauth/*`: access finalization, authorization start, direct/cloud/
  Vercel callbacks, client registration, grant/connection refresh, and refresh
  lease bookkeeping. Lease-only writes are not automatically health producers.
- `tool-access/token-broker/service.ts`, `tool-gateway.ts`,
  `tool-oauth-legacy-backfill.ts`, and `github-connection-events.ts`: actual-use
  health observations, credential repair, and access changes.
- Email connections/channels and Slack-search OAuth: determine which existing
  REST/MCP connection writes remain eligible for this health owner.
- Access provisioning, agent routes, smoke-lab setup, AI connection services,
  and chat provider modules: classify supported imports and shared entry points;
  do not attach unnecessary wakes to excluded AI/chat transports.
- Application type changes and company deletion: retain SQL join eligibility and
  remove stale deadlines after cascades. Instance experimental settings are an
  intentional administrative scope, distinct from ordinary tenant mutations.

Use existing transaction notifications before writes, including caller-owned
transactions. Ordinary company mutations must not activate cross-company scans.
Startup reconstruction is a separate instance-owned obligation. Process-local
hints are not a multi-replica or independent-SQL-writer protocol.

## Required verification

- Empty, disabled, archived, excluded-transport, and retained-history quietness.
- Configured eligible future check: no intervening SQL; run at the saved deadline.
- First creation/enablement and changed credentials through real service producers.
- Successful/failed manual probe and catalog/use health updates reschedule correctly.
- Disablement, deletion, and feature changes cancel or restore the proper obligation.
- Page fairness with more than 25 due rows and with an early uncheckable candidate.
- Company scope, outer commit/rollback, a commit during final reconciliation,
  drain/resume, startup reconstruction, admitted shutdown, and failure recovery.
- Keep provider calls outside transactions and avoid concurrent checks that can
  overwrite newer credentials or health observations with an old result.
- Actual query plan on representative retained history, current consumers,
  required build/type gates, and fresh PR review/checks.

## Related work

Open PRs #15448, #15325, and #11910 concern MCP failure classification and continued
usability after transient tool errors. This migration must preserve that owning
policy rather than choose new disablement behavior in the scheduler. The search
also found #14638 for AI health exclusions. Inspect exact diffs before changing
those paths; titles alone do not establish duplication or compatibility.
