# Voice maintenance sleep migration audit

Baseline: receiver parent #17572, head 643f4766227e15006b684d2cc7bea7ddd5cc2147.
Branch: codex/sleep-21-voice-session-recovery.
Status: owner audit only. No voice polling removal is implemented or verified.

## Separate the reasons before changing the timer

The app invokes `voice.reconcile()` from the remaining one-second chat lane.
The public service is created through `chat-channels/speko/runtime.ts`; the
implementation is `voice/voice-session-service.ts`. Its reconcile method hides
five distinct obligations. Each needs its own PR, preserving the others until
its producer and deadline contracts are implemented.

| Slice | Existing behavior | Proposed owner and trigger |
| --- | --- | --- |
| Live session recovery (this branch) | Reads experimental settings, scans live sessions for expiry, ending, disabled endpoints/connections, generation mismatch and 30-second active-state checks | Voice session owner; committed lifecycle/authorization changes plus real expiry, cleanup and active-call inspection deadlines |
| Reply push | `pushVoiceReplies` scans for provider delivery work | Existing reply/session records, committed source changes, pending provider delivery and claim/retry deadlines |
| Inbound admission expiry and provider cleanup | Scans guest/approval/denied/expired calls past expiresAt, inspects/ends exact provider sessions | Inbound owner; admission/lifecycle/decision changes, saved expiry and unresolved end retries |
| Inbound history retention | Deletes denied/expired/ended rows without sessionId or intakeIssueId once both expiresAt and updatedAt are seven days old | Retention owner; deadline max(expiresAt, updatedAt) + seven days, mutation invalidation and startup reconstruction |
| Call reports | Fetches reports for terminal sessions with provider IDs within 24 hours of endedAt; follows nextCheckAt backoff | Report owner; terminal/lifecycle/report events and saved report recheck deadlines, preserving late recording/transcript behavior |

Removing one invocation of the outer reconcile method would drop several owners.
First expose the live-session operation independently, register it with the
existing coordinator, and leave the other four calls in their existing lane.
The outer wrapper can disappear only after the remaining owners migrate.

## Live-session source of truth and invariants

Existing chat_voice_sessions, chat_endpoints, tool_connections, access/bindings,
and instance settings define eligibility and current authority. No new table is
needed. Current live states are reserved, creating, creation_unknown, connecting,
active and ending. Terminal states are ended, failed and expired.

The current pass uses 25 oldest updatedAt rows. A session qualifies when expired,
ending, disabled, generation-mismatched, or when a connecting/active session has
not been inspected for 30 seconds. Active-session checks validate current task,
caller and guest authority, then inspect the exact saved providerSessionId to
recover a hangup without a final browser callback. A live call is concrete work;
its bounded provider-state inspection is not empty-instance discovery.

Unknown creation remains reserved until expiresAt plus two minutes of teardown
grace. The provider maximum duration is the final bound. Never replay creation
because its response was lost. Ending retains exact provider cleanup debt until
termination is confirmed. An error records cleanup_pending and updatedAt.
Preserve these business boundaries and distinguish a database error from a real
revocation before changing recovery behavior.

An inactive instance with no live sessions must stop this owner's settings and
session queries after reconstruction. Retained terminal sessions alone must not
create a live-session deadline. Report work for those rows belongs to its own
slice and stays active under its existing contract for now.

## Required producer audit

- voice-session-store.reserve, including inbound and guest binding paths;
- service start claim, successful provider binding, unknown creation, failed
  creation, concurrent end, and failure to persist provider identity;
- closeProvider and user end; inspect and tool callbacks that change session state;
- inbound lifecycle, guest intake, approval/denial and end paths that write sessions;
- signed lifecycle callbacks and report callbacks (separate saved report debt);
- endpoint/connection pause, removal, generation or credential changes;
- feature disable, membership/access revocation, task reassignment, binding and
  environment changes used by authorizeSession;
- restart/resume and the supported single active writer contract.

Use existing transaction ownership. Add intent before the write; transaction
outcome uncertainty remains the shared database layer's responsibility. Prefer
session/endpoint/company scopes rather than refreshing all sessions per mutation.
Authorization stays with the voice store; provider requests stay with the Speko
provider. Shared scheduling consumes normalized work identities and deadlines.

## Required proof

Reproduce recurring SQL in no-session and retained-terminal-history states before
removal. Test first real session creation after quiet; nested transaction commit
and rollback; uncertain creation without duplicate provider calls; expiry/grace;
ending cleanup failure and retry; active hangup recovery; revoked membership,
changed task binding and feature disable; guest isolation; multiple-company
fairness and backlog; failed scoped reads; mutation during sweep; drain/resume;
shutdown joining admitted provider work. Keep all four adjacent obligations and
their existing tests running. Inspect `voice-session-store.integration.test.ts`
and current producer fixtures before inventing new test contracts.

The receiver parent has 218 selected passing tests, workspace typecheck/build,
and is published/attached. CI run 40173962833 is live on its exact head; Greptile,
security and Paperclip review are pending. This is not stack completion or merge
permission. The full original ledger, #17490 failure and final master
reconciliation remain required.


## Initial implementation checkpoint

Live-session recovery now has a voice-owned paged deadline reader and a scoped
coordinator worker. The periodic wrapper retains reply, inbound, and report
maintenance. Session writes signal their existing transactions; standalone service
updates use one small transaction helper. Configuration, feature-disable and
voice tool/access removal paths signal relevant scopes. Active sessions retain
30-second inspection, unknown creation retains the saved expiry plus two-minute
grace, and no call-creation action exists in recovery. Authority lookup failures
retry instead of treating an unavailable database as confirmed revocation.

Four initial actual-service cases pass: first start after quiet and retirement
on missed hangup, membership revocation, and feature disable; unknown creation
expires at its saved grace deadline without another provider call. Server types
pass after fixing the database projection of the internal runtime generation.
The startup wiring regression failed before removal. This is a checkpoint only:
full producer, lifecycle, race, backlog, and consumer evidence is still required.

Receiver #17572 has Greptile 5/5 and no failed checks, but Paperclip Review 4/5
requests suppressing rediscovery after discovery-initiated stops. Its optional
full-refresh coalescing observation will also be addressed in the owning parent
before this branch is published. Preserve all unfinished voice changes in this
commit while repairing that parent.
