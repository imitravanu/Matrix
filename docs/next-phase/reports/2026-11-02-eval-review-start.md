# Evaluator scoring review: initial checks — 2026-11-02

Candidate: commit `094642a0889184f85ec4618b72bd7336bceb335f`, clean working
tree before this report. Runtime: Node 24.21.0. This is a partial review, not
an acceptance decision or the complete PRV-106 adversarial audit.

Claim checked: the exported candidate, rather than candidate-controlled
serialization intrinsics, determines both scoring results. A correct copy of
the input should pass, while a function returning an empty array should fail.

An isolated script called `runAuthoritativeVerification` in both modes with
three import-free submissions: a valid spread-copy implementation; a wrong
implementation returning a proxy around an empty array; and a wrong
implementation that replaced `JSON.stringify`, `Array.isArray`, and
`Number.isSafeInteger` before returning an empty array. The valid source
passed both modes; both wrong sources failed both modes. These calls exercise
the real verification subprocess, but do not exercise the full provider loop.

`node --test test/provider-eval.test.mjs test/process.test.mjs` passed 40 of
40 tests, with no failures or skips. No live provider or credentials were used.

Still required: independent end-to-end counterexamples for the repaired
binding, stdin and receipt boundaries, including the documented detached-process
concern; the provider acceptance matrix; and the exact-candidate release gates.
The limited checks above do not establish that the VM is a security sandbox or
that the provider phase is ready for acceptance.
