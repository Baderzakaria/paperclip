# GitHub stale-head review projection repair

Date: 2026-10-25. Parent: GitHub review-check migration #17662.

## Obligation and owner

The GitHub check dispatcher can record `cancelled/stale_head` before task
admission creates its review row. A review in `queued` or `running` with no
assessment must then become `superseded`, but only when the cancellation belongs
to that exact admitted delivery. Same PR/head alone is not enough authority.

Existing reviews, check actions, and deliveries are durable truth. This is local
projection repair, not provider reconciliation. It needs no provider HTTP,
periodic deadline, or new queue table. The GitHub provider directory owns the
predicate and repair; the shared coordinator owns coalescing, fairness, retries,
drain, startup reconstruction, and shutdown.

## Producer audit

- `githubReviewCheckService.dispatch`: stale-head cancellation commits the action.
  Signal before the action write, even if no review existed during dispatch.
- `retainGitHubReviewReceipt`: task admission inserts the automatic review in the
  caller-owned transaction. Signal before insertion, preserving outer settlement.
- `githubChatReviewService.reviewForHead`: binding an unbound automatic review can
  set it back to running. Signal before that update. Newly inserted manual review
  identities use `run:...` and cannot match an admitted delivery UUID.
- Check publication can set a review to running. Signal before that review update
  to cover an existing cancellation for its exact delivery.
- Assessment writes remove eligibility. Publication receipts/check metadata do
  not create it. Supersession removes it. Delivery authority updates preserve the
  original automatic context; task admission creates the review after the context.

## Correctness and lifecycle

Discover only matching unfinished repairs, with bounded keyset pages and shared
fair dispatch. Recheck the complete pending predicate in the UPDATE so a competing
assessment or state transition cannot be overwritten from a stale selection.
A failed selection or update retains a retry through the existing coordinator.
No pending repair means no recurring SQL. Configured endpoints, manual reviews,
assessed reviews, and settled cancellation history are passive.

Signals are process-local to a database owner and its child clients. Independent
SQL writers or another process require an explicit integration; startup rebuilds
already committed work. This does not extend Cloud wake coverage, relax idle
safety, or prove host/database suspension.

## Scope

Remove this duty from the periodic GitHub maintenance wrapper. Retire the empty
wrapper and its publication-maintenance wiring while preserving the independent
GitHub missed-webhook recovery lane. Preserve explicit/manual combined check
recovery. Other server maintenance remains in the original stack inventory.

## Evidence

Ten new real-PostgreSQL cases cover real webhook admission after cancellation,
cancellation after a held remote-head read and intervening admission, nested
receipt commit/rollback, restart/drain/standby, failed-update retry across drain,
assessment ownership under an observed PostgreSQL row-lock wait (with and
without concurrent shutdown), and 106 pending repairs plus 105 manual rows.
The existing late-projection regression still exercises the explicit recovery API.

The first selection passed eight and failed two cases. The nested-commit
assertion had the default one-second timeout, matching rather than exceeding
the shared worker's one-second coalescing interval. It now uses the established
five-second observation allowance. Warm standby correctly retains an unresolved
intent hold until reconciliation is admitted; the fixture now asserts that hold
while also proving no passive SQL. No coordinator or production delay changed.
After repair, all 20 worker/legacy/startup cases passed in 24.72 seconds and
again in 30.61 seconds after query/index changes.

Workspace typecheck and build passed before the final scalar-query refinement;
fresh acceptance for that final refinement is pending. Migration generation,
safety checks, application, replay, and index validity passed. The generated
migration adds two concurrent, idempotent indexes and retains five snapshots.

A rollback-only PostgreSQL plan seeded 10,000 each of completed reviews, manual
queued reviews, processed checks, unrelated cancelled checks, and deliveries.
The original joined EXISTS query used the receipt index only for company and
endpoint. An unrelated prefix forced 10,001 cancellation reads, 32,382 shared
buffers and about 34 ms. A nested EXISTS form was flattened into a hash scan of
retained cancellations. The final scalar receipt lookup uses all three index
keys, the delivery primary key, and the partial pending-review index: one result,
21 shared buffers, about 0.062 ms in the recorded fixture. This is a query-plan
check, not a whole-worker or fleet benchmark.

The canonical lower-case UUID guard preserves the old delivery.id::text equality:
manual run identities and noncanonical strings never matched that predicate.
CASE guards the cast even if PostgreSQL reorders predicates. The receipt lookup
is limited to one row and runs with the review's company and endpoint authority.
The candidate partial index excludes assessed, terminal, and manual history.

Final scalar-query verification: all 20 selected worker, legacy regression, and
startup tests passed in 33.62 seconds. Workspace typecheck and build passed on
the same source. Full chat/publication/startup acceptance is running in a fresh
database; its result and remote PR checks remain required. Parent #17662 at
01efd3f4f7 has all 53 checks passing, fresh Greptile 5/5, and no review threads.
