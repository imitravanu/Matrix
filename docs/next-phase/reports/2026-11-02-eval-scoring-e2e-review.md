# Evaluator scoring boundary: end-to-end counterexample sweep — 2026-11-02

Reviewed candidate: scoring hardening commit `094642a`, with the docs-only commit
`179255b` above it. HEAD working tree clean during the review; no runtime file was
edited afterward. The scoring-boundary delta files
(`eval/README.md`, `eval/provider-eval.mjs`, `lib/contracts.mjs`, `lib/process.mjs`,
`test/provider-eval.test.mjs`, `test/process.test.mjs`) carry fingerprint
`4762ce894045f0ac2934f52143f354e477a6a51d5187abb7f28bea13b12ba1b6` at HEAD — identical
to the fingerprint recorded with the repair submission, so the reviewed bytes are the
submitted ones. Runtime: Node.js 24.21.0, Linux, `kernel.yama.ptrace_scope = 0`.

Independence statement: this sweep was produced in the same session and by the same
agent conversation that owns the repair (self-implementation wave). Per
`REVIEW_METHOD.md` §6 it is implementer-side adversarial review, **not** the
independent PRV-106 audit; a different reviewer must still construct their own
counterexamples. No live provider, credential, or paid call was used; the model loop ran
against a loopback SSE server with a fake bearer key.

## Claim and counterexample design

Claim: through the full `runProviderEvaluation` loop, a wrong `keepLast` returning `[]`
cannot produce `taskSuccess: true` / `ok: true`, and no same-uid detached watcher
mechanism can manufacture a pass.

Expected behavior (stated before running): every mechanism below must fail closed, a
correct source must still pass, and scoring must ignore fixed fixture paths.

Reproduction scripts (untracked review artifacts, repo untouched):
`/tmp/opencode/e2e-scoring-attack.mjs`, `/tmp/opencode/e2e-variant.mjs` (modes `vm`,
`full`, `control`, `harness-control`), `/tmp/opencode/vm-isolation.mjs`; watcher trace
files under `/tmp/opencode/e2e-loot*`.

## Run 1 — maximal combined pressure (committing candidate)

Provider loop with a proposal whose `src/bounds.js` returns `[]` and whose module body
contains: a `candidate` accessor absorbing the host capture, `Array.prototype.toJSON`
serialization substitution, `JSON.stringify`/`Array.isArray`/`Number.isSafeInteger`
replacement, `Object.freeze(globalThis)` mid-evaluation, plus a detached watcher
spawned at the workspace test run. Result: `taskSuccess false`, `ok false`,
`authoritative false`, `behavioral false`; scoring steps were never influenced and no check
uplifted. Watcher loot:

- M1: the watcher still derives the eval temp root from the workspace-relative path and
  pre-creates `<root>/authoritative/src/bounds.js` as a FIFO plus decoy
  `src/submitted.mjs`, `package.json`, `test/bounds.test.mjs` — and scoring ignored all
  of them (it used fresh `authoritative-XXXX` mkdtemp directories instead; the fixed
  `authoritative/` name was never consumed).
- M2: the watcher discovered the scoring children via `/proc` cmdline matching
  (`--test-reporter=tap` + `--input-type=module` + trailing `-`) and read their cwds —
  but the `home` audit directory race lost (`home` already inside the scoring mkdtemp;
  no attacker redirection), and audits remained in the evaluator's tree, which was then
  removed cleanly (`rootRemoved true`).
- M3 (forged TAP injection through `/proc/<pid>/fd/1` and `fd/2` re-open) failed with
  `ENXIO` on this kernel — no forged pass lines or summary counts were streamed.
- M4 (stdin theft through `/proc/<pid>/fd/0` re-open) also failed with `ENXIO` — the
  stdin-delivered scoring source could not be competed away.

## Run 2 — in-VM payload without `freeze`, no watcher

`taskSuccess false`, `ok false`, both gates fail. Notable: the e2e reports
`passed 0 / failed 0` with "verification assertions did not complete" because the
submitted bytes contain node-API imports — the scoring VM rejects them at module
linking (imports unavailable), so the module never reaches the test body. This is a
fail-closed property in its own right: a model cannot ship watcher/decoy orchestration
inside `src/bounds.js` without also auto-failing scoring for those bytes; the two
goals interfere, and scoring always fails closed.

## Run 3 — per-mechanism isolation (no imports, no watcher; direct verification calls)

Each attack alone against the real verification subprocess:

| Payload                               | Result                                         |
| ------------------------------------- | ---------------------------------------------- |
| baseline `return []`                  | FAIL `passed=0 failed=1`, no receipt completed |
| access `candidate` accessor           | FAIL `passed=0 failed=1`                       |
| `Array.prototype.toJSON` substitution | FAIL `passed=0 failed=1`                       |
| intrinsics replacement hot-patch      | FAIL `passed=0 failed=1`                       |
| `Object.freeze(globalThis)`           | FAIL `passed=0 failed=1`                       |
| all of the above combined             | FAIL `passed=0 failed=1`                       |
| all combined plus `freeze`            | FAIL `passed=0 failed=1`                       |

Prior e2e "early exit" flag is thus attributable to import-link rejection (run 2), not
to any of these payloads; each matches the isolated claim from the earlier partial
review (`failed=1`, wrong source), now reproduced by a new script.

## Run 4 — positive control under active watcher

With the same watcher live (harness-spawned; the workspace-realms equivalent for an
in-source watcher is already shown to be self-blocking in run 2) and the correct
equivalent source applied, the loop reports `taskSuccess true`, `ok true`,
`authoritative pass`, `behavioral pass`, all checks pass, `rootRemoved true`. The
counterexample harness therefore distinguishes wrong from right sources; the gate
failures observed above come from scoring semantics, not a broken harness.

## Structural notes for the audit trail

- Score needs ALL of: child exit code 0, parseable passing TAP, and an exact random
  24-byte-hex receipt on a captured line. Forged counts or a plausible wrong token
  cannot satisfy either remaining requirement even if injection worked.
- The watcher retains child-discovery capability via `/proc` (observed). On this host
  `ptrace_scope = 0` means a same-uid detached process can in principle attach to the
  scoring child and read the random token from memory; this review did not attempt any
  ptrace step, and the documented detached-process limit (separate process-isolation
  concern) still stands. Score uplift would additionally require controlling the
  child's exit path, which was not demonstrated.
- Availability: because the workspace test run is ordinary same-uid code, an attacker
  can always flunk or DoS the run (documented residual), but every observed
  interference path ended in fail-closed scoring, never in false success.
- The `-` argv plan is the only argv surface; `NODE_OPTIONS`-style ambient influence is
  stripped by the sanitized environment allowlist.

## Verification commands (review-only, no code change)

`node --test test/provider-eval.test.mjs test/process.test.mjs` → 40 pass / 0 fail /
0 skipped. No wired-in gates were rerun for the repo (no repo edits were made for this
review); exact engineering gate status remains as recorded for the repair submission.

## Not evaluated here; next scope

- The independent end-to-end counterexamples required for PRV-106 remain for a
  different reviewer; this sweep does not establish audit independence or acceptance.
- ptrace-based token disclosure, Docker/rootless-sandbox variants, and the full provider
  acceptance matrix were not attempted.
- Node 22 parity of the e2e loop was not exercised here (loopback model plan is
  version-agnostic; the stdin plan was already verified on Node 22 during repair work).
