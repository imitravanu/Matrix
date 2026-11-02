# Provider implementation assignments

Read [NEXT_PHASE.md](../../NEXT_PHASE.md), [PROVIDERS.md](PROVIDERS.md),
[PROVIDER_AUDIT.md](PROVIDER_AUDIT.md) and [STATUS.md](STATUS.md) first.
All tasks are unimplemented at this planning baseline. New filenames below are proposed;
confirm the current tree and freeze interfaces before depending on them.

## Working rules for every implementer

1. Claim one task and reserve exact files, checkout and base revision on the board.
2. Inspect existing callers and local changes. Preserve other agents' work.
3. Add meaningful acceptance/characterization tests before changing behavior when practical.
4. Implement the smallest coherent layer; do not rewrite the transport or UI incidentally.
5. Observe actual outbound requests, filesystem effects and persisted bytes, not only labels.
6. Run focused checks and the required integration gates. Record failures and skips honestly.
7. Submit the evidence packet from AUDIT.md and mark SUBMITTED. Only the chief accepts.
8. Do not commit/push, use real keys in tests, run paid probes, or change dependencies implicitly.

A contract disagreement requires a proposed decision, tradeoff and executable example.
Continue independent tests/design while the chief resolves it. Do not bypass a blocked
interface by adding a second resolver, silently changing precedence or weakening tests.
The chief applies shared documentation/package changes from submitted snippets.

## PRV-101 — configuration, identity and interface contracts

**Initial status:** READY. **Dependencies:** none. **Role:** configuration/contracts implementer.

**Own:** proposed `lib/provider-config.mjs`, `lib/provider-contracts.mjs`,
`test/provider-config.test.mjs`, `test/provider-contracts.test.mjs`, and
`docs/next-phase/decisions/PRV-101.md`. Coordinate changes to shared contracts with chief.

**Read:** existing Matrix home/config conventions, `lib/models.mjs`, `lib/credentials.mjs`,
session codec, `lib/contracts.mjs` and current CLI parsing. Inventory every model identity
and key-availability caller. Do not move UI/controller code in this task.

**Build/how:** implement strict bounded schema loading and safe atomic mutations. Validate
reserved IDs, exact wire IDs, URL/API directory rules, auth references, default models,
request options and metadata. Implement the serializable resolved-target contract,
canonical digest and explicit selection/legacy precedence interfaces. Provide a proof
of the chosen concurrent configuration-writer strategy, including process death and
symlink/nonregular inputs; do not import the deferred durable-goal engine for this.

Freeze in the decision record: exported signatures and error codes; home path defaults;
profile replacement expected-digest semantics; endpoint/auth precedence table; exact
fields included in the digest; session-binding migration; test-only injection boundaries.
Specify provider and per-model options without allowing arbitrary request-body overrides.

**Observe:** a failed write leaves the old file valid; stale replace cannot overwrite a
new profile; no key value enters serializable descriptors; explicit unknown profiles do
not fall back; exact model ID case survives round trips. A bad custom file cannot prevent
Local Forge from starting, but its diagnostic remains visible.

**Evaluate:** table-driven parser/resolver tests, temporary private homes, controlled
concurrent writers and subprocess death, config boundary/size tests and credential canaries.
No provider network is needed.

**Accept:** P0 only when the chief approves the executable contracts, limits, migration
and writer proof. PRV-102/103 must consume these exports rather than invent equivalents.

## PRV-102 — provider-bound credentials and transport

**Initial status:** BLOCKED on accepted PRV-101. **Role:** transport implementer.

**Own:** `lib/credentials.mjs`, `lib/openrouter.mjs`, proposed
`lib/provider-transport.mjs`, and dedicated transport/credential tests. Existing shared
transport tests require an explicit reservation. Do not edit model-agent/controller yet.

**Read:** all existing streaming tests and timeout/retry/cancellation paths; the frozen
resolved target; current Ollama/OpenRouter request differences and environment precedence.

**Build/how:** bind target and privately resolved key once; support bearer/none; preserve
legacy exports through an adapter. Use the existing bounded parser and normalize events
through current contracts. Join URLs without dropping path prefixes. Reject redirects.
Gate optional usage/token fields and provider-specific options by adapter. Keep keys out
of errors/events/metrics and redact echoed server content. Unsupported protocol/options
produce an actionable failure with no silent alternate provider or downgraded tool loop.

**Observe:** loopback servers capture exact path, model, headers and payload; concurrent
same-model calls to two providers stay isolated; auth-none emits no Authorization;
environment changes during retries cannot retarget a run. A redirect destination sees
zero requests. Cancellation releases resources and produces one terminal outcome.

**Evaluate:** isolated fake keys, local HTTP fixture servers, split SSE/tool deltas,
malformed/oversized events, partial streams, retry boundaries, deadlines, missing usage,
auth errors and cancellation. Re-run existing OpenRouter/Ollama tests. No live network.

**Accept:** transport audit cases pass with request-level evidence and compatibility
characterization. Deliver the target-to-stream API before PRV-104 takes runtime wiring.

## PRV-103 — catalog, manual entries and bounded discovery

**Initial status:** BLOCKED on accepted PRV-101. **Role:** catalog implementer.

**Own:** `lib/models.mjs`, proposed `lib/provider-catalog.mjs`,
`lib/provider-discovery.mjs`, and dedicated catalog/discovery tests. Do not change transport,
CLI or UI files owned elsewhere. Use PRV-102's shared request binding where necessary;
initial discovery tests can inject its frozen interface without a duplicate credential resolver.

**Read:** model filters/index helpers, all consumers of MODELS/modelById/modelIndex,
provider schema and the picker requirements. Report every caller needing migration.

**Build/how:** first deliver a catalog snapshot combining built-ins and manual profiles,
exact tuple identity, arbitrary explicit model resolution and per-profile availability.
Then add explicit `/models` refresh, bounded parsing, authenticated endpoint binding,
cache invalidation and stale/error reporting. Preserve manual metadata on refresh failure.
Do not infer tool support, pricing or context from an ID or an unrecognized listing field.

**Observe:** two identical wire IDs remain separate by provider; punctuation and case
survive; a model absent from discovery still resolves; stale cache never changes endpoint;
malformed catalog data cannot corrupt profiles, inject terminal controls or trigger fetches.

**Evaluate:** no-network load/render assertions; 404/auth/timeout/malformed/oversize list
responses; duplicate entries; config edit/removal; atomic cache updates; bounds on total
cache state; current built-in filtering/aliases. Assert exact outbound discovery auth.

**Accept:** manual catalog interface is usable by PRV-104 before discovery is complete.
Full task acceptance requires discovery cases, including cancellation and stale labels.

## PRV-104 — CLI, controller, UI and session integration

**Initial status:** BLOCKED on accepted PRV-101/102 and PRV-103 manual interface.
**Role:** application integration implementer. **Own:** `bin/matrix.mjs`,
`lib/controller.mjs`, `lib/model-agent.mjs`, `lib/session.mjs`, `src/matrix.mjs`,
`src/screens/model.mjs`, `lib/cli.mjs`, `lib/input.mjs`, `lib/doctor.mjs`,
`src/credentials.mjs` and dedicated
integration/session/UI tests. Verify actual filenames and reserve each before edits.
No other agent edits these files during this handoff.

**Read:** complete ordinary remote loop, CLI headless defaults, session codec,
model switching, approvals, outcome handling, doctor and frame-width tests.

**Build/how:** implement the proposed provider commands and `--provider` selection.
Carry the resolved target through every layer without reducing it to a bare model ID.
Picker uses the shared catalog, per-provider availability and manual model entry;
reload is explicit. Pin active targets and resolve next-run selections independently.
Save provider/model/configuration binding, migrate recognized legacy sessions and require
explicit repair for missing/changed profiles. Headless invalid bindings fail before fetch.
Use existing outcome classification and approval flows. Supply README/help/architecture
changes to the chief; no new authority or remote parallel execution.

**Observe:** custom model not in source completes read → proposed edit → approval →
actual write → separately authorized test → final outcome → exact undo using a real
local server and temporary workspace. Denied edits and tests cause no side effects.
Profile changes during a stream do not retarget its next tool round. Saved sessions
contain identity but no secrets; corrupted/rebound sessions make zero remote calls.

**Evaluate:** real CLI subprocess fixture and UI event tests, default headless denials,
legacy sessions, provider replacement/removal, identical wire IDs, invalid profile startup,
manual entry, narrow terminal sizes and screen-reader/reduced-motion paths. Existing
protected-file and undo tests remain mandatory. Inspect persisted bytes and request logs.

**Accept:** P1 requires an executable end-to-end demonstration with actual file/test
side effects, exact selected model and unchanged authority boundaries. A picker screenshot
or successful text completion is insufficient. Hand off shared files before PRV-105 integration.

## PRV-105 — compatibility probes and evaluation selection

**Initial status:** BLOCKED on accepted PRV-102/103/104 interfaces.
**Role:** compatibility/evaluation implementer.

**Own:** proposed `lib/provider-probe.mjs`, `test/provider-probe.test.mjs`,
dedicated evaluation fixtures/runner modules and tests. Reserve exact eval paths first;
chief owns shared eval manifests/scripts. CLI changes go through PRV-104 handoff or chief.

**Read:** provider limits, existing eval evidence classes, stream/tool schema contracts
and outcome semantics. Do not label protocol tests as coding capability measurements.

**Build/how:** implement explicitly invoked text/tool round-trip probes with synthetic
no-op tools, shared request binding and the total invocation cap. Persist bounded,
redacted observations keyed to exact configuration/model identity. Expose pass/fail/not
evaluated separately for each check. Let an opt-in evaluation path select the same provider
and arbitrary model as normal execution; record reproducible settings and task revisions.
Default evaluation remains credential-free and offline. Do not run paid experiments now.

**Observe:** tool response ID links correctly across both calls; ignored/malformed tools
fail; no real tool executes; retries cannot exceed the cap; interruption ends the probe;
changing profile invalidates badges. A user-declared capability never becomes observed
success merely because it was declared. Unknown usage/cost remains unknown.

**Evaluate:** deterministic servers supporting/rejecting usage options, tools, fragmented
arguments and follow-up messages; per-invocation request/token/time ceilings; stale records;
secrets in echoed errors; probe history limits; offline eval unchanged. A fake-provider
coding run demonstrates evaluator selection without claiming live model quality.

**Accept:** P2 probe/eval cases pass and the report explicitly separates offline evidence
from any separately authorized live checks. Real service availability may be NOT EVALUATED;
mandatory deterministic acceptance cases may not.

## PRV-106 — independent adversarial provider audit

**Initial status:** BLOCKED on P0 for fixture preparation; integrated candidate for verdict.
**Role:** reviewer distinct from implementer of the reviewed change.

**Own:** proposed `test/provider-adversarial.test.mjs`, independent fixture files and
`docs/next-phase/reports/PRV-106.md`. Coordinate shared helper changes through the chief.
Do not fix production behavior inside this assignment; file reproducible findings for owners.

**Build/how:** execute every PV case in PROVIDER_AUDIT.md. Independently inspect the
resolved-target call chain and secret persistence boundaries. Use two recording servers
and canary credentials; attempt redirect, profile mutation, same-model collision, forged
session binding, discovery poisoning, oversized streams and cancellation races. Reproduce
at least one denied edit/test and one approved edit/test/undo through the real CLI.

**Observe:** request counts and destinations, exact auth, file hashes/modes, process exit,
stream cleanup, private session/cache/probe files and terminal event ordering. Search all
captured artifacts for canaries, rather than trusting a redaction helper's unit test.

**Evaluate:** independent matrix report names case, command, expected/actual observation,
candidate revision/digest, PASS/FAIL/NOT EVALUATED and remaining defect. No live keys.

**Accept:** no unmet mandatory case or unresolved critical/high finding. Reviewer records
findings; chief records final acceptance. Audit independence must be stated honestly.

## PRV-107 — chief integration and release decision

**Initial status:** BLOCKED on submitted PRV-101 through PRV-106 evidence.
**Role:** chief/integrator, with independent review of any integration changes it authors.

**Own:** shared docs/config, coordinated final wiring, status and audit reports.
Integrate reviewed patches in dependency order and resolve conflicts by rechecking the
contracts. Do not equate individually passing branches with an accepted integrated result.

**Do/observe/evaluate:** run P3 on the exact integrated tree; inspect packaged CLI dependencies,
help/README examples, private-path behavior and Local Forge offline startup. Re-run affected
adversarial cases after integration changes. Record Node versions, commands, counts, skips,
candidate identity and hosted CI separately. Confirm no real credential or temporary artifact
is included. A live check, if separately requested later, must not replace deterministic gates.

**Accept:** all mandatory cases and compatibility regressions pass; no unresolved P0/P1
finding or missing requirement. Record ACCEPTED with evidence, then release the deferred
durable phase. Commit only when requested by the owner.

## Copyable agent handoff

> Implement PRV-NNN in /home/mitravanu/matrix. Read AGENTS.md, NEXT_PHASE.md,
> PROVIDERS.md, your assignment, PROVIDER_AUDIT.md and STATUS.md. Claim/reserve your
> exact files and record the base revision before editing. Respect dependency gates.
> Preserve unrelated work and existing approval/undo/security behavior. Use isolated
> homes, fake keys and local servers. Submit code, exact tests and observed results,
> candidate identity, limitations and a requirement-to-evidence mapping. Mark SUBMITTED;
> do not mark ACCEPTED, commit/push or run live paid probes. Raise concrete interface
> decisions to the chief; continue independent work while the decision is reviewed.
