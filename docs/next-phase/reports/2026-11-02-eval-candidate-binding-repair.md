# Evaluator candidate-binding and fixture-tamper repair — 2026-11-02

Implementer repair submission; independent re-review remains required. This is not an
acceptance decision and does not close PRV-105.

Base: commit `4708709`; the 51-file provider candidate at that commit still has
fingerprint `f54ce83fcff21ae65168dd5b21d45c872d448933632f605d25915fe51859e763`.
The binding repair originally changed three evaluator files. The follow-up
fixture-tamper repair expands the scoring-boundary delta to six files with fingerprint
`4762ce894045f0ac2934f52143f354e477a6a51d5187abb7f28bea13b12ba1b6`
(sorted path + NUL + raw bytes over `eval/README.md`, `eval/provider-eval.mjs`,
`lib/contracts.mjs`, `lib/process.mjs`, `test/provider-eval.test.mjs` and
`test/process.test.mjs`).
Runtime: Node.js 24.21.0. This repair did not create a commit or push, and used no
live provider credentials or paid calls.

## P1 finding — mutable candidate global

Location: the first host shim in `eval/provider-eval.mjs` stored the candidate with
`context.candidate = candidate` and referenced the global identifier `candidate` in
the per-case script.

A submitted module can define that global as an accessor before the shim assigns it:

```js
Object.defineProperty(globalThis, "candidate", {
  configurable: true,
  set() {},
  get() {
    return (items) => items;
  },
});
export function keepLast(items) {
  return [];
}
```

The module evaluates first. The host assignment invokes the setter, the suffix reads
the getter, and the fake identity function is scored instead of the exported
`keepLast`. A deliberately wrong function returning `[]` passed both verification
runs.

The ordinary evaluation path reproduced this with a whole-file edit that also patched
`node:assert/strict` in the agent's own run through `typeof process`:

```text
requests 2, applied 1
target/edit/test/package/scope/verification/cleanup all pass
verification verified
authoritative true
behavioral true
taskSuccess true
ok true
```

## Fix

There is no candidate global now.

- Before submitted code evaluates, `runInContext` creates a factory that captures
  `JSON.stringify`, `Array.isArray` and `Number.isSafeInteger` in a VM closure.
- After evaluation, `invokeFactory(candidate)` returns an invoker that closes over the
  captured candidate.
- The invoker is installed as `__matrix_invoke_<random hex>` with `writable: false`,
  `configurable: false` and `enumerable: false`.
- Each case still runs through `runInContext(..., { timeout: 1000 })`, so the whole
  per-case call remains bounded.

Submitted code can discover and call the invoker, but it cannot replace the random
non-configurable property or the candidate captured in the closure. Freezing or
otherwise preventing installation fails closed.

## P1 finding — authoritative fixture tamper

The binding fix survived direct VM attacks, but the evaluator still trusted a writable
fixture path shared with the workspace. The agent's own test run executes model-written
`src/bounds.js` as ordinary Node code, unsandboxed, with the evaluator temp root
reachable. A malicious source could therefore create
`<root>/authoritative/src/bounds.js` as a FIFO and spawn a detached watcher before
scoring. The authoritative setup then wrote the host shim through that path; the watcher
consumed those bytes and replaced the FIFO with a malicious shim that read the random
completion token from `test/bounds.test.mjs` and returned `items.slice()`.

The ordinary evaluation path reproduced the bypass end to end with a wrong `keepLast`
returning `[]`:

```text
requests 2, applied 1
target/edit/test/package/scope/verification/cleanup all pass
verification verified
authoritative true
behavioral true
taskSuccess true
ok true
```

The same wrong source without the FIFO tamper failed both gates (`passed: 0`,
`failed: 1`, `ok: false`), confirming the tamper was the cause.

## Fixture-tamper fix

The authoritative run no longer has a writable fixture file or a predictable fixture
directory.

- `runAuthoritativeVerification` generates one self-contained module in memory: the VM
  harness, submitted bytes as a JSON string literal, the random invoker name, host
  assertions, and the completion token.
- The module is delivered on the child's stdin. `runProcess` and `runTests` accept an
  optional `input`; it is never part of argv, the displayed command, or the
  trust/execution audit.
- The child runs in a fresh `mkdtemp` directory with no `src/bounds.js`,
  `src/submitted.mjs`, `package.json`, or test file. Its disposable audit/home
  directory is inside that random directory, not at a fixed path under the temp root.
- The plan remains `node --experimental-vm-modules --test-reporter=tap
--input-type=module -`, so exact-plan authorization, sanitized environment, bounded
  output, cancellation, audits and process-group cleanup still apply.
- The temporary directory is removed after each run.

A regression pre-creates the old `authoritative/src/bounds.js` path as a FIFO, writes a
valid `submitted.mjs` beside it, and adds a forged test file. An import-free wrong source
still fails closed with `ok: false`, `status: "fail"`, `passed: 0`, `failed: 1`; the run
is not timed out and the FIFO remains unconsumed.

The original FIFO end-to-end reproduction now reports:

```text
requests 2, applied 1
edit fail · test pass · package pass · scope pass · verification fail
authoritative false · behavioral false
taskSuccess false · ok false
```

That reproduction's malicious source imports Node APIs, so the inline VM rejects it
before assertions. The separate import-free regression exercises the assertion-failure
path with the same pre-created FIFO.

## Regressions

`test/provider-eval.test.mjs` now covers:

- the `candidate` accessor payload in both verification modes;
- an accessor for the fixed `__matrix_invoke` name;
- `Object.freeze(globalThis)` during module evaluation;
- a valid equivalent source still passing both modes;
- a loopback end-to-end run proposing the whole-file accessor plus assertion patch;
- pre-created old fixture paths, including a FIFO, not affecting a wrong source's failure;
- stdin input in `runProcess` staying out of the displayed command;
- the submitted source marker and completion token absent from the trust/execution audit.

The ordinary-path regression now observes:

```text
requests 2, applied 1
target pass · edit fail · test pass · package pass · scope pass · cleanup pass
verification fail
authoritative false · behavioral false
taskSuccess false · ok false
```

## Evidence

| Command                                                         | Result                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `node --test test/process.test.mjs test/provider-eval.test.mjs` | 40 tests, 40 pass, 0 fail, 0 skipped on Node 24.21.0 and 22.23.4      |
| `node --test test/provider-eval.test.mjs`                       | 22 tests, 22 pass, 0 fail, 0 skipped                                  |
| `npm run check` on Node 24.21.0                                 | exit 0 — 753 tests, 753 pass, 0 fail/skip; coverage 94.18/84.10/94.62 |
| `npm run check` on Node 22.23.4                                 | exit 0 — 753 tests, 753 pass, 0 fail/skip; coverage 94.21/83.92/94.64 |
| `npm run syntax`                                                | 177 modules checked with Node 24.21.0 and 22.23.4                     |
| `npx eslint eval/provider-eval.mjs lib/process.mjs test/...`    | exit 0                                                                |
| `npm run typecheck`                                             | exit 0                                                                |
| Prettier check on changed files                                 | clean after formatting                                                |

An intermediate Node 22 full run hit the known unrelated timing failure in
`test/provider-catalog.test.mjs:593` (`timeoutMs: 10`). That file passed 16/16 alone and
the final Node 22 full run passed 753/753. The earlier binding-repair focused
provider/redaction suite passed 143/143 on rerun after the same known flake; the final
full gates above cover it again with no failures.

Not run here: hosted CI, live providers or model-quality evaluation.

## Limits

The candidate is still executable code inside a VM. These repairs remove the mutable
candidate binding and the writable authoritative fixture, but a VM is not a general
security sandbox and the agent's own test run remains ordinary unsandboxed Node code.
A detached process that can inspect or signal the evaluator's child is a separate
process-isolation concern; this repair does not claim to close it. An unsettled
top-level `await` in submitted source can still consume the outer verification timeout
before failing closed, because the VM evaluation timeout does not interrupt pending
promises. Independent review must attempt new counterexamples against the closure, the
random invoker property, the stdin boundary, the marshaling boundary and the completion
receipt before this submission can be accepted.
