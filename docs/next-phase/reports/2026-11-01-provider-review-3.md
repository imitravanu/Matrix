# Provider review 3 — 2026-11-01

**Verdict: prior RR1–RR3 reproductions pass; phase acceptance still requires changes.**
Two discovery contract gaps remain. The earlier repairs are real progress and should
not be reported as still failing the original reproductions.

Reviewed the uncommitted candidate over `e1b3c66`. Runtime/test/config SHA-256:
`5c640f9be9f37292c427d37e57a679ed1c19a22433f9e790ef79915eae00e844`.
Same identity method as prior reviews: 22 sorted modified/untracked runtime, test and
configuration files, path + NUL + raw bytes + NUL; planning/docs excluded.
No runtime edits, commits, real credentials or live inference during this review.

## Findings

### D1 — P2: explicit discovery has no caller cancellation path

Location: `lib/provider-discovery.mjs:208–217,233–241`.

refreshProviderModels creates an internal timeout controller but does not accept or
connect the caller's AbortSignal. A caller cannot cancel a refresh when the user cancels
or leaves the operation. Even an already-aborted caller signal is ignored: the function
issues the request and may commit the returned cache as a successful refresh. The default
15-second timeout bounds ordinary network activity but does not implement user cancellation.
This violates the active discovery requirement before CLI/UI integration consumes this API.

**Reproduced:** create an isolated lab profile, abort a controller, then call
refreshProviderModels with its signal and an injected successful response. Actual result:
request count 1, ok true. No external provider was contacted.

**Required fix:** accept and compose caller cancellation with the existing deadline;
check before fetch and before cache replacement. Clean up listeners/readers in every exit
path. Test already-aborted calls (zero requests), cancellation during fetch/body streaming,
and cancellation before persistence. Preserve the prior valid snapshot on cancellation.

### D2 — P2: catalog reload drops discovery failure/freshness information

Location: `lib/provider-catalog.mjs:105–121,127–132`; failure result handling in
`lib/provider-discovery.mjs`.

The failed refresh result reports stale=true, but that failure state is not retained in
the shared catalog/cache representation. buildProviderCatalog subsequently returns the
previous discovered entries without stale/fetchedAt/error metadata, while its top-level
status/error describe only configuration validity. A fresh CLI/UI consumer cannot
honestly distinguish the failed refresh from a successful one or display the required
stale/error label. A transient return value is insufficient for the shared offline snapshot.

**Reproduced:** successful discovery stores Exact/Model; a second refresh returns HTTP 503
and stale=true. Rebuild the catalog from the same home: status valid, error null, discovered
entry has neither stale nor fetchedAt. No network operation happens during catalog reload.

**Required fix:** represent the last successful snapshot time and last refresh outcome
per provider, retain only bounded redacted diagnostics, and expose discovery freshness
separately from configuration validity. Preserve manual models and the prior valid list.
Test failure followed by catalog reconstruction/new process, then successful refresh clearing
the error; retain digest invalidation and offline/no-fetch behavior.

## Previous findings retested

- **RR1 (aliased home exclusion):** an original-path holder now causes an alias-path
  contender to fail CONFIG_LOCKED. Lock addresses use directory device/inode identity.
  The new two-process alias writer regression passes in the focused suite.
- **RR2 (header credential prefix):** the identical 70-character prefix plus fake-key
  Content-Type reproduction emits no ten-character key prefix. Header and provider-error-code
  regressions, including persisted projection coverage, pass.
- **RR3 (FIFO cache hang):** the same FIFO cache fixture now lets a subprocess return
  a valid catalog with exit 0, within the one-second watchdog. Nonblocking/no-follow
  descriptor checks reject the invalid cache. Symlink-cache regression also passes.

These observations close the specific previous reproductions, not every possible
filesystem/network adversarial schedule. This is a focused review, not full PRV-106 approval.

## Verification and scope

- Node 24.21.0; `node --test test/provider-*.test.mjs test/redaction.test.mjs`:
  63 passed, 0 failed, 0 skipped.
- `npm run check`: exit 0; 640 passed, 0 failed, 0 skipped.
  Coverage: 93.92% lines, 83.64% branches, 94.42% functions.
- Independent reproductions used temporary homes, owned subprocesses and injected
  responses. No real keys or external inference.
- Node 22, hosted CI, live compatibility and model quality were not evaluated.
  Evaluation/smoke/pack were not re-run in this focused review.

The source still lacks provider management commands, interactive provider selection,
provider/configuration session binding, compatibility probes and the required full coding
workflow demonstration. Completing the fixes does not itself complete the provider phase.
