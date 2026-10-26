# Matrix internals

This document describes the implementation that actually ships in this repository. It is not a
roadmap and it does not describe simulated capabilities. For installation and everyday command
usage, start with [README.md](README.md).

## Design constraints

Matrix is built around four constraints:

1. **Useful without a network.** Local Forge is the default engine. It indexes the workspace,
   proposes a real patch, writes it atomically, runs the project's tests, and reports the real
   result.
2. **Nothing writes without a decision.** Every file-changing proposal passes through a gate.
   Headless runs are deny-by-default. Remote models get the same gate as the local engine.
3. **Show the bytes and the result.** The UI renders the actual hunk, parsed verification results,
   provider token usage when supplied, and the actual file that changed. Empty or unavailable data
   must not become a decorative statistic. Retained output expands for complete inspection, and
   usage/cost provenance remains explicit.
4. **Keep the visual identity, but make it earn its pixels.** The phosphor palette, spatial screens
   and pixel canvas remain. The canvases are now driven by the parsed workspace and the live run.

## Runtime map

| Area              | File                                                  | Responsibility                                                                           |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| CLI               | `bin/matrix.mjs`                                      | Interactive, headless, tour, dump, vision, smoke, bench, doctor, sessions.               |
| CLI parser        | `lib/cli.mjs`                                         | Subcommands, flags, validation, help text.                                               |
| Project index     | `lib/project.mjs`                                     | Budgeted workspace walk, language counts, test-runner detection, git context.            |
| Structural parser | `lib/scope.mjs`                                       | Python indentation scopes; masked JS/TS brace scopes; Rust/Go/Ruby declarations.         |
| Task layer        | `lib/task.mjs`                                        | Intent classification, candidate scoring, grounded search results.                       |
| Local engine      | `lib/local-agent.mjs`                                 | Deterministic inspect/propose/apply/verify loop.                                         |
| Remote engine     | `lib/model-agent.mjs`, `lib/openrouter.mjs`           | Streaming OpenRouter loop, audited tools, usage accounting.                              |
| Controller        | `lib/controller.mjs`                                  | One active run, approval lifecycle, abort, undo stack, session re-arm.                   |
| Safety            | `lib/workspace.mjs`                                   | Path containment, atomic writes, mode preservation.                                      |
| Diff              | `lib/diff.mjs`                                        | Line diff and hunks used by the gate and cards.                                          |
| Process           | `lib/process.mjs`                                     | Bounded child processes, streaming output, test-result parsing.                          |
| Command policy    | `lib/command-policy.mjs`, `lib/command-execution.mjs` | Exact one-shot argv/script approval, audits, bounded results and outcome classification. |
| Linux sandbox     | `lib/linux-bwrap.mjs`, `lib/linux-snapshot.mjs`       | Required namespaces, minimal mounts, disposable no-follow snapshots and cleanup.         |
| Sessions          | `lib/session.mjs`                                     | `MATRIX_HOME`, atomic JSON sessions, backups, run event logs.                            |
| Application       | `src/matrix.mjs`                                      | React state/effects, controller and I/O composition; no presentational frame ownership.  |
| Presentation      | `src/frame.mjs`, `src/views.mjs`                      | `Frame`/`ScreenView`, primary/all-view routing, and shared scope-source definitions.     |
| Interaction       | `src/keyboard.mjs`, `src/event-reducer.mjs`           | Pure keyboard decisions and React-independent run-event effect reduction.                |
| UI projections    | `src/session-codec.mjs`, `src/result-projection.mjs`  | Transcript/session, usage, retained-output, and public result projections.               |
| Cards             | `src/cards.mjs`                                       | Pure card builders; no terminal or filesystem side effects.                              |
| Screens           | `src/screens/*.mjs`                                   | Empty, chat, permission, swarm, scope and vision views.                                  |
| Renderer          | `src/render.mjs`                                      | Render-only frame imports, fixed geometry, and geometry checks (`checkFrame`).           |
| Panels            | `lib/graph.mjs`                                       | Real workspace/scope/telemetry canvases and adaptive headers.                            |
| Raster            | `lib/raster.mjs`                                      | Pixel buffer, primitives, half-block truecolor, PNG encoder.                             |
| Swarm state       | `lib/swarm.mjs`                                       | Projects run events into three lanes with bounded logs.                                  |
| Doctor            | `lib/doctor.mjs`                                      | Runtime, workspace, git, test, credential, session-home and demo checks.                 |
| Credentials       | `lib/credentials.mjs`                                 | One transport-free provider/key lookup shared by execution and cached UI availability.   |
| Public contracts  | `lib/contracts.mjs`                                   | Type-only JSDoc project/result/event/controller contracts; no runtime dependency.        |
| Engineering gates | `scripts/check-*.mjs`                                 | Recursive syntax checks, fail-closed coverage ratchets, and dry-run pack inspection.     |

The UI is split so that card construction can be tested without a terminal, and so screen
rendering can be checked at fixed dimensions with `MATRIX_COLS`/`MATRIX_ROWS` or `checkFrame`.
Render-only consumers import `src/frame.mjs` and `src/views.mjs` through `src/render.mjs`, never the
application orchestrator. An isolated ESM load-hook regression proves that path does not load the
controller, local/remote agents, or provider transport. `src/matrix.mjs` retains compatibility exports
for existing callers. `ChatScreen` owns a bounded per-instance layout cache keyed by message identity/signature, width,
fold state, and active-spinner state. Cold views compute exact line-count metadata for scrolling;
warm views reuse stable records and construct only visible line arrays. `buildChatLines` remains the
uncached pure reference. Collapsed reasoning above 65,536 UTF-16 code units uses a bounded preview
instead of wrapping the complete source; expanded and streaming reasoning remain complete. History appends preserve
existing projected message identities on the ordinary under-budget path.

The wordmark stops its animation subscription at `REST_TIME` and memoizes its settled raster. Run
animation is active only for visible chat/swarm content, and reduced-motion/screen-reader modes stay
static. Credential availability is cached across renders and refreshed by explicit model/picker
actions; provider execution still performs its own credential lookup.

The index applies file-count, depth, byte, directory, and entry work budgets with incremental
directory reads. Manifests have byte caps and identity revalidation; git status distinguishes
`clean`, `dirty`, `truncated`, `unavailable`, and `not-a-repo` rather than silently treating overflow
as clean. Equivalent asynchronous scans deduplicate by canonical root/configuration, snapshots have
an explicit freshness policy, and task/test/write/undo paths invalidate stale state. Interactive
initial detection and execution refreshes stay off the render path; non-render CLI paths may use the
synchronous API.

## A Local Forge run

A typical task such as “fix the off-by-one in the bounds slice in src/processor.py” follows this
path:

1. A bounded project index supplies the file list, language counts, test command, and git branch;
   the interactive app obtains it through `detectProjectAsync` before execution.
2. `classifyTask` chooses an intent: fix, test, explain, rename or inspect.
3. The local engine emits a plan and indexes candidates. It searches for explicit paths, identifiers,
   slice expressions and task keywords.
4. It reads the chosen file, parses its scopes, and locates a validated change. For a bounds slice,
   the candidate is checked against the surrounding source rather than blindly appended.
5. It computes a unified hunk and emits `proposal` followed by `approval:request`.
6. If approved, the original bytes are backed up, then written through a temporary file and rename.
   The controller records the exact post-patch bytes and backup path in its undo stack.
7. The detected test command runs with a timeout. Output is streamed as `verify:line`; the final
   totals become `verify:end`.
8. A final `result` and `done` close the run. A failing verification is reported as failing; the edit
   is not silently reverted.

The local engine is intentionally narrow. It is strongest on explicit source files, slice and
off-by-one defects, test runs, grounded explanations, and limited rename operations. It is not a
general-purpose language model and does not pretend to be one.

## Remote runs

Remote models use the OpenRouter chat-completions API with streaming enabled. The agent exposes a
small audited tool surface:

| Tool                    | Effect                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `list_files`            | Read-only workspace listing.                                                                |
| `search_repo`           | Read-only literal search.                                                                   |
| `read_file`             | Read-only bounded file read; known credential and VCS-internal paths are refused.           |
| `propose_edit`          | Builds a real validated patch; never writes by itself.                                      |
| `write_file`            | Creates or rewrites a text file through the same proposal gate; binary targets are refused. |
| `run_tests`             | Runs the detected executable-plus-argv test plan with a scrubbed environment.               |
| `run_sandboxed_command` | Optional remote-only exact argv execution in a disposable no-network Linux sandbox.         |

Legacy arbitrary `run_command` shell execution remains **disabled** and is never advertised. A legacy
call is hard-denied without spawning a process. The only command path is the separately designed
`run_sandboxed_command` policy below; it is not a destructive-command denylist or a way to apply edits.
The default six-tool schema is unchanged, and dynamic command schemas are used identically for context
budgeting and provider requests.

### Sandboxed command capability

`run_sandboxed_command` requires a separate capability opt-in and exact per-command approval. Plans
contain only `executable`, `argv`, `cwd`, optional `script`, and optional `scriptFile`; model-selected
environment, network, backend, resource, audit, home, or lifecycle-hook options are rejected. Plan
hashes cover canonical workspace/cwd, policy identity, resolved executable, literal argv, declared
script hashes, and workspace-executable identity/content. `/usr` runtimes and the exact current Node
runtime are the only host executable exceptions; other outside paths are rejected.

Interactive approval creates a fresh one-shot decision for every command and displays exact argv,
inline/file script bytes, and a copyable hash. Headless execution requires `--enable-commands` plus
`--allow-command=<64 lowercase hex>` and keeps one policy per invocation, so an identical second call
is denied. Edit `--yes`, test trust, and persistent command approval carry no authority.

Execution uses a private no-follow workspace snapshot, never an RW bind of the live tree. Bubblewrap
requires user/PID/IPC/network/UTS namespaces, a read-only minimal root, fresh `/dev` and procfs, cleared
environment, bounded `/tmp`, and parent CPU/address-space/file/FD/process/output/wall limits. Network
uses a new empty namespace with no inherited host sockets. Snapshot writes are discarded: there is no
automatic import, applied edit, or undo record. Decision/start/end audits are mandatory and contain
hashes/redacted metadata, not inline/file script bytes or raw environment/output. Provider cards and
headless `commands` retain process, audit, cleanup, truncation, and discarded-write evidence.

No seccomp filter or VM is claimed. There are no aggregate post-exec CPU/memory/disk quotas, host
`/usr` contents are not hashed, and secret-name filtering is not content classification. Unsupported
platforms or failed real probes return `unavailable`; there is no unsandboxed fallback. CLI `doctor`
and interactive `/doctor` await `runDoctorAsync()` and its real policy probe; the compatibility
`runDoctor()` API remains synchronous and explicitly reports the sandbox as unprobed.

Repository tests require workspace and exact test-plan trust before spawning. Interactive first-use
approval shows the resolved executable, argv, cwd, and current npm `pretest`/`test`/`posttest` scripts.
Trust is scoped by SHA-256 workspace and plan/script hashes and revalidated during the approval window.
Headless tests require the dedicated `--allow-tests` decision for the first exact plan in an invocation;
`--yes` applies only to edit approval. Audit logs record `execution:start` and `execution:end` without
environment or process output, and retained output is redacted. Start-audit persistence failures prevent
execution; no OS sandbox is implied.

The transport has configurable connection, idle-stream and total deadlines, bounded HTTP-error/SSE
buffers, safe pre-stream retries, and reader cancellation. Successful responses must be SSE and end
with `[DONE]`; malformed or truncated streams become errors instead of clean completions.

Tool calls have stable identities across indexed and unindexed deltas, strict plain-object argument
validation, per-call/response/run byte budgets, and model-context preflight. Tool results are truncated
with valid JSON envelopes and explicit metadata rather than sliced JSON text.

A `propose_edit` tool call creates a proposal, requests approval, and only then writes. The same
controller gate is used for local and remote runs, so denying a remote edit leaves the file
untouched. If the model edits a file but forgets `run_tests` — or tested before the latest edit —
the agent runs verification after the round. Usage and cost carry `provider`, `estimated`, `mixed`,
or `unavailable` provenance, with provider charges preferred and unknown cost left `null` rather than
rendered as `$0.00`. Follow-up history is bounded to 12 textual messages and 32 KiB; runs without
`extraContext` are deliberately stateless.

If no OpenRouter key is configured, an OpenRouter headless run exits with an error before making a
network request. Ollama models use `OLLAMA_HOST` (default `http://127.0.0.1:11434`) and do not need
an OpenRouter key. `OLLAMA_HOST` never reroutes OpenRouter models. Custom `MATRIX_API_BASE` uses
`MATRIX_API_KEY`; `OPENAI_BASE_URL` uses `OPENAI_API_KEY`, so one provider's credential is not sent
to another provider's origin. Selecting an unknown explicit model is an error in CLI/headless mode.

The registry includes zero-listed-cost models (`openrouter/free`, `nvidia/nemotron-3.5-lightning:free`,
`cohere/north-mini-code:free`, `poolside/laguna-s-2.1:free`, `recursive/flint-v1.0:free`,
`liquid/lfm-2.5-2.6b:free`, `google/gemma-4-31b-it:free`). Registry prices, context sizes and tool
capabilities are static metadata, not a live provider verification. The UI labels estimates and
unknown dynamic-Ollama capabilities accordingly.

## Agent event protocol

The renderer, swarm lanes, session log and verification cards all consume the same events:

| Event                                              | Meaning                                                                                        |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `run:start`                                        | Mode, model, task and initial plan.                                                            |
| `phase`                                            | Current phase (planning, reading, editing, applying, verifying, complete, failed, aborted).    |
| `plan`, `plan:step`                                | Plan and per-step status updates.                                                              |
| `thought`, `content`                               | Streaming reasoning and answer text.                                                           |
| `tool:start`, `tool:end`                           | Audited tool lifecycle with a summary and optional card data.                                  |
| `proposal`                                         | A validated patch with file, hunk, stats and rationale.                                        |
| `approval:request`, `approval:result`              | The gate and its decision.                                                                     |
| `applied`                                          | The write actually happened; includes backup path and stats.                                   |
| `verify:start`, `verify:line`, `verify:end`        | Real test execution and parsed totals.                                                         |
| `verify:skipped`                                   | No runner was detected, so verification did not happen.                                        |
| `execution:start`, `execution:end`                 | Exact test execution metadata, trust decision, and terminal status; no environment or output.  |
| `command:decision`, `command:start`, `command:end` | Exact sandbox approval, execution, cleanup and audit lifecycle; no script bytes or raw output. |
| `trust:decision`                                   | Denied/blocked test-trust decision with safe reason metadata.                                  |
| `usage`                                            | Provider token usage; only emitted when available.                                             |
| `metrics`                                          | Elapsed time, rounds, tool calls and cost.                                                     |
| `result`                                           | The final public result card.                                                                  |
| `error`                                            | A real failure, with an aborted flag when applicable.                                          |
| `abort:requested`                                  | The user requested cancellation while a run was active.                                        |
| `undo`                                             | Files restored by the undo stack.                                                              |
| `done`                                             | The run is finished, whether successful, denied, failed or aborted.                            |

Logs in the swarm state are bounded, so a noisy stream cannot grow the UI without limit.

`lib/outcome.mjs` is the shared terminal classifier: `ok` is true only for `success` or non-error
`denied`. Failed, unverified, timed-out, aborted, and budget-exhausted runs are never projected as
success. Controller, both agents, swarm, CLI, and interactive result/session objects expose the same
`ok`, `status`, `outcome`, `failure`, and timing fields. Terminal order is `metrics → phase → result →
done`, so `done` is always last and final metrics are available before persistence.

## Approval and undo invariants

The safety rules are enforced in code, not just in documentation:

- A requested path is resolved inside the workspace. Traversal and symlink escapes are rejected.
- Indexing skips symlinks, and reads are capped. A truncated read is never editable because writing
  it back would delete the unseen tail.
- Before a write, the path is re-resolved and the current bytes are compared with the approved
  proposal. A file that changed or grew after approval is refused, not overwritten. Creation is
  permitted only when no filesystem entry exists, both when proposed and again after approval;
  existing binary, unreadable, directory and symlink targets are never treated as new files.
- Writes preserve the original file mode and use a temporary file plus rename.
- Diff generation preserves EOL and final-newline transitions with `\ EOL:` and `\ Final newline:`
  metadata plus whole-file review rows; standard no-newline markers are also parsed. Mixed-EOL inputs
  are refused rather than silently normalizing unchanged lines.
- A backup is created before an approved write.
- The controller records `original`, `updatedText`, `absPath`, `backupPath`, patch stats and the
  hunk. Undo state is published on the first applied event. Undo validates every target first, then
  restores files in the last applied edit set; successful partial restorations are journaled immediately
  so remaining work can be retried. Multiple edits to one file are coalesced so the first original and
  final fingerprint produce one exact undo.
- Undo compares the complete current file bytes and size with the stored post-patch fingerprint,
  without using the agent's capped text reader. If someone else changed or appended to the file,
  undo refuses instead of overwriting their work.
- A denied proposal is not stored as an applied patch and produces no undo entry.
- Session resume re-arms a versioned `undoRun` only when every stored post-image and recovery source
  still matches. Multi-file edits, same-file coalescing, created files, and partial retry are covered;
  legacy `lastPatch` records migrate only when their metadata is unambiguous.
- A test failure is a reported result. It does not cause an automatic revert.
- Test children receive a scrubbed environment without common credentials or loader hooks. This is
  not a filesystem/network sandbox; repository test code remains arbitrary user-selected code.
- Test output uses independent UTF-8 stream decoders, bounded partial lines, bounded tail captures,
  and the latest 400 display lines with truncation metadata, so late summaries survive noisy suites.
- Verification exposes `processOk`, `verified`, and `verificationStatus`. A zero exit with unrecognized
  output is `unverified`, not green; recognized zero-test summaries remain valid, and Cargo/Go summaries
  have direct parser fixtures.
- Agent runs that combine `--yes` with `--demo` are refused, so an automated command cannot silently
  modify the checked-in demo. The tour, dump and screenshots operate on a temporary copy.

## Structural scope lens

`lib/scope.mjs` is a structural parser, not a tree-sitter wrapper:

- **Python** uses the indentation contract and recognizes decorated classes and functions.
- **JavaScript/TypeScript** masks comments, strings, template literals and regexes while preserving
  offsets and newlines, then matches braces to derive function/class/method boundaries.
- **Rust, Go and Ruby** recognize common declaration forms and derive depth from indentation and
  braces where applicable.
- Every emitted scope has a real start line, end line, depth, parent and label. The scope screen
  highlights the active line and the chain that contains it. Truncated source is explicitly marked
  `PARTIAL` in the scope header and cards rather than presented as complete analysis.

This is deliberately heuristic. It answers “which declaration encloses this line and where does it
end?” for real files without a native dependency. It does not build a complete syntax tree, and it
does not claim to.

## Pixel canvas

`lib/raster.mjs` implements a genuine RGBA pixel buffer. It includes clipped primitives, alpha
blending, a 3×5 bitmap font, half-block truecolor rendering, and an RGB PNG encoder with CRC32,
zlib deflate and real scanlines.

`lib/graph.mjs` builds three canvases from live data:

- **Scope:** an icicle/flame graph over the parsed file, with the active chain highlighted.
- **Workspace:** language and file inventory from the indexed project.
- **Telemetry:** actual prompt/completion/cache tokens, elapsed time, rounds, tool calls, cost and
  test totals when available; explicit empty states otherwise.

Headers adapt to narrow canvases by shortening their title and dropping the subtitle when it cannot
fit, rather than overdrawing two strings into unreadable pixels. Short telemetry canvases allocate
their rows to token and test summaries and skip the footer instead of painting it over the data.

`matrix vision ... --png` writes the same canvas as a PNG. The default terminal representation is
half-block truecolor; native Kitty graphics are not used by this build. `MATRIX_REDUCED_MOTION=1`
disables animation. `INK_SCREEN_READER=true` also disables animation and replaces every Vision mode
with a textual data summary. The help overlay has a scrollable viewport and visible position so all
keys and slash commands remain reachable at 40×20.

## Swarm semantics

The swarm screen is a projection of one real run, not three independent agents running at once.
Each lane has a different view of the same event stream:

- **Plan/Graph:** plan steps and phase progression.
- **Code Forge:** tool activity, proposed hunks and applied edits.
- **Verification:** test output and the final verification result.

Lane focus, tabbed layout at narrow widths, and bounded logs are real UI state. The screen never
invents a second concurrent model run to fill a lane.

## Sessions and state

`MATRIX_HOME` defaults to `~/.matrix`:

- `sessions/*.json` — session id, workspace, project summary, transcript cards, model, token stats,
  metrics, and versioned `undoRun` recovery entries.
- `backups/` — exact pre-edit file bytes.
- `runs/` — per-run event logs written for later inspection.

Writes use atomic JSON replacement. Session and backup files are created with private permissions
where the platform supports it. Transcript and event retention is newest-first with count and UTF-8
byte budgets. Small `<id>.meta.json` sidecars let session pickers list indexed records without parsing
full transcripts; legacy records fall back to full parsing, while malformed records/sidecars produce
visible warnings. Run-log/backup pruning
is reference-aware and preserves every recovery source referenced by `undoRun` or legacy `lastPatch`.
Save, list, and resume failures surface as structured nonfatal warnings. Session ids are validated
and sessions are filtered by workspace when resuming; a record from another workspace is not loaded.
`/new` starts a fresh id and clears metrics, prompt history, saved patch, undo and auto-approve;
`/clear` clears only the transcript and keeps the session and undo state. `/auto` toggles auto-approve
for the next run. Pressing `a` at a gate enables it for the current run only, and the default is
restored when that run finishes.

Credentials are read from `OPENROUTER_API_KEY` or `~/.matrix/credentials.json` (for example
`{"openrouterApiKey":"..."}`; the legacy `apiKey` field is still accepted). Doctor and the UI report
whether a key is available, never its value. UI and execution share `lib/credentials.mjs`, so routing
rules cannot drift. Interactive availability is cached across renders and revalidated by explicit
model/picker actions; provider execution does not rely on the UI cache.

## CLI and headless behavior

Command-specific flags and positional arguments are validated before work: incomplete values,
non-integer geometry, invalid Vision modes, stray arguments, and incompatible flags fail with a short
help hint rather than being ignored.

The CLI has two modes:

- **Interactive** when stdin and stdout are TTYs. It uses the alternate screen and synchronized
  output when supported.
- **Headless** when a task is supplied without a TTY. It prints a plan, result, edit summary and
  verification, or JSON with `--json`.

Headless edits are denied unless `--yes` is present. The process exit code and `result.ok` are
false when the run errors or has a failure, when verification fails, times out, or is aborted. A
denied patch is still a completed, honest run (exit 0). Remote runs without credentials fail
honestly. Sandboxed headless execution separately requires `--enable-commands` and an exact
`--allow-command` plan hash; a replay is denied. The additive `commands` result array preserves
process, audit, cleanup, truncation, and discarded-write evidence without script bytes. Render-only
commands (`tour`, `dump`, `vision`, `smoke`) never patch the working tree;
`tour` and `dump` use a temporary copy of the bundled demo.

## Testing

The suite uses `node:test` and temporary directories. It covers:

- text width, truncation and ANSI handling;
- project indexing, scope parsing, diffs, task classification and grounded answers;
- the real Local Forge apply, deny, verify and undo path, including resumed-session undo;
- the controller's one-run/approval/abort/undo lifecycle;
- remote streaming and tool calls against mocked HTTP, plus honest missing-key behavior;
- real bubblewrap namespace/mount execution and adversarial command approval, containment,
  executable replacement, audit, cancellation, cleanup, and cross-runtime behavior;
- raster primitives, graph data, short-canvas rendering and PNG encoding;
- every screen at multiple dimensions, all three Vision modes, and frame-width invariants;
- the real Ink application through `ink-testing-library`, including auto-approve lifetime,
  `/test` cancellation and slash-menu scrolling;
- CLI integration: version, help, doctor, sessions, smoke, dump, PNG export, apply, deny, failing
  Node verification, invalid flags, demo-write protection and missing credentials.

Run the direct suite or the complete engineering gate with:

```bash
npm test
npm run check
```

The default suite is network-free. `npm run check` runs recursive syntax checks, ESLint, a
contract-focused JSDoc/`checkJs` pass, Prettier, and the complete suite once with V8 coverage.
`lib/contracts.mjs` defines the public project/result/event/controller types used by the checked
implementation graph; it is not a TypeScript runtime rewrite. The coverage runner parses both Node
22 TAP-prefixed and Node 24 information-prefixed reports, rejects missing/malformed/duplicate data,
and enforces line/branch/function ratchets for 12 safety, protocol, and public-contract modules.
Individual `syntax`, `lint`, `typecheck`, `format:check`, and `coverage` scripts are also available.
The lint toolchain requires Node 22.13+; local gates run on current Node 22 and 24.

## Agent evaluation

`npm run eval` runs a separate, serial, network-free evaluation of real controller/agent behavior.
The default profile has nine Local Forge and seven mocked-remote policy cases covering fix, limited
rename, create, deny, abort, exact undo/refusal, noisy verification, large-repository budgets,
malformed tools/transport, prompt-injection containment, retry/usage provenance, and recovery.
It is not a live model quality benchmark and does not duplicate the full unit suite.

Case-specific `taskSuccess` is independent of `contractPass`; denied completion is not task completion.
Reports retain structured safety violations, complete workspace/recovery evidence, per-attempt
verification, independent retry counters, raw latency samples, and usage/cost provenance. Unknown cost
is null, Local Forge model usage is `not-applicable`, and no cross-provider cost average is computed.
Schema/fixture/baseline versions and exact case membership fail closed. Baseline updates require an
explicit reviewed identity and are forbidden in CI. `node eval/run.mjs --stress` is a separate opt-in.
Generated `eval/reports/` files are gitignored; only reviewed baselines are versioned. Hosted CI runs
the default comparison and uploads sanitized failure evidence.

## Internal packaging

Matrix is a private/internal CLI at 1.0.0. `private` remains true, and `main: src/matrix.mjs` is a
compatibility entry rather than a newly supported public module API. `package.json#files` allows only
`bin/`, `lib/`, `src/`, `demo-project/`, README/MATRIX, LICENSE, and CHANGELOG. The stripped internal
pack intentionally omits source-checkout benchmarks and evaluation fixtures/baselines, engineering
tests/scripts, development configs, planning docs, credentials, local state, generated reports, and
scratch artifacts.

`npm run pack:check` invokes real `npm pack --dry-run --json` with lifecycle scripts disabled and a
temporary destination. It compares the complete file set against the source tree, verifies private,
`main`, `bin`, and executable mode, and fails on unexpected or missing files. It never creates a
tarball or publishes. [RELEASE.md](RELEASE.md) is the maintainer release checklist; hosted Node 22/24
CI and any deliberately scoped live-provider evidence remain separate from local package inspection.

## Known limits

- The scope parser is structural and heuristic, not a full grammar or tree-sitter AST.
- The swarm view is one run projected into three lanes, not independent parallel models.
- Local Forge is deliberately narrow; broad code generation requires a remote model.
- Vision uses half-block truecolor and PNG export, not the Kitty graphics protocol.
- Sandboxed commands are Linux/bubblewrap-only and have no seccomp or aggregate post-exec quotas;
  namespaces/mounts are not a VM, and snapshot writes never become live edits.
- Test-runner detection covers common project manifests and falls back to honest “no runner”
  behavior.
- Approval gates protect edits made through Matrix. They are not an OS sandbox around arbitrary
  commands run by a project's own test suite.
