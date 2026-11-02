# Provider management CLI review — 2026-11-01

Scope: new provider-commands module and providers CLI wiring over the previously
reviewed working tree. No source modifications, commits or live provider requests.

## Finding — P2: cached models output hides the last refresh failure

Location: `lib/provider-commands.mjs:128,199–201`.

modelsReport exposes discovery as outcome/error/at, without a stale property.
formatProviderModels checks discovery.stale rather than outcome === "error".
Consequently the normal `matrix providers models lab` text view drops the failure:
its cached models are printed without a stale/error warning. The --refresh invocation
has a separate failure line, and list uses another projection, so existing checks of
those paths do not catch the mismatch.

Independent reproduction in a temporary home: add a profile, seed successful discovery,
perform a mocked HTTP 503 refresh, then compose modelsReport({refresh:false}) with
formatProviderModels. The report has outcome error, but output contains none of
"stale", "503", "failed" or "unavailable". It only lists the old model and timestamp.

Required fix: use a consistent discovery summary across models/list/catalog, or render
failure from outcome. Add a real CLI regression: successful refresh → failed refresh →
new `providers models` invocation without --refresh. Assert the failure remains visible,
manual models remain available and no new request is made. Check both text and JSON.

## Progress and next assignment

Provider list/add/remove/models and explicit refresh commands now exist, with library
and actual CLI tests. Do not continue reporting all management commands as absent.
Show/update/replace workflows are still absent from the command action parser.

Next work remains PRV-104:

1. Fix the command projection mismatch above and close remaining management scope.
2. Implement interactive provider/model picker, arbitrary model entry and availability.
3. Persist provider/model/configuration identity and require explicit repair on mismatch.
4. Finish explicit built-in provider routing and provider-aware doctor/help integration.
5. Demonstrate real CLI approved edit, separately authorized test and exact undo.

Then proceed to PRV-105 probes/evaluation and complete PRV-106/107 acceptance. The
previous dependency-audit finding remains separate; no lockfile repair is present.

## Verification

- Targeted commands/catalog/argument-parser tests: 34 passed, 0 failed, 0 skipped.
- Commands plus actual CLI integration tests: 22 passed, 0 failed, 0 skipped.
  Both test runs used Node 24.21.0; their totals overlap and should not be added.
- `git diff --check`: passed.
- Earlier full-engineering results describe an older candidate, not this new CLI patch.
