# Provider repair check 4 — 2026-11-01

**Verdict: D1 reproduced as fixed; D2 partially fixed, one P2 remains.**

Candidate: uncommitted implementation over `e1b3c66`, runtime/test/config SHA-256
`821a38f5359ee3ee52b4ad01f8d8c999934569f994ed657a6accbe2d01a661a8`.
Identity uses the same 22-file sorted path + NUL + bytes + NUL method as review 3;
documentation is excluded. No runtime changes, commits, real credentials or live inference.

## Remaining finding — P2: body timeout skips persistent refresh status

Location: `lib/provider-discovery.mjs:359–364`, especially line 364.

After the timeout controller cancels a stalled response reader, readBoundedBody can
resolve normally with partial bytes. The following aborted-controller branch returns
failed(...) directly, bypassing recordFailure(...). It therefore leaves the last
successful refresh status intact. The immediate result is stale/error, but rebuilding
the catalog reports outcome ok, stale false, error null. This is a remaining D2 path,
not a recurrence of the fixed HTTP 503 path.

**Independent reproduction:** seed a valid discovery snapshot, then refresh using an
injected HTTP 200 ReadableStream that emits a partial JSON chunk and never closes.
Set the deadline to 20 ms. Observe:

```text
refresh: ok=false, error="models request timed out", stale=true
rebuilt catalog: outcome="ok", stale=false, error=null
```

**Required correction:** route this provider timeout through the persistent failure
recording path, preserving the prior snapshot. Keep explicit user cancellation separate.
Add a regression that starts with a successful cached snapshot, times out during body
reading, rebuilds the catalog and verifies stale/error state; a later success should
clear it. Cover both rejected reads and cancellation-resolved reads.

## Checks that now pass

- An already-aborted discovery invocation produces zero fetch calls and ok=false.
- A successful refresh followed by HTTP 503 remains outcome error/stale=true when
  buildProviderCatalog reconstructs the snapshot from disk.
- Focused provider/redaction suite: 68 passed, 0 failed, 0 skipped on Node 24.21.0.
- `npm run check`: exit 0; 645 passed, 0 failed, 0 skipped on Node 24.21.0.
  Coverage: 93.92% lines, 83.63% branches, 94.38% functions.

The broader provider phase remains partial: UI selection, management commands, session
binding, probes and complete workflow acceptance remain outstanding. This check does not
establish Node 22, hosted CI, live provider compatibility or model quality. No separate
eval/smoke/pack run was performed in this focused repair check.
