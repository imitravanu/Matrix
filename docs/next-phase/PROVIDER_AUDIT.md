# Provider acceptance and chief audit

This is a required test plan, not recorded PASS evidence. Use the submission packet,
evidence classes and independent-review procedure in [AUDIT.md](AUDIT.md). Its durable
crash matrix applies later; the PV matrix here applies to the active provider phase.

## Acceptance gates

- **P0:** executable configuration/identity/precedence contracts and writer proof accepted.
- **P1:** arbitrary manual model works through actual CLI/controller/agent/transport,
  approved edit, separately authorized test, final outcome and exact undo.
- **P2:** catalog, UI/session integration, bounded discovery and probes pass the matrix,
  with independent adversarial evidence.
- **P3:** exact integrated candidate passes Linux Node 22/24 engineering/regression gates,
  documentation and packaging review; chief records verdict and any live evidence separately.

Independent local HTTP servers and fake keys exercise real HTTP/subprocess paths without
contacting a provider. Dependency-injected fetch mocks remain useful unit tests, but do
not replace P1 or request-isolation evidence. Never put a real API key in a fixture/report.

## Mandatory matrix

| ID    | Scenario                                               | Required observation                                                                                                                                               |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PV-01 | Strict configuration and resource bounds               | Invalid version/fields/IDs/URLs/enums/metadata and oversized input fail before use; old configuration survives failed mutation                                     |
| PV-02 | Configuration write races, process death, symlink/FIFO | No lost updates, unsafe target writes, hangs or partial committed JSON; stale expected digest rejected                                                             |
| PV-03 | Arbitrary exact model ID                               | Mixed case, slash and colon reach server unchanged without source/catalog edits; explicit unknown provider fails                                                   |
| PV-04 | Same model on two profiles                             | Correct endpoint/auth for both, including concurrent runs; no cache/selection/session identity collision                                                           |
| PV-05 | Auth isolation and precedence                          | Missing selected key makes zero requests; auth-none has no Authorization; unrelated environment/legacy credentials cannot supply the key                           |
| PV-06 | URL path, scheme and redirect handling                 | Nested API paths preserved; unsafe URL forms rejected; 3xx rejected and destination server receives zero requests                                                  |
| PV-07 | Adapter payload differences                            | Token field exactly one; usage option conditional; custom profile receives no OpenRouter-specific options/headers; legacy adapters remain compatible               |
| PV-08 | Fragmented stream and tool loop                        | Content/tool argument chunks reconstruct correctly; follow-up tool IDs match; terminal events occur once and in existing order                                     |
| PV-09 | Auth errors, partial streams, retries                  | Honest bounded errors; no replay after emitted work or duplicate tool execution; configured run target unchanged across retries                                    |
| PV-10 | Cancel, timeout and size limits                        | Requests/streams close, no runaway retries or late tool effects; oversized event/body fails within declared bound                                                  |
| PV-11 | Discovery absent or broken                             | Manual model stays usable; prior cache retained and labeled stale; malformed/401/404/timeout response cannot overwrite configuration                               |
| PV-12 | Hostile/large discovery                                | Model/count/byte/time limits hold; control text escaped; returned URLs/auth/instructions ignored; no implicit pagination or new origins                            |
| PV-13 | Offline startup/picker/doctor                          | Zero provider requests; Local Forge usable with malformed custom file and visible error; per-profile credential states accurate                                    |
| PV-14 | UI manual entry and selection                          | Arbitrary model entry works; same IDs distinguishable; tuple selection survives sorting/refresh; narrow widths and accessibility remain usable                     |
| PV-15 | Profile mutation during active run                     | Existing stream, retries and later tool rounds retain original endpoint/auth/options; next run reflects explicit new selection                                     |
| PV-16 | Session restore/migration                              | Known legacy sessions work; missing/changed profile blocks remote execution until explicit reselection; forged stored endpoint/key never used                      |
| PV-17 | Actual coding task and exact undo                      | Local fixture provider drives read/propose/approve/write/authorized test; diff and test observed; undo restores original bytes/mode                                |
| PV-18 | Denied authority and protected files                   | Headless default denial, edit-only --yes, separate test consent and protected reads/writes remain enforced for custom models                                       |
| PV-19 | Capability honesty                                     | Declared/observed/unknown stay distinct; unsupported tools fail coding selection; unknown cost/usage is not rendered as zero/free                                  |
| PV-20 | Probe tool round trip and caps                         | Synthetic no-op only; ignored/malformed tool call fails; at most 3 requests including retries, 256 requested completion tokens each, 30 seconds total              |
| PV-21 | Probe/cache invalidation and storage bounds            | Profile change invalidates evidence; per-profile/model records bounded; no stale success for a different endpoint or model                                         |
| PV-22 | Credential canaries                                    | Exact, JSON-escaped and URL-encoded canary forms absent from configuration/cache/session/export/log/error/report artifacts; echoed server content redacted         |
| PV-23 | Evaluation identity and evidence                       | Offline suite stays offline; opt-in runner uses exact profile/model and records settings/task revision; mock success is never presented as live quality            |
| PV-24 | Compatibility and package contents                     | Local Forge, OpenRouter/Ollama aliases, legacy overrides, session paths and existing eval/smoke/undo/security checks pass; new runtime imports included in package |

PRV-101 freezes finite handling for unusual but valid names and URL normalization.
Tests should assert observable behavior, not copy an implementation expression. A reviewer
must add independent hostile inputs and inspect outbound requests/persisted bytes.

## Required acceptance demonstration

Use a temporary repository with a small failing regression and a temporary MATRIX_HOME.
Run an actual local fixture server that requires a fake bearer key and records the exact
model string. Add a profile through the implemented CLI and select a model that does not
appear in `lib/models.mjs`. Demonstrate default-denied writes/tests first. Then use explicit
edit and separate test authority to fix the regression through the ordinary Matrix loop,
inspect the diff/result and restore exact bytes through undo. Observe the real test process;
a fabricated provider response saying tests passed is insufficient.

Restart with the saved provider/model binding and demonstrate explicit repair after profile
change/removal. Repeat selection with another profile using the same model ID and a different
key/server; verify no request crosses providers. Keep provider calls local and archive only
redacted evidence, fixture commands, observed file hashes and outcome data.

UI coverage separately verifies manual entry, per-profile credential availability, selection
retention, active-run pinning and model badges at 40×20, 60×22, 80×26, 100×30 and 140×40.
A passing headless demonstration does not establish interactive behavior.

## Exact-candidate engineering checks

Use Node 22.13+ in the Node 22 line and the project's Node 24 development version. Resolve
installed binaries explicitly; record `node --version` and ensure npm uses the intended
Node via PATH. Do not accidentally run both checks with the same binary.

```sh
npm run check
npm run eval
npm run smoke
npm run pack:check
git diff --check
```

Run the engineering checks on both Node versions for P3 and record per-runtime results.
Run changed-screen geometry cases beyond the standard smoke set where necessary. New
provider tests belong in the default offline suite and must run under existing coverage
rules; no lowered floors, silent skips or refreshed baselines to conceal failures. New
production modules need meaningful boundary coverage, including any coverage-manifest
updates reviewed by the chief. Use `npm run bench` if picker/catalog performance changes.

Re-run affected tests after a patch changes the audited candidate. The submission names
commit plus working-diff digest (including untracked submitted files), or an equivalent
immutable patch identity; bare HEAD does not identify an uncommitted implementation.
Hosted CI is separate evidence; do not describe local runs as CI success.

## Live checks and evaluation limits

Normal user-requested remote tasks and explicit probe commands authorize their stated
network work. This planning document itself does not authorize paid calls. Offline gates
must not need live credentials. If the owner later requests live validation, report the
chosen profile/model/configuration digest, date, provider protocol, checks, usage and
limits without secrets. Failed or unavailable services are reported honestly.

A live text/tool probe establishes only observed compatibility at that time. Claims that
one model is better require the deferred capability protocol: pinned tasks/environments,
matched budgets, held-out cases, repeated trials where feasible and actual diff/test review.
Do not invent context size, cost, success rates or superiority from model names/listing data.

## Verdict and dispatch policy

Each case has candidate identity, command/fixture, expected observation, actual observation,
and PASS/FAIL/NOT EVALUATED. Missing mandatory deterministic evidence blocks acceptance.
Missing optional live evidence is explicitly NOT EVALUATED and does not turn offline proof
into a claim of live compatibility. No P0/P1 finding or unmet required behavior is waived.

Implementers submit; the independent reviewer reports; the chief records ACCEPTED or
CHANGES REQUIRED with findings and affected tasks. Only PRV-107 acceptance releases the
deferred durable phase. The provider phase is not complete merely because the new command
appears in help or one endpoint returns text.
