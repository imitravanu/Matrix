# Provider repair review — 2026-11-01

**Verdict: CHANGES REQUIRED.** The repairs address several previous reproductions, but
three independently reproduced defects remain. This does not accept the provider phase
or establish completion of PRV-106's full matrix.

Reviewed the uncommitted candidate over `e1b3c66`. Runtime/test/config SHA-256:
`16b6b3bc41d49e083448b7b307dca8621b23e2451577fd0c81f8ff63899bb12d`.
Computed over 22 modified/untracked runtime, test and configuration files sorted by path,
concatenating path + NUL + raw bytes + NUL; docs, AGENTS.md, NEXT_PHASE.md and MATRIX.md
excluded. Review changed only this report. No commit, real credentials or live inference.

## Findings

### RR1 — P1: path aliases bypass the new kernel lock and lose updates

Location: `lib/provider-config.mjs:245–247` (`lockAddress`).

The abstract socket name hashes `resolve(configPath)`, which normalizes a path string
but does not resolve symlinked parent directories. Two supported Matrix home paths can
therefore refer to the same providers.json while obtaining different exclusion locks.
The mutation functions accept both homes and do not reject symlinked parents. The
kernel lock fixes stale-lock stealing for one pathname, but not shared-file exclusion.

**Independent reproduction:** create a temporary real home and a directory symlink to
it. Acquire both locks with zero wait: both succeed and have different socket addresses.
Then pause writer A just before its config rename, holding the real-home lock. Writer B
adds a profile through the alias and returns success. Resume A; it also returns success.
The final file contains only A's profile: B's successful update was lost. The controlled
schedule used a test-only filesystem wrapper and owned SIGSTOP/SIGCONT subprocess.

**Required correction:** bind exclusion to the actual trusted configuration directory
identity (or reject aliases consistently before any operation), not a lexical path.
Account for parent replacement while binding and writing. Keep the kernel-held lifetime
property. Add a two-process regression using real and symlinked homes that verifies both
updates survive or the second writer receives a conflict/lock error.

### RR2 — P2: Content-Type error formatting still truncates before redaction

Location: `lib/openrouter.mjs:679–687`.

HTTP error-body redaction is repaired, but the non-SSE success branch still slices an
untrusted Content-Type header to 80 characters before building an error. When an echoed
credential straddles that boundary, the final literal/encoded redactor cannot match the
complete key, and this path does not use redactedDetail's fragment withholding.

**Independent reproduction:** use a fake credential and inject an HTTP 200 response whose
Content-Type is 70 `x` characters followed by that credential. The returned error exposes
the first ten credential characters, with neither a redaction nor withholding marker.
No remote request or real credential was used. This is a remaining route for the previous
R3 finding; the prior URL-encoded HTTP-body and 160-character-boundary cases now pass.

**Required correction:** sanitize the complete header before truncation or omit the
untrusted value from this error. Review other error fields such as provider error codes
for the same ordering. Add header-boundary canary tests, checking the returned events
and persisted projections rather than only the redaction helper.

### RR3 — P2: a nonregular discovery cache can hang offline catalog loading

Location: `lib/provider-discovery.mjs:60–69` (`boundedRead`).

The cache reader calls blocking `openSync(path, "r")` before checking file type. If
provider-cache/lab.json is a FIFO, open waits for a writer and the later fstat guard is
never reached. buildProviderCatalog invokes this synchronously, so an invalid cache
can prevent even offline/manual catalog access indefinitely. Discovery reads the cache
before installing its network timeout, so that timeout cannot recover it either.

**Independent reproduction:** create an isolated valid lab profile and a FIFO at its
cache path using mkfifo. Run buildProviderCatalog in a child process. It never returns;
the parent terminates it after one second with ETIMEDOUT. No network operation occurs.

**Required correction:** use bounded, no-follow/nonblocking regular-file access and
validate the opened descriptor before reading; do not rely only on a pre-open lstat
that can race. Treat invalid caches as absent while preserving configured models.
Add FIFO/symlink tests in subprocesses with a hard timeout to avoid hanging the suite.

## Retest of previous findings

| Previous finding                                 | Observed result                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1: explicit provider dropped in a terminal      | Fixed by explicit refusal. Real PTY arbitrary-ID invocation now fails before the legacy resolver; actual TUI provider support remains deferred.          |
| R2: stale reclaimer steals live replacement lock | Old reclaim mechanism removed on Linux; kernel lock lifetime, crash and paused-owner tests pass. Shared-file exclusion still fails through aliases: RR1. |
| R3: encoded/truncated credentials in errors      | Prior HTTP-body reproductions pass, including URL encoding and boundary truncation. Header path remains vulnerable: RR2.                                 |
| R4: oversized successful config write            | Fixed for the reproduced cumulative-size case: CONFIG_TOO_LARGE occurs before replacement, exact prior bytes survive, reload remains valid.              |
| R5: credential changes between tool rounds       | Fixed for the reproduced environment-mutation case: both requests retain the original key. Focused binding regression passes.                            |

## Verification

- Node 24.21.0: `node --test test/provider-*.test.mjs test/redaction.test.mjs`:
  57 passed, 0 failed, 0 skipped.
- `npm run check`: exit 0; 634 passed, 0 failed, 0 skipped. Coverage:
  93.98% lines, 83.67% branches, 94.41% functions.
- Independent controlled reproductions above reveal cases absent from the passing suite.
- Node 22, hosted CI and live-provider/model-quality validation were not evaluated.
  Evaluation, smoke and packaging were not re-run in this focused repair review.

## Phase status

The unchanged delivery gaps in the original report remain: provider management CLI,
interactive provider selection, saved provider/configuration binding, explicit built-in
selection, compatibility probes/evaluation integration, and the real CLI approved edit /
separately authorized test / exact undo acceptance demonstration. The status board still
identifies partial implementation, not phase completion.

Fix RR1–RR3 with regression evidence and complete remaining phase requirements before
acceptance. Do not count a repaired finding or passing engineering gate as proof that
the user-facing provider phase is finished.
