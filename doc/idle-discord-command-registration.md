# Discord command registration while idle

Command registration uses the shared delivery coordinator and existing saved
registration deadlines. It no longer runs as a side effect of the recurring
Gateway runtime reconciliation. Foreground configure and resume still attempt
registration immediately under their existing credential lease.

## Existing obligations and authority

The registration store owns `chat_actions` records of kind
`discord_command_registration`. The existing `chat_discord_command_owners` table
retains the application namespace owner even after endpoint or company deletion.
No table, trigger, listener connection, or private timer is added.

A valid successful receipt has a five-minute remote verification deadline. Other
saved outcomes retain their existing retryAt, including Retry-After. An indefinite
retry remains parked. A genuinely unowned namespace is immediately due. Invalid
receipts, foreign owners, and orphaned ownership tombstones do not become new
registration work. The deadline reader is only a hint; the existing protocol still
checks authority, generation, credentials, identity, and receipt state before
provider operations and commits. An uncertain create is recovered by reading
remote state, never by blindly repeating a create.

Eligible endpoints are Discord, verifying/active/attention, with an active enabled
connection and a known bot/application ID and guild ID. Attention plus failed
connection health remains excluded. These are the old runtime discovery filters;
company status and unrelated endpoint metadata do not add new policy.

## Scheduling and lifecycle

Startup reconstructs eligible state in UUID keyset pages of 100. Committed hints
refresh only the affected endpoint, connection, or deleted company. Refresh and
retry passes have a 30-second minimum spacing. There is no periodic inventory
scan after all hints settle. Due dispatch rechecks persisted eligibility and the
saved deadline, invokes the command owner, and reloads its durable result.

Each pass admits at most 25 commands, taking turns across companies and preserving
oldest-first order within each company. A company cursor rotates between passes,
including when more companies are due than fit in one pass. A failed or no-progress
attempt backs off from 30 seconds to five minutes; a future stored deadline wins.
A returned promise alone does not prove registration settled.

Dirty scopes received during work remain pending. Drain and warm standby retain
requests without passive SQL. Discovery checks cancellation between rows/pages.
Shutdown stops the coordinator before the chat service and joins an already
admitted provider operation through settlement. A local Gateway is refreshed
through its existing owner after command work; command failure does not replace
or tear down a healthy listener.

## Producer coverage

| Producer | Wake contract |
| --- | --- |
| Registration store | Register intent before initial owner/action insert, state/receipt transitions, and retry-result updates in their existing transaction |
| Configure, reconnect, resume, pause, remove | Existing endpoint-work helper now also signals command scheduling by connection ID |
| Setup test completion | The same endpoint-work helper covers activation |
| Credential reference publication/removal | Signal before binding and reference writes, while retaining the credential lease |
| Gateway connecting, ready, availability and failure callbacks | Scoped endpoint signal when health/status can change eligibility; existing runtime generation fences remain |
| Provider availability reconciliation | Signal available/restored and disabled/removed endpoints |
| Provider-effect, publication and interaction failures | Signal before endpoint attention and failed-health writes |
| Accepted inbound task mutation | Signal the endpoint before its status/connection activation writes; message metadata-only writers stay exempt |
| Generic tool connection API | Existing chat connection transaction helper covers enable/disable and credential/configuration changes |
| Generic connection removal | Signal the SDK connection before archival |
| Generic manual health observation | Chat-owned dispatcher signals SDK connections; other transports do not wake this worker |
| Membership/credential revocation | SDK connections signal before reference removal or disablement |
| Company deletion | Signal the company before the company cascade; namespace tombstones survive |

Draft endpoint creation has no eligible identity and waits for configuration.
Endpoint display names, reach preferences, resource metadata, publication/event
timestamps, and capability-only runtime projection do not create a registration
obligation. Other providers' setup, OAuth, and registration protocols do not
become Discord work. Direct SQL and independent writers still require explicit
wake integration; process-local hints are not cross-replica notification delivery.

## Verification and limits

Selected local verification covers 38 real-PostgreSQL protocol/lifecycle cases,
three fair-batch cases, 91 Discord integration cases, 487 tool-access/access
consumers, and 20 chat-worker/startup consumers: 639 unique tests. Workspace
typechecking and build pass; the final small fairness addition also receives
server type/build verification before publication. The full local `pnpm test:run`
is not claimed: embedded PostgreSQL is unavailable on this host. Remote CI must
complete the full matrix before acceptance.

The large-backlog fairness regression failed before selection was repaired.
Other observed failures were fixture issues: duplicate live-bot IDs, uncertain
transactions retained by prior fault tests, installing a fake clock after creating
a real timer, pausing a connection still in setup, and removing a fixture twice.
Repeated broad runs on a reused database also found an unchanged hard-coded bot
ID and a global comment-body assertion reading earlier fixtures. The final broad
Discord run uses a fresh schema-only disposable database and passes all 91 cases;
production constraints and the unrelated assertions were not relaxed. See the
[dated audit](plans/2026-10-25-discord-command-registration-sleep-audit.md).

This migration proves the command worker's quiet periods. Runtime inventory,
receipt-to-runtime projection, active Gateway lease renewal, persistent sockets,
voice, Teams, and other chat maintenance remain separate obligations. The remaining
runtime poll can still read command receipts; it no longer initiates command
registration or remote verification. Cloud sleep eligibility and durable alarm
coverage are unchanged. A timer in this process cannot wake a stopped host.
