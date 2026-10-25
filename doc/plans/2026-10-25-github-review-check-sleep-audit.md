# GitHub review-check scheduling audit

Baseline: `3d7c79c262f92563555b278d101de8240e6f011b`, parent
[#17661](https://github.com/paperclipai/paperclip/pull/17661).
Parent acceptance: 1,571 tests across complete chat, publication, and startup
suites passed in 517.41 seconds. All 53 remote checks passed on that commit;
Greptile reviewed the same head at 5/5 with no findings. The parent is unmerged.

## Scope and owner

This slice owns publication of the GitHub Review check derived from ordinary
chat admission, review binding, run state, and assessment ownership. Existing
`chat_actions.kind = github_review_check` rows remain durable truth. No new
queue table is needed. GitHub state interpretation belongs under
`chat-channels/github/`; the shared coordinator receives identifiers/deadlines.

Late stale-head projection repair is a separate duty. The manual combined
`processPending` API remains compatible. The legacy maintenance callback now
calls only `repairSupersededReviews`; removing that scan is the next slice.
Assessment publication remains owned by its existing governed outbox, including
its authorization, score, delivery receipts, and recovery guarantees.

## Actual external obligation

The old dispatcher checks the current remote PR head before publishing. A saved
nonterminal check receives a five-second `retryAt` even when its local state has
not changed. The current webhook parser accepts opened, synchronize, reopened,
and ready-for-review events, but receipt is not a proof that all future pushes
will arrive. A manual review can also exist without a new automatic admission.
This slice must not turn a missed webhook into a permanently active obsolete
check or authorize publication against an old head.

Retain the existing five-second remote-head reconciliation deadline only while
that particular check is received/nonterminal. Local state changes can make the
entry due immediately; a successful unchanged inspection does not rewrite the
provider check. Failure uses its saved exponential backoff and existing eight-
attempt exhaustion policy. Processed, cancelled, and exhausted history have no
worker deadline. This is not a claim that an active review needs no SQL/network
traffic: unresolved checks retain external reconciliation until they settle.
The startup global scan and committed scope rebuilds enumerate unfinished rows;
deadline dispatch rechecks only known entry IDs. No configuration-only timer.

## Producer and lifecycle boundary

- `githubReviewCheckService.enqueue`: automatic webhook and authorized manual
  creation use one awaited notification before insertion, inside a database
  transaction. Caller-owned/nested transaction settlement stays with `createDb`.
- `retainGitHubReviewReceipt`: task admission signals its repository/PR before
  inserting the queued review in the existing caller-owned transaction.
- `reviewForHead`: manual review insertion and binding an existing review to a
  run signal inside their short database transactions. Provider calls remain
  outside those transactions.
- Existing run/lineage and endpoint-configuration notification ownership fans
  out to the new topic by company. These hints conservatively rebuild that
  company's outstanding checks; they do not inspect completed history. Narrow
  repository/PR hints are used by check enqueue, review writes, and lease release.
- Assessment and publication receipts are serialized by the existing GitHub
  publication lease. Its transactional release wakes the affected repository/PR.
  A competing holder's saved expiry is a deadline if it dies without release.
- Delivery admission failures retain discovery through the outstanding check's
  remote reconciliation deadline. This does not claim every shared delivery
  mutation now emits a check-specific immediate signal.
- Restart reconstructs existing received/retryable-failed rows. Shared scheduling
  retains dirty scopes across drain/standby. HTTP admission is checked before each
  provider request; receipt fencing remains with the publication lease.
- Supported writers are the existing process-local database ownership boundary.
  Independent SQL writers and other replicas do not receive a new signal protocol.

Current provider-state reads preserve the prior latest-review/run selection,
legacy delivery provenance, current configuration checks, and completed-check
replacement behavior. Introducing a scheduler does not authorize changing those
product decisions or passing GitHub payloads into generic scheduling machinery.

## Evidence ledger

- Provider-state extraction: server typecheck initially found widened returned
  state literals. Explicit domain-state typing repaired the extraction.
- Three existing check/late-projection/manual-review acceptance cases passed after
  extraction. This was a targeted selection, not all GitHub coverage.
- First worker selection: 12 passed, one retry test failed. The fixture installed
  fake timers after a real 60-second timer had been armed, so fake advancement did
  not deliver that timer. Move fake timer installation before registration; keep
  the production deadline unchanged. Corrected selection pending.

Remaining acceptance: immediate producer transitions, scope/history pagination,
provider failure and drain boundaries, startup wiring, migration/index evidence,
full relevant acceptance, workspace checks, and remote PR review/CI. No deployed
host sleep, Cloud alarm coverage expansion, or fleet savings are claimed.

The corrected first selection passed all 13 cases. Expanded coverage added real
run-identity commit/rollback, a 101-row revoked prefix, and shutdown during HTTP.
It exposed a real stop-admission error: the HTTP boundary wrapped the stop as a
provider error and spent a retry attempt. Check admission in the catch boundary
as well; leave the durable action for resume. That regression then passed. The
next run passed 15 cases and failed the history fixture: fixed UUIDs collided
with intentionally retained rows from earlier tests. Use a per-fixture UUID
prefix while retaining deterministic before-candidate ordering. No database was
dropped and no production timeout was enlarged. Workspace typecheck passed
before the final shutdown guard change; final acceptance remains pending.

## Wired validation checkpoint

The fresh database selection passed 36 cases across chat integration and startup
wiring in 63.66 seconds. It includes eleven new worker cases plus selected existing
check and maintenance cases; the other 1,532 cases were filtered out. The complete
chat/publication/startup selection is now running separately in a fresh database.
Workspace typecheck and build passed after the shutdown repair.

Migration 0392 adds only `chat_actions_github_check_work_idx`, with the exact
received/retryable-failed predicate used by the worker. It uses concurrent,
idempotent creation and the existing top-level migration runner. Generation,
safety checks, application, replay, and index validity passed. Snapshot pruning
retains 0388 through 0392. A rollback-only plan inserted 10,000 processed actions
and one unfinished action; candidate selection used an index-only scan, read one
row and three shared buffers, and took 0.019 ms. This measures candidate selection,
not all provenance reads or fleet-wide performance.

The earlier source checkpoint is `219061a159`. No full local acceptance or remote
CI success is claimed for this slice until the running checks finish. Open parent
stack failures and review findings remain independent obligations; this slice does
not make the whole stack ready or authorize merging it.
