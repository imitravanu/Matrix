# Verifier environment and lifecycle recheck — 2026-11-02

The reported environment leak is repaired. An independent model-source fixture
could no longer observe a fake MATRIX_AUDIT_SECRET in its authoritative child.
All ten provider evaluation tests pass, zero failures/skips; log:
`/tmp/matrix-astra-verifier-review.log`.

## Remaining P2 — Authoritative verification leaves descendants running

The previously disclosed direct-spawn integration gap has a concrete lifecycle
consequence. runAuthoritativeVerification uses spawnSync without an owned process
group or descendant cleanup. Its caller considers directory removal and controller
disposal sufficient for cleanup, but that controller does not own this subprocess.

Independent reproduction: synthetic source starts a non-detached Node child with
ignored stdio and unrefs it, writes the child's PID to a temporary marker, then
exports a working keepLast. The authoritative test returns pass while that child
is still alive (verified with process.kill(pid, 0)). The review explicitly killed
the child afterwards and removed all temporary files. No external service or real
credential was involved.

The evaluator invokes this helper on arbitrary final model source before exact
source acceptance, so a failed score does not prevent this execution or leakage
of a running descendant. An environment fix alone cannot establish cleanup.

Use the shared trusted execution/lifecycle path and verify the authoritative
process and its descendants settle before reporting cleanup. Cover normal exit,
timeout and cancellation; retain the minimal environment and original fixture
integrity. Do not close this issue solely on a passing happy-path subprocess.

Runtime files were not changed. This focused review confirms the credential fix,
not full evaluation or provider-phase acceptance.
