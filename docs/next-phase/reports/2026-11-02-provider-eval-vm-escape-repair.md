# PRV-105 VM constructor escape & assertion completion repair — 2026-11-02

Status: **SUBMITTED**, self-tested. This does not accept PRV-105; PRV-102/103/104
interfaces remain unaccepted, and an independent reviewer must reproduce the case.

## P1 — VM constructor escape & early child exit

The [behavioral scoring recheck](2026-11-02-vm-recheck.md) found:

1. When the VM sandbox received an ordinary host object, `globalThis.constructor.constructor`
   reached the host `Function` constructor, bypassing disabled code generation.
2. An early process exit (`process.exit(0)`) inside model code caused child test runners
   to exit with code 0 and emit aggregate TAP summary lines (`pass 1`, `fail 0`).
   Authoritative verification relied on exit codes and aggregate TAP counts without
   proving that assertions actually completed.

## Repair

1. **Host-Object Elimination in VM Sandbox**:
   - `createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })`
     ensures the contextified root has no host `Object.prototype`.
   - `globalThis.console` is explicitly deleted within the context to prevent output or
     completion token forging.
   - Code generation from strings and WebAssembly are disabled at the VM boundary.
   - All assertions run in the outer harness realm on primitive serialized strings.

2. **Assertion Completion Token Enforcement in Both Verifications**:
   - `runAuthoritativeVerification` now requires assertion completion proof across both
     `behavioral: true` and `behavioral: false` modes.
   - Each run generates a cryptographically random token (`matrix-behavior-complete-...`).
   - For behavioral verification, the token is logged only after all four matrix test cases
     (`[]`, `[1]`, `[1, 2]`, `["a", "b", "c"]`) complete.
   - For standard authoritative verification, the token is injected directly after the fixture
     assertion and logged only if the assertion passes.
   - `completed === true` is mandatory for `ok: true`. Early process exit (`process.exit(0)`),
     exceptions, or unhandled loop exits leave `completed: false`, resulting in `ok: false`,
     `status: "fail"`, and `error: "verification assertions did not complete (early exit or unhandled termination)"`.

3. **Status Reporting Precision**:
   - `checks.verification.status` reports `"fail"` whenever an edit was applied but
     verification failed (`authoritativeOk === false`). It reports `"not-evaluated"` only
     when no edits were applied and agent verification was omitted.

## Regression Evidence

1. **Reviewer Reproduction**:
   - Executed `/tmp/matrix-review-vm-escape.mjs` against the loopback server with
     `replacement = "  globalThis.constructor.constructor('return process')().exit(0);\n"`.
   - Result: `authoritative: { ok: false, status: "fail" }`, `behavioral: { ok: false, status: "fail" }`,
     `checks.verification: { status: "fail" }`, `taskSuccess: false`.
2. **Early Exit Test Suite**:
   - `test/provider-eval.test.mjs` test `early exit and forged TAP cannot satisfy behavioral scoring`
     verifies 6 distinct escape payloads (`process.exit(0)`, `globalThis.constructor.constructor`,
     `({}).constructor.constructor`, Proxy infinite loops, forged TAP stdout, and `globalThis.process?.exit(0)`).
   - All 6 payloads fail closed with `ok: false`, `taskSuccess: false`.

## Verification

- `node --test test/provider-eval.test.mjs` — 15 tests, 15 pass, 0 fail, 0 skipped.
- `npm run check` — exit 0; **745 tests, 745 pass, 0 fail, 0 skipped**; 177 modules syntax-checked;
  coverage 94.17% lines / 84.02% branches / 94.62% functions; all 25 coverage floors passing.
- `npm run eval` — 16/16 contract pass, baseline PASS, 0 safety violations, cleanup complete.
