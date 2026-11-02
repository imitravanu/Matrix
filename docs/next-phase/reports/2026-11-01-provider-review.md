# Provider candidate review — 2026-11-01

**Verdict: CHANGES REQUIRED. The provider phase is not complete or accepted.**

Reviewed the uncommitted implementation over `e1b3c66` using source inspection,
existing tests, a real PTY, a controlled two-process lock schedule, and isolated
configuration/transport/agent reproductions. No production source was changed by this
review, no commit was created and no live provider was contacted. This is a focused
review, not completion of every PRV-106 matrix case.

Runtime/test/config candidate SHA-256:
`1e3c5942b04022d8378c2c2422b6c956a8e6b623702ec78b5d537c3adea0de80`.
Computed over the 18 modified/untracked runtime, test and configuration files, sorted by
path, concatenating path + NUL + raw bytes + NUL. Planning/docs files were excluded.

## Findings

### R1 — P1: terminal tasks bypass explicit provider selection

Location: `bin/matrix.mjs:811–829` (especially the `!options.task` guard).

With stdin/stdout attached to a terminal, adding a task bypasses the guard that refuses
unsupported interactive custom providers. The function then uses the static legacy model
resolver and launches MatrixApp without passing the provider. Consequently the documented
command rejects arbitrary IDs in a normal terminal; a recognized legacy ID can select
that legacy model instead of the explicitly requested provider. No-model selection can
also fall back to the ordinary default.

**Reproduced:** in a real PTY, run
`node bin/matrix.mjs --provider review-nonexistent --model 'Review/Arbitrary:tag' 'Inspect this repository'`.
Actual error: `unknown model "Review/Arbitrary:tag"`, proving the legacy resolver runs
instead of validating the requested provider. The source confirms the provider is absent
from MatrixApp props. No inference request was made in this reproduction.

**Required correction:** route explicit-provider task invocations through the implemented
provider path irrespective of TTY, or explicitly reject every unsupported TTY invocation
until integration exists. Never ignore the provider. Add actual CLI/PTY tests for an
arbitrary model, a legacy alias and an omitted model; assert the exact endpoint or zero
requests on refusal. The existing provider integration test calls runModelAgent directly.

### R2 — P1: stale-lock recovery can steal a live writer's replacement lock

Location: `lib/provider-config.mjs:254–263` and its acquisition caller.

Reclaim decides that a lock is dead, then renames whatever directory currently occupies
that path. Another contender can reclaim the dead directory and acquire a new live lock
between those operations. The delayed contender then removes the new lock and acquires
its own. The comment that only one contender can win is false when the path is recreated.
Both processes can now enter the configuration critical section, permitting lost updates.

**Reproduced:** create a lock with a nonexistent owner PID. Pause contender A immediately
before its reclaim rename using a test-only filesystem wrapper and SIGSTOP; wait until
`/proc/PID/status` confirms it stopped. Let B acquire/reclaim and hold the lock. Resume A.
Observed: A also returns an acquired lock while B remains alive; the owner token changes
and B's release returns false. Only temporary homes and owned subprocesses were used.

The missing-owner path also reclaims on age after a short reread; a process paused between
mkdir and owner publication can still be alive. Age alone does not establish safe recovery.

**Required correction:** use an acquisition/recovery protocol that cannot remove a new
owner's lock, preferably a proven OS-held exclusion mechanism for this Linux target.
Prove the exact delayed-reclaimer and paused-owner schedules, plus multiple simultaneous
reclaimers. Adding a token check followed by an unprotected rename is not sufficient.

### R3 — P1: error redaction leaks recoverable encoded credentials

Location: `lib/openrouter.mjs:443–446,675`; equivalent pattern in
`lib/provider-discovery.mjs`.

Redaction replaces only the literal key. A provider echoing its URL-encoded or JSON-escaped
form exposes recoverable credential material through error events. HTTP detail is also
truncated before redaction, so a key spanning that boundary leaks its visible prefix.
Short credentials are excluded from redaction entirely.

**Reproduced:** invoke streamChatCompletions with a fake key containing `/` and `+`, and
an injected HTTP 400 response containing `encodeURIComponent(key)`. The returned error
contains the complete encoded canary and no redaction marker. With 155 prefix characters
followed by the literal canary, the returned error contains the first five key characters.
No real secrets or remote connections were used.

**Required correction:** centralize redaction for supported literal/encoded forms, apply it
before display truncation, and avoid exposing raw untrusted error-body fragments when
safe redaction is uncertain. Cover discovery, streaming errors, headers and persisted
artifacts. Regression assertions must search for canaries rather than just a marker.

### R4 — P2: successful mutations can make the configuration unreadable

Location: `lib/provider-config.mjs:373–379,442–444`.

Mutation validates schema/count limits but never validates the UTF-8 byte length of the
serialized file. The writer can therefore commit more than the loader's 1 MiB maximum,
return success and leave every subsequent load/mutation rejecting CONFIG_TOO_LARGE.
The previous valid configuration has already been replaced.

**Reproduced:** add profiles with 256 valid models each (roughly 200-character IDs and
200-character display names) to a temporary home. An add returned success with a
1,066,349-byte providers.json; immediate reload returned `invalid / CONFIG_TOO_LARGE`.
All individual field/model/profile limits were respected.

**Required correction:** serialize once, check the exact persisted UTF-8 byte length
including formatting/newline before replacement, and fail without changing prior bytes.
Test cumulative multi-profile growth, Unicode byte expansion and the exact boundary.

### R5 — P2: credentials are resolved again on every tool round

Location: `lib/model-agent.mjs:1116–1125`,
`lib/provider-transport.mjs:65,108–117`.

The endpoint descriptor is frozen, but each streamProviderChat call resolves its key from
the mutable environment again. One agent run can thus use different credentials on
successive tool rounds, contrary to the declared whole-run binding. Command audit
redaction separately captures the original key and can diverge from the transport.

**Reproduced:** run a temporary-workspace agent against an injected two-response provider.
The first response requests list_files; change the supplied environment's key after that
request. The second request uses the replacement credential. Observed two requests,
first with the original fake key, second with the replacement fake key.

**Required correction:** resolve a private credential binding once at run start and share
it across every round/retry and related redaction. Keep it out of serializable events and
sessions. Test environment mutation between rounds and separately verify a new run sees
a deliberately changed credential.

## Remaining delivery gaps

The current status board already acknowledges partial delivery. Source inspection confirms:

- Provider add/list/show/remove/discovery CLI commands are absent; configuration requires
  editing the user file or invoking library functions.
- The TUI picker/manual model entry and per-profile doctor integration are absent.
- Sessions do not persist/validate provider/model/configuration bindings.
- Explicit built-in provider selection is not supported by the custom-profile resolver.
- Compatibility probes and provider-aware evaluation are not delivered.
- P1's real CLI approved-edit → separately authorized test → exact undo demonstration is
  absent. The two integration tests exercise argument parsing and one text-only library run.
- PRV-106's full adversarial matrix and PRV-107's final integration decision remain pending.

These gaps are phase-completion blockers, distinct from the reproduced implementation bugs.
Do not mark PRV-101/102/103 accepted merely because their existing tests pass.

## Verification performed

- Node version: 24.21.0.
- `node --test test/provider-*.test.mjs`: 43 passed, 0 failed, 0 skipped.
- `npm run check`: exit 0; 617 passed, 0 failed, 0 skipped. Coverage:
  93.86% lines, 83.51% branches, 94.45% functions.
- Independent reproductions above demonstrate behavior the passing suite does not cover.
- Node 22, hosted CI, live-provider compatibility and model quality were not evaluated.
- Evaluation, smoke and packaging were not re-run in this focused review; passing
  historical runs must not be substituted for missing exact-candidate evidence.

Repair R1–R5, add the reproductions as durable regression cases, then complete the missing
integration and audit requirements. Review the resulting exact candidate before acceptance.
