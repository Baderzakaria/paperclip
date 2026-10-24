# Plugin job scheduling without idle polling

Plugin cron scheduling uses the instance delivery coordinator. It no longer
queries `plugin_jobs` every 30 seconds when there is no eligible work.

## Ownership and durable state

The plugin scheduler owns cron interpretation, dispatch eligibility, concurrency,
and run settlement. `plugin_jobs` stores schedules and their next deadlines;
`plugin_job_runs` records admitted calls and their outcomes. No table or migration
is added. The application passes its existing coordinator to `scheduler.start`.
The coordinator owns timer execution, transaction uncertainty, and drain gating.

The job store and registry signal before changes inside their transactions.
Definition sync, pause/resume, changed schedules, run creation/settlement, job
removal, and plugin removal invalidate the scheduler. Nested transactions wake
only after their outer transaction settles. An empty manifest is a real sync:
both the loader and lifecycle coordinator pause removed definitions.
Registration and worker status changes provide local lifecycle wakes. The shared
`registerDeadlineWork` helper retains explicit wakes received during drain,
including a worker becoming available without a database mutation.

## Idle and dispatch behavior

- Empty instances, manual-only jobs, invalid cron definitions, paused jobs, and
  unavailable workers have no recurring scheduler SQL after reconciliation.
- Configured future jobs arm their saved next deadline. No SQL is needed between
  reconciliation and that deadline unless a supported producer changes state.
- Startup reconstructs deadlines. An overdue saved timestamp is owed work and
  is not replaced merely because the plugin registered again. A missed schedule
  dispatches once, then computes its next cron time after completion.
- A missing timestamp is initialized from the current cron expression. A changed
  cron clears the old timestamp so the new schedule can be initialized.
- Claims recheck the definition under a job-row lock and reject outstanding
  queued, pending, or running records. Manual and scheduled dispatch share this
  boundary. Worker RPC calls run outside transactions.
- Active calls consume concurrency slots and remain tracked until settlement.
  Their completion wakes waiting work without an interval. Slow calls do not
  prevent other available slots from being used.
- Completion and the scheduled job's next timestamp commit together. Failed
  persistence retries the retained settlement, not the plugin side effect.
  A concurrent schedule edit is preserved by the settlement check.
- Stop rejects new admissions, detaches worker subscriptions, and waits for
  admitted work. Existing calls retain their RPC timeout. The application then
  stops the shared coordinator before ending the database pool.

## Limits

This is the existing single-process writer model. Independent SQL writers and
other app replicas do not emit these local signals. The row lock prevents an
overlapping claim, but does not establish a supported multi-replica wake protocol.

A process crash after a plugin call but before durable completion leaves an
unresolved run. The scheduler does not assume that an unknown external effect is
safe to repeat. Such a run remains outstanding until explicit lifecycle/operator
reconciliation. During a live process, failed completion writes retain their
exact result and retry. This does not invent exactly-once external execution.

Plugin definitions remain instance-scoped, as on the base branch. The separate
company-scoped job proposal is not implemented here. Plugin configuration and
worker authorization retain their existing owners.

The Cloud sleep proof remains conservative for plugin work. An internal cron
deadline cannot wake a stopped host; this PR does not add external alarm coverage,
allow configured plugins to bypass idle checks, or claim measured host sleep.

## Verification

`plugin-scheduled-work.test.ts` uses real PostgreSQL and controlled worker calls.
It checks idle SQL silence with no jobs and configured future/manual-only jobs;
first writes, pause/resume, worker availability, outer commit and rollback;
restart and overdue execution; removed schedules; concurrent claims; failed
completion persistence without repeated RPC; capacity refill; drain; and shutdown.
Worker responses are simulated. Existing startup, authorization, loader, shared
coordinator, decision-expiry, and warm-standby tests cover affected consumers.
