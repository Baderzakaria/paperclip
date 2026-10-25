# Voice reply delivery sleep migration audit

Parent: live-session recovery #17576 at 8f5e861dbd6ea5c2b45684dff970ea27723a84cb.
Branch: codex/sleep-22-voice-reply-delivery.
Status: owner audit and implementation in progress; recurring reply scan remains.

## Obligation

`voice-session-service.reconcileMaintenance` invokes `pushReplies` every chat tick.
The reply owner first reads settings, quarantines dispatch intents older than 30
seconds, and scans up to 25 active phone sessions. Each session can dispatch up to
eight chunks. A live phone call with no published reply still repeats this work.
Browser calls retrieve updates through their own request path and do not use push.

Existing `chat_voice_replies`, `chat_publications`, `chat_voice_sessions` and
`chat_actions` are the durable truth. The action kind `speko_voice_reply_push`
records per-chunk dispatch and outcome. No new queue table is needed. Use one
coordinator worker for this delivery obligation, preserving the existing ledger,
provider authority, multipart ordering and uncertainty policy.

## Policy that must not be duplicated or weakened

- Only active, unexpired phone sessions can receive proactive speech.
- The first eligible published undelivered reply controls ordering. An empty text
  or blocked earlier reply must not be silently skipped to speak later answers.
- Synthetic progress is excluded unless it carries an authorized question.
- A question notification is a barrier until authorized get_updates marks the
  reply presented. Accepted notification is not permission to speak later replies.
- Multipart acceptance is recorded per part. A changed publication digest cannot
  append a different suffix to a partly delivered answer.
- A dispatching/unknown outcome is never permission to resend. A dispatch intent
  becomes unknown only at its existing 30-second stale threshold. A known 429
  retries at its saved retryAt. Failed or uncertain historical actions alone must
  not create repeated empty delivery scans.
- Accepted by the provider is not spoken playback. Preserve both distinctions.
- Session authorization remains before claim and immediately before provider I/O.
  Do not move provider calls inside the transaction or invent a second claim owner.

Extract the existing multipart decision into a voice-owned pure policy before
implementing deadline selection. The dispatcher and scheduler must share that
policy rather than reproduce partially overlapping JSON/status predicates.

## Producers and the publication timing gap

The Speko publication transport calls `enqueuePublication` while the publication
can still be streaming. It schedules a direct `pushReplies`, then the publication
worker commits `state = published`. Therefore signaling only the reply insertion
is insufficient: that wake can run before publication settlement and miss the
reply becoming deliverable. Signal the published-state write in its transaction,
with a normalized voice publication scope routed by the owning transport/service
boundary. Audit the resolution/recovery published-state writer as well.

Other producers are live phone-session creation/promotion, missed-reply collection,
reply retrieval/presentation, explicit repeat, session termination, action claim,
retry/unknown/accepted settlement, and feature/configuration changes. Browser
retrieval may unblock the next phone reply and needs a committed hint. Startup
must reconstruct both deliverable replies and abandoned dispatch intents, including
intents for sessions that are already terminal. Prior-call delivery barriers and
missed-publication catch-up must remain with their existing voice-store owner.

## Required lifecycle and acceptance

The worker must become quiet for no sessions, active calls with no replies,
terminal history, accepted speech, unknown/failed outcomes and presented question
barriers. It must wake from each supported producer, retain exact retry/claim
expiry deadlines, and preserve changes during refresh/drain. Verify transaction
rollback/outer commit, restart, unfair backlogs, failures and shutdown joins with
real PostgreSQL and controlled provider operations.

Keep live-session recovery, inbound admission cleanup, inbound history retention
and call reports separate. Do not remove the outer maintenance call until each
remaining reason has migrated. Keep manual push entry points compatible where
needed, but route normal committed work through the coordinator.

## Parent verification record

#17576 is published and attached. Its 837 selected tests, workspace typecheck and
build pass. CI run 40176142139 and review run 40176142016 were live at publication.
The full local test command was deliberately stopped (session 77073, exit 143)
after repeated embedded PostgreSQL initialization failures prevented suites from
executing. It is not a full local pass; the PR description records this. Affected
database suites did execute against separate disposable PostgreSQL databases.
Receiver #17572 has passing latest-head checks and Greptile 5/5 at 1604a9fcba;
its second Paperclip reviewer stopped before completion, so do not invent a fresh
completed review result. No stack PR was merged. The complete original inventory,
older #17490 failure and final master reconciliation remain outstanding.


## Initial implementation checkpoint

The existing multipart selection now lives in voice-reply-policy.ts. The dispatcher
uses that pure policy for chunk identity, digest consistency, question barriers,
retry deadlines and no-resend outcomes. Its claim, authorization and provider I/O
remain in the existing owner. Twelve selected real-database reply integration
cases and server typechecking pass after extraction. This is a foundation only:
no recurring reply scan has been removed, and no reply PR is published yet.

Next implement the shared voice reply-state reader and deadline selection, audit
all session/reply/action and published-state producers, register the worker, and
prove quiet/reactivation before retiring the recurring and direct normal dispatch
paths. Preserve the public/manual push API and all adjacent voice maintenance.
