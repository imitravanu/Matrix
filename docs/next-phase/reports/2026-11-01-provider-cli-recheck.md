# Provider CLI repair recheck — 2026-11-01

**Verdict: the stale-cache display finding is fixed. No new finding in this focused check.**
This does not accept the complete provider phase.

Runtime/test/config candidate over `e1b3c66`:
`e99edb4f93ba118ae582b26f748214afedd5f35ad1dfb3ac20af507165a7946b`.
SHA-256 of 24 sorted changed/untracked runtime/test/config files, path + NUL + bytes + NUL;
docs and AGENTS.md/NEXT_PHASE.md/MATRIX.md/README.md excluded.

Independent reproduction: create an isolated profile with a manual model, seed a successful
mocked discovery and then an HTTP 503 failure. Invoke actual CLI subprocesses for
`providers models lab` and the same command with `--json`, without --refresh.
Both exit 0; text contains the stale HTTP 503 warning, JSON has discovery.stale=true,
and both manual and cached models remain available. No live provider was contacted.

The projection now supplies stale from outcome, and the formatter also recognizes error
outcomes directly. The actual CLI regression verifies a new process after a failed refresh,
both output formats and no extra provider requests.

`node --test test/provider-commands.test.mjs test/cli-integration.test.mjs`:
22 passed, 0 failed, 0 skipped on Node 24.21.0. `git diff --check` passed.
No source changes or commits. Full engineering/Node 22 gates were not repeated for this
focused repair; earlier full-gate results belong to the earlier candidate.

Next work remains PRV-104 interactive provider/model selection and session configuration
binding; show/update management actions, probes and complete phase acceptance are still
outstanding. The development-dependency audit finding remains separate.
