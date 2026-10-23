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
3. **Show the bytes and the result.** The UI renders the actual hunk, the actual test output, the
   actual token usage, and the actual file that changed. Empty or unavailable data is shown as
   empty, not as a decorative statistic.
4. **Keep the visual identity, but make it earn its pixels.** The phosphor palette, spatial screens
   and pixel canvas remain. The canvases are now driven by the parsed workspace and the live run.

## Runtime map

| Area | File | Responsibility |
| --- | --- | --- |
| CLI | `bin/matrix.mjs` | Interactive, headless, tour, dump, vision, smoke, bench, doctor, sessions. |
| CLI parser | `lib/cli.mjs` | Subcommands, flags, validation, help text. |
| Project index | `lib/project.mjs` | Workspace walk, language counts, test-runner detection, git context. |
| Structural parser | `lib/scope.mjs` | Python indentation scopes; masked JS/TS brace scopes; Rust/Go/Ruby declarations. |
| Task layer | `lib/task.mjs` | Intent classification, candidate scoring, grounded search results. |
| Local engine | `lib/local-agent.mjs` | Deterministic inspect/propose/apply/verify loop. |
| Remote engine | `lib/model-agent.mjs`, `lib/openrouter.mjs` | Streaming OpenRouter loop, audited tools, usage accounting. |
| Controller | `lib/controller.mjs` | One active run, approval lifecycle, abort, undo stack, session re-arm. |
| Safety | `lib/workspace.mjs` | Path containment, atomic writes, mode preservation. |
| Diff | `lib/diff.mjs` | Line diff and hunks used by the gate and cards. |
| Process | `lib/process.mjs` | Bounded child processes, streaming output, test-result parsing. |
| Sessions | `lib/session.mjs` | `MATRIX_HOME`, atomic JSON sessions, backups, run event logs. |
| UI | `src/matrix.mjs` | Application state, key handling, event reducer, screen composition. |
| Cards | `src/cards.mjs` | Pure card builders; no terminal or filesystem side effects. |
| Screens | `src/screens/*.mjs` | Empty, chat, permission, swarm, scope and vision views. |
| Renderer | `src/render.mjs` | `Frame`, screen renderer, geometry checks (`checkFrame`). |
| Panels | `lib/graph.mjs` | Real workspace/scope/telemetry canvases and adaptive headers. |
| Raster | `lib/raster.mjs` | Pixel buffer, primitives, half-block truecolor, PNG encoder. |
| Swarm state | `lib/swarm.mjs` | Projects run events into three lanes with bounded logs. |
| Doctor | `lib/doctor.mjs` | Runtime, workspace, git, test, credential, session-home and demo checks. |

The UI is split so that card construction can be tested without a terminal, and so screen
rendering can be checked at fixed dimensions with `MATRIX_COLS`/`MATRIX_ROWS` or `checkFrame`.

## A Local Forge run

A typical task such as “fix the off-by-one in the bounds slice in src/processor.py” follows this
path:

1. `detectProject` builds a bounded index (file list, language counts, test command, git branch).
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

| Tool | Effect |
| --- | --- |
| `list_files` | Read-only workspace listing. |
| `search_repo` | Read-only literal search. |
| `read_file` | Read-only bounded file read. |
| `propose_edit` | Builds a real validated patch; never writes by itself. |
| `run_tests` | Runs the detected test command. |

A `propose_edit` tool call creates a proposal, requests approval, and only then writes. The same
controller gate is used for local and remote runs, so denying a remote edit leaves the file
untouched. If the model edits a file but forgets `run_tests` — or tested before the latest edit —
the agent runs verification after the round. Usage and cost are taken from OpenRouter's response and
from the model registry pricing, not invented by the renderer.

If no OpenRouter key is configured, a remote headless run exits with an error before making a
network request. In the interactive UI, selecting a remote model produces a warning; Local Forge
remains selected and usable.

## Agent event protocol

The renderer, swarm lanes, session log and verification cards all consume the same events:

| Event | Meaning |
| --- | --- |
| `run:start` | Mode, model, task and initial plan. |
| `phase` | Current phase (planning, reading, editing, applying, verifying, complete, failed). |
| `plan`, `plan:step` | Plan and per-step status updates. |
| `thought`, `content` | Streaming reasoning and answer text. |
| `tool:start`, `tool:end` | Audited tool lifecycle with a summary and optional card data. |
| `proposal` | A validated patch with file, hunk, stats and rationale. |
| `approval:request`, `approval:result` | The gate and its decision. |
| `applied` | The write actually happened; includes backup path and stats. |
| `verify:start`, `verify:line`, `verify:end` | Real test execution and parsed totals. |
| `verify:skipped` | No runner was detected, so verification did not happen. |
| `usage` | Provider token usage; only emitted when available. |
| `metrics` | Elapsed time, rounds, tool calls and cost. |
| `result` | The final public result card. |
| `error` | A real failure, with an aborted flag when applicable. |
| `abort:requested` | The user requested cancellation while a run was active. |
| `undo` | Files restored by the undo stack. |
| `done` | The run is finished, whether successful, denied, failed or aborted. |

Logs in the swarm state are bounded, so a noisy stream cannot grow the UI without limit.

## Approval and undo invariants

The safety rules are enforced in code, not just in documentation:

- A requested path is resolved inside the workspace. Traversal and symlink escapes are rejected.
- Indexing skips symlinks, and reads are capped. A truncated read is never editable because writing
  it back would delete the unseen tail.
- Before a write, the path is re-resolved and the current bytes are compared with the approved
  proposal. A file that changed or grew after approval is refused, not overwritten.
- Writes preserve the original file mode and use a temporary file plus rename.
- A backup is created before an approved write.
- The controller records `original`, `updatedText`, `absPath`, `backupPath`, patch stats and the
  hunk. Undo validates every target first, then restores the files in the last applied edit. Multiple
  edits to one file are coalesced so the first original and final fingerprint produce one exact undo.
- Undo compares the current file bytes with the stored post-patch fingerprint. If someone else
  changed the file, undo refuses instead of overwriting their work.
- A denied proposal is not stored as an applied patch and produces no undo entry.
- Session resume re-arms undo only when the stored backup or original and the fingerprint are
  available and the current file still matches. A resumed session that cannot prove this is honest
  about not offering undo.
- A test failure is a reported result. It does not cause an automatic revert.
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
  highlights the active line and the chain that contains it.

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
half-block truecolor; native Kitty graphics are not used by this build.

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
  metrics, and last-patch metadata.
- `backups/` — exact pre-edit file bytes.
- `runs/` — per-run event logs written for later inspection.

Writes use atomic JSON replacement. Session and backup files are created with private permissions
where the platform supports it. Sessions are filtered by workspace when resuming. `/new` starts a
fresh id and clears metrics, prompt history, saved patch and undo; `/clear` clears only the
transcript and keeps the session and undo state.

Credentials are read from `OPENROUTER_API_KEY` or `~/.matrix/credentials.json`. Doctor and the UI
report whether a key is available, never its value.

## CLI and headless behavior

The CLI has two modes:

- **Interactive** when stdin and stdout are TTYs. It uses the alternate screen and synchronized
  output when supported.
- **Headless** when a task is supplied without a TTY. It prints a plan, result, edit summary and
  verification, or JSON with `--json`.

Headless edits are denied unless `--yes` is present. The process exit code is non-zero when the run
errors or verification reports failures. Remote runs without credentials fail honestly. Render-only
commands (`tour`, `dump`, `vision`, `smoke`) never patch the working tree; `tour` and `dump` use a
temporary copy of the bundled demo.

## Testing

The suite uses `node:test` and temporary directories. It covers:

- text width, truncation and ANSI handling;
- project indexing, scope parsing, diffs, task classification and grounded answers;
- the real Local Forge apply, deny, verify and undo path, including resumed-session undo;
- the controller's one-run/approval/abort/undo lifecycle;
- remote streaming and tool calls against mocked HTTP, plus honest missing-key behavior;
- raster primitives, graph data, short-canvas rendering and PNG encoding;
- every screen at multiple dimensions, all three Vision modes, and frame-width invariants;
- the real Ink application through `ink-testing-library`;
- CLI integration: version, help, doctor, sessions, smoke, dump, PNG export, apply, deny, invalid
  flags, demo-write protection and missing credentials.

Run it with:

```bash
npm test
```

No network is required for the default suite.

## Known limits

- The scope parser is structural and heuristic, not a full grammar or tree-sitter AST.
- The swarm view is one run projected into three lanes, not independent parallel models.
- Local Forge is deliberately narrow; broad code generation requires a remote model.
- Vision uses half-block truecolor and PNG export, not the Kitty graphics protocol.
- Test-runner detection covers common project manifests and falls back to honest “no runner”
  behavior.
- Approval gates protect edits made through Matrix. They are not an OS sandbox around arbitrary
  commands run by a project's own test suite.
