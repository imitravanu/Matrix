# Planning self-review

Updated 2026-10-29 against source at `e1b3c66` and the planning diff. This is the chief's
self-review of a plan, not an independent audit of implemented provider support.

## Source findings used

- `lib/models.mjs` uses a static catalog plus arbitrary Ollama tags; generic arbitrary
  provider/model selection is absent.
- `lib/credentials.mjs` and `lib/openrouter.mjs` bind global overrides and model-derived
  credentials; they do not provide named immutable provider profiles.
- Runtime callers reduce selection to model IDs; CLI, UI, doctor and saved sessions need
  coordinated changes, not just another endpoint environment variable.
- Existing stream/tool/approval/outcome/undo behavior supplies the compatibility baseline.
  It must remain intact across new model selection paths.

## Plan decisions checked

- Provider work precedes durable execution in NEXT_PHASE, AGENTS and the dispatch board.
  The durable brief remains available with explicit deferral banners.
- Manual arbitrary model selection is a required early milestone; discovery is optional
  for each provider and cannot block manual operation.
- Provider/model tuple identity, auth/endpoint isolation, immutable run binding and session
  mismatch handling are explicit. A changed profile cannot silently redirect an active run.
- Schema limits, path validation, bounded cache/probe storage, credential redaction and
  concurrent configuration updates have concrete tests and ownership.
- Transport compatibility is scoped to Chat Completions streaming; native protocols and
  additional auth schemes are not implied. Unknown pricing/capabilities remain unknown.
- Independent local-server tests cover actual CLI side effects and authority. Unit mocks,
  live compatibility and coding-quality evaluation are separate evidence classes.
- Each assignment states what to build, how, what to observe, evaluation and acceptance.
  Shared-file ownership and dependency handoffs prevent concurrent incompatible rewrites.
- No runtime implementation, dispatched agent, live spending or accepted capability is
  claimed. Historical test counts are explicitly historical.

## Proof still required

PRV-101 must turn the schema, digest, precedence, configuration writer and migration
contracts into executable evidence. PRV-102/104 must prove the complete target binding
through real requests and tools. PRV-106 audits adversarial cases independently. PRV-107
checks the exact integrated tree before releasing durable execution.

Prepared for **PRV-101 dispatch**. All runtime acceptance remains pending.

## Documentation validation for this delivery

- `npm run format:check`: passed across the repository after formatting the planning files.
- `node --test test/docs.test.mjs`: 3 passed, 0 failed, 0 skipped. These existing tests
  check documentation consistency; they do not prove provider implementation.
- Local Markdown link check: 28 links across 11 planning/guide documents resolved.
- `npm run pack:check`: passed, 81 packaged files; no tarball or publication.
- `git diff --check`: passed. Runtime code was unchanged; full runtime/provider gates
  and live-model tests were not run for this documentation-only delivery.
