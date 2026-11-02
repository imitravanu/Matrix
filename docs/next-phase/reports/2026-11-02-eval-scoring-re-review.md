# Evaluator scoring re-review — 2026-11-02

Verdict: **CHANGES REQUIRED (P1)**. This is an independent follow-up review
started in a new review session. No runtime or test code was changed.

Candidate: base HEAD `e1b3c66`, uncommitted working tree, 51 changed/untracked
runtime/test/config files, fingerprint
`f54ce83fcff21ae65168dd5b21d45c872d448933632f605d25915fe51859e763`.
That fingerprint matches the final-repair submission. Runtime observed:
Node.js 24.21.0. The focused provider/redaction suite passed 139 tests with no
failures or skips.

## P1 — submitted source controls both verification authorities

The task revision v4 requires the original fixture verification and a separate
pure-function behavioral gate to pass, each with a completion receipt. Both can
be made to pass by a deliberately wrong `keepLast` that returns `[]`.

### Mechanism 1 — authoritative run assertions are mutable

`runAuthoritativeVerification` writes the submitted source beside the original
test and runs the test in one Node process. The test statically imports
`node:assert/strict` before importing the submitted source. The submitted
module can therefore mutate the shared assertion object before any assertion
runs:

```js
if (typeof process !== "undefined") {
  const a = process.getBuiltinModule("node:assert/strict");
  a.deepEqual = () => {};
  return [];
}
```

`assert.deepEqual` is writable. The original assertions become no-ops, the
completion token still prints, and the result is `ok: true`.

### Mechanism 2 — behavioral gate serializes a candidate-controlled value

The behavioral harness calls the candidate, checks `Array.isArray`, then passes
the returned array to a captured `JSON.stringify`. `JSON.stringify` reads the
value's inherited `toJSON` property, which the candidate controls:

```js
globalThis.__last = items;
Array.prototype.toJSON = function () {
  return globalThis.__last;
};
return [];
```

A wrong implementation that always returns `[]` thereby serializes as its
input for every assertion. All four behavioral cases pass with `ok: true`.

### End-to-end reproduction

A loopback provider proposed a source that branches on `typeof process`:
patch `assert.deepEqual` in the authoritative run, use `Array.prototype.toJSON`
in the behavioral run, and always return `[]`. The real controller applied the
edit and ran the ordinary verification. The report observed:

```text
requests 2, applied 1
checks: target/edit/test/package/scope/verification/cleanup all pass
verification: verified
authoritative: true
behavioral: true
taskSuccess: true
ok: true
deniedPaths: []
```

This is the same failure family as the earlier early-exit/forged-output
finding: the verdict is still controlled by code the submitted module can
mutate. It is not a VM escape; the new null-prototype context closes the
reproduced host-constructor path. The remaining authority leak is in the
assertion and serialization boundary.

### Required behavior

The scoring verdict must be controlled by assertion state and result values
that the submitted module cannot mutate.

- Capture the exact assertion functions before submitted code evaluates, or run
  assertions in a separate process that does not import the submitted module.
  The token must not be readable from a file the model code can access during
  the authoritative run.
- Do not serialize candidate-controlled objects with `JSON.stringify` to decide
  correctness. Copy array length and indexed primitives into a host-owned
  structure, reject non-primitive elements, and compare that structure with the
  expected primitives.
- Add regressions for both mechanisms: patching an assertion method before the
  first assertion, and a wrong return value whose only correction is a
  tampered `toJSON`/proxy serialization.

## Provider cache invalidation — independent PASS

A temporary home with a loopback probe observed:

```text
firstRecorded true, records before 1
external endpoint edit B: records 0
restore exact bytes A: records 0
synchronizeProviderCache: true, records 0
fresh probe: recorded true, records 1
```

The direct-edit A → B → A path fails closed: old probe evidence does not
reappear after endpoint reversion or cache adoption, and a new probe records
under the new generation. This supplements, and does not replace, the
platform/filesystem failure testing requested on the board.

## Scope and limits

- Not evaluated here: Node 22, the full `npm run check`, `npm run eval`,
  hosted CI, live providers or model quality, and the complete PRV-106 matrix.
- The prior 746-test and 741-test counts are implementer evidence, not
  independent acceptance.
- PRV-101–104 remain SUBMITTED/PARTIAL. This review does not accept them and
  does not close the provider phase.
- No real credentials, paid calls, commits, or pushes were used.
