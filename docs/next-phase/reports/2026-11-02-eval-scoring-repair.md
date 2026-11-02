# Evaluator scoring repair — 2026-11-02 (host shim)

Implementer repair submission; independent re-review remains required. This is not an
acceptance decision. The reviewed provider candidate keeps its CHANGES REQUIRED (P1)
verdict until an independent reviewer re-runs the boundary.

A follow-up finding showed this first shim still stored the candidate in a mutable VM
global. That binding mechanism is superseded by the
[candidate-binding repair](2026-11-02-eval-candidate-binding-repair.md); the assertion
and serialization protections described below still apply.

Base: commit `4708709`, created outside this repair session. The 51-file provider
candidate at that commit has fingerprint
`f54ce83fcff21ae65168dd5b21d45c872d448933632f605d25915fe51859e763`, matching the
reviewed candidate. The repair-specific delta covers three evaluator files with
fingerprint `9c16cf8533adc9a10e0872df1dbeae72c33e8f39d62b02a10f434fc82946c9c6`.
Runtime: Node.js 24.21.0. This repair did not create a commit or push, and used no
live provider credentials or paid calls.

## Boundary repaired

`runAuthoritativeVerification` now writes two host-owned files for both modes:

- `src/bounds.js` is the host-controlled shim.
- `src/submitted.mjs` contains the final submitted bytes.

The original fixture test and the behavioral test both import `src/bounds.js`. Their
assertions and the per-run completion receipt stay in the host test realm. The shim
evaluates submitted source in a null-prototype VM context with runtime code
generation disabled, imports denied and the default console removed. Its exported
`keepLast`:

- validates that the input is an array of bounded primitive values;
- invokes the VM candidate with a context-realm array literal;
- copies the result length and each indexed primitive into a bounded string built
  inside the VM, rejecting non-primitive elements;
- parses that string in the host and returns a host-owned array to the assertion.

Correctness is no longer decided by `JSON.stringify` of a candidate-controlled value.
An inherited `toJSON`, accessor or proxy on the result cannot substitute the input.
`--experimental-vm-modules` is passed for both modes because both use the shim.

The agent's own test run is still ordinary workspace evidence and can be fooled by
in-process assertion patching. It is not the authority: task success requires the
agent verification **and** both independent runs, so a fooled agent run alone cannot
produce success.

## Regressions added

`test/provider-eval.test.mjs` now covers:

- patching `node:assert/strict` through a static import;
- patching it through `process.getBuiltinModule("node:assert/strict")`;
- substituting results through `Array.prototype.toJSON`;
- the combined `typeof process` reproduction from the review;
- a valid equivalent source passing both modes;
- both modes denying `node:fs` and `process.env` access;
- timeout and cancellation still failing closed.

The loopback end-to-end regression proposes the combined wrong source. It applies one
edit and observes:

```text
requests 2, applied 1
scope pass
authoritative false
behavioral false
verification fail
taskSuccess false
ok false
```

Three earlier tests assumed submitted source ran in-process with Node APIs. They were
rewritten because that execution is the boundary being removed. Submitted code can no
longer spawn descendants; process-group cleanup remains owned by the shared test path,
and timeout/cancellation coverage now uses a non-returning submission.

## Verification evidence

| Command                                      | Result                                 |
| -------------------------------------------- | -------------------------------------- |
| `node --test test/provider-eval.test.mjs`    | 18 tests, 18 pass, 0 fail, 0 skipped   |
| focused provider/redaction suite             | 141 tests, 141 pass, 0 fail, 0 skipped |
| `npm run syntax`                             | 177 modules checked with Node 24.21.0  |
| `npx eslint eval/provider-eval.mjs test/...` | exit 0                                 |
| `npm run typecheck`                          | exit 0                                 |
| Prettier check on changed JS/docs            | clean after formatting                 |

Not run here: the full `npm run check`/coverage gate, Node 22, hosted CI, live
providers or model-quality evaluation. The completion receipt and bounded execution
remain process-level evidence, not proof of sandbox security for arbitrary code.

## Limits

A VM is not a general security sandbox. This repair narrows the task to one pure
function and keeps scoring authority in the host; it does not make arbitrary
model-written programs safe to execute. The ordinary coding/test path still requires
the existing trusted-execution policy. Independent review must attempt new
counterexamples in the assertion, marshaling and completion-receipt families before
this repair can be accepted.
