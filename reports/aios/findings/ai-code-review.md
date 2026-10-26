# AI code review

## ZAK-2 self-wake loop

Gate: PASS

- Every changed route hunk is scoped to treating a comment from the issue's
  checkout or execution run as a self-comment for wake suppression.
- The helper centralizes the pre-existing run-ownership predicate; it does not
  widen authorization, alter comment attribution, or suppress human comments
  without a matching run ID.
- The route regression exercises the user-auth local-CLI shape rather than
  reasserting the helper implementation.
- The changelog documents the externally visible wake-suppression behavior.
- No invented external APIs, removed guards, stubbed behavior, or unrelated
  changes found.

The repository does not contain `.claude/aios/EVIDENCE.md`; this review used the
standard skill checks against the complete local diff.
