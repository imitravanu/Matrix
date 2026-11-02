# PRV-105 opt-in provider evaluation — 2026-11-02

> Follow-up: two review defects (a weakened test still passing and the preflighted
> credential being ignored during execution) were repaired the same day. See the
> [review repair report](2026-11-02-provider-eval-review-repairs.md); the counts below are
> the original submission's evidence.

Status: **SUBMITTED**, self-tested. This is not an acceptance of PRV-105 and does not
establish that PRV-102/103/104 interfaces are accepted. The delivery was made under the
owner's continuing gate exception while those tasks remain SUBMITTED/PARTIAL.

## Delivered

- `eval/provider-eval.mjs` — an explicitly invoked provider evaluation path, separate from
  the default `npm run eval` profile. It requires `--provider <id>` and
  `--model <exact-id>`, resolves the same validated target normal execution uses, and runs
  one deterministic coding task through the real controller and model agent.
- `test/provider-eval.test.mjs` — five cases: a complete loopback-provider edit with real
  patch application and verification; prose-only output that is not task success; an HTTP
  failure reported honestly with cleanup; a real CLI subprocess that writes and redacts the
  report; and strict argument parsing.
- `npm run eval:provider` — the CLI entry point. `--help` prints usage and unknown/missing
  arguments fail before any configuration load or request. `--json` prints the same report
  object that is written to disk.
- `eval/README.md` and `README.md` — evidence class, scope, report location and the
  no-live-quality/availability/pricing/context/latency limitation.
- `docs/next-phase/STATUS.md` — PRV-105 moved from BLOCKED/Unassigned to SUBMITTED with the
  prerequisite caveat above.

## Behavior

- The fixture is a temporary workspace containing `package.json`, a buggy `src/bounds.js`
  and a test file. The expected edit is exact (`return items.slice(0, items.length)`), and
  task success requires that changed source, a passing verification through the separate
  test-approval path (auto-approved only inside the disposable copy), an `ok` outcome, and
  confirmed cleanup. A successful agent outcome without an applied edit is not task
  success; prose is not evidence.
- The controller home, backups and workspace live under one temporary tree. Approvals are
  auto-scoped to that disposable copy. Shell/command tools stay disabled. The tree is
  removed on success, agent failure, HTTP failure and watchdog abort; the report records
  whether the controller was disposed and whether the root actually disappeared.
- Preflight rejects an unknown profile, a Local Forge/local selection, and a missing
  credential before any request. A failed binding or provider/agent failure is returned as
  a failed report with `outcome.error`, not converted to success.
- The report separates `target`, `edit`, `verification` and `cleanup`, each `pass`, `fail`
  or `not-evaluated`; it records provider/model/config identity, endpoint, auth type and
  env-var name (never the value), task revision and SHA-256 digest, runtime, network class,
  outcome status/error, verification summary, applied paths, rounds, tool calls, finish
  reason, usage provenance and unknown costs as `null`.
- A 60-second watchdog aborts the run. Reports are bounded/redacted: the canary key and
  temporary absolute path are asserted absent from serialized output. `eval/reports/` stays
  gitignored; the default reviewed baseline is never touched.

## Verification

Node 24.21.0 on this host:

- `node --test test/provider-eval.test.mjs` — 5 tests, 5 pass, 0 fail, 0 skipped.
- `npm test` — 716 tests, 716 pass, 0 fail, 0 skipped.
- `npm run check` — exit 0; 176 modules syntax-checked; 716 tests; coverage 94.20% lines /
  84.21% branches / 94.53% functions, every floor passing.
- `npm run eval` — 16/16 contract pass, baseline PASS, 0 safety violations, cleanup
  complete. This confirms the default evaluation remains offline and unchanged, including
  its credential-free path.
- `node eval/provider-eval.mjs --help` — exit 0 with usage; no arguments — exit 1 with
  `provider eval requires --provider <id>` and no request.
- `npm run pack:check` — 90 files packed (dry-run), no tarball; `eval/` is outside the
  published `files` list.

The loopback fake provider is the only provider exercised. No live/paid provider was
called, and no live availability, quality, pricing, context-length or latency claim is
made. Node 22 and hosted CI were not run for this candidate.

## Not done

- Independent review/reproduction of this evaluation path.
- A PRV-106 adversarial audit and the PRV-107 integrated release decision.
- Acceptance of PRV-102/103/104, on which PRV-105 formally depends.
- Any real-provider run; the interface exists but remains an explicit future opt-in.
