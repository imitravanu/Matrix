# Matrix

A spatial agent workbench for the terminal. Matrix combines an offline, deterministic coding
engine with a real approval gate, real test execution, a structural scope lens, a truecolor pixel
canvas, and an event-driven three-lane swarm view. It is designed to be useful before it is
decorative.

No API key is required for the default Local Forge engine. Remote OpenRouter models are optional.

## What is real

- **Local Forge** indexes the workspace, classifies the task, reads the relevant file, proposes a
  concrete patch, asks for approval, writes atomically, runs the project's tests, and reports the
  actual result. It works with no network.
- **Remote models** use a real OpenRouter streaming tool-calling loop with audited tools and the
  same approval gate. Without a key the CLI fails honestly instead of pretending to work.
- **The patch gate** shows the actual hunk and file. `y` applies it, `a` applies and enables
  auto-approval, `n`/`Esc` denies it and leaves the file untouched.
- **Undo** restores the exact bytes from before the edit. It refuses to overwrite a file that was
  changed after Matrix wrote it, including after resuming a saved session.
- **Verification** runs the detected test command and reports real pass/fail totals and failure
  summaries. A failing test does not silently auto-revert the patch. Failed-output tails remain
  visible, and `Alt+O` expands every retained line for scrollable inspection.
- **The scope lens** is built from a local structural parser, not a mock AST. Python uses
  indentation; JavaScript/TypeScript use a masked brace parser; Rust, Go and Ruby use structural
  declarations.
- **Vision** is a real pixel canvas rendered as half-block truecolor and exportable as a PNG.
- **Swarm lanes** are three views of one real agent event stream. They are not three independent
  models running concurrently.
- **Sessions** are saved locally with bounded newest-first transcripts, model, usage, metrics, and
  versioned `undoRun` recovery state. Resume can re-arm undo when every post-patch file still matches
  its stored fingerprint.

## Requirements

- Node.js 22 or newer (developed against Node 24). The development lint toolchain requires Node 22.13+;
  the complete engineering gate is verified on current Node 22 and 24.
- A truecolor terminal is recommended for Vision.
- Python 3 and pytest are only required for the bundled demo and its tests. Other workspaces use
  their detected test runner.
- `git` is optional; branch and dirty-state context is shown when available.

## Quick start

```bash
npm install
npm start
```

`npm start` opens the workbench in the current directory. Describe a task, or type `/` for commands.
The bundled demo is a small, intentionally buggy Python project:

```bash
npm run tour
```

The tour runs Local Forge end-to-end on a temporary copy of `demo-project`, shows the proposal gate,
applies the fix, runs pytest, and renders the real chat, permission, swarm, scope and vision screens.
It removes the temporary workspace when it finishes. A test run on the untouched demo reports
`2 failed, 2 passed`; the fixed state is `4 passed`.

## Common commands

```bash
node bin/matrix.mjs                         # interactive workbench
node bin/matrix.mjs "fix the bounds bug"     # open with a task
node bin/matrix.mjs "fix the bounds bug" --yes --json   # headless, auto-approved
node bin/matrix.mjs doctor                  # environment and capability report
node bin/matrix.mjs sessions                # saved sessions
node bin/matrix.mjs tour --demo             # real end-to-end demo on a temp copy
node bin/matrix.mjs vision scope --demo     # print the pixel canvas
node bin/matrix.mjs vision telemetry --demo
node bin/matrix.mjs vision scope --demo --png vision.png
node bin/matrix.mjs dump --demo --screen chat --mono
node bin/matrix.mjs smoke --demo            # 32 render checks across four sizes
node bin/matrix.mjs bench --iterations 20
node bin/matrix.mjs bench --stress --suite transcript --iterations 3
```

Useful flags:

| Flag                         | Meaning                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `-C, --cwd <dir>`            | Operate on another workspace.                                                             |
| `--demo`                     | Use the bundled demo.                                                                     |
| `--model <id-or-short>`      | `local`, `sonnet`, `gemini`, `gpt-mini`, `deepseek`, `qwen`, `ollama`, or `ollama/<tag>`. |
| `--offline`                  | Force Local Forge.                                                                        |
| `--yes`                      | Auto-approve edits. Use with care. Does not grant test trust.                             |
| `--allow-tests`              | Allow the first exact test plan in a headless invocation; required for headless tests.    |
| `--json`                     | Machine-readable output where supported.                                                  |
| `--resume`, `--session <id>` | Resume a saved interactive session.                                                       |
| `--cols <n> --rows <n>`      | Fixed geometry for `dump` and `vision`.                                                   |
| `--png <path>`               | Export a Vision canvas as a real PNG.                                                     |
| `--mono`, `--no-color`       | Strip colour.                                                                             |
| `--no-alt`, `--no-sync`      | Disable alternate screen / synchronized output.                                           |

Unknown options, incomplete values, incompatible flags, invalid Vision modes, and stray positional
arguments fail before work with a short help hint.

Headless runs are deny-by-default: without `--yes`, the edit is reported as denied and the file is
not changed. Headless test execution also requires `--allow-tests` for the first exact plan; stored
interactive trust is not sufficient, and `--yes` applies only to edits. Their exit code is non-zero
when the result has an error, a failure, or failed, timed-out
or aborted verification. Interactive runs stop at the gate unless auto-approve was explicitly
enabled. Agent runs that combine `--yes` with `--demo` are refused; copy the demo if you want to run
an automated write against it.

## Keys

| Key                    | Action                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `Alt+1` … `Alt+6`      | Empty forge, chat, patch gate, swarm, scope lens, vision; available during runs.       |
| `Enter`                | Send a task or apply the selected model.                                               |
| `Tab`                  | Complete a slash command.                                                              |
| `↑` / `↓` or `j` / `k` | Prompt history, scope/model selection, or help scrolling.                              |
| `←` / `→`              | Cursor movement, lane focus, scope files, or Vision mode.                              |
| `PgUp` / `PgDn`        | Scroll chat, diff, test output, or help.                                               |
| `Alt+m`                | Open the model router (`/model` also works).                                           |
| `/export`              | Export the current Vision canvas as PNG.                                               |
| `f` / `Alt+f`          | Fold at the patch gate / fold diff or reasoning while running.                         |
| `Alt+u`                | Undo the last applied patch when its fingerprint still matches (`/undo` also works).   |
| `Alt+o`                | Expand or collapse retained verification output; PgUp/PgDn inspect all retained lines. |
| `y` / `a` / `n`        | Apply / apply and auto-approve / deny at the patch gate.                               |
| `Alt+h`                | Open help (`/help` also works).                                                        |
| `?` / `Esc`            | Close help / close the current overlay.                                                |
| `Ctrl+C`               | Abort an active run or `/test`; press again to quit when idle.                         |

On the main screens, printable keys always edit the prompt. Alt-modified shortcuts therefore stay
unambiguous at normal typing speed; the patch gate, model picker and help overlay own their keys.
Help supports arrows, `j`/`k`, paging, and Home/End so every command remains reachable at small sizes.

Set `MATRIX_REDUCED_MOTION=1` to disable animation. `INK_SCREEN_READER=true` also disables animation
and replaces every Vision canvas with a textual scope/workspace/telemetry summary.

Slash commands: `/help`, `/new`, `/clear`, `/test`, `/auto`, `/diff`, `/thoughts`, `/chat`, `/ast`, `/scope`, `/swarm`,
`/vision`, `/model`, `/plan`, `/undo`, `/session`, `/doctor`, `/export`, `/quit`.

- `/new` starts a fresh session and clears metrics, prompt history, the saved patch, undo and auto-approve.
- `/clear` clears the transcript but keeps the session and its undo history.
- `/auto` toggles auto-approve for the next run. Pressing `a` at a patch gate enables it for the
  current run only; the default returns after that run finishes.

## Local and remote models

Local Forge is the default and needs no credentials. It is deliberately narrow and deterministic:
it is strongest on explicit source files, off-by-one/slice bugs, test runs, grounded explanations,
and limited renames. It does not claim to be a general-purpose language model.

For remote models, provide an OpenRouter key in either place:

```bash
export OPENROUTER_API_KEY=...
# or create ~/.matrix/credentials.json with {"openrouterApiKey":"..."}
```

Keep the credential file private (`chmod 600 ~/.matrix/credentials.json`). Registry prices and
capabilities are static estimates, not live provider verification. Without the required key, a
headless OpenRouter run fails before any network request. An unknown explicit `--model` is also an
error rather than silently selecting a different engine.

Ollama uses `--model ollama` or `--model ollama/<tag>` and does not require an OpenRouter key.
`OLLAMA_HOST` defaults to `http://127.0.0.1:11434` and applies only to Ollama models. Custom
`MATRIX_API_BASE` uses `MATRIX_API_KEY`; `OPENAI_BASE_URL` uses `OPENAI_API_KEY`, preventing one
provider's credential from being sent to another provider's origin.

Remote tool calls are audited, and file writes still go through the approval gate. Arbitrary
`run_command` shell execution is disabled because its side effects cannot be diffed or undone.

## Safety model

- Writes use a temporary file plus rename; paths must stay inside the workspace.
- The exact original bytes are backed up before an approved write.
- Undo validates that the current file still matches the post-patch fingerprint. If it does not,
  undo refuses rather than overwriting someone else's work.
- Session resume re-arms undo only when both the backup or stored original and the fingerprint are
  available and the file is unchanged.
- A denied proposal is never stored as an applied patch.
- Remote reads refuse known credential paths such as `.env*`, `.git` internals and private keys.
- Test children receive a scrubbed environment without common credentials or loader hooks. Exact
  executable/argv/script-hash trust is required before execution; start/end audits are private and
  bounded, and retained output is redacted. This is not an OS sandbox.
- Test output retains bounded tails with explicit truncation metadata; late summaries survive noisy runs.
- A zero exit with unrecognized output is `unverified`, not a green verification. Recognized zero-test
  summaries remain valid, and process success is reported separately as `processOk`.
- Test failures are reported, not hidden and not auto-reverted.
- `demo-project` is used on a temporary copy for tour, dump, smoke and screenshots.

## State and configuration

Matrix stores sessions, backups and run logs under `~/.matrix` by default:

- `sessions/` — saved transcripts and versioned `undoRun` recovery metadata.
- `backups/` — pre-edit file bytes.
- `runs/` — per-run event logs.

Set `MATRIX_HOME` to use another directory. Session and backup files are written with private
permissions where the platform supports it. Small metadata sidecars make session listing independent
of full transcript parsing; newest-first count/byte limits bound live and saved history. Run-log and
backup pruning preserves every record referenced by offered undo. Save/list/resume warnings are
nonfatal and visible. Resume re-arms a complete versioned `undoRun`, including multi-file edits,
same-file coalescing, created files, and retryable partial undo. Legacy `lastPatch` sessions migrate
conservatively when their recovery metadata is unambiguous.

Remote credentials are read but never printed by doctor or the UI.

## Development

```bash
npm test               # direct network-free node:test suite
npm run check          # syntax + lint + checkJs + formatting + tests/coverage ratchets
npm run syntax         # node --check every source/test/config module
npm run lint           # ESLint correctness rules
npm run typecheck      # contract-focused JSDoc/checkJs
npm run format:check   # Prettier without modifying files
npm run coverage       # full suite once plus critical-module ratchets
npm run eval           # 16 network-free agent cases + strict baseline comparison
npm run smoke          # render sanity checks
npm run bench          # bounded local benchmark cases
npm run pack:check     # inspect the private internal pack without creating a tarball
```

`npm run check` executes the full test suite only once, inside the coverage gate. `npm run eval`
separately exercises 16 deterministic Local Forge and mocked-remote policy cases against reviewed
baselines; `node eval/run.mjs --stress` is an explicit large-repository opt-in. See
[eval/README.md](eval/README.md) for evidence classes, metrics, and baseline-update policy. No live
provider quality, price, availability, or latency claim is made. `npm audit` remains a separate
network-dependent check. The test suite uses temporary workspaces and a temporary
`MATRIX_HOME`; it never intentionally patches the checked-in demo. Tests cover the real Local Forge apply/deny/undo path, resumed-session
undo, remote streaming with mocked HTTP, structural parsing, PNG encoding, responsive screen
geometry, cached transcript scrolling, idle animation, the CLI, and failure paths including a missing
remote key. The benchmark command runs 32 bounded local cases; `--stress` opts into larger fixtures,
and `--suite` selects a suite such as `transcript` or `parser`.

See [MATRIX.md](MATRIX.md) for the architecture, event protocol, and implementation invariants.
For the current engineering audit and phase-wise execution backlog, see
[ENGINEERING_REVIEW.md](ENGINEERING_REVIEW.md) and [ENGINEERING_PLAN.md](ENGINEERING_PLAN.md).
Follow-up coding agents should start with [AGENTS.md](AGENTS.md).

## Internal packaging

Matrix remains a **private/internal CLI** at 1.0.0. The supported consumer entry point is the `matrix`
command; `main: src/matrix.mjs` is retained for compatibility, not declared as a supported public module
API. The pack allowlist includes only runtime modules, the runnable demo, user/architecture docs,
[LICENSE](LICENSE), and [CHANGELOG.md](CHANGELOG.md). Tests, benchmarks, evaluation fixtures/baselines,
development configuration, credentials, local state, generated reports, and scratch artifacts are excluded.

Use `npm run pack:check` for a real `npm pack --dry-run --json` inspection with lifecycle scripts disabled.
It verifies the complete file set, private/main/bin posture, and executable CLI without publishing or
creating a tarball. [RELEASE.md](RELEASE.md) defines the full release checklist. Hosted run #3 passed
on the hardening branch; every future release candidate still requires a fresh Node 22/24 CI pass.

## Limitations

- The structural scope parser is heuristic; it is not a full tree-sitter AST.
- The swarm screen visualises one run's event stream, not independent parallel agents.
- Local Forge is not a general code generator; use a remote model for broader work.
- Vision's half-block canvas is portable, not native Kitty graphics. It exports real PNGs instead.
- The demo is intentionally buggy; its initial pytest result is expected to fail.
