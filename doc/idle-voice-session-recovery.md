# Voice session recovery without idle discovery

The live-session worker replaces the session-discovery portion of the recurring
voice maintenance call. It uses the existing delivery coordinator, transaction
signals and shared scheduler. It adds no tables or migrations. Reply delivery,
inbound admission cleanup, inbound history retention and call reports are separate
obligations; their existing maintenance remains until their own migrations land.

## Work and deadlines

Existing `chat_voice_sessions` rows are authoritative. Startup reconstructs live
sessions in UUID pages of 100, joined to their same-company endpoint and connection.
Terminal history does not create a live-session recovery obligation. With no live
sessions, the worker also avoids reading experimental settings after reconstruction.

| State | Next obligation |
| --- | --- |
| No provider identity yet | Existing `expiresAt` plus two minutes of teardown grace; no provider creation replay |
| Known provider, ending or invalidated configuration | Immediate cleanup; a recorded cleanup failure waits 30 seconds |
| Connecting or active call | Earlier of session expiry and `updatedAt + 30 seconds` for current authorization and missed-hangup inspection |
| Other live state with provider identity | Saved session expiry |
| Ended, failed or expired | No live-session work; reports have a separate owner |

Provider maximum duration remains the final bound for uncertain creation. A
late provider response can bind identity while expiry is being considered. The
expiration write requires that provider identity is still absent, so a newly
known call retains exact-call cleanup rather than being marked terminal prematurely.

Each due call is reloaded before execution. The voice store checks current
company, endpoint, credentials, caller, task, guest sandbox and binding authority.
A 403/404 means authority no longer permits the call. A transient lookup error
retains a retry; it does not authorize ending an otherwise valid call. The existing
voice service owns provider inspection and termination, including single-flight
termination and ambiguous-response confirmation. Recovery never creates a call.

## Producers and transaction ownership

| Owner | Changes that wake live-session recovery |
| --- | --- |
| `voice-session-store.ts` | Reservation, guest promotion, connecting-to-active transition and reply cursor writes that change the inspection timestamp |
| `voice-session-service.ts` | Creation claim, binding, known/unknown creation failure, user end, cleanup outcome and foreground inspection |
| `voice-inbound-service.ts` | Guest session creation, guest denial and signed terminal lifecycle callbacks |
| `voice-reply-push.ts` | Confirmed remote end and unknown delivery outcome that changes session state/timestamp |
| Chat configuration helper | Endpoint configuration, pause, reconnect, generation/credential changes, connection hints and company removal |
| Generic tool/access services | Voice connection API mutation, removal and credential revocation during access removal |
| Instance settings | Explicit chat-connector feature enable/disable |

Existing transactions register the awaited signal before the session/configuration
write. Standalone session updates use the small `withVoiceSessionChange` helper.
Provider requests remain outside database transactions. Nested writes retain outer
commit ownership, rollback does not dispatch work, and uncertain commit settlement
stays with the shared database protocol.

Membership changes, task reassignment, phone preferences and other authorization
inputs that do not mutate the session or connection remain checked on the existing
30-second active-call inspection deadline, as well as on use. This slice does not
promise instant cleanup for every authority mutation or add cross-cutting voice
hooks throughout those owners. Session activity that changes `updatedAt` retains
the existing inspection-time semantics. The session expiry is always an upper
bound for authorized active work.

The generic chat connection hint does not always carry a transport. It can cause
a bounded empty voice lookup after a chat configuration write. It does not create
idle polling or a recurring deadline. The shared helper contains only routing;
voice eligibility, authority and provider policy stay with the voice owner.

## Failure and lifecycle behavior

Refreshes coalesce by scope, with a full refresh covering already pending narrower
hints. Changes arriving during refresh remain dirty. Failed refreshes block use of
stale cached entries in that scope. Per-scope and per-call failure backoff starts
at 30 seconds and caps at five minutes. New hints do not erase failure backoff.
Batches rotate across companies, process at most 25 calls, and continue an already
due backlog after one second. A failed provider does not stall independent calls.

Drain and standby retain dirty work without passive SQL. Resume processes that
work, and restart reconstructs deadlines from the rows. Shutdown joins admitted
provider work and removes the coordinator's subscriptions and timers. Retained
terminal history becomes quiet after any already committed hints settle.

Process-local signals support the existing single active database writer and its
shared clients. Independent SQL writers or another replica need an explicit wake
contract. This change neither expands Cloud alarm coverage nor relaxes sleep
eligibility. Active calls and their real deadlines remain obligations; local worker
quiet is not proof of host suspension or fleet savings.

## Verification

The voice integration suite exercises actual service producers, guest intake,
signed callbacks, current authority, unknown creation and adjacent reply/report
behavior. The recovery-owner suite uses real PostgreSQL and controlled provider
operations for outer commit/rollback, drain, restart, scope failure, mutation during
refresh, paging, company fairness, shutdown and the late-provider-binding race.
The latter race failed before the write-time guard and passes afterward.

The dated audit records exact commands, results, initial fixture failures and
remaining acceptance work: [voice migration audit](plans/2026-10-25-voice-maintenance-sleep-audit.md).
