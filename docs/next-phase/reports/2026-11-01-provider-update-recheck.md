# Provider update repair recheck — 2026-11-01

**Verdict: the unlisted-default erasure finding is fixed. No new finding in this
focused repair check. Full provider-phase acceptance remains pending.**

Candidate over `e1b3c66`, runtime/test/config SHA-256:
`7313d877cab9319efb94e9c1c49591b75f1fc018cc2a22bf72b25b0654a3f837`.
24 changed/untracked files hashed in sorted order as path + NUL + bytes + NUL;
docs and AGENTS.md/NEXT_PHASE.md/MATRIX.md/README.md excluded.

Independent reproduction used an isolated home with a valid defaultModel
`Vendor/Manual:latest` and an empty configured model list. Actual CLI subprocesses
performed name-only, URL-only and auth-only updates. All exited 0, preserved the exact
default model and reported only the requested field in changes. Provider-only selection
continued resolving successfully after each update. No live provider was contacted.

The implementation now clears the default only if this command explicitly removes that
model. Added regression coverage also checks removal of a configured default and removal
with a replacement default in the same update.

Commands, parser and actual CLI integration tests: 40 passed, 0 failed, 0 skipped
on Node 24.21.0. `git diff --check` passed. No runtime changes or commits.
Full engineering and Node 22 checks were not repeated for this focused repair.

Next work remains PRV-104 interactive picker/manual model entry and session binding,
followed by remaining replacement management, probes and full phase acceptance. The
previous dependency-audit findings are separate and remain unresolved.
