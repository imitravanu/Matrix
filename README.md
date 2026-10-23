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
- **Verification** runs the detected test command and shows its real output and real pass/fail
  totals. A failing test does not silently auto-revert the patch.
- **The scope lens** is built from a local structural parser, not a mock AST. Python uses
  indentation; JavaScript/TypeScript use a masked brace parser; Rust, Go and Ruby use structural
  declarations.
- **Vision** is a real pixel canvas rendered as half-block truecolor and exportable as a PNG.
- **Swarm lanes** are three views of one real agent event stream. They are not three independent
  models running concurrently.
- **Sessions** are saved locally with their transcript, model, usage, metrics, and last patch. Resume
  can re-arm undo when the post-patch file still matches its stored fingerprint.

## Requirements

- Node.js 22 or newer (developed against Node 24).
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
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `-C, --cwd <dir>` | Operate on another workspace. |
| `--demo` | Use the bundled demo. |
| `--model <id-or-short>` | `local`, `sonnet`, `gemini`, `gpt-mini`, `deepseek`, `qwen`. |
| `--offline` | Force Local Forge. |
| `--yes` | Auto-approve edits. Use with care. |
| `--json` | Machine-readable output where supported. |
| `--resume`, `--session <id>` | Resume a saved interactive session. |
| `--cols <n> --rows <n>` | Fixed geometry for `dump` and `vision`. |
| `--png <path>` | Export a Vision canvas as a real PNG. |
| `--mono`, `--no-color` | Strip colour. |
| `--no-alt`, `--no-sync` | Disable alternate screen / synchronized output. |

Headless runs are deny-by-default: without `--yes`, the edit is reported as denied and the file is
not changed. Interactive runs stop at the gate unless auto-approve was explicitly enabled.
Agent runs that combine `--yes` with `--demo` are refused; copy the demo if you want to run an
automated write against it.

## Keys

| Key | Action |
| --- | --- |
| `1` … `6` | Empty forge, chat, patch gate, swarm, scope lens, vision. |
| `Enter` | Send a task or apply the selected model. |
| `Tab` | Complete a slash command. |
| `↑` / `↓` | Prompt history; model selection in the picker. |
| `←` / `→` | Cursor movement; lane focus on the swarm screen. |
| `PgUp` / `PgDn` | Scroll chat, diff or test output. |
| `m` | Open the model router. |
| `v` / `e` | Cycle Vision mode / export the current canvas as PNG. |
| `f` | Fold the diff or reasoning. |
| `u` | Undo the last applied patch (when its fingerprint still matches). |
| `y` / `a` / `n` | Apply / apply and auto-approve / deny. |
| `[` `]` | Previous/next file in the scope lens. |
| `j` / `k` | Previous/next scope in the scope lens. |
| `?` / `Esc` | Help / close the current overlay. |
| `Ctrl+C` | Abort an active run; press again to quit when idle. |

Slash commands: `/help`, `/new`, `/clear`, `/test`, `/auto`, `/diff`, `/ast`, `/swarm`, `/vision`, `/model`,
`/undo`, `/session`, `/doctor`, `/quit`.

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

The model registry uses real OpenRouter IDs and prices. Without a key, selecting a remote model shows
an honest warning; a headless remote run exits with an error and makes no network call. Remote tool
calls are audited, and file writes still go through the approval gate.

## Safety model

- Writes use a temporary file plus rename; paths must stay inside the workspace.
- The exact original bytes are backed up before an approved write.
- Undo validates that the current file still matches the post-patch fingerprint. If it does not,
  undo refuses rather than overwriting someone else's work.
- Session resume re-arms undo only when both the backup or stored original and the fingerprint are
  available and the file is unchanged.
- A denied proposal is never stored as an applied patch.
- Test failures are reported, not hidden and not auto-reverted.
- `demo-project` is used on a temporary copy for tour, dump, smoke and screenshots.

## State and configuration

Matrix stores sessions, backups and run logs under `~/.matrix` by default:

- `sessions/` — saved transcripts and last-patch metadata.
- `backups/` — pre-edit file bytes.
- `runs/` — per-run event logs.

Set `MATRIX_HOME` to use another directory. Session and backup files are written with private
permissions where the platform supports it.

Remote credentials are read but never printed by doctor or the UI.

## Development

```bash
npm test          # node:test suites, including real parser, raster, agent, CLI and Ink tests
npm run check     # alias for npm test
npm run smoke     # render sanity checks
npm run bench
```

The test suite uses temporary workspaces and a temporary `MATRIX_HOME`; it never intentionally
patches the checked-in demo. Tests cover the real Local Forge apply/deny/undo path, resumed-session
undo, remote streaming with mocked HTTP, structural parsing, PNG encoding, responsive screen
geometry, the CLI, and failure paths including a missing remote key.

See [MATRIX.md](MATRIX.md) for the architecture, event protocol, and implementation invariants.

## Limitations

- The structural scope parser is heuristic; it is not a full tree-sitter AST.
- The swarm screen visualises one run's event stream, not independent parallel agents.
- Local Forge is not a general code generator; use a remote model for broader work.
- Vision's half-block canvas is portable, not native Kitty graphics. It exports real PNGs instead.
- The demo is intentionally buggy; its initial pytest result is expected to fail.
