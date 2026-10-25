# Matrix Agent Guide

Matrix is a Node.js/Ink terminal coding-agent workbench. Preserve its local-first behavior, honest
reporting, and approval-gated writes before adding visual or agent capabilities.

## Read first

1. `README.md` — user workflows, commands, keymap, and safety contract.
2. `MATRIX.md` — runtime architecture and implementation invariants.
3. `ENGINEERING_REVIEW.md` — verified findings, baseline measurements, and risks.
4. `ENGINEERING_PLAN.md` — stable task IDs, dependencies, acceptance criteria, and execution waves.
5. `RELEASE.md` — private/internal package boundary and release-only gates.
6. `eval/README.md` — evaluation evidence classes, metrics, baselines, and review policy.

## Environment and verification

- Use Node.js 22 or newer at runtime; the lint toolchain requires Node 22.13+, and development uses Node 24.
- Install with `npm install` only when dependencies are missing or intentionally changing; use `npm ci` for clean-checkout verification.
- Run `npm test` for the direct network-free `node:test` suite.
- Run `npm run check` for the complete syntax, ESLint, JSDoc/`checkJs`, Prettier, test, and critical-module coverage gate. It runs tests once inside `npm run coverage`.
- Run `npm run smoke` for all screens at four terminal geometries.
- Run `npm run bench` before and after rendering or indexing performance work.
- Run `npm run eval` after changing agent behavior or evaluation contracts; stress and baseline updates are explicit, separate decisions.
- Run `npm run syntax` after changing module boundaries or CLI entry points; use `node --check` for quick focused checks.
- Use `npm run format:check` for verification. Restrict `npm run format` to deliberate formatting changes.
- Run `npm run pack:check` after changing package boundaries; it must inspect the real dry-run pack without creating a tarball.

The default test suite must not require network access or real provider credentials. Use temporary
workspaces and a temporary `MATRIX_HOME`; never intentionally modify the checked-in demo.

## Non-negotiable invariants

- Every file-changing agent proposal passes the same explicit approval gate. Headless runs deny by
  default. Do not add a tool that bypasses this contract.
- Resolve workspace paths safely, revalidate approved bytes before writing, preserve file modes, and
  write atomically. Undo restores exact bytes or refuses honestly.
- Never silently revert a failing change or turn a failed/aborted verification into success. Use
  `lib/outcome.mjs` for terminal classification instead of adding independent success predicates;
  emit final metrics before `result` and keep `done` last.
- Do not print, copy, or commit credentials. Tests use mocks and isolated credential fixtures only.
- Keep Local Forge useful offline. Remote integrations must fail honestly when unavailable.
- Require exact repository/test trust before spawning. `--yes` is edit-only; headless tests need a
  dedicated `--allow-tests` decision. Preserve private bounded execution audits and redact output.
- The current swarm is three projections of one event stream, not independent parallel agents. Do not
  imply otherwise until real isolated concurrency exists.
- Keep event, transcript, process-output, and swarm collections bounded.

## UI contract

- Printable input belongs to the prompt on main screens; never use timing to guess whether a
  printable key was a shortcut. Global main-screen shortcuts use Alt. The patch gate, model picker,
  and help overlay own their keyboards.
- Read-only screen navigation remains available during active runs.
- Use `forge.text` for primary copy, `forge.muted` for readable secondary copy, and `forge.dim` only
  for decoration. Do not reduce functional-text contrast for visual effect.
- Test changed screens at 40×20, 60×22, 80×26, 100×30, and 140×40 as applicable. Preserve exact frame
  widths and usable narrow-screen content, not just absence of overflow.
- Keep `MATRIX_REDUCED_MOTION` and `INK_SCREEN_READER` paths functional: no unnecessary animation,
  scrollable help with all commands reachable, and textual summaries for every Vision mode.

## Task workflow for follow-up agents

1. Claim one stable task ID from `ENGINEERING_PLAN.md`; read its dependencies and file-ownership notes.
2. Inspect the current working tree and preserve other agents' changes. Do not revert unrelated work.
3. Reproduce the issue or add a characterization/regression test before behavioral changes when practical.
4. Make the smallest coherent change that satisfies the task's acceptance criteria. Avoid drive-by
   rewrites and unrelated dependency additions.
5. Add tests for success, failure, cancellation, and boundary cases relevant to the task.
6. Update `README.md`, `MATRIX.md`, and the task status when behavior or architecture changes. The
   integrator owns shared documentation during parallel execution waves to avoid conflicts.
7. Run the required verification commands and report exact results, remaining risks, and files changed.

`src/matrix.mjs`, `package.json`, `package-lock.json`, and shared test helpers are high-collision files.
Only one agent should own each in an execution wave. Do not start the orchestrator split while another
agent is changing UI behavior in `src/matrix.mjs`.

Do not commit, push, rebase, or otherwise mutate git history unless the user explicitly requests it.
