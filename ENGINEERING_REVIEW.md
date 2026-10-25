# Matrix Engineering Review

**Review date:** 2026-10-26
**Runtime:** Node.js 24.21.0, npm 12.2.0
**Reviewed state:** `master` at `ed14f33` plus the current uncommitted hardening changes
**Execution backlog:** [ENGINEERING_PLAN.md](ENGINEERING_PLAN.md)

## 1. Executive assessment

Matrix has a substantive foundation: a real offline engine, a real approval gate, atomic writes,
exact-byte backups, useful undo refusal rules, honest CLI failures, deterministic render fixtures,
and an unusually broad network-free test suite. It is much more than a decorative TUI.

The review also found stop-ship defects: arbitrary model shell commands bypassed approval and undo;
an unreadable existing file could be classified as a new file; provider credentials could be routed
to the wrong origin; and undo fingerprints could miss external appends beyond the text-read cap.
Those paths are closed in the current working tree with regression tests. Approved Local Forge
renames, multi-hunk application, mixed process streams, late test summaries, and long-line diff
review were also repaired.

**Current verdict:** a strongly hardened v1 candidate, not yet a frontier production system. Complete
multi-file undo now survives sessions, streaming/tool protocols and terminal outcomes are unified,
repository tests have exact trust decisions and durable audits, and accessibility essentials are covered.
Large parser, graph, raster, event, index, session-retention, and transcript-rendering work is complete.
Orchestrator responsibilities are separated with a proven render-only dependency boundary, and the
static/test/coverage engineering gate passes locally on Node 22 and 24. The private/internal package
and release contracts are implemented and dry-run verified. Hosted run #3 passed the clean-checkout
matrix on both versions, closing Phase 3. `EVAL-001` is now the active Phase 4 gate before advanced
parallelism or sandbox work. No wholesale rewrite is recommended.

## 2. Scope and method

Five focused reviews covered core correctness, security, model/provider behavior, performance, and
engineering quality. The review included runtime/UI code, CLI behavior, tests, documentation,
dependencies, benchmarks, and safe temporary-workspace reproductions.

- Inspected approximately 17.3K lines across 61 JavaScript modules and 21 test suites.
- Ran the complete suite with V8 coverage, render smoke checks, the end-to-end tour, syntax checks,
  rendering benchmarks, targeted stress probes, and `npm audit`.
- Used mocked provider streams and fake credentials only. No live model capability, price, or
  availability claim was treated as verified.
- Node 22.23.4 and 24.21.0 pass the complete local suite, and hosted run #3 passed the clean-checkout
  matrix on both versions. Every future release candidate still requires a fresh hosted pass.
- The benchmark figures below are local measurements, not portable SLAs. Fresh-render CLI benches
  do not measure warm React updates or terminal write rates.

## 3. Current verification baseline

| Check                | Current result                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Complete test suite  | **388/388 passing** on local Node 22 and 24, plus **388/388** with hostile fake provider variables on Node 24  |
| Agent evaluation     | **16/16 default and 1/1 stress contracts pass** locally on Node 22/24 with zero safety violations              |
| Hosted CI            | **Run #3 passed** clean install, static tests, hostile tests, pack, audit, smoke, and benchmarks on Node 22/24 |
| Engineering gate     | `npm run check` passes on Node 22 and 24, including lint, `checkJs`, formatting, and 12 coverage ratchets      |
| Responsive smoke     | **32/32 frame checks passing** across four geometries                                                          |
| Benchmark smoke      | **32/32 local cases passing**, with cleanup and zero active Ink/process resources                              |
| Package inspection   | **59 intended files** on Node 22 and 24; private/main/bin verified, no tarball or publication                  |
| Syntax               | `node --check` passed for all 113 current `.mjs` modules                                                       |
| V8 line coverage     | **94.41%** on Node 24                                                                                          |
| V8 branch coverage   | **83.82%** on Node 24                                                                                          |
| V8 function coverage | **93.92%** on Node 24                                                                                          |
| Dependency audit     | `npm audit`: **0 vulnerabilities**                                                                             |
| Diff whitespace      | `git diff --check` passing                                                                                     |
| Runtime used         | Local Node 22.23.4 and 24.21.0; hosted Node 22/24 matrix verified                                              |

Coverage is a diagnostic, not a quality score. Terminal adapters now have direct line coverage, while
the large application orchestrator, failure branches, and live provider/remote-Ink behavior remain
the meaningful weak spots. The next coverage work should target those contracts rather than chase a
global percentage.

### Current local performance references

A standalone 20-iteration fresh-render sweep at 120×36 measured 91.04 ms across all eight views;
Vision was the largest mean per-frame cost at 24.58 ms. This is a small-fixture baseline only.

Measured scaling work also landed: 1,000 nested Python declarations dropped from 4.90 s to 5.12 ms
(958×), 1,000 nested JS declarations from 51.13 ms to 2.95 ms (17.4×), and an 8,000-scope graph from
316.43 ms to 3.28 ms (96.5×). A 10,000-event content stream now produces zero irrelevant swarm state
transitions. These are review-machine fixtures, not universal latency guarantees.

The first long-line wrapping implementation was quadratic and took approximately 1.9 s for a 40 KiB
line in a review probe. The replacement forward traversal measured **6.76 ms** for the same size and
preserved exact content. A standalone benchmark run performed concurrently with coverage was
discarded as invalid; only isolated measurements are recorded here.

The 600-message transcript fixture includes 1 MiB of collapsed reasoning. Five-sample p50 costs fell
from 660.026 ms to 70.721 ms for full layout, from 526.082 ms to 90.560 ms for Ink mount, and from
518.782 ms to 15.362 ms for a warm Ink update. The cached viewport measured 1.470 ms with 600 stable
history hits, one changed-live build, and 28 visible lines. These are local references, not SLAs.

## 4. Strengths to preserve

1. **Real safety primitives.** Static path containment, symlink refusal, post-approval content
   revalidation, atomic temp-file rename, mode preservation, and private exact-byte backups.
2. **Deny-by-default behavior.** Headless edits require explicit approval, `--yes --demo` is refused,
   and a denied proposal is not represented as applied.
3. **Honest failure intent.** Failed verification is not silently reverted or reported as success.
4. **Useful offline operation.** Local Forge needs no credentials or network and works on real files.
5. **Real integration tests.** Temporary workspaces exercise actual edits, pytest/Node execution,
   undo, CLI exit statuses, PNG bytes, and Ink interactions.
6. **Bounded visual projections.** Swarm logs and diffs are capped; the three lanes truthfully show
   one event stream rather than pretending to be independent agents.
7. **Small runtime dependency surface.** Two runtime dependencies plus an exact, development-only
   static toolchain, with a synchronized lockfile and no current audit findings.

## 5. Stop-ship and high-impact fixes now in the working tree

| Task                                                     | Result                 | Evidence and regression coverage                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SAFE-001` — close the shell boundary                    | **Done**               | `run_command` is removed from tool schemas and hard-denied at runtime. A mocked redirect cannot create a file, no `command:start` occurs, and the system prompt no longer advertises it.                                                                                                         |
| `SAFE-002` — make creation existence-based               | **Done**               | Creation uses `lstat`/`ENOENT`, not any read failure. Existing unreadable files and files appearing during approval remain byte-exact. Binary paths/NUL content are rejected.                                                                                                                    |
| `SAFE-003` — reduce credential disclosure                | **Done (first layer)** | Remote reads refuse `.env*`, VCS internals, key/credential paths; test children scrub common secret and loader variables. Sentinel tests prove values are not forwarded. Broader repository trust/sandboxing remains open.                                                                       |
| `PROV-001` — bind provider routing and selection         | **Done**               | Ollama routing is model-specific and case-insensitive; OpenRouter/Ollama/custom-base variables no longer cross-route. Custom endpoints use matching credentials. Headless/picker guards receive the model, and unknown explicit CLI models fail before running.                                  |
| `STATE-001` — make undo fingerprinting byte-exact        | **Done**               | Undo compares complete size and bytes, not a capped decoded read. Exact-cap-plus-append is refused. Creation flags survive current single-patch serialization; inconsistent creation/backup metadata is refused.                                                                                 |
| `STATE-002` — publish and journal undo correctly         | **Done**               | Undo is published before the first `applied` observer, remains available after agent failure, and partial restores remove successful entries immediately so retries and resumed retries work with pending backups.                                                                               |
| `STATE-003` — persist complete run recovery              | **Done**               | Versioned `undoRun` stores ordered/coalesced entries and exact recovery bytes. Two edited files plus a created file, same-file coalescing, legacy migration, and oversized recovery records pass real save/resume/undo tests.                                                                    |
| `CORE-001` — repair approved Local Forge rename          | **Done**               | The rename plan now matches all five stages. An approved rename applies, verifies, and finishes with coherent plan states.                                                                                                                                                                       |
| `CORE-002` — unify terminal outcomes                     | **Done**               | One classifier drives success, denial, failure, unverified, timeout, abort, and budget states across agents, controller, swarm, CLI, and interactive results. Metrics precede result and `done` is final; elapsed time and applied-edit recovery remain coherent.                                |
| `PROV-005` — add usage provenance and recovery semantics | **Done**               | Provider/estimated/mixed/unavailable usage and cost retain subtotals and completeness. Bounded follow-up history, explicit/automatic healing, and interactive/headless recovery are integrated into UI, sessions, CLI, and Vision.                                                               |
| `SEC-001` — establish repository/test trust              | **Done**               | Exact executable/argv/script-hash trust, interactive first-use approval, headless allow decisions, private bounded execution audits, output redaction, and recovery-safe retention are implemented and tested.                                                                                   |
| `PERF-004` — remove parser/search pathology              | **Done**               | One-pass Python/JS scope analysis, iterative IDs and safe ancestry, lexical prefilters, budgeted search, and cache validation are measured on flat, nested, and adversarial corpora.                                                                                                             |
| `PERF-005` — optimize swarm/graph/raster                 | **Done**               | Irrelevant swarm transitions are eliminated, publication is batched, parent lookup is constant-time, and numeric raster loops preserve byte-equivalent output. Benchmarks show large graph/raster gains.                                                                                         |
| `CLI-001` — complete CLI and result validation           | **Done**               | Strict argv, public outcome/elapsed fields, usage provenance, and structured recovery are aligned across headless and interactive consumers.                                                                                                                                                     |
| `PERF-002` — define live/session/event retention         | **Done**               | Newest-first count/byte retention, metadata sidecars, reference-aware run-log/backup pruning, and visible nonfatal save/list warnings are integrated.                                                                                                                                            |
| `PERF-003` — add indexing budgets and deduplication      | **Done**               | Entry/directory caps, manifest identity, async in-flight dedupe, invalidation, cache freshness, and async initial/task/test refresh are implemented. Large synthetic trees obey small independent work caps.                                                                                     |
| `UX-004` — expose retained verification output           | **Done**               | Failed-output tails, Alt+O expansion, complete retained scrolling, long-line wrapping, and `last N of M` truncation counts are available for agent tests and direct `/test`.                                                                                                                     |
| `BENCH-001` — build reproducible stress benchmarks       | **Done**               | Thirty-two opt-in local cases expose p50/p95/max, memory, real UTF-8 bytes, fixture metadata, cleanup state, and reference ratios.                                                                                                                                                               |
| `PERF-001` — eliminate idle/full-history amplification   | **Done**               | Bounded per-screen cached viewports preserve exact descriptors and scrolling; stable history is reused, collapsed reasoning uses a bounded preview, settled/visible-only animation stops idle renders, and credential availability is cached with explicit refresh.                              |
| `REF-001` — split the orchestrator by responsibility     | **Done**               | Frame/view, session/result, event, keyboard, and scope contracts are extracted with compatibility exports. Render-only imports provably avoid orchestrator, agent, controller, and transport modules; UI/provider credential rules share one neutral helper.                                     |
| `TOOL-001` — make `npm run check` a real gate            | **Done**               | Syntax, ESLint, contract-focused JSDoc/`checkJs`, Prettier, and fail-closed Node 22/24 coverage parsing enforce 12 critical-module ratchets. Clean installs and both local Node versions pass; production dependencies remain unchanged.                                                         |
| `REL-001` — define package and release posture           | **Done**               | Matrix remains a private/internal CLI at 1.0.0 with unchanged main/bin/runtime dependencies. ISC license, changelog, release checklist, and source-backed dry-run inspection verify 59 intended files on Node 22 and 24 without a tarball or publication.                                        |
| `CI-001` — add hosted Node 22/24 CI                      | **Done**               | Hosted run #3 passes clean install, the complete static/test gate, hostile provider environments, pack inspection, dependency audit, smoke, and benchmark smoke on both versions. Invalid job contexts and two portability fixtures were fixed with regressions.                                 |
| `DIFF-001` — repair patch application                    | **Done**               | Back-to-front hunks use original coordinates, empty-file starts work, overlap/order is checked, and non-finite edit coordinates are rejected. Multi-hunk insertion/deletion/replacement round trips pass.                                                                                        |
| `DIFF-002` — make newline/diff behavior lossless         | **Done**               | EOL/EOF changes produce explicit metadata and whole-file review rows; mixed EOL is refused instead of silently normalized. Standard no-newline markers and 60 deterministic encoding/edit fixtures round-trip exactly.                                                                           |
| `PROC-001` — make process output trustworthy and bounded | **Done (core path)**   | Per-stream UTF-8 decoders and line buffers preserve identity and split characters; long lines and tail captures are bounded; latest 400 lines survive; late summaries parse; direct `/test` is capped; escalation timers are cleared. Noisy-output, mixed-stream, UTF-8, and 512-KiB tests pass. |
| `PROC-002` — separate process and verification success   | **Done**               | `processOk`, `verified`, and `verificationStatus` now distinguish verified, unverified, failed, skipped, timeout, and abort. Empty zero-exit output is not green; recognized zero-test summaries are supported; Cargo/Go fixtures pass.                                                          |
| `PROV-002` — enforce tool status and call budgets        | **Done (baseline)**    | Denied/failed tools no longer emit `ok: true`. Execution stops before call 25 and returns an incomplete/error result. Empty and budget-exhausted runs no longer suppress `failure`.                                                                                                              |
| `PROV-003` — harden streaming transport                  | **Done**               | Connect/idle/total deadlines, bounded error/SSE buffers, safe pre-stream retries, reader cancellation, and byte-oriented SSE parsing now have 19 network-free tests covering splits, stalls, retries, malformed streams, and aborts.                                                             |
| `PROV-004` — make tool protocol safe                     | **Done**               | Parallel/no-index calls retain identity, strict object validation prevents dispatch crashes, source is never regex-repaired, results truncate into valid JSON, and call/argument/context budgets are enforced.                                                                                   |
| `UX-001` — make input/navigation deterministic           | **Done**               | Timing-based printable-key arbitration is gone. Printable input stays in the prompt; Alt shortcuts work during runs; scope hints match real keys; narrow scope selection stays visible.                                                                                                          |
| `UX-002` — make approval diffs inspectable               | **Done**               | Long changed lines wrap without data loss in the gate and edit cards. Wrapping is linear and preserves spaces, wide glyphs, line numbers, and frame widths. Resolved gates no longer advertise approval actions.                                                                                 |
| `UX-003` — align live status and model claims            | **Done (baseline)**    | `/diff` is read-only, `/new` always disables auto-approve, recovery hints use Alt+U/`/undo`, and price/privacy/capability copy distinguishes estimates and unknowns.                                                                                                                             |
| `TEST-001` — make the harness deterministic and hermetic | **Done**               | State-based app waits, alt-screen/sync-stream/term suites, env/fetch traps, and terminal lifecycle fixes are in place. All 388 tests pass on local Node 22 and 24 and with hostile fake provider variables on Node 24. Pure adapter/child tests document the no-PTY fallback.                    |
| `A11Y-001` — enforce contrast and monochrome behavior    | **Done**               | Added WCAG role tests, moved functional text off `dim`, and verified `NO_COLOR`, `--mono`, and `--no-color` on direct Vision/dump output. Doctor now points to the actual ASCII fallback.                                                                                                        |
| `UX-005` — complete accessible interaction modes         | **Done**               | Help scrolls at 40×20 with visible position; all eight views have geometry/content checks; reduced motion is static; every Vision mode has a textual summary; approval, error, and verification content survives screen-reader mode.                                                             |
| `DOC-002` — make documentation executable                | **Done**               | `test/docs.test.mjs` now checks slash commands, shortcuts, the six-tool surface, recovery/outcome contracts, view lists, and engineering task-ID synchronization.                                                                                                                                |

These changes close the reproduced stop-ship paths; they are not a security certification or a claim
that every remaining high-priority issue is solved.

## 6. Open findings, ordered by engineering risk

No open P0/P1 correctness or P2 scale/accessibility findings remain in the current working tree.

### P3 — maintainability and release readiness

| Task       | Finding                                                                                                                                                                                     | Required next outcome                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `EVAL-001` | **In progress.** The versioned 16-case default and one-case stress evaluations pass locally on Node 22/24 with zero safety violations; hosted execution of the new CI eval step is pending. | Require the hosted default comparison to pass before advanced sandboxing or real parallelism. |

## 7. Accepted risks and unresolved validation boundaries

- **Project tests are arbitrary repository code.** This is documented and remains security-significant.
  Environment scrubbing is not an OS sandbox.
- **Filesystem check/use races remain.** Path validation and atomic rename do not provide directory-FD
  compare-and-swap semantics against a concurrent local adversary. Stable proposal IDs and stronger
  no-follow/FD-relative operations require a separate design.
- **Remote providers receive requested repository context.** Sensitive-path denial reduces unnecessary
  exposure but cannot replace user trust, redaction policy, or provider governance.
- **Sessions, backups, and logs contain development data.** Private modes help, but retention,
  deletion, redaction, and pre-existing-permission policies still need work.
- **Scope parsing is heuristic.** It is useful structural navigation, not a complete AST.
- **The swarm is one event stream.** Real parallel agents must be implemented with isolated worktrees,
  scheduling, conflict handling, and independent approval semantics before being advertised.
- **Live provider metadata is unvalidated.** Current tests prove routing and behavior with mocks, not
  current model availability, prices, context limits, or tool support. Context budgets use documented
  character-based estimates rather than provider tokenizers; fully anonymous interleaved tool deltas
  without IDs, indices, or slot ordering remain inherently ambiguous.
- **Coverage and pass counts do not prove absence of races.** Delayed process, filesystem, and session
  interleavings need injected-failure and stress tests.

## 8. Frontier release bar

Matrix should not be called production/frontier-ready until all of these are true:

1. **Safety:** no unapproved write or command path in adversarial tests; exact undo or explicit refusal;
   no credential forwarding to unintended origins; no pending high-severity data-loss finding.
2. **Lifecycle:** apply/deny/abort/timeout/failure/partial-restore have one consistent outcome contract;
   `done` is terminal; multi-file undo survives save/resume and partial retry.
3. **Protocol:** bounded streaming, strict tool assembly/schema handling, honest incomplete outcomes,
   and hermetic raw-byte tests.
4. **Operability:** failures expose actionable retained output; docs match behavior; session/persistence
   errors are visible; retention never invalidates offered recovery.
5. **Scale:** transcript/index/parser/output costs are bounded by explicit work budgets, with stress
   benchmarks rather than small-demo inference.
6. **Accessibility:** keyboard, reduced-motion, monochrome, narrow-terminal, and screen-reader paths
   expose all essential actions and data.
7. **Release engineering:** Node 22/24 CI, clean install, static checks, network-free default tests,
   reproducible packaging, and a deliberate release process.
8. **Agent quality:** a versioned local evaluation suite measures task success, unsafe actions, exact
   undo, verification honesty, latency, and cost. Remote live evaluations remain opt-in.

The phase-wise tasks, dependencies, ownership constraints, and acceptance criteria are in
[ENGINEERING_PLAN.md](ENGINEERING_PLAN.md).
