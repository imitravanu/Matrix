# Probe stream-bound repair — 2026-11-02

The P2 in the [stream-bound review](2026-11-02-probe-stream-bound-review.md) is repaired
at cause. This is a self-tested repair, not acceptance of the probe or PRV-105.

## Finding

`consume()` in `lib/provider-probe.mjs` appended every tool-argument fragment to one
string and retained every call and finish reason until the stream completed.
`runToolsCheck()` checked the 4 KiB argument bound only after that return, so a provider
could stream many small valid events and grow the probe observation beyond the advertised
limit.

## Repair

- The per-call byte count is now updated as each `tool_call` fragment arrives. The first
  fragment that would cross `PROBE_LIMITS.toolArgumentBytes` sets
  `synthetic tool arguments exceeded the probe bound` and breaks the event loop before the
  fragment is appended.
- Breaking out of the `for await` loop returns through the shared stream generator's
  `finally`, which cancels the reader and closes the HTTP response. The probe does not wait
  for `[DONE]` or the total deadline.
- Only one tool call is observed (`PROBE_LIMITS.toolCalls`); a second distinct call stops
  the stream instead of growing the map. Only the last finish reason is retained.
- The post-consume argument check remains as a defensive assertion, but is no longer the
  enforcement point.

## Regression

`test/provider-probe.test.mjs` adds a loopback response with 100 SSE events for one tool
call. Each event carries a 1,024-byte argument fragment (below the per-event bound), the
response has no `[DONE]`, and it stays open until the client cancels. The probe:

- fails the tools check with `/exceeded the probe bound/` in under 2 seconds while the
  invocation budget is 4 seconds;
- sends exactly one request and no follow-up;
- causes the server to observe response cancellation before the test's 2-second close
  watchdog.

The existing 5000-byte single-fragment case still fails before a follow-up, and the full
probe suite (21 tests) passes.

## Verification

Node 24.21.0 on this host:

- `node --test test/provider-probe.test.mjs` — 21 tests, 21 pass, 0 fail, 0 skipped.
- `npm run check` — exit 0; **717 tests, 717 pass, 0 fail, 0 skipped**; 176 modules
  syntax-checked; coverage 94.20% lines / 84.20% branches / 94.59% functions, every floor
  passing (`provider-probe` 92.59/82.52/100.00 against 90/75/95).
- The default offline eval and provider-eval suites were not changed.

No live provider was called. An independent reviewer must re-run the fragmented-stream
reproduction and confirm cancellation before this repair is accepted. PRV-105 and the
provider phase remain SUBMITTED/PARTIAL, not accepted.
