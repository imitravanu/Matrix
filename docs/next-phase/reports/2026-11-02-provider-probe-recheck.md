# Provider probe repair recheck — 2026-11-02

The three findings in the 2026-11-01 probe review pass focused rechecking.
No new finding was identified within this repair scope. This does not establish
acceptance of PRV-105 or completion of the provider phase.

Candidate fingerprint:
`44f11d600334fb0f0852b58644de56c2c1fee90f1c92144df69502e1105e16c7`
(41 runtime/test/config files, using the previous report's fingerprint method).

Independent reproductions used temporary profiles and fake credentials, with
synthetic SSE responses through the production stream parser:

- Raw, URL-encoded and JSON-escaped credentials in an unexpected tool name are
  absent from returned and persisted observations; the check still fails.
- Repeated tool calls, bare completion and length-truncated follow-ups fail
  after two requests instead of receiving a compatibility pass.
- Partial usage preserves only reported fields and sets usageComplete false.
  A successful three-request text/tool exchange with usage on only the first
  request also remains explicitly incomplete.

`git diff --check` passed. Probe, provider-command, CLI-parser and CLI-integration
suites passed: 60 tests, zero failures/skips. Log:
`/tmp/matrix-probe-recheck-1102.log`.
Full engineering checks were not rerun for this focused review.
Runtime files were not edited; no commit was made.
