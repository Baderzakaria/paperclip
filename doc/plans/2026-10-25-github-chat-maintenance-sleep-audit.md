# Remaining GitHub chat maintenance owners

Inspected after slice 33 at `6d01f4c730aed91e660a63eede688f4f4da61252`.
No implementation or verification claim yet.

The label "GitHub history maintenance" hides several separate duties.
`chat-channels/github/maintenance.ts` serially calls response-comment
`processPending`, then review-check `processPending`. It launches through the
chat service's tracked message-processing lifecycle, with a single-flight flag.
Do not replace that tracked work with an unjoined promise or shared-provider code.

## Candidate slice 34: response-comment acknowledgement dispatch

Owner: `chat-github-response-comments.ts`. Existing durable actions have
kind `github_response_comment`. `stageResponse` inserts status received before
competing for the repository publication lease, so contention does not lose work.
It is called both by acknowledgement and `writeGitHubResponseComment`, including
agent-authored/final response paths. Insertion currently uses a root client;
notification must be in a transaction around the actual write. Repeated calls
also read the existing action, and must not repeatedly wake themselves solely
because an insert lost onConflictDoNothing.

The first half of `processPending` selects received actions and failed actions
with result.retryable=true whose saved retryAt is due, oldest-created first,
limit 10. `tryAcknowledge` records attempts and exponential retryAt capped at
five minutes; existing policy stops automatic retries after eight attempts.
403 authorization changes cancel the action. Preserve that current policy,
company/endpoint/principal authority, generation fencing, and lease ownership.
Do not infer successful delivery from a missing row or an SDK return alone.

Acknowledgement can deliberately defer to a fast response while its request or
publication is pending/running/streaming, or until its saved expiresAt. Published
or ambiguous fast responses supersede the ordinary acknowledgement without
another send. A worker cannot simply repeatedly run every received action with
now+backoff: park behind committed fast-response/publication state and retain
only the real expiration/recovery obligation. Inspect all those producers.

Provider history scanning is bounded at 100 pages of 100 comments and fails
closed if identity cannot safely be recovered. Preserve App-owned markers,
shared pull-response targets, legacy placeholder retirement, no-regression final
receipts, and uncertain-post handling. Provider details stay in this owner.

## Separate reason: terminal response reconciliation

The second half of response `processPending` scans processed actions with
result.final != true. It joins conversation/endpoint/issue and latest terminal
run for the assigned agent, with blocked-issue or source-message provenance
conditions. Acknowledgement completion is not final-response completion.
Run transitions, issue changes, source linkage, response/publication settlement,
and fast-response changes can affect eligibility. Current milestone notifications
may provide an existing boundary but require a full writer audit.

`acknowledge` preserves source-run/active-identity checks and defers while
`githubRunReplyState` is unsettled. A successful final reply may require retiring
an older placeholder rather than posting a second reply. Existing no-op maintenance
writes updatedAt only to rotate oldest-prefix candidates; removing that polling
must replace starvation handling without manufacturing permanent writes.
Waiting for a nonterminal run is passive, while unresolved actual delivery still
needs owned recovery. Keep this independently reviewable from initial dispatch.

## Separate reason: GitHub review-check publication

Owner: `chat-github-checks.ts`, kind `github_review_check`. Enqueue comes from
webhook-events and chat-github-reviews. It snapshots runtime generation and
normalized review event. Delivery derives queued/running/completed state from
review, run, inbound delivery, assessment and current configuration. Existing
repository publication leases and GitHub head/authority checks remain mandatory.
A terminal assessment has its own outbox; ordinary check delivery marks itself
processed when that assessment owns the result. Never dispatch agents here.

Nonterminal success currently saves received plus retryAt=now+5s, even if
nothing changed. Replace that state discovery with producer events. Failed
publication has saved exponential retryAt and the existing eight-attempt policy.
Investigate stale-head discovery: an external PR push must have a supported
webhook/replay contract or a scoped outstanding-check reconciliation deadline.
Do not remove its only fallback on assumption that local run events cover it.

## Separate reason: late review projection repair

Before dispatch, check processPending globally updates queued/running review
rows without assessments when a matching cancelled stale-head check receipt
exists. This repairs admission that commits after cancellation. Both writers
must signal it; late review insert and cancellation are separate commits.
Extract this duty from publication dispatch rather than keep a global update
on every check wake. Preserve exact company/endpoint/delivery/event identity.

All four duties still need real producer tests, startup reconstruction, scoped
fair progress, rollback/commit, drain/resume, and quiet retained-history tests.
The aggregate maintenance call cannot be retired until every duty is covered.

## Additional producer/dependency evidence

Response writes also enter from `chat-github-reviews.ts` (agent comment/update
and assessment paths), `chat-channels/publications/transport.ts` (failed-run
publication), and `github/wake-authority.ts` after inbound admission. The
`tryAcknowledge` boundary classifies current authority failures as cancellation;
it does not silently return null for a missing source. Preserve that distinction.

Fast-response insertion already signals `DELIVERY_QUEUES.fastResponse` through
`fast-responses.ts`, but that notification currently has no scope and later
request-state transitions need their own audit. Publication notifications carry
optional issue scope only on relevant writers; not every publication mutation
currently fans out to milestones. A future acknowledgement worker must cover
both request and publication transitions without importing GitHub policy into
these shared services. The concrete cross-owner capability is notification of
a change to an existing response slot, not a GitHub-specific scheduler branch.

Existing integration fixtures and regression tests are in the early GitHub
section of `chat-channels.integration.test.ts` (around lines 2,750-6,200 in this
revision); there are no standalone response-comment or check suites at the
initial guessed filenames. Reuse the controlled provider API and real DB
fixtures rather than replace authority/lease operations with mocks.

## Design constraints refined during slice 33 acceptance

Keep initial acknowledgement dispatch separate from terminal-response recovery.
The public/manual `processPending` can delegate to both, while recurring
maintenance calls only the terminal half until its own later migration.

The repository publication lease already releases through a transaction and
signals `chatGitHubPublications`. A new acknowledgement worker must not register
a second worker under that occupied topic. It needs its own topic and narrowly
scoped lease-release hints or a shared response-availability notification.
Lost/contended lease acquisition returns undefined; that is not proof of a
successful acknowledgement. Represent the actual outstanding lease expiry and
react to release. Renewals are active-operation work, not idle polling.

Avoid a self-wake loop: `stageResponse` is called repeatedly while acknowledging
an existing action. A no-op insert/read must not repeatedly trigger dispatch of
that same received action. A received action waiting on fast-response publication
needs either the saved fast-response expiry, publication outcome changes, or
concrete unresolved claim recovery. Never return now indefinitely for it.

Most ordinary publication terminal writers already supply company/issue scope to
`notifyChatPublicationWork`; provider retry/unknown and stale-stream quarantine
paths sometimes omit it. Specifically inspect `publications/failures.ts`,
`worker.ts::settlePublicationPreparationFailure`, and queue quarantine. A fast
response that changes streaming -> retry/unknown must release/reclassify the
acknowledgement's wait. Do not depend solely on succeeded publication events.

Fast-response state writers include enqueue, skip, settle, claim, publication
comment binding, supersede, final publication-status suppression, and bulk expiry.
Only changes to the actual acknowledgement predicate require a wake. Expiry is
already a saved deadline; claim pending -> running keeps the same predicate.
Early failure/skip and adding a publication binding require producer coverage.
Do not blindly wrap every write or introduce GitHub branches in fast-responses.
Use a normalized response-slot change contract if these shared owners need a
new notification capability, with existing transactions reused wherever present.
