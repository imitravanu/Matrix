# Provider probe review — 2026-11-01

Decision: CHANGES REQUIRED. Runtime/test/config fingerprint:
`a34fe63fe89c6cc3a2793dda3f851a1a91f796841608306aad76da7ae9fbf5b8`
(41 changed/untracked files; sorted path + NUL + bytes + NUL, excluding docs/,
AGENTS.md, README.md, MATRIX.md and NEXT_PHASE.md).

## P1 — Unexpected tool names expose credentials

`lib/provider-probe.mjs:240` interpolates a provider-controlled tool name into
an error without redaction. `boundedError` only truncates. The stream core
redacts transport errors, but deliberately preserves tool deltas; this new error
path must independently redact before truncating or omit the untrusted name.

Independent reproduction: create a temporary bearer profile and inject an SSE
response with a tool call whose function name is the fake bearer credential.
Run the real `probeProvider` with the shared stream parser. Both the returned
result and the persisted `.probes.json` contain the exact credential. The CLI
prints this result/error, so private file modes do not close the disclosure.
No real secret was used or printed during the reproduction.

Required regression: exact, URL-encoded and JSON-escaped canaries in unexpected
tool names must be absent from result JSON, formatted output and persisted bytes.
Sanitize before bounding so truncation cannot preserve a credential prefix.

## P2 — Tool follow-up can pass without completing the round trip

`lib/provider-probe.mjs:268–270` accepts any follow-up with `[DONE]`, even another
tool request. `consume` ignores finish reasons and this branch does not inspect
the follow-up's tool calls or content.

Independent reproduction: return the same valid `matrix_probe_noop` call with
`finish_reason: "tool_calls"` in both responses. The second call remains
unanswered, but the probe returns `ok: true`, tools `pass`, two requests. A bare
`[DONE]` response is also sufficient. This is not evidence that the synthetic
tool result was successfully consumed and the exchange completed.

Require an explicit completed follow-up appropriate to this fixture, reject
additional tool calls and incomplete/truncated finish reasons, and cover
empty, repeated-call, malformed-call and normal completed responses. Preserve
the three-request ceiling; do not keep invoking tools to obtain a pass.

## P2 — Missing usage fields become observed zeros

`lib/provider-probe.mjs:285–288` initializes all token counters to zero after
seeing any usage field. A response containing only `completion_tokens: 2`
produces `{prompt_tokens: 0, completion_tokens: 2, total_tokens: 0}` in the
report and store. Missing-usage rounds are also silently omitted from totals.

Keep missing fields unknown and distinguish partial observed sums from complete
invocation usage. Test partially populated usage and mixed rounds with/without
usage; no missing token count should become a claim of zero consumption.

## Evidence scope

The three reproductions used temporary profiles, fake credentials and injected
SSE Response objects through the production stream parser. No external service
or repository data was sent. The existing probe suite passed 12 tests, zero
failures/skips (`/tmp/matrix-probe-review.log`); those tests miss these cases.
Provider command, CLI parser and CLI integration suites passed another 45 tests,
zero failures/skips (`/tmp/matrix-probe-cli-review.log`). `git diff --check` passed.
The full engineering gate was not rerun for this review. No runtime edits or
commits were made.
