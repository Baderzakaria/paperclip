# Voice recovery drain repair

Owner: slice 21, PR #17576. Reviewed baseline: 1bf70185d2.

Greptile finding 4370544173 is valid. The worker retained dirty scopes while
paused, and reported those in-memory hints as pending work. After the producer
committed, the coordinator therefore retained its intent activity hold. No SQL
was required to reproduce the blocked drain; the earlier quiet assertion checked
SQL only and missed the nonzero idle counter.

The worker now reports pending dirty scopes only while dispatch is permitted.
It still retains every hint and next deadline. The coordinator independently
checks databaseWorkPending, so an open/uncertain transaction retains its activity
hold until transaction reconciliation establishes settlement. Paused timers then
use the existing passive-maintenance path without changing the idle generation.
Resume processes the retained first session without another producer signal.
No provider behavior or external sleep eligibility rule changes.

The strengthened real-PostgreSQL test proves: an open write during drain retains
an activity hold; commit releases it; a further minute causes neither SQL nor
an idle-snapshot change; resume processes the one retained session exactly once.

- /tmp/sleep21-drain-before.log: original worker fails, active is 1 instead of 0.
- /tmp/sleep21-drain-tests.log: all 11 voice recovery lifecycle tests pass.
- /tmp/sleep21-drain-typecheck.log: production server typecheck passes.
- Dedicated migrated database: paperclip_sleep21_drain_20261025_test.

Propagate this predicate into slice 22's extracted scoped-deadline worker and
all descendants, then rerun its existing consumers. The earlier tool-health,
Discord command, and receiver workers have the same predicate pattern; audit
and repair those at their own parent PRs as a separate propagation pass. Do not
report all stack drain behavior fixed from the voice test alone. The company
inbound cleanup/deletion policy, older E2E failure, current chat milestone audit,
and full original inventory remain outstanding.
