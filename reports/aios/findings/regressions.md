# Regression tests

## ZAK-2 self-wake loop

- Test: `server/src/__tests__/issue-update-comment-wakeup-routes.test.ts`
- Failure evidence: `reports/aios/evidence/regression-generator/zak-2-failing.txt`
- Passing evidence: `reports/aios/evidence/regression-generator/zak-2-passing.txt`
- Fix commit: current branch HEAD

The regression posts a board-authenticated comment with an actor run ID equal to
the assigned issue's execution run ID and verifies that no `issue_commented`
wake is enqueued. The existing top-level board comment test retains coverage
that a human comment without an owning run still wakes the assignee.
