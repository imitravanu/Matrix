# Provider picker and resume review — 2026-11-01

Decision: not accepted. Three independently reproduced defects remain in the
new interactive selection/session paths. Runtime files were not edited.

Base HEAD: `e1b3c66`. End-of-review runtime/test/config fingerprint:
`70b56865939826cbc176e0b2d579a6088304a74e908de0581c7f1465a8c0779c`
(38 changed/untracked files; sorted path + NUL + contents + NUL, excluding
docs/, AGENTS.md, NEXT_PHASE.md, MATRIX.md and README.md).

## P1 — Remote model named `local` runs Local Forge

`lib/controller.mjs:417` routes on the display model's ID before considering
the resolved provider target. A valid custom target `{providerId: "lab",
modelId: "local"}` therefore executes `runLocalAgent`.

Reproduction: validate an auth-none loopback profile, resolve exact model
`local`, project it with `pickerModelFromTarget`, and call the real controller
in a temporary empty workspace with headless approvals denied. The profile's
endpoint was unreachable (`http://127.0.0.1:1/v1`), yet the result reported
`ok: true`, `mode: "local"`, and `Local Forge completed the analysis`.

Required repair: route explicit targets by target kind/transport, preserving
legacy routing only when no target exists. Add a controller regression proving
a remote `local` wire ID reaches the selected endpoint and never Local Forge.

## P1 — Explicit built-in identity is lost on resume

`lib/provider-session.mjs:17` discards every built-in target. The session codec
then retains only the raw model ID; `src/matrix.mjs:127` restores it using the
legacy resolver. Explicit built-ins now support raw arbitrary IDs that this
resolver cannot reconstruct.

Reproduction: resolve and project `openrouter / vendor/unlisted` and
`ollama / llama3.2:8b`. Both produce a null saved provider identity, and
`resolveModel(savedModelId)` returns Local Forge. This silently changes the
execution provider when the saved session is reopened without a new preset.

Required repair: persist and restore exact built-in provider/model identity
without applying mutable-profile digest requirements. Add save/load/UI resume
coverage for arbitrary OpenRouter and raw Ollama IDs, with no fallback.

## P2 — Manual uncatalogued models cannot resume

`lib/provider-session.mjs:52–60` requires catalog membership even when the
profile and execution digest match. Exact manual entry intentionally works
without discovery or a configured model entry.

Reproduction: resolve `lab / vendor/unlisted` against a valid profile with
`models: []`, save its projected identity, and validate against the unchanged
configuration and empty catalog. Validation returns `ok: false` with
`model "vendor/unlisted" is no longer available for provider "lab"`.

Required repair: re-resolve the saved exact model against the matching profile
without requiring discovery membership, and construct its picker selection on
resume. Simply removing the catalog check is insufficient because the UI's
catalog lookup would still fall through to legacy resolution.

## Verification scope

Node targeted suite: `node --test test/provider-picker.test.mjs
test/provider-session.test.mjs test/provider-integration.test.mjs
test/app-interaction.test.mjs` — 38 passed, 0 failed, 0 skipped.
Log: `/tmp/matrix-current-provider-review.log`.

Independent reproductions used temporary filesystem state, auth-none fixtures,
and pure identity/selection functions. No real credentials or external service
were used. Full engineering gates were not rerun on this candidate; previous
full-suite evidence does not establish acceptance of these new changes.
