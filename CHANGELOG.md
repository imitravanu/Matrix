# Changelog

All notable changes to Matrix are recorded here. Matrix is a private/internal CLI; a version entry is
not a claim that an npm release occurred.

## Unreleased

- Added durable goals on Linux: `matrix goal start|resume|pause|cancel|list|inspect` saves criteria,
  cumulative budgets and operation receipts under `$MATRIX_HOME/goals/`, keeps a resumable goal
  outside the workspace, and reconciles a crashed attempt on the next resume. `--yes` authorizes edits
  for one invocation only, and test dispatch needs a separate `--allow-tests` decision bound to one
  exact test plan. `list` and `inspect` are read-only, and all JSON output is bounded and redacted.
- Added the reviewed pidfd ownership helper (`scripts/build-pidfd-helper.mjs`) used by the durable
  process-ownership boundary. Durable goals require Linux, `bubblewrap`, `util-linux` and a C
  toolchain to build the helper once per machine into `$MATRIX_HOME/bin`; without it, durable goal
  test execution fails closed and `matrix doctor` reports the capability as unavailable. The
  `matrix goal` surface is unavailable on other platforms.
- Added the durability adversarial harness (`npm run eval:durability`), a network-free 20-case
  crash-recovery matrix covering the durable goal store, executor, recovery and process-ownership
  boundaries.
- Added an Ink Swarm review path for bounded, isolated Local Forge parallel batches, explicit conflict
  decisions and integration, saved undo recovery, and independently approved combined verification.
  The ordinary single-run Swarm remains a projection; parallel work remains in progress.
- Hardened parallel Git isolation with sanitized status inspection and no-checkout worktrees populated
  from bounded snapshots, so repository Git filters are not invoked during setup. Isolation currently
  requires Linux and can conservatively refuse repositories with unsupported index or Git settings.
- Durable-goal test evidence is now bound to the complete filesystem input boundary the disposable
  snapshot exposes, not to a working-directory selection or a static import closure. The bounded
  no-follow traversal covers the whole workspace with the snapshot's own exclusions and budgets and
  records every entry's existence, type, permission bits, content digest and symbolic-link target, so
  a changed file, a removed execute bit, a closed directory or a retargeted link anywhere the approved
  test can reach invalidates the evidence instead of letting a goal complete on stale results. Coverage
  that cannot be established completely refuses verification.

## [1.0.0] - 2026-10-26

This is the initial internal baseline. The existing `1.0.0` version is retained deliberately; REL-001
establishes release hygiene without a version bump or publication.

### Added

- Node.js 22+ Ink terminal workbench with the `matrix` CLI, offline Local Forge, optional remote
  providers, approval-gated edits, exact-byte undo, bounded sessions, and honest verification results.
- Structural scope, truecolor Vision, accessible screen modes, and three swarm projections of one
  agent event stream; these lanes do not claim independent parallel execution.
- A self-contained demo project, responsive render smoke checks, reproducible local benchmarks, and a
  network-free engineering suite with static checks and critical-module coverage ratchets.
- A versioned 16-case Local Forge/mocked-policy evaluation with exact recovery and safety evidence,
  strict reviewed baselines, and a separate opt-in large-repository stress profile.
- Optional remote-only `run_sandboxed_command` with exact one-shot argv/script approval, disposable
  no-network bubblewrap snapshots, redacted bounded output, and complete command audits. Legacy
  `run_command` remains disabled; snapshot writes are discarded with no live edit or undo.
- ISC license text, this changelog, a maintainer release checklist, and a deliberate npm-pack
  allowlist with reproducible dry-run inspection.

### Changed

- Hardened provider routing and streaming, tool validation and budgets, repository/test trust,
  process-output handling, lossless diffs, multi-file session recovery, and public outcome semantics.
- Bounded indexing, transcript, event, output, and session work; separated orchestrator responsibilities
  without changing the existing `main` or `bin` compatibility entry points.
- Kept Matrix private and CLI-only. Runtime dependencies remain production dependencies; packaging is
  for internal inspection/distribution, not public npm publication.

### Validation boundaries

- Local Node.js 22/24 checks do not replace the required hosted Node.js 22/24 CI matrix. Hosted run #6
  passed on the hardening branch, including default evaluation and real bubblewrap execution; every
  future release candidate still requires a fresh pass.
- Provider tests use mocks and isolated fake credentials. They do not validate live model availability,
  prices, context limits, tool support, latency, or output quality. Any opt-in live check must be
  reported separately with its date and scope rather than inferred from this changelog.
