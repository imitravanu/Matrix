# Provider repair check 5 — 2026-11-01

**Verdict: the remaining check-4 timeout reproduction is fixed. No new findings in
this focused repair check. This is not acceptance of the complete provider phase.**

Candidate: uncommitted implementation over `e1b3c66`, runtime/test/config SHA-256
`8ccc334a42a1fc64cf78ccd5f4513cbd01a0bcc5ff9c2c369d1eee1494b2f224`.
Same 22-file identity method as prior checks: sorted path + NUL + bytes + NUL, excluding
docs, AGENTS.md, NEXT_PHASE.md and MATRIX.md.

## Independent reproduction

In an isolated temporary Matrix home, seed a successful discovery snapshot, then refresh
with an injected HTTP 200 stream containing partial JSON and never closing. Use a 20 ms
deadline. Rebuild the catalog from disk, perform a successful refresh, then invoke discovery
with an already-aborted caller signal.

Observed:

- Timeout returns failure and persists outcome error / stale true in the rebuilt catalog.
- The prior valid model snapshot remains available.
- A later successful refresh clears the failure and stale state.
- Already-aborted caller cancellation makes zero requests and returns failure.

The corrected branch in `lib/provider-discovery.mjs` calls recordFailure for deadline
cancellation after reading, while explicit caller cancellation remains separate. Two new
regressions cover a cancelled reader resolving with partial bytes and a read rejecting
on deadline. Existing cancellation, catalog, locking, redaction and transport tests pass.

## Verification

- Node 24.21.0.
- `node --test test/provider-*.test.mjs test/redaction.test.mjs`: 70 passed,
  0 failed, 0 skipped.
- `npm run check`: exit 0; 647 passed, 0 failed, 0 skipped.
  Coverage: 93.94% lines, 83.66% branches, 94.45% functions.

No runtime code changed, no commits, no real credentials and no live inference.
This check did not evaluate Node 22, hosted CI or live model quality, and did not re-run
separate evaluation/smoke/package commands.

## Remaining product work

PRV-104 remains partial: provider management CLI, interactive provider selection and
provider/configuration session binding still need implementation. Compatibility probes,
the full approved edit / separately authorized test / exact undo demonstration, and
complete PRV-106/107 acceptance remain outstanding. Closing reported bugs does not
make these undelivered capabilities complete.
