# PRV-105 evaluation review repairs — 2026-11-02

Status: **SUBMITTED**, self-tested. This does not accept PRV-105; PRV-102/103/104
interfaces remain unaccepted, and an independent reviewer must reproduce both cases.

## P1 — A weakened test assertion still reported PASS

`runProviderEvaluation` checked the final `src/bounds.js` bytes and the verification
result, but never checked the fixture's test file. A model could make the required source
edit and replace the assertion in `test/bounds.test.mjs` with `assert.ok(true)`; the
weakened suite passed and the report said `taskSuccess: true`.

Repair:

- The evaluator now captures the final test-file bytes and rejects any run with an applied
  edit to `test/bounds.test.mjs`, including an edit that is later reverted.
- A separate `test` check is reported alongside `target`, `edit`, `verification` and
  `cleanup`. `taskSuccess` and the overall `ok` require `test: pass`.
- The text report prints the test check so a reader cannot see `verification pass` without
  the failed fixture integrity beside it.

Regression: a loopback provider applies the correct source edit, then proposes a
replacement of the assertion with `assert.ok(true)`. Verification genuinely passes on the
weakened test, but the report records `outcome.status: success`, `verification: pass`,
`checks.test: fail`, `taskSuccess: false` and `ok: false`.

## P2 — Preflighted credential was ignored during execution

The evaluator called `bindProviderTarget(target, env)` before starting, then passed only
`providerTarget` to the controller. The model agent rebound the target from `process.env`,
so an explicit `env` credential that had passed preflight was ignored; execution used the
process environment instead.

Repair:

- The already-bound `{ credential, endpoint, ok, error }` decision is passed through
  `controller.start()` as `providerBinding` and forwarded to `runModelAgent()`.
- The model agent uses that binding for the transport and for the command-audit redactor.
  Callers that omit it still bind once from their `env` argument, preserving existing
  behavior. The credential is not logged or persisted.
- The provider evaluation passes the exact preflight binding into the run.

Regression: `process.env.LAB_API_KEY` is set to a wrong canary while
`runProviderEvaluation` receives `env: { LAB_API_KEY: <expected> }`. The loopback server
returns 401 unless it receives the expected bearer value. The run succeeds and both
requests carry the expected credential; before the repair it would fail with the process
value.

## Verification

Node 24.21.0 on this host:

- `node --test test/provider-eval.test.mjs` — 7 tests, 7 pass, 0 fail, 0 skipped.
- `npm run check` — exit 0; **719 tests, 719 pass, 0 fail, 0 skipped**; 176 modules
  syntax-checked; coverage 94.20% lines / 84.20% branches / 94.59% functions, every floor
  passing.
- `npm run eval` — 16/16 contract pass, baseline PASS, 0 safety violations, cleanup
  complete. The default offline eval and its baseline are unchanged.

No live provider was called. Node 22 and hosted CI were not run. The repairs remain
self-tested until an independent reviewer reproduces both cases.
