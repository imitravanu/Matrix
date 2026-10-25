# Matrix Engineering Execution Plan

This is the stable, phase-wise backlog for follow-up coding agents. Read
[ENGINEERING_REVIEW.md](ENGINEERING_REVIEW.md) for evidence and [AGENTS.md](AGENTS.md) for workflow and
non-negotiable invariants.

## 1. Task protocol

- **Statuses:** `DONE` means implemented and acceptance-tested in the current working tree; `READY`
  means dependencies are satisfied; `IN PROGRESS` means implementation exists but validation remains;
  `BLOCKED` means another task must land first.
- **Priorities:** `P0` stop-ship safety/data loss; `P1` correctness/trust/recovery; `P2` scale,
  accessibility, operability; `P3` strategic/release capability.
- **Sizes:** `S` focused module and tests; `M` coordinated multi-module change; `L` architectural or
  multi-wave work. Size is scope, not a time estimate.
- Claim one task ID, record ownership before editing, and leave exact test results in the handoff.
- Do not reset or revert the current working tree. It contains the completed hardening tasks below.
- Every task needs regression tests and documentation when behavior changes. `DONE` requires the
  complete network-free suite and relevant smoke/stress checks, not only a focused test.

### High-collision ownership

| Files                                               | Rule                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/matrix.mjs`                                    | One owner at a time. Complete lifecycle/UI behavior before `REF-001`.             |
| `lib/model-agent.mjs` + `test/model-agent.test.mjs` | One provider/core owner per wave.                                                 |
| `bin/matrix.mjs` + `lib/cli.mjs`                    | One CLI owner per wave.                                                           |
| `package.json` + `package-lock.json`                | One manifest owner per wave; no incidental dependency edits.                      |
| `test/helpers.mjs`                                  | Centralize shared fixture changes in `TEST-001`; other tasks keep fixtures local. |
| `README.md`, `MATRIX.md`, these planning docs       | Integrator owns shared documentation during parallel waves.                       |

## 2. Completed baseline — do not reassign

| Task                                                                | Status   | Completion evidence                                                                                                                     |
| ------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `SAFE-001` — disable arbitrary shell execution                      | **DONE** | Tool schema/prompt removal, runtime denial, no-spawn/no-write regression.                                                               |
| `SAFE-002` — existence-based file creation                          | **DONE** | Existing unreadable and approval-window creation races refused; genuine creation still works.                                           |
| `SAFE-003` — first credential-exposure controls                     | **DONE** | Sensitive remote reads denied; test-child environment scrubbed; sentinel tests.                                                         |
| `PROV-001` — provider routing and explicit model selection          | **DONE** | Provider-bound endpoint/key tests, model-aware guards, strict unknown CLI models.                                                       |
| `PROV-002` — tool status and per-call budget                        | **DONE** | Denied/failed tool status and 24-call execution cap with incomplete outcome.                                                            |
| `PROV-003` — streaming transport and SSE correctness                | **DONE** | Bounded deadlines/buffers, safe retries, cancellation, raw-byte SSE fixtures, and 19 provider tests.                                    |
| `PROV-004` — tool assembly, schemas, and context budgets            | **DONE** | Stable call identity, strict argument validation, structured truncation, and call/argument/context budget tests.                        |
| `STATE-001` — raw undo fingerprints and single-patch creation state | **DONE** | Exact-cap append refusal and creation metadata preservation/guards.                                                                     |
| `STATE-002` — immediate, retryable undo                             | **DONE** | Applied-time publication, failure recovery, and journaled partial undo with pending backups.                                            |
| `STATE-003` — versioned multi-file session undo                     | **DONE** | `undoRun` with ordered/coalesced entries, conservative migration, and real multi-file/creation resume tests.                            |
| `CORE-001` — approved Local Forge rename                            | **DONE** | Five-stage plan and real approved rename/verification test.                                                                             |
| `CORE-002` — unified outcome and event semantics                    | **DONE** | Shared classifier, consistent controller/CLI/swarm/UI outcomes, terminal event order, and abort/timeout/budget coverage.                |
| `PROV-005` — usage provenance and recovery/conversation             | **DONE** | Provider/estimated/mixed/unavailable accounting, bounded follow-up history, healing, recovery guidance, and UI/session integration.     |
| `SEC-001` — repository/test trust and auditing                      | **DONE** | Exact plan/script trust, interactive first-use approval, headless allow decisions, private bounded audits, and redaction.               |
| `PERF-004` — parser and search scaling                              | **DONE** | One-pass Python/JS scope analysis, lexical prefilters, safe ancestry, budgeted search, and measured large-nesting improvements.         |
| `PERF-005` — swarm, graph, and raster optimization                  | **DONE** | Structural sharing, batch reduction, constant-time parent lookup, numeric raster loops, and byte-equivalence benchmarks.                |
| `CLI-001` — argv and public result validation                       | **DONE** | Strict CLI validation plus aligned outcome, elapsed, usage provenance, and recovery fields.                                             |
| `PERF-002` — live/session/event retention                           | **DONE** | Newest-first count/byte limits, metadata indexes, reference-aware retention, and visible persistence warnings.                          |
| `PERF-003` — indexing work budgets and deduplication                | **DONE** | Real work caps, async deduplicated scans, manifest identity, invalidation, freshness policy, and render-path migration.                 |
| `UX-004` — retained verification output                             | **DONE** | Failed-output tails, Alt+O expansion, full retained scrolling, long-line wrapping, and truncation counts.                               |
| `BENCH-001` — reproducible stress benchmarks                        | **DONE** | Thirty-two local-only cases with opt-in stress, p50/p95/max, memory/byte metadata, and cleanup guarantees.                              |
| `PERF-001` — transcript and idle rendering scalability              | **DONE** | Bounded cached viewports, collapsed-reasoning previews, settled/visible-only animation, and cached credential state.                    |
| `REF-001` — split the orchestrator by responsibility                | **DONE** | Presentational, codec/result, event, keyboard, and view contracts extracted; render-only dependency boundary proven.                    |
| `TOOL-001` — real static and coverage engineering gate              | **DONE** | Syntax, lint, JSDoc/checkJs, formatting, and 12 critical-module coverage ratchets pass clean installs on Node 22/24.                    |
| `REL-001` — private package and release posture                     | **DONE** | ISC license, changelog, release checklist, and a 59-file dry-run pack allowlist preserve private/main/bin compatibility.                |
| `DIFF-001` — multi-hunk and edit-coordinate correctness             | **DONE** | Original-coordinate multi-hunk round trips and non-finite rejection.                                                                    |
| `DIFF-002` — lossless newline and encoding behavior                 | **DONE** | Explicit EOL/EOF metadata, mixed-EOL refusal, standard marker support, and 60 deterministic round-trip fixtures.                        |
| `PROC-001` — process-output correctness and bounds                  | **DONE** | Stream/UTF-8/long-line/noisy-summary/latest-400/direct-UI bounds and timer cleanup tests.                                               |
| `PROC-002` — verification confidence and process outcome            | **DONE** | Explicit `processOk`/`verified`/`verificationStatus`, unrecognized-output refusal, recognized zero-test policy, and Cargo/Go fixtures.  |
| `UX-001` — deterministic prompt and live navigation                 | **DONE** | Real typing-pause and active-run navigation regressions.                                                                                |
| `UX-002` — complete, linear diff review                             | **DONE** | Exact long-line preservation and linear wrapping tests/probe.                                                                           |
| `UX-003` — live gate and model/status truth                         | **DONE** | Read-only `/diff`, `/new` reset, key hints, and estimate/unknown labels.                                                                |
| `TEST-001` — deterministic and hermetic test harness                | **DONE** | State-based app waits, terminal adapter/lifecycle tests, shared env/fetch traps, and full suite passes with hostile provider variables. |
| `A11Y-001` — contrast and monochrome contracts                      | **DONE** | WCAG role tests, functional-color cleanup, direct Vision/dump monochrome tests, and honest Doctor guidance.                             |
| `UX-005` — keyboard, reduced-motion, and semantic UI                | **DONE** | Scrollable help at 40×20, all-eight-view geometry checks, static reduced motion, and textual Vision/screen-reader content.              |
| `DOC-002` — executable documentation contracts                      | **DONE** | Slash/key/tool/view/recovery documentation is checked by `test/docs.test.mjs`.                                                          |

**Current baseline:** 381/381 tests on local Node 24.21.0 and 22.23.4, plus 381/381 with hostile fake
provider variables on Node 24; 32/32 responsive smoke checks; 32 benchmark cases; 99 module syntax checks;
94.34% line / 83.48% branch / 93.92% function V8 coverage on Node 24; and zero npm-audit findings.
`npm run check` and the 59-file `npm run pack:check` pass locally. Hosted Node 22/24 validation remains pending.

## 3. Phase summary and execution waves

| Phase                                 | Goal                                                                                     | Exit gate                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **1 — Lifecycle and trust**           | Finish undo/session, outcome, provider protocol, diff, and verification contracts.       | No open P0/P1 correctness finding; all success/denial/abort/timeout/failure paths agree. |
| **2 — Operator experience and scale** | Make failures inspectable and work bounded on real repositories and long sessions.       | Accessibility essentials and stress benchmarks pass with documented budgets.             |
| **3 — Architecture and release**      | Reduce coupling, make checks hermetic/reproducible, and establish CI/package gates.      | Node 22/24 CI, static checks, clean packaging, and documentation contracts pass.         |
| **4 — Frontier capability**           | Add evidence-driven agent evaluation and only then real isolated parallelism/sandboxing. | Measured agent quality with no safety regression; advanced claims match implementation.  |

### Recommended parallel waves

1. **Wave A:** `DIFF-002`, `PROV-003`, and `TEST-001` are complete. `CI-001` has a workflow with
   normal and hostile-provider gates and awaits hosted Node 22/24 validation. Integrator owns docs.
2. **Wave B:** `PROC-002`, `STATE-002`, `STATE-003`, `PROV-004`, and `CORE-002` are complete. Next are
   `PROV-005` and `CLI-001` result alignment, plus `SEC-001` for a separate trust owner.
3. **Wave C:** `SEC-001`, `UX-004`, `PERF-001`, `PERF-002`, `PERF-003`, `PERF-004`, `PERF-005`, and
   `BENCH-001` are complete. Local Node 22/24 gates pass; hosted CI remains the only open scale/CI gate.
4. **Wave D:** `REF-001`, `TOOL-001`, `DOC-002`, and `REL-001` are complete. CI is configured for the
   full static/test gate, package inspection, dependency audit, hostile tests, smoke, and benchmarks;
   hosted Node 22/24 validation is still required.
5. **Wave E:** `EVAL-001`, then `ADV-002` and `ADV-001` only after all Phase 1–3 gates pass.

Dependencies are minimum ordering, not permission to edit overlapping files concurrently.

## 4. Phase 1 — Lifecycle and trust

### `STATE-002` — Publish undo immediately and make partial undo retryable

**Priority:** P1 · **Size:** M · **Status:** DONE
**Owns:** `lib/controller.mjs`, `lib/session.mjs`, `test/controller.test.mjs`

- Publish the new run's undo stack on the first `applied` event while preserving the previous stack
  for genuinely no-edit runs.
- Journal each successful restore immediately; retain only failed/unattempted entries and their backups.
- Acceptance: observers at `applied`, `result`, and `done` see current undo state; an injected agent
  exception after a write remains undoable; injected mid-undo failure is retryable; partial success is
  explicitly reported and persisted.

### `STATE-003` — Version complete run-level undo in sessions

**Priority:** P1 · **Size:** L · **Status:** DONE
**Owns:** `lib/session.mjs`, `lib/controller.mjs`, session codec in `src/matrix.mjs`, session tests

- Add `undoRun` with schema version, ordered/coalesced entries, creation flags, post-image
  fingerprints, and backup references. Keep `lastPatch` only for backward migration.
- Save only after current undo state is published; never truncate exact recovery bytes as transcript data.
- Acceptance: two edited files plus one created file survive real save/load/resume/undo; same-file edits
  restore pre-run bytes; old sessions either migrate safely or honestly disable incomplete undo.

### `CORE-002` — Unify terminal outcome and event semantics

**Priority:** P1 · **Size:** L · **Status:** DONE
**Owns:** agents, `lib/controller.mjs`, result projection in `bin/matrix.mjs`, `lib/swarm.mjs`, tests

- Introduce one classifier for success, denial, failure, unverified, timeout, abort, and budget exhaustion.
- After every process await, check abort/timeout before starting another model round or process.
- Emit final metrics before `result`; `done` is always last. Preserve applied-edit recovery guidance.
- Acceptance: local fix/rename/test-only and remote explicit/automatic verification have identical
  outcomes; failed verification is never success; denied edits remain non-error completions; headless
  exit codes, controller `ok`, swarm mode, elapsed time, and persisted metrics agree.

### `DIFF-002` — Make newline encoding and diff generation lossless

**Priority:** P1 · **Size:** M · **Status:** DONE
**Owns:** `lib/diff.mjs`, `test/diff.test.mjs`

- Represent EOF-newline transitions; preserve per-line terminators or explicitly reject mixed-EOL rewrites.
- Count header-like source lines from parsed hunks, not broad `+++`/`---` prefix filtering.
- Acceptance: LF/CRLF/final-newline/newline-only/mixed-EOL cases round-trip exactly; randomized
  multi-hunk insertion/deletion/replacement fixtures with repeated context pass; no invisible EOL change.

### `PROC-002` — Separate process success from understood verification

**Priority:** P1 · **Size:** M · **Status:** DONE
**Owns:** `lib/process.mjs`, `lib/project.mjs`, `test/process.test.mjs`; lifecycle owner also owns result consumers

- Define `verified`, `unverified`, `failed`, `skipped`, timeout, and abort independently of exit code.
- Define zero-test and truncation policy; add Cargo/Go fixtures and honest generic handling for Maven/Gradle.
- Acceptance: empty/unrecognized zero-exit output cannot produce a green verified result or zero-status
  agent run; recognized zero-test behavior is explicit; truncated output cannot manufacture confidence.

### `PROV-003` — Harden streaming transport and SSE parsing

**Priority:** P1 · **Size:** L · **Status:** DONE
**Owns:** `lib/openrouter.mjs`, `test/openrouter.test.mjs` (keep raw fixtures local to this suite)

- Add configurable connect, idle-stream, and total deadlines composed with caller abort; cancel bodies on exit.
- Bound SSE/event/error-body bytes; parse data with/without spaces, multiline data, CRLF, and final unterminated events.
- Reject malformed/non-SSE success responses. Retry only bounded safe pre-execution failures with backoff/`Retry-After`.
- Acceptance: raw-byte and stalled-stream tests settle without unhandled rejection; no valid event is lost;
  malformed completion is an error; retry caps and abort-during-backoff are proven without network.

### `PROV-004` — Make tool assembly, schemas, and context budgets protocol-safe

**Priority:** P1 · **Size:** L · **Status:** DONE
**Owns:** `lib/model-agent.mjs`, `test/model-agent.test.mjs`

- Assemble parallel calls by stable identity, not a default zero index; validate plain-object arguments before labels.
- Remove source-altering regex repair; return protocol-valid errors for invalid calls and structured truncation for results.
- Enforce per-response and total call/argument/context budgets while retaining the completed 24-call cap.
- Acceptance: two no-index calls remain distinct; null/scalar input never crashes a run; source stays byte-exact;
  excess calls never execute; oversized results remain valid JSON with truncation metadata.

### `PROV-005` — Add usage provenance and deliberate recovery/conversation semantics

**Priority:** P2 · **Size:** L · **Status:** DONE
**Owns:** `lib/model-agent.mjs`, `lib/models.mjs`, usage UI/session projections, provider tests

- Distinguish provider, estimated, mixed, and unavailable usage/cost; prefer provider charges when present.
- Choose bounded follow-up history or explicitly document stateless tasks and remove dead context API.
- Apply bounded healing to explicit and automatic failed verification; make failure-after-edit recovery explicit.
- Acceptance: mixed-round usage and headers/session/graph agree; no invisible estimate mixing; two-run
  conversation tests prove the chosen contract; time-sensitive registry metadata is sourced/dated or downgraded.

### `SEC-001` — Establish repository/test trust and durable privacy-reviewed audit

**Priority:** P1 · **Size:** L · **Status:** DONE
**Owns:** trust/policy modules, process invocation, controller audit, session retention, tests

- Add first-use workspace and test-plan/script-hash trust showing the actual script, not only `npm test`.
- Distinguish explicit user `/test` from model-triggered/automatic tests. Record durable start/end status before/after execution.
- Redact sensitive output and define session/run-log permissions and retention; do not persist secrets indiscriminately.
- Acceptance: no untrusted test starts before its required decision; abort/crash retains a truthful audit record;
  sentinel secrets are absent from children, provider requests, and logs; headless has equivalent auditing.

### `CLI-001` — Strict argv and public CLI result validation

**Priority:** P1 · **Size:** M · **Status:** DONE
**Owns:** `lib/cli.mjs`, `bin/matrix.mjs`, `test/cli.test.mjs`, `test/cli-integration.test.mjs`

Strict integer/value validation, positional validation, command-specific flags, help hints, and
elapsed/result alignment are implemented with unit/integration regressions. Usage provenance remains
for `PROV-005`; do not mark this task `DONE` until that consumer contract lands.

- Require complete positive integers; reject flag-as-value, invalid Vision modes, stray positionals, and incompatible flags.
- Preserve task joining, `--`, `--flag=value`, and paths with spaces. Add concise help guidance on errors.
- Acceptance: malformed input fails before work with tested stderr/exit status; elapsed/usage/result fields
  match `CORE-002`/`PROV-005`; no network or write occurs during validation failures.

## 5. Phase 2 — Operator experience and scale

### `UX-004` — Expose retained verification output

**Priority:** P2 · **Size:** M · **Status:** DONE
**Owns:** `src/cards.mjs`, `src/screens/chat.mjs`, `src/matrix.mjs`, card/app tests

- Add collapsed and expanded output views for agent tests and direct `/test`, with `/output` or an explicit Alt shortcut.
- Use the completed latest-400/truncation metadata; wrap long lines and make every retained line scrollable.
- Acceptance: failing output is immediately diagnosable; users can inspect all retained lines; UI says
  “last N of M” when truncated rather than claiming completeness; sessions retain only bounded safe output.

### `UX-005` — Complete keyboard, reduced-motion, and semantic UI modes

**Priority:** P2 · **Size:** L · **Status:** DONE
**Owns:** `src/screens/*`, `src/matrix.mjs`, `lib/term.mjs`, `lib/wordmark.mjs`, UI tests

- Make help scrollable/pageable at 40×20 with visible position; cover all eight views at every required geometry.
- Add reduced motion with no unused animation timers, semantic screen-reader labels, and textual Vision summaries.
- Acceptance: every essential key/action, phase, patch, error, test total, and Vision datum is available without
  animation, color, pixels, or a tall terminal; idle reduced-motion mode produces no animation renders.

### `A11Y-001` — Enforce contrast and monochrome contracts

**Priority:** P2 · **Size:** M · **Status:** DONE
**Owns:** `lib/forge.mjs`, UI color call sites, `lib/raster.mjs`, Vision CLI, new contrast tests

- Add the referenced contrast suite for text/muted/status roles on normal/add/delete backgrounds.
- Move remaining functional copy off `dim`; keep it only for decoration.
- Acceptance: `NO_COLOR`, `--mono`, and `--no-color` emit no color escapes in direct Vision; readable ASCII
  remains; Doctor describes actual behavior; all essential screen-reader/monochrome tests pass.

### `PERF-001` — Eliminate idle and full-history render amplification

**Priority:** P2 · **Size:** L · **Status:** DONE
**Owns:** `src/matrix.mjs`, `src/screens/chat.mjs`, `src/cards.mjs`, wordmark/credential state, render benchmarks

- Run animation only for visible active content; stop the settled wordmark and cache credential availability.
- Cache stable message layout by ID/version/width/fold state; virtualize history and avoid full collapsed-reasoning layout.
- Acceptance: idle intro completion produces zero animation-driven renders/credential reads; a 500-message warm
  update scales with visible/changed content; a collapsed 1 MiB reasoning preview does not fully wrap the source.

Per-screen bounded caches preserve exact descriptors and scroll bounds while reusing stable history. Idle
render/credential regressions have direct tests. On the 600-message/1 MiB stress fixture, full layout p50 fell
from 660.026 ms to 70.721 ms, Ink mount from 526.082 ms to 90.560 ms, and Ink warm update from 518.782 ms to
15.362 ms; the cached viewport itself measured 1.470 ms with 600 hits, one live build, and 28 visible lines.

### `PERF-002` — Define live/session/event retention

**Priority:** P2 · **Size:** L · **Status:** DONE
**Owns:** `src/matrix.mjs`, `lib/session.mjs`, `bin/matrix.mjs`, session/app tests

- Add count and byte budgets for live/persisted transcript and event payloads; retain newest records, not oldest.
- Add session metadata indexes and reference-aware backup/run-log retention with visible nonfatal save failures.
- Acceptance: a 600-message fixture resumes the newest allowed messages; 1,000 large sessions list via metadata;
  memory is bounded; retention never silently invalidates an offered undo.

### `PERF-003` — Add real indexing work budgets and scan deduplication

**Priority:** P2 · **Size:** L · **Status:** DONE
**Owns:** `lib/project.mjs`, project call sites, project/stress tests

Entry/directory work caps, incremental directory reads, manifest byte caps, and explicit git states
are implemented. Equivalent async requests deduplicate, invalidation is observable, and initial UI
loading plus task/test refreshes use `detectProjectAsync`; non-render CLI paths may remain synchronous.

- Bound visited entries/directories/bytes/work, including manifests and huge directories; expose incomplete-scan metadata.
- Move scanning/git work off the render path, dedupe equivalent scans, and represent git clean/dirty/truncated/unavailable honestly.
- Acceptance: a synthetic 100,000-file tree obeys a small work cap independent of total size; render-only frames
  cause no scans; no start/finish double scan; large git output cannot appear proven clean.

### `PERF-004` — Remove pathological parser and search complexity

**Priority:** P2 · **Size:** L · **Status:** DONE
**Owns:** `lib/scope.mjs`, `lib/local-agent.mjs`, `lib/project.mjs`, parser/stress tests

- Compute Python boundaries and JS delimiter matches in one pass; use scope-ID maps and safe ancestor lookup.
- Apply cheap lexical prefilters before reads/parses; cache validated file identity; skip truncated parsing and support abortable work.
- Acceptance: adversarial nested corpora scale near input bytes + scope count; a no-hit candidate search performs
  no full parses; no-match search has a work budget; partial scope output is labelled.

### `PERF-005` — Batch swarm updates and optimize graph/raster internals

**Priority:** P2 · **Size:** M · **Status:** DONE
**Owns:** `lib/swarm.mjs`, `lib/graph.mjs`, `lib/raster.mjs`, related event/render tests

- Return previous state for irrelevant events, coalesce deltas, aggregate reasoning, and preserve structural sharing.
- Use constant-time scope-parent maps and numeric RGBA buffer offsets without per-pixel temporary objects/color recomputation.
- Acceptance: 10,000 content deltas cause no irrelevant swarm transitions; output pixels/ANSI/PNG remain equivalent;
  the 8,000-scope graph approaches linear scaling and current small-screen benchmarks do not regress.

### `BENCH-001` — Build reproducible stress benchmarks

**Priority:** P2 · **Size:** M · **Status:** DONE
**Owns:** `bin/matrix.mjs`, benchmark-only modules/fixtures, documentation

- Add index, parser, transcript/update, process, session, event, and raster stress suites with local temporary fixtures.
- Record Node version, fixture shape, warmups, p50/p95/max, memory, and `Buffer.byteLength` output.
- Acceptance: every performance finding has a reproducible fixture; mount vs warm update and scan vs parser costs
  are distinguishable; CI uses robust ratios/reference budgets rather than brittle universal timings.

## 6. Phase 3 — Architecture and release

### `REF-001` — Split the orchestrator by observable responsibility

**Priority:** P3 · **Size:** L · **Status:** DONE
**Owns:** `src/matrix.mjs`, new focused modules, characterization tests

- Extract session codec/result projection, event reducer, keyboard decisions, and presentational Frame/ScreenView.
- Keep `MatrixApp` as composition glue and preserve compatibility exports. Centralize primary/all-view and extension lists.
- Acceptance: characterization tests pass unchanged; render-only imports do not load agent/controller implementations;
  no behavior change is required merely to reduce file size.

Presentational frame/view routing, session/result projections, event reduction, and keyboard decisions are
now separate modules with compatibility exports and centralized view/scope definitions. An isolated ESM
load-hook test proves render-only imports avoid the orchestrator, agents, controller, and provider transport.
Provider and UI availability checks share `lib/credentials.mjs`. All 372 tests pass locally on Node 22/24
and with hostile provider variables on Node 24; smoke and all 32 benchmark cases pass.

### `TEST-001` — Make the harness deterministic and hermetic

**Priority:** P2 · **Size:** M · **Status:** DONE
**Owns:** `test/helpers.mjs`, terminal-adapter tests, shared view fixtures, provider child-test utilities

The portability fallback is accepted: pure terminal-adapter tests plus isolated child lifecycle tests
cover abnormal restoration without requiring a PTY. A real PTY smoke may be added later but is not a
release gate. CI also runs provider suites with hostile fake endpoints/credentials.

- Replace ordinary fixed sleeps with observable-state waits; keep deliberate delays only for timing regressions.
- Add raw SSE fixtures, hostile-provider-env fetch traps, all-eight-view fixtures, alt-screen/sync-stream/term tests, and supported PTY smoke.
- Acceptance: tests pass with provider variables set/absent/fake-hostile and prove zero real fetch; terminal cleanup
  and abnormal restoration pass; loaded-CI repetitions do not depend on 10–80 ms ordinary sleeps.

### `TOOL-001` — Make `npm run check` a real engineering gate

**Priority:** P3 · **Size:** M · **Status:** DONE
**Owns:** `package.json`, `package-lock.json`, static-check configs, scripts

- Add reproducible lint, JSDoc/`checkJs` typecheck, format-check, syntax, and coverage scripts; expand `check` deliberately.
- Ratchet critical safety/controller/protocol thresholds rather than an arbitrary global percentage.
- Acceptance: clean install reproduces every check; public project/result/event/controller contracts are typed via
  JSDoc without a wholesale TypeScript rewrite; formatting is an isolated final change.

`npm run check` now runs syntax, ESLint, contract-focused JSDoc/`checkJs`, Prettier, and the complete suite
once with fail-closed Node 22/24 coverage parsing and 12 critical-module ratchets. Exact development-only
ESLint/TypeScript/Prettier dependencies are locked; production dependencies and `private` are unchanged.
Local `npm run check` passes 381/381 tests on Node 22.23.4 and 24.21.0, all 98 modules pass syntax checks,
hostile-provider tests pass 381/381, smoke/benchmarks pass, and `npm audit` reports zero vulnerabilities.

### `CI-001` — Add Node 22/24 CI with isolated credentials

**Priority:** P3 · **Size:** M · **Status:** IN PROGRESS
**Owns:** CI workflow only; integrator owns manifest changes

`.github/workflows/ci.yml` contains the Node 22/24 matrix, isolated homes, pytest, the complete static/test
`npm run check` gate, hostile-provider tests, package inspection, dependency audit, smoke, benchmark smoke,
and failure artifacts. Local Node 22.23.4
and 24.21.0 engineering gates pass 381/381, and PNG tests compare portable RGBA scanlines rather than
zlib-specific compressed bytes. The hosted clean-checkout matrix must still pass before `DONE`.

- Run `npm ci`, Python/pytest setup, tests, smoke, syntax/static checks, and relevant stress smoke on Node 22 and 24.
- Isolate `HOME`/`MATRIX_HOME`, use fake/no credentials, and prohibit live provider calls.
- Acceptance: clean checkout passes both versions; Node 22 compatibility is proven; logs contain no secrets;
  failure artifacts contain useful test/benchmark output without workspace pollution.

### `DOC-002` — Make documentation contracts executable

**Priority:** P3 · **Size:** S · **Status:** DONE
**Owns:** Integrator and documentation tests

- Keep tools, slash commands, keymap, primary/all views, provider distinctions, and recovery instructions sourced from one definition where practical.
- Date/source time-sensitive model metadata; live validation remains opt-in.
- Acceptance: docs tests detect stale lists/claims; README, MATRIX, help, and runtime agree; planning docs record
  completed task IDs and remaining risks without claiming live provider verification.

### `REL-001` — Define package and release posture

**Priority:** P3 · **Size:** M · **Status:** DONE
**Owns:** one release owner for manifest, lockfile, license, changelog, pack allowlist

- Choose private/internal CLI or supported publishable package; do not change `private` accidentally.
- Add the declared ISC license, release checklist/changelog, and inspect `npm pack --dry-run`; decide scratch-artifact policy.
- Acceptance: pack contains only intended runtime/demo/docs/license files; public exports or CLI-only posture are
  documented and compatible; version changes are deliberate and CI-verified.

Matrix remains a private/internal CLI at 1.0.0 with unchanged `main`, `bin`, and production dependencies.
The ISC license, changelog, and release checklist are present. `npm run pack:check` performs real dry-run
inspection on Node 22 and 24: 59 intended runtime/demo/docs/license files, executable bin, no unexpected
files, no tarball, and no publication. Hosted Node 22/24 CI remains an unchecked release-checklist gate.

## 7. Phase 4 — Frontier capability

### `EVAL-001` — Add a versioned agent evaluation system

**Priority:** P3 · **Size:** L · **Status:** BLOCKED by Phase 1 and `CI-001`
**Owns:** evaluation fixtures/runner/metrics; no production behavior changes required

- Build deterministic local tasks for fix, rename, create, deny, abort, undo, noisy verification, malformed tools,
  prompt injection, large repositories, and recovery. Add opt-in remote suites separately.
- Measure task success, unsafe actions, exact recovery, verification honesty, retries, latency, tokens, and estimated/provider cost.
- Acceptance: baseline and thresholds are versioned; CI local evals are network-free; a regression blocks release;
  reports distinguish deterministic Local Forge capability from remote-model results without invented averages.

### `ADV-002` — Design and implement an OS-sandboxed command capability

**Priority:** P3 · **Size:** L · **Status:** BLOCKED by `SEC-001` and `EVAL-001`
**Owns:** new execution-policy/sandbox modules and adversarial tests; do not restore legacy `run_command`

- Require separate opt-in and per-command approval with exact argv/cwd/script; default to executable-plus-argv, not shell strings.
- Enforce workspace-only writes and explicit network/secret policies using OS sandboxing where supported; otherwise disable.
- Acceptance: redirection, interpreters, `sed -i`, substitution, traversal, symlink races, network exfiltration, and denied-edit
  replacement cannot escape policy; headless needs a distinct allow flag; audit/undo limitations are explicit and tested.

### `ADV-001` — Implement real isolated parallel agent execution

**Priority:** P3 · **Size:** L · **Status:** BLOCKED by `EVAL-001` and `ADV-002`
**Owns:** new scheduler/worktree/conflict modules, controller protocol, swarm UI, integration tests

- Use independent workspaces/worktrees, bounded scheduling, stable agent IDs, per-agent approvals, cancellation, and cleanup.
- Detect conflicting edits and require an explicit integration/merge decision; never write concurrently to one shared file.
- Acceptance: independent tasks actually run concurrently with resource caps; conflicts never silently overwrite;
  abort cleans every child/worktree; UI clearly distinguishes real parallel runs from the existing single-stream projection.

## 8. Agent handoff template

```text
Task ID / wave:
Owned files (and files deliberately not touched):
Baseline and reproduction:
Behavioral changes:
Tests added and exact commands/results:
Documentation updated:
Remaining risks or acceptance-criteria deviations:
Suggested next task and any new dependency:
```

Do not mark a task `DONE` with an unverified acceptance criterion. If scope changes, keep the original
ID, document the deviation, and create a follow-up ID rather than silently weakening the gate.
