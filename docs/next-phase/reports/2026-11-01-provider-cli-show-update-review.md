# Provider CLI show/update review — 2026-11-01

**Verdict: CHANGES REQUIRED — one independently reproduced P2.**

Scope: newly added show/update commands, their parser, projections and CLI wiring.
Provider UI/session integration remains undelivered; this is not full phase acceptance.

Candidate over `e1b3c66`, runtime/test/config SHA-256:
`8e154e8c79ac4e3ba0462fbaad5809670adb3f801b6bafec92b5fc3e0d2b7b52`.
24 changed/untracked files hashed in sorted order as path + NUL + bytes + NUL;
docs and AGENTS.md/NEXT_PHASE.md/MATRIX.md/README.md excluded.

## P2: unrelated updates erase a valid unlisted default model

Location: `lib/provider-commands.mjs:186–189`.

The provider contract permits an exact defaultModel even if models is empty: model
selection must not depend on a catalog. updateProvider nevertheless clears any default
absent from the configured list on every update, including name-only changes. This
changes a field the user did not request and breaks subsequent provider-only execution.
The comment describes removal, but the branch does not test whether the current command
actually removed that model.

Independent real-CLI reproduction:

1. In a temporary Matrix home, create a valid lab profile with
   defaultModel `Vendor/Manual:latest`, models `[]`, and anonymous auth.
2. Verify resolveProviderSelection selects that exact default successfully.
3. Run `matrix providers update lab --name Renamed --json` in a subprocess.
4. Actual: exit 0, changes includes both name and defaultModel, stored defaultModel null.
   Resolving the same provider now throws PROVIDER_NO_DEFAULT_MODEL.

No network or real credentials were used.

Required correction: preserve defaultModel on unrelated updates. Only clear it when
an explicit remove-model action removes the current default and no replacement default
was requested. Keep arbitrary exact-ID semantics consistent with the configuration
contract. Add regressions for name/auth/URL updates with an unlisted default, alongside
explicit removal of a configured default and replacement in the same command.

## Verification

Commands, argument parser and actual CLI integration tests: 38 passed, 0 failed,
0 skipped on Node 24.21.0. The independent reproduction is absent from this passing
suite. `git diff --check` passed.
No runtime modifications or commits. Earlier full engineering results apply to the older
candidate, not this newly added command implementation.
