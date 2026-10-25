# Company deletion with chat endpoints

Company deletion must remove chat endpoints before deleting their referenced issues or assigned agents.
The endpoint-to-agent foreign key uses RESTRICT, so waiting for the final company
cascade fails while deleting agents. This was reproduced by the Discord scheduling
producer test and by the owning company-removal suite.

The chat owner participates in the existing company-deletion transaction. It
removes only the requested company's endpoint rows before issue deletion and before the agent lifecycle
participant runs. Existing endpoint foreign keys remove their dependent records.
The lifecycle owner still requires completed agent termination. The transaction
still rolls back all SQL cleanup if a later participant fails. No external calls,
new scheduler, schema change, or relaxed constraint is introduced.

Discord command ownership tombstones have no cascading foreign keys and remain
unchanged. Deletion does not authorize a new endpoint to adopt an old application.
Other retained-history constraints, including voice-session restrictions, still
apply; this fix does not bypass them or change external provider teardown policy.

Both new PostgreSQL regressions failed before the change. All six cleanup-removal
cases pass afterward, including deletion ordering, another company's untouched
endpoint, preserved namespace ownership, and rollback after a later failure.
The suite accepts a validated dedicated external PostgreSQL test database because
embedded PostgreSQL cannot start on this host. Server typecheck/build and remote
CI/review are tracked separately; this is not evidence of deployed host sleep.


Review expanded the fixture to include a conversation and publication linked to
an issue. Both regressions then failed because cleanup ran after issue deletion.
The chat participant now runs immediately after the company row is locked, before
any referenced issue or agent is removed. The same transaction preserves history
on rollback. This supplements the original endpoint-only proof; it does not claim
to remove existing voice-session restrictions.
