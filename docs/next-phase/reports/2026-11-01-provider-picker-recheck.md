# Provider picker repair review — 2026-11-01

The three findings in `2026-11-01-provider-picker-review.md` are repaired for
their reproduced cases. This is not phase acceptance: the interactive capability
refusal below remains open.

Candidate: base `e1b3c66`; runtime/test/config fingerprint
`724cf4b5c71cdb5ffa4d126a1b586c8786db106e0ce1e9dd52aa372d79dc3ccc`
(39 files; the previous report's fingerprint procedure).

## Repaired cases

- Remote `local` wire ID: the controller gives explicit remote targets routing
  precedence. The loopback controller regression receives one request with model
  `local` and returns the remote fixture response.
- Explicit built-in resume: OpenRouter `vendor/unlisted` and Ollama
  `llama3.2:8b` now retain provider/model identity. Independently projecting and
  validating those saved identities reconstructs the exact IDs. Save/load and
  UI restoration regressions pass.
- Uncatalogued manual resume: an exact `Vendor/unlisted:Tag` identity validates
  against its unchanged profile and an empty catalog. The UI reconstructs the
  saved target directly rather than relying on catalog membership. The new UI
  regression passes.

## Open P2 — Interactive runs ignore declared unsupported tools

Location: `src/matrix.mjs:570–577`, the preflight portion of `startTask`.
The UI checks only that a custom target exists before starting the controller.
Neither the controller nor model agent blocks a target whose tools capability is
`unsupported`. The headless entry point already refuses this target at
`bin/matrix.mjs:674`.

Independent reproduction used the real Ink app, a temporary copied demo and
isolated HOME/MATRIX_HOME, no real credentials, and a trapped fetch:

1. Validate an auth-none `lab` profile with model `text-only` declaring
   `capabilities: { tools: "unsupported" }`.
2. Resolve the target and pass `pickerModelFromTarget(target, {available: true})`
   as the initial interactive selection.
3. Submit `Inspect the repository` through the real prompt.
4. Observe one provider request containing all six tools; the fixture response
   appears in the UI. Observed output:
   `{"declared":"unsupported","requests":1,"toolsSent":6,"responseDisplayed":true}`.

This violates the capability rule in `docs/next-phase/PROVIDERS.md:170` and
produces different execution policy for the same target in TTY and headless mode.
Refuse before network/tool execution with an actionable message, preferably at
a shared coding-run boundary, and surface that refusal in the UI. Add an app
regression asserting zero requests and no edit/test activity. Preserve permitted
runs for explicitly selected models whose tool support is unknown.

## Verification

- Node 24.21.0 targeted picker/session/integration/app/controller suite: 63 passed,
  0 failed, 0 skipped. Log: `/tmp/matrix-provider-recheck-current.log`.
- Smoke: 32 frame checks across four geometries passed.
  Log: `/tmp/matrix-provider-recheck-smoke.log`.
- `npm run check`: exit 0 on Node 24.21.0. Syntax (172 modules), lint,
  typecheck, formatting, and coverage gates passed; 688 tests passed, 0 failed,
  0 skipped. Coverage: 94.19% lines / 84.17% branches / 94.43% functions.
  Log: `/tmp/matrix-provider-review-check.log`.
- Node 22, clean-install, evaluation, and release gates were not rerun in this
  focused review; previous results are not acceptance evidence for this candidate.

Runtime and tests were not edited during this review. No commit was made.
