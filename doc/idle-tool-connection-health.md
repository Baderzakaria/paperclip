# Tool connection health while idle

The health worker replaces the aggregate maintenance tick's repeated connection
inventory query. It preserves the existing 15-minute proactive health interval
for eligible connections. This is a deadline migration, not removal of proactive
health checks or proof of host suspension.

## Ownership and lifetime

`tool-access/catalog/health-schedule.ts` owns eligibility and saved deadlines.
The existing health and catalog services still own provider behavior. The worker
uses the shared delivery coordinator for admission, wake coalescing, retry,
drain/resume, and shutdown. Startup reconstructs eligible deadlines from existing
connection rows. No new table, polling listener, or private interval is added.

Eligible rows are active and enabled, excluding `chat_sdk`, `runtime_auth`, and
applications of type `paperclip_plugin`. Disabled experimental connectors have
no deadline until the settings producer enables them. Application status and
company status are not new filters: this migration preserves the old policy.

An unchecked row is due immediately. Otherwise its deadline is `healthCheckedAt`
plus 15 minutes. A company hint refreshes that company's cache. Startup and an
instance feature-settings change can refresh the whole instance. Refreshes are
coalesced with a 30-second minimum spacing. There is no scheduled refresh when
there are no eligible rows or unresolved changes. Future checks cause no SQL
before their deadline. Each pass checks at most 25 due connections, taking turns
across companies and preserving due order within each company. The company cursor
rotates across passes when more companies are due than fit in one batch.

Before a provider check, the service reloads current eligibility and deadline.
A saved health result, including a failed health observation, owns the next
15-minute deadline. A check that cannot persist an observation retains recovery
debt with exponential backoff from 30 seconds to 15 minutes. A failed company
refresh does not prevent another company's checks. Dirty scopes arriving during
a refresh remain pending. Drain retains them without passive database reads.
Shutdown joins admitted work; it does not abandon a provider call midway.

## Producer coverage

| Owner | Scheduling change |
| --- | --- |
| Tool access API and examples | Create, enable/disable, reconfigure, revive, or restore a connection; setup grants, credential bindings, and runtime slots commit before a creation wake |
| Gallery setup and failure handling | Activation, temporary quarantine, failed-identity restoration, and failed setup deletion |
| OAuth callbacks and finalization | Direct, Cloud, Vercel, and personal/shared activation; reauthorization-required disablement |
| Connection removal | Archive and disable in the owning transaction |
| Health/catalog publication | Successful or failed saved health observation moves the deadline |
| Gateway actual use | Saved remote connection health moves the deadline |
| GitHub installation events | Health observation commits with the installation-event transaction |
| Email setup/control/health | REST connection activation, pause/resume/removal, successful receipt health, and failed health observations |
| Shared chat lifecycle | Voice health activation, setup, pause/resume/removal, resource reconciliation, inbound activation, and failure observations; SDK-only chat mutations do not wake this worker |
| Access removal | Losing the last applicable credential grant disables the connection |
| Smoke Lab | Connection setup and fixture health updates |
| Company deletion | Removes cached deadlines after cascading deletion commits |
| Instance settings | Experimental connector eligibility changes use an administrative all-company hint |

Notifications are awaited before the relevant SQL write. Existing transactions
remain the owner; standalone mutations use the same small transaction helper.
Nested calls retain the shared database client's outer-commit, rollback, and
uncertain-outcome protocol. Provider requests are outside newly added
transactions. The health worker never interprets provider protocols.

Credential-only refresh, refresh lease acquisition/release, client registration,
OAuth authorization-start metadata, legacy credential repair, Slack-search OAuth,
aggregator account metadata, and install markers do not change health eligibility
or `healthCheckedAt`. They do not gain health notifications. A due probe reads
current credentials. AI writers use the excluded runtime-auth transport.
Application display/status updates do not change the old health eligibility.
Application deletion refuses linked connections; company cascade is covered.
New draft-only connections remain ineligible until their activation producer.

## Limits

The supported live writer model is this server's instrumented services. Offline
restore is reconstructed at startup. Independent SQL writers and other replicas
need their own wake integration; process-local hints do not cover them.

Existing manual health checks and catalog operations can overlap. This migration
does not introduce a credential-version CAS or change provider failure policy.
The scheduled worker itself is non-overlapping and rechecks the current row before
probing. A naive `updatedAt` CAS would reject a health check's own catalog writes.
Voice remains eligible under the old sweep's policy even though its generic
health probe can report an unsupported transport. Changing that policy belongs
to the voice owner, separately from this scheduling migration.

The Cloud sleep-safety proof is unchanged. An in-process deadline cannot wake
stopped compute; unsupported external wake obligations remain blockers.

## Verification in progress

The original startup regression showed repeated idle health sweeps. It now proves
one scheduled-worker reconstruction and no health inventory work from aggregate
ticks. Seventeen real-PostgreSQL lifecycle tests pass: empty/configured quiet,
excluded transports, first writes, nested commit/rollback, drain/resume, saved
observations, restart, page progress, real API activation/disable/archive,
company failure isolation, feature toggles, company deletion, voice activation,
concurrent producer writes, failed persistence, and admitted shutdown.

The first consumer run passed 514 cases and failed a rollback fault fixture tied
to transaction call order. The fixture now rejects the actual restoration update
with a PostgreSQL trigger. All 515 startup/tool-access cases pass afterward.
Another 163 gateway/settings cases pass. Server typechecking passes after fixing
two mutable values captured by transaction callbacks. Additional producer/chat
consumers, query-plan inspection, build, and remote review/checks remain pending.

An initial additional-consumer command ran before its external-database fixture
patch applied: embedded PostgreSQL failed to start and 72 tests were skipped.
That run is not passing evidence. The corrected run uses validated disposable
PostgreSQL databases; results will be recorded before PR acceptance.

The corrected producer run first passed all 44 email cases but contaminated the
other suites with shared fixture rows, causing foreign-key cleanup failures.
Separate freshly initialized databases preserve each suite's original isolation;
all 72 access/email/GitHub/smoke-lab cases then pass. Three selected chat credential
and pause cases pass; 1,414 deselected cases are not counted as passing coverage.
The producer mapping/voice wake contract is covered by the health lifecycle test.
Server build passes. The scoped inventory SQL with 40,000 archived and 10 active
rows uses `tool_connections_company_enabled_idx`, 13 shared buffer hits, and
0.022 ms execution; the diagnostic data was rolled back. No new index is needed
for this observed query. The local passing selection totals 770 distinct tests.
Full workspace and remote acceptance gates remain required.

Review repair: a controlled 503 probe persisted its failed health observation,
but the warning regression failed before the fix. Scheduled probe failures now
log company/connection identifiers and a fixed message, without provider prose.
The saved 15-minute deadline still controls the next check. All 64 health/startup
cases and server typechecking pass after repair; total selected coverage is now
771 unique tests. Fresh remote gates are required for this repair.


Review follow-up: fair round-robin company batching replaces the global oldest-25
selection. The two-company regression failed before the repair; 19 health-worker
and three shared batching cases pass afterward. Each probe's pre/post eligibility
query already includes the connection ID, so those indexed current-state checks
remain. A scheduled observation still emits the normal transaction signal and
may cause one coalesced company refresh; this deliberately preserves uncertainty
and concurrent-writer recovery rather than introducing a silent-write exception.

The real-service producer suite now proves AgentMail activation triggers its first
health probe, pause cancels the next deadline, GitHub installation events update
the cached deadline, and member removal cancels a personal connection's deadline.
The GitHub newer-access branch retains its old health deadline, as intended.
These tests use the actual coordinator, transaction notifications, schedule query,
and service mutations; AgentMail also runs the actual health service against its
controlled provider. Subsequent idle windows assert no SQL.

The first run exposed two incorrect fixture expectations: AgentMail setup leaves
healthCheckedAt null until its first probe, and a stale GitHub installation event
does not overwrite a newer access refresh. The tests now preserve those policies.
A targeted rerun reused AgentMail's retained fixture user and failed setup with a
duplicate key; a fresh disposable database fixes that isolation issue without
changing application behavior or weakening assertions. All 66 access/email/GitHub
cases pass on the final run. Server typecheck/build pass. Cumulative selected
coverage is 776 unique tests; full-suite and fresh remote review/checks remain
acceptance gates. No whole-instance sleep or provider suspension is claimed.
