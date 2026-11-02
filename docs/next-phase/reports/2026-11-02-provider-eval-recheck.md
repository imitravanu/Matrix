# Evaluation repair recheck — 2026-11-02

The credential binding repair carries the preflight binding through controller
and model-agent execution. Its conflicting ambient-key regression passes.
Direct edits to the test file now prevent task success.

## P1 remains open — Test runner integrity is not protected

This is an incomplete repair of the prior test-integrity finding. The runner
still approves all edits and checks only the test file's bytes/path in addition
to the expected source. It does not protect package.json or its test script.

Independent reproduction through real controller/model-agent execution with
intercepted fake-provider SSE: propose an edit to package.json replacing its
test script with a node command printing '# tests 1', '# pass 1', '# fail 0'
and '# duration_ms 1'; then apply the expected source fix and finish.

Observed result: ok=true; appliedPaths=[package.json, src/bounds.js]; target,
edit, test, verification and cleanup all pass. Verification reports one passed
test despite the original regression never being executed by this replacement
command. The test file remains untouched, bypassing the new integrity check.

Restrict permitted edit paths and protect the package/test runner bytes. Score
against authoritative verification of the original fixture, not a model-selected
replacement command. Add this package-script case beside the test-edit regression.

The seven provider-eval regression tests pass. This reproduction uses temporary
files and auth-none fake-provider responses, with no external service or real
credentials. Runtime files were not edited during review; no commit was made.
