# Evaluation verifier review — 2026-11-02

The prior package-script bypass is addressed: only the source file is approved,
denied paths fail the scope check, package/test integrity is checked, and original
fixtures are restored in a separate verification directory. The credential
binding repair remains present. Nine evaluation tests pass with no failures or
skips (`/tmp/matrix-eval-integrity-recheck.log`).

## P1 — New authoritative subprocess inherits secrets

In eval/provider-eval.mjs, runAuthoritativeVerification constructs its environment
from all of process.env, removing only NODE_OPTIONS, NODE_TEST_CONTEXT and
NODE_V8_COVERAGE. It then imports and executes the model-written source with
spawnSync. This bypasses the ordinary test-execution environment isolation.
The helper is invoked before the final exact-source acceptance check, including
for unsuccessful model runs; a later failing score cannot undo disclosure.

Independent reproduction: set a fake MATRIX_REVIEW_SECRET in the parent, call
the real authoritative verifier with source that reads that environment variable
and writes it to a temporary marker, and export a working keepLast function.
The test passed and the marker contained the exact canary. No real credential,
external service or repository file was used.

Route authoritative verification through the existing trusted test execution and
sanitized environment machinery, preserving cancellation, output bounds and audit
semantics. Do not merely delete this one environment-variable name. Add a
regression asserting model-written source cannot observe fake provider and
repository-secret variables in the authoritative child while ordinary verification
still passes. Review the direct subprocess against the project's execution policy.

Verdict: the original integrity bypass is repaired, but the new verifier is not
ready for acceptance until its child-environment isolation is fixed. Runtime
code was not edited during this review; no commit was made.
