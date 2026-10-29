# ADV-001 completion review

Reviewed 2026-10-29 against the current uncommitted implementation. The two reproduced findings below
have fixes and regression tests in the current working tree. Final verification passed: 570 tests on
both Node 22.23.4 and Node 24.21.0, plus smoke, evaluation and package checks. The previously recorded
560-test gates are historical evidence and did not cover these cases. The review used temporary
workspaces and removed them afterward.

## P1: Non-Git publication skips result validation

Location: `lib/integration-publication.mjs`, early directory return at line 55.

`publishIntegrationIntent()` returns a successful directory publication before the baseline and
approved-postimage validation used for Git results. A trusted test command can rewrite an approved
file and still exit successfully. The run then advertises a successful, published result whose bytes
are not the reviewed patch. This is an ordinary test-side-effect case, not a race or a malicious
same-user process modifying a private directory concurrently.

Reproduction: a temporary non-Git demo, normal Local Forge fix and integration approval, followed by
an explicitly approved `node --test` test that overwrites `src/processor.py` and passes. Observed:

```json
{
  "integration": "integrated",
  "verified": true,
  "status": "success",
  "publicationStatus": "published",
  "resultBytes": "NOT THE APPROVED PATCH\n"
}
```

Required correction: validate result contents for both publication kinds before announcing publication.
Refuse publication and preserve the result for inspection when approved or baseline files have changed.
Do not carry a test-success claim over to a different result. Add end-to-end tests for passing test
commands that alter an approved file and an unrelated baseline file in a non-Git result.

## P2: Final terminal output omits the result destination

Locations: `lib/parallel-interactive.mjs` lines 179–185 and 198–217, `src/parallel-app.mjs`
decision submission, and `bin/matrix.mjs` lines 760–776.

The result directory and intent path are printed before combined test approval. Submitting that
approval clears the Ink review buffer. On normal non-Git completion, the final view contains only
the verification status; the destination and recovery details are gone. On CLI exit the alternate
screen disappears, and the shell receives only the recovery-session ID, not the result directory,
intent path, or a resume command with the required workspace. Git branch details also disappear from
the shell when the alternate screen closes.

Reproduced through the actual `ParallelApp` with `ink-testing-library`, real agents, normal
integration approval, and denied combined tests. The returned result had a valid retained workspace,
but the completed frame had neither `Result workspace` nor recovery information. Its review showed:

```text
Combined verification: unverified
Finished: unverified · Enter to exit
```

Required correction: print a final result summary after all questions and again after alternate-screen
exit. Include the result directory, intent path, session/resume command, publication branch/commit
when applicable, and the actual verification/publication status. Test the completed frame and the
post-exit terminal output for both Git and non-Git workflows.

## Acceptance consequence

ADV-001 was reopened. Regression tests now cover modified approved files, modified baseline files,
new files produced by passing tests, and final Ink and post-exit terminal summaries for Git and
non-Git runs. Non-Git publication refuses drift and retains the result; earlier verification becomes
stale. Final gates passed as recorded above and in ENGINEERING_PLAN.md. The original recovery and
Git-publication implementation was preserved.
