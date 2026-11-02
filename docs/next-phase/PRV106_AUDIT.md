# PRV-106 audit assignment: evaluator scoring integrity

This is an assignment spec for the PRV-106 independent adversarial audit, not a
record of completed evidence. It operationalizes AUDIT.md, PROVIDER_AUDIT.md and
REVIEW_METHOD.md for one boundary: the committed PRV-105 evaluator scoring
candidate. The chief owns dispatch and acceptance; the auditor owns evidence.

## 1. Dispatch modes (chief marks exactly one)

- **Mode A — confirm the open findings now.** Two P1 findings are recorded against
  the committed candidate (`094642a`): unbound score-time bytes
  (`eval/provider-eval.mjs:538`, `checks.edit` at `:593` never compares bytes) and
  same-uid ptrace receipt forgery (live token disclosure from both scoring
  children, forged TAP, substituted `exit_group(0)`). In Mode A the auditor
  independently confirms each with their own counterexamples, then records a
  verdict so the chief can decide repairs on independent evidence.
- **Mode B — audit the repaired candidate.** If the chief dispatches a repair
  first, the auditor verifies the repair submission **and** constructs at least
  one alternate counterexample in each repaired failure family (REVIEW_METHOD
  requires the alternate family member, not a replay of the original input), plus
  fresh counterexamples for every other claim below.

In both modes the auditor investigates other mechanisms under the same matrix;
prior reports are context, never evidence.

## 2. Independence preconditions

- A **fresh session and reviewer** that is neither the implementer nor the prior
  same-session review. Prior artifacts to treat as context only:
  [initial checks](reports/2026-11-02-eval-review-start.md),
  [repair submission](reports/2026-11-02-eval-candidate-binding-repair.md),
  [implementer sweep](reports/2026-11-02-eval-scoring-e2e-review.md) and
  [integrity review](reports/2026-11-02-eval-scoring-integrity-review.md).
- **Own kit.** Fresh scripts and loot directories (e.g. `/tmp/opencode/prv106-kit/`);
  never reuse prior fixtures as evidence, and never restate a prior report's
  numbers as observations.
- **No upside pressure from process.** The audit does not modify runtime code,
  does not commit, push or rebase, and does not repair what it finds. Findings are
  documented; repairs belong to a separate implementation wave.

## 3. Identity, environment, hygiene

- Record candidate identity: HEAD commits, the scoring-delta file fingerprint
  (`eval/README.md`, `eval/provider-eval.mjs`, `lib/contracts.mjs`,
  `lib/controller.mjs`, `lib/model-agent.mjs`, `lib/process.mjs`,
  `test/provider-eval.test.mjs`, `test/process.test.mjs` — eight files after the
  2026-11-02 in-flight isolation repair),
  runtime profile (Node version, platform, `kernel.yama.ptrace_scope`).
- Recompute the fingerprint at the end of every session and state whether runtime
  code changed during the audit.
- Discipline: temporary workspaces and temporary `MATRIX_HOME`; loopback-only
  provider endpoints with a fake bearer key (record `network: loopback` evidence);
  no real credentials, no paid providers, no unrelated processes, no unrelated
  files. Detached helpers and watchers must be confined to processes created by
  the audit harness and must be killed by it (record pids in the loot). All
  sub-tests run on Node 22 **and** Node 24 where the claim applies to the
  evaluator loop.

## 4. Claims first, controls second

Write the claim table before inspecting tests (REVIEW_METHOD §1). The minimum set:

| Claim                                       | Counterexample the auditor constructs themselves                                           | Evidence to capture                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Scored bytes are the submitted bytes        | Post-apply unauthorized rewrite; any writer, any window the auditor designs                | Proposal bytes, on-disk bytes at read time, full report fields |
| Verdict facts come only from the honest run | Forged output or forged sources in the auditor's chosen form (streamed TAP, counts, exits) | Captured stream, exit status, receipt line, each gate result   |
| Receipt token exists only for the evaluator | Memory read or any disclosure channel of their choosing                                    | Disclosed token vs internal token; per-gate accept state       |
| Submitted bytes stay inert inside the VM    | Import-free payload performing host-visible work                                           | Marker files, error class, a second gate pass attempt          |
| Workspace fixtures remain authoritative     | Decoys, FIFOs, symlink or path races the auditor designs                                   | Digests, denials, actual consumed paths                        |
| Report semantics cannot be laundered        | Wrong source plus interference reaching any single `ok`-like field                         | Full report JSON; `not-evaluated` vs `fail` distinctions       |

The claim wording above is the auditor's to refine; the table is a floor, not a
ceiling. A counterexample that cannot be demonstrated is labeled **unverified**
with the limitation stated, never omitted.

Controls run before any attack and must discriminate: a correct-source proposal
reaching `taskSuccess: true` with all checks passing, and an import-free wrong
source failing closed with observable failure semantics. If a control fails, the
audit stops and reports a harness defect before adversarial conclusions.

## 5. Mechanism isolation matrix

One family per run so an early failure cannot mask a later vulnerable boundary.

1. Candidate binding and serialization.
2. Stdin authority and fixture integrity (test file and `package.json` bytes).
3. Receipt and exit integrity (forgery surfaces of the auditor's choosing; the
   host's ptrace state is recorded but not assumed in either direction).
4. Detached-process interference (spawn paths, discovery races, process
   lifetime, cleanup).
5. Report and acceptance semantics (per-check composition, `taskSuccess`, `ok`,
   verification status laundering).

Each family produces its own expected-vs-observed record, retained fixture
scripts, and loot. Test an alternate member of a family when auditing a repair.

## 6. Gate and regression evidence the audit itself runs

- `node --test test/provider-eval.test.mjs test/process.test.mjs` on Node 22 and
  Node 24, results recorded in the report.
- One full `runProviderEvaluation` loop per matrix cell that needs end-to-end
  evidence (loopback provider; no verdict mocking; the report's own fields are
  the surface under test).
- The audit does not substitute for the full engineering gates (`npm run check`,
  `npm run smoke`, `npm run pack:check`) — those remain chief-level P3 items.

## 7. Report and decision flow

- One report under `docs/next-phase/reports/` with all six required elements:
  exact candidate identity and scope; reproduction commands or retained fixture
  scripts; expected versus observed; findings with severity, tight code locations
  and repair directions (no implementation); test results and explicit gaps; and
  a clear verdict — **CHANGES REQUIRED**, **no findings within the tested scope**,
  or **incomplete with a specific named blocker** — plus an explicit independence
  statement.
- `STATUS.md` rows added by the auditor record evidence, never acceptance. PRV-105
  task state transitions require the chief.
- What this audit can close: the P2 "independent adversarial evidence" cell for
  the evaluator scoring boundary. What it cannot close: remaining P0/P1/P3 cells,
  other provider tasks (PRV-102/103/104), release and packaging review.

## 8. Suggested kit sketch (examples, not prescriptions)

- Loopback SSE provider returning `propose_edit` with the auditor's payload (see
  REVIEW_METHOD's counterexample table for model-flow pitfalls; one follow-up
  request per round unless multiple rounds are intended).
- A child-forge/discovery tool of the auditor's own building; record `gcc`
  availability and the actual syscall technique used.
- Loot directories per mode; a cleanup pass that kills recorded pids, verifies
  `ps`/`/proc` emptiness and removes loot.

Referenced code anchors from prior reviews — verify them yourself before relying
on any of them: `provider-eval.mjs` reads the workspace source at score time
around line 538, `checks.edit` composes around line 593, the scoring VM rejects
imports at lines 222–231, token generation/embedding sits at lines 282/303.

## 9. Safety contract for this audit

Adversarial process inspection is confined to processes the audit harness
created; a sacrificial child validates each primitive before any live-run use;
every attach is against harness-owned pids only; loot is cleaned up after every
session. Terminate every spawned helper before finishing; never leave background
runners or watchers alive.
