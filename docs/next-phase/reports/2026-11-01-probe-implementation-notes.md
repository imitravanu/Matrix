# PRV-105 implementation notes

The probe must use only synthetic messages and a synthetic no-op tool. It must
not pass the workspace, repository content, or ordinary agent tools to a provider.

The existing `streamProviderChat` accepts a pre-bound credential and forwards
transport options to `streamChatCompletions`. The stream reports `content`,
fragmented `tool_call` events (index/key/id/name/arguments), `finish`, `done`
and `error`. The transport defaults to two retries and a 300-second total timeout;
a probe must explicitly set `maxRetries: 0` and enforce its own 30-second
deadline across all requests, rather than resetting that deadline per request.

Recommended invocation sequence: resolve one target and bind its credential once;
request text once if selected; request the synthetic tool call once if selected;
validate one complete call, then send a synthetic tool result with the exact call
ID and require the subsequent response. Three requests is therefore the maximum
when both checks are selected. Set at most 256 completion tokens on each request.
Use a shared abort signal for interruption and deadline; stop immediately on
failure and record unattempted checks as not evaluated.

The observation store needs an independently reviewed private, atomic, bounded
implementation. Key observations by profile ID, target digest and exact wire
model ID; retain at most one per model and 256 models per profile. A changed
profile digest must not display an old success. Persist only bounded redacted
status and usage, not credentials, request headers, raw provider output or
synthetic tool arguments. Unknown usage/cost must remain unknown.

Before shipping, test loopback fixtures for fragmented and malformed calls,
ignored calls, mismatched tool-result IDs, redirects, cancellation, deadline,
retry cap, malformed/oversized streams, canary redaction, cache replacement,
and unknown usage. Exercise the CLI and an opt-in evaluator with the same exact
provider/model identity. Default evaluation remains offline. Live checks are
not required to establish deterministic protocol behavior and must never be
reported as coding-quality evidence.

PRV-105 is not implemented or accepted by these notes. PRV-101 through PRV-104
remain unaccepted in the dispatch board; the required independent contract and
integration gates still apply.
