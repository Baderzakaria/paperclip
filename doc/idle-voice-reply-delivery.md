# Voice reply delivery without idle polling

Phone replies wake from committed publication, reply, session, and configuration
changes. The application registers the worker with the shared delivery coordinator.
The one-second chat maintenance lane no longer calls `pushReplies`. Inbound voice
admission, report reconciliation, and other chat duties remain separate migrations.

## Durable truth and delivery boundaries

The existing voice sessions, voice replies, chat publications, and chat actions
remain authoritative. No table or migration is added. The worker reconstructs
active phone sessions and outstanding dispatch intents at startup. Notifications
are scoped hints, never permission to replay a provider action.

A reply inserted while its publication is streaming is not yet deliverable.
Both normal publication completion and operator resolution signal the endpoint
before committing its published state. Reply insertion and authorized question
retrieval signal their session before writing. The existing transaction boundary
holds notifications until outer commit and reconciles uncertain outcomes.

The dispatcher retains current authorization, session locking, ordered reply and
multipart barriers, and its atomic action claim. Provider calls remain outside
SQL transactions. An accepted receipt is distinct from spoken playback. Unknown
outcomes never authorize resending the answer or appending its remaining parts.

## Deadlines and disarming

- A ready ordered reply is immediate work; a bounded pass drains up to eight parts.
- A definitive rate limit retains its saved retry deadline.
- A dispatch without a durable receipt retains its existing strict 30-second
  uncertainty deadline. These actions are tracked independently of live sessions,
  so ending a call cannot strand its abandoned dispatch intent.
- Database or provider-path failures retain per-entry backoff. Scoped inventory
  failures retry their scope; healthy companies retain fair processing access.
- No ready reply, a presented question awaiting retrieval, accepted history, or an
  unknown/failed outcome leaves no recurring reply scan.

Live-call recovery already checks current authority before provider inspection.
Reply delivery remembers sessions denied by its authorization check. A successful
subsequent live-call authorization signals only those blocked sessions. This
preserves restoration after membership/task authority changes without adding
notifications to every authorization table or scanning healthy empty reply queues
on every live-call inspection. Startup reconstructs this in-memory state from
existing sessions. This dependency must remain explicit if active-call recovery
is changed later; a notification alone never bypasses reauthorization.

## Lifecycle and limits

The coordinator coalesces changes, serializes work, preserves dirty scopes across
failure and drain, and stops work on shutdown. Startup loads identities in pages;
processing uses fair bounded batches. Manual `pushReplies` and one-shot `reconcile`
remain available for explicit diagnostics/tests and must not become periodic lanes.

Signals cover the supported process-local database owner. Independent SQL writers
or other processes require their own notification/reconciliation contract. These
changes do not extend Cloud wake coverage, permit sleep during a live call, or
prove deployed instance/database suspension.


Both live-session recovery and reply delivery use `scoped-deadline-work.ts` for
coalescing, fair batching, scope reconstruction, retries and drain retention.
Their adapters keep domain state and provider operations in the voice owner.
The production-wiring regression covers authority returning before live recovery
observes the denial; recovery still ends calls when their authority is absent.
