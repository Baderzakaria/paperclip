# Direct GitHub webhook recovery scheduling

Parent: slice 37 at `0a25cae9ef10a8714801d72ac798823de335e050`.
Branch: `codex/sleep-38-github-webhook-recovery`.
Inspected mainline: `5a28f7acf8` (2026-10-25). Final stack reconciliation is
still required; this slice does not incorporate every subsequent master change.

## Obligation and stop condition

A failed GitHub callback can leave no local inbox row. Direct App integrations
therefore require the existing bounded external history reconciliation. This is
an explicit exception to event-only dispatch, not proof that configured direct
GitHub endpoints become network-idle. Cloud relay registrations are excluded:
Cloud owns their transport retry. No eligible direct endpoints, including an
instance with only Cloud registrations or disabled endpoints, means no recurring
SQL or HTTP from this worker after reconstruction and notification settlement.

Previously the app called the due-endpoint selector every second. This slice
reconstructs deadlines at startup, reloads affected scopes on committed changes,
and dispatches only at those deadlines. It removes the final production chat
reconciliation interval and its unused lane coordinator. Other existing chat
workers remain independently registered with the delivery coordinator.

Durability already exists:

- `chat_sdk_state`, key `paperclip:github-webhook-recovery:v1`, stores the
  versioned runtime epoch, App identity, callback URL, floor, and `nextScanAt`.
- `chat_actions` recovery receipts store immutable source fences, attempts,
  cancellation decisions, and unknown transport outcomes.
- The genuine authenticated GitHub callback owns inbox admission. Provider
  history is never admitted directly or transformed into a locally signed event.

No table, migration, Cloud alarm, or host-sleep exemption is added.

## Ownership and policy

State parsing, eligible endpoint selection, credential fingerprint comparison,
recovery execution, and notification scopes stay under `chat-channels/github/`.
The existing recovery owner retains signature, current authority, source-body,
resource, runtime-generation, lease, and claim-version checks. Recovery I/O stays
outside database transactions. A small provider-owned checkpoint transaction
notifies before its existing compare-and-set; generic SDK persistence does not
learn the meaning of GitHub keys.

The per-endpoint recovery core is shared by the explicit/manual bounded API and
the worker. The worker independently reloads current eligibility and epoch before
execution. It does not call the manual selector with cached early deadlines:
that selector's legacy due predicate does not detect credential-only epoch
changes. The worker recognizes those changes immediately, even during a saved
24-hour backoff, and establishes a new floor without adopting historical events.

Preserved policy:

- One-minute normal external reconciliation; five-minute claim and failure
  backoff; bounded provider rate-limit backoff up to one day.
- One-hour lookback, three provider-history pages, five inspected eligible
  envelopes per endpoint, and three maximum redelivery attempts.
- Successful sibling deliveries suppress replay. Ambiguous redelivery outcomes
  remain durable and are not blindly retried without a distinct failed attempt.
- Five endpoints per dispatch batch, fairly rotated between companies.

The shared scoped-deadline helper gains only an optional batch limit. Its default
remains 25 for every existing caller. It still owns no provider SQL or policy.
The new owner loads at most 100 rows per query and retains all pages' deadlines;
it does not silently discard endpoints after the first page.

Every recovery HTTP call checks dispatch admission and the worker abort signal
before starting. A call already in flight keeps the existing bounded provider
request timeout and is joined during shutdown. Its result/uncertainty settlement
may finish; stopping does not erase a committed attempt. Other registered queues
continue while a provider call is held. Drain and standby preserve dirty scopes,
failed reconstruction, and saved deadlines without passive SQL.

## Producer inventory

| Owner | Mutation and notification |
| --- | --- |
| `configuration.ts` | Configure/reconnect, pause, resume, removal and failure paths already call `notifyChatEndpointWork` in their owned transactions; that now includes the connection-scoped GitHub topic. |
| `setup-probes.ts` and chat task admission | Successful activation already notifies through `notifyChatEndpointWork` or endpoint configuration. |
| `credentials.ts` | Credential reference replacement and clearing notify endpoint configuration before writes. |
| `resource-reconciliation.ts`, `provider-effects.ts`, interaction callbacks and publication failures | Eligibility/status changes use existing configuration notifications. |
| `github/installation-lifecycle.ts` | New explicit endpoint notification precedes revocation, legacy identity upgrade, runtime generation/availability settlement, and failed-inventory transitions. |
| `chat-github-wizard.ts` | Setting `cloudRegistrationId` now notifies inside its short owned setup transaction; unrelated wizard metadata does not signal this worker. |
| `github/webhook-ingress.ts` | Claim and final recovery-window CAS writes notify before writing, including manual recovery. |
| Tool connection configuration/health and company deletion | Existing connection/company notification fan-out now carries this topic; removal invalidates cached deadlines. |
| `github/app-setup.ts` | Initial identity claim is restricted to incomplete setup; later credential persistence and activation are covered. Stage/management URL metadata alone does not change recovery eligibility. |
| Webhook authentication, ordinary activity, review settings, endpoint display/task settings | Do not change recovery eligibility, runtime epoch, callback origin, or recovery checkpoint; no added signal. |

Supported writes share the database owner's process-local transaction signals.
Independent SQL writers and another server process need a separate integration;
this change does not claim they are observed. Nested savepoints still settle at
the outer transaction. Unknown transaction outcomes retain the shared intent
hold until the database protocol resolves them.

The callback base URL comes from configured startup URLs or the live canonical
Cloud identity. `applyCloudRuntimeIdentityAssertion` allows one durable claim
and identical retries, and rejects replacement with another assertion. Warm
standby defers reconstruction until admission opens, so the worker sees the
claimed identity. Ordinary self-hosted URL configuration changes restart the
process. No permanent URL-discovery poll is introduced.

## Evidence and retained failures

- Initial server typecheck passed (`/tmp/sleep38-first-types.log`).
- First selection: 27 passed, four failed (`/tmp/sleep38-worker-first.log`).
  One assertion confused a numeric scheduler deadline with a Date. Two lifecycle
  cases created real timers before installing fake timers. The resume fixture
  forced active status without complete setup. Corrected fixture/clock ownership;
  no production timing change. All 31 selected cases then passed in 15.87 seconds
  (`/tmp/sleep38-worker-fixed.log`).
- The first installation producer test passed while startup checkpoint signals
  were still pending. Waiting for their actual future deadline exposed the missing
  notification: deletion left the deadline armed. This regression failed in
  `/tmp/sleep38-lifecycle-settled-regression.log` before the lifecycle writer fix.
  It now passes through real signed deletion and reinstall behavior.
- Wired acceptance passed all integration cases but failed two obsolete source
  assertions about the removed timer. Updated them to assert shared worker
  registration and absence of the coordinator/interval.
- Final bounded selection: 41 passed in 26.55 seconds
  (`/tmp/sleep38-bounded-tests.log`). Includes quiet unconfigured/Cloud/disabled
  states, no SQL before a saved deadline, real callback-only admission, real
  resume/pause, restart/drain/standby, nested rollback/outer commit, credential-only
  epoch change, reconstruction failure across drain, held HTTP with independent
  queue progress and joined shutdown, 106 deadlines across companies with an
  initial five-item batch, and the prior review-projection default-batch consumer.
  The backlog fixture then replaced timing-derived App IDs with random identities
  to avoid a possible fixture uniqueness collision; final acceptance follows.
- Final workspace typecheck and build pass (`/tmp/sleep38-workspace-types.log`
  and `/tmp/sleep38-workspace-build.log`). Voice session/retention acceptance
  passes all 122 cases in 26.48 seconds (`/tmp/sleep38-voice.log`). Complete chat
  acceptance and remote CI/review remain required. This is not a full-stack
  readiness claim.

## Review repair: a claimed redelivery that never reached transport

Greptile identified a valid P1 at initial head `936e132c01`: drain/shutdown
could start after the recovery receipt committed and before the POST began.
The guard correctly prevented HTTP, but the catch marked the receipt uncertain,
and the next scan refused that same failed delivery. Four real-PostgreSQL cases
reproduced the lost callback for drain/shutdown with both a first claim and a
previous receipt (`/tmp/sleep38-unsent-regression.log`, four failures).

The owner now distinguishes transport admission from a persisted claim. If the
request did not start, it restores the prior receipt or removes the new receipt
inside a short notifying transaction. If transport may have started, it retains
`delivery_unknown`. Settlement and restoration use the exact attempt identity
(id, processing status, count, provider delivery, and requested timestamp), so
an older attempt cannot overwrite a successor. Lease failure before HTTP follows
the same known-unsent path. Neither database transactions nor the provider POST
are replayed automatically. A crash between commit and transport, or failure to
persist restoration, still requires conservative durable uncertainty handling.

- Server typecheck and 59 selected integration/publication/startup cases passed
  after the repair (`/tmp/sleep38-unsent-types.log`,
  `/tmp/sleep38-unsent-fixed.log`, 28.91 seconds).
- Two additional cases replace the receipt timestamp while preserving its
  processing status and attempt count. All six stop-before-transport cases pass;
  restoration leaves the newer receipt intact and restart does not replay it
  (`/tmp/sleep38-unsent-cas.log`, 10.27 seconds).
- The initial full command passed 1,586 tests across two files in 571.36 seconds
  (`/tmp/sleep38-full-chat.log`). It misspelled the standalone publication suite
  filename, so it did not run that suite and is not three-suite acceptance.
  The corrected complete command includes `chat-interaction-publications.test.ts`.
- Final workspace typecheck/build passed. Corrected three-suite acceptance on
  `paperclip_sleep38_final_20261025_1837_test` passed 1,605 cases and failed one
  resume timing assertion in 571.32 seconds (`/tmp/sleep38-final-chat.log`).
  The test observed the newly committed checkpoint before `check` reloaded its
  deadline and the coordinator scheduled it. It now waits for idle tracking to
  settle and a deadline more than 30 seconds in the future, then verifies pause
  disarms it. Production code is unchanged by this assertion repair.
- All 37 selected lifecycle/publication/startup cases pass with that assertion
  (`/tmp/sleep38-settlement-fixed.log`, 23.10 seconds). This is focused repair
  evidence, not a claim that the earlier full run passed. The latest commit still
  requires all remote CI and fresh review. The production repair at `491a7e1eef`
  received Greptile 5/5 and its P1 thread is resolved.

## Remaining boundaries

The idle-safety proof still blocks unsupported active channel obligations. A
registered in-process timer is not an acknowledged Cloud alarm and cannot wake a
suspended host. These tests establish worker behavior, not provider suspension or
fleet savings. GitHub connection discovery/replay, credential continuity, and
merged-PR confirmation are separate remaining duties.

All earlier stack CI/review findings, remaining original inventory items, final
master reconciliation, and each latest-head PR gate remain required. No merge is
authorized or performed by this migration stack.
