# PRV-107 provider acceptance review

Review date: 2026-11-04. Scope: the mandatory PV-01 through PV-24 provider matrix in
[PROVIDER_AUDIT.md](../PROVIDER_AUDIT.md), the four P3 advisories carried from the
[PRV-106 audit](2026-11-02-prv106-audit.md), the independent
[PRV-106 review](2026-11-04-prv106-independent-review.md), and the independent
[Yama tracing verification](2026-11-04-prv106-yama-tracing-verification.md).

This is a consolidated acceptance review, not a new fresh-context audit. It reuses the
two independent reviews above for the scoring-isolation and tracing cells, and it
executes the remaining provider-matrix checks against the same working tree. Runtime
code, host settings, and Git history were not modified. The only repository file added
by this review is this report.

## 1. Candidate identity

| Item                                  | Value                                                                                                                                                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository                            | `/home/mitravanu/matrix`                                                                                                                                                                                                                                                   |
| Branch                                | `matrix/engineering-hardening`                                                                                                                                                                                                                                             |
| HEAD                                  | `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`                                                                                                                                                                                                                                 |
| Commit subject                        | `Enforce Bubblewrap test runner isolation and proposal-bound edit verification (PRV-105/PRV-106)`                                                                                                                                                                          |
| Dirty tracked files                   | `README.md`, `docs/next-phase/STATUS.md`, `eval/README.md`, `eval/provider-eval.mjs`, `test/provider-eval.test.mjs`                                                                                                                                                        |
| Untracked files present before review | `docs/next-phase/decisions/DUR-001.md`, `docs/next-phase/reports/2026-11-02-prv106-audit.md`, `docs/next-phase/reports/2026-11-04-prv106-independent-review.md`, `docs/next-phase/reports/2026-11-04-prv106-yama-tracing-verification.md`, `test/goal-lock-spike.test.mjs` |
| Runtime fingerprint                   | `2743c680fd6ad6549d9dfb2ae550585de756a0106cf6aebd1df01b24d9a2869c` over 98 tracked runtime files under `eval/`, `lib/`, `src/`, plus `package.json`                                                                                                                        |
| Working-tree fingerprint              | `7617cd71ba4a3e7423ced18254e370129623443cc7862cbe953f3d47183f7dfe` over 258 files, before this report was added                                                                                                                                                            |

The runtime fingerprint is computed as `sha256(concat(sorted(path, NUL, raw 32-byte
sha256(file bytes))))` and matches the value in the independent Yama review and
`STATUS.md`. The 258-file working-tree fingerprint uses the same construction over all
files excluding `.git`, `node_modules`, and `eval/reports`. The `STATUS.md` file changed
after the independent Yama report was saved; that is a documentation-only edit on a
dirty path and does not change the 98-file runtime fingerprint. The runtime fingerprint,
not the documentation digest, binds the provider evidence below.

Environment:

- Node `v24.21.0` at `/usr/bin/node`.
- Node `v22.23.1` at `/tmp/opencode/review-kit/dist/node-v22.23.1-linux-x64/bin/node`,
  with a `/tmp/opencode/prv107-kit/node22-bin/node` symlink so npm still resolves under
  `/usr`.
- Linux `7.0.12+kali-amd64`, Bubblewrap `0.13.1`.
- Host `kernel.yama.ptrace_scope=0`, unchanged before and after review.
- Loopback HTTP fixtures and fake bearer credentials only. No live provider or paid call
  was used.

## 2. Verdict

**Recommended: ACCEPT PRV-107 for the provider acceptance matrix.** All 24 mandatory
cases have deterministic PASS evidence on the candidate runtime above. No P0, P1, or P2
finding remains within the documented threat model. The four P3 advisories are
dispositioned in section 5; three of them limit what the evaluator report may be used
to claim, but none reopens the provider runtime matrix.

The acceptance is subject to these recorded conditions:

1. F-1 and F-3 must be fixed before an evaluator report is used as a behavior
   certificate. Until then, `checks.target` is decorative and `checks.edit` conflates
   byte binding with scoring.
2. F-2 must be fixed, or the evaluator's `taskSuccess` must be explicitly limited to
   fixture conformance, before any quality or behavioral-generalization claim.
3. F-4 is a non-blocking hardening deferral.
4. Provider evaluation requires Linux Yama `kernel.yama.ptrace_scope=2` or `3` and an
   untraced evaluator. On this host at scope 0 the CLI correctly refuses before any
   provider request or report write, so no live evaluator run is claimed here.
5. Live provider compatibility and quality remain **NOT EVALUATED**; the matrix uses
   loopback fixtures and mocked transports.

## 3. Mandatory matrix

All cases are against the candidate runtime fingerprint above. "PASS" means the required
observation was made; it does not convert mocked or loopback evidence into live-provider
evidence.

### PV-01 — Strict configuration and resource bounds — PASS

- `test/provider-contracts.test.mjs:150` rejects unknown fields, versions, duplicate IDs,
  invalid enums, and invalid metadata; `:244` proves limits are enforced before a write.
- `test/provider-config.test.mjs:218` refuses an oversized or symlinked configuration
  target unread; `:248` proves a mutation over the persisted byte limit leaves the prior
  bytes byte-for-byte intact.
- Observed: invalid input fails before use and old configuration survives failed
  mutation.

### PV-02 — Configuration write races, process death, symlink/FIFO — PASS

- `test/provider-config.test.mjs:294` live kernel-lock contention; `:339` immediate
  release after owner death; `:367` concurrent writers serializing without lost updates;
  `:468` paused owner exclusion; `:509` real and symlinked homes sharing one lock.
- New FIFO fixture `pv02-config-fifo.mjs`: loading a FIFO configuration returned
  `CONFIG_NOT_REGULAR` without hanging, `addProviderProfile` refused with the same code,
  the FIFO remained a FIFO, and a sentinel file stayed unchanged. Log:
  `/tmp/opencode/prv107-kit/logs/pv02-config-fifo.log`.
- Observed: no lost updates, unsafe target writes, hangs, or partial committed JSON;
  stale expected digests are rejected by the replacement tests.

### PV-03 — Arbitrary exact model ID — PASS

- `test/provider-contracts.test.mjs:82` preserves mixed case, slashes, and colons;
  `:326` accepts an explicit provider absent from the catalog.
- `test/provider-integration.test.mjs:115` completes a real headless agent run over a
  loopback server; `test/cli-integration.test.mjs:757` reaches the exact endpoint with
  the exact model.
- `docs/next-phase/fixtures/provider-p1-loopback.mjs` recorded six requests with the exact
  model and endpoint on Node 24 and Node 22. Logs:
  `/tmp/opencode/prv107-kit/logs/provider-p1-loopback-node24.log` and
  `...-node22.log`.
- Observed: no source or catalog edit is needed; an explicit unknown provider fails
  through the contract tests.

### PV-04 — Same model on two profiles — PASS

- `test/provider-transport.test.mjs:100` runs two profiles with the same wire model
  concurrently and verifies distinct endpoints and keys.
- New concurrent fixture `pv04-concurrent-same-model.mjs` used
  `Vendor/Shared-Model:Free` on `lab-a` and `lab-b`; each endpoint received its own key
  and exact model, target and session-identity digests were distinct, and each run
  emitted one terminal `done`. Log:
  `/tmp/opencode/prv107-kit/logs/pv04-concurrent-same-model.log`.
- Status records the owner's removal/replacement run: after the saved profile was
  removed, resume exited 1, made zero requests to either endpoint, and preserved the
  binding; explicit reselection repaired it.
- Observed: no endpoint, auth, cache, selection, or session identity collision.

### PV-05 — Auth isolation and precedence — PASS

- `test/provider-transport.test.mjs:225` auth-none sends no `Authorization` header;
  `:263` a missing key fails before any network activity; `:332` a built-in binding
  ignores ambient `MATRIX_API_BASE` and `MATRIX_API_KEY`.
- `test/provider-contracts.test.mjs:347` exercises explicit precedence without silent
  fallback; `test/provider-integration.test.mjs:177` keeps one credential binding across
  tool rounds; `test/openrouter.test.mjs:449` proves a missing legacy key never reaches
  fetch.
- Observed: missing selected key produces zero requests; unrelated environment or legacy
  credentials cannot supply it.

### PV-06 — URL path, scheme and redirect handling — PASS

- `test/provider-contracts.test.mjs:92` preserves nested path prefixes and rejects
  credentials, queries, and full endpoint URLs.
- `test/provider-transport.test.mjs:240` rejects a 302 and proves the redirect
  destination received zero requests; `test/provider-catalog.test.mjs:210` refuses
  discovery redirects and missing keys; `test/provider-probe.test.mjs:711` surfaces a
  redirect without following it.
- Observed: unsafe URL forms and redirects fail before a second origin is contacted.

### PV-07 — Adapter payload differences — PASS

- `test/provider-transport.test.mjs:152` verifies a closed payload with exactly one token
  limit field, no `max_tokens`, no `stream_options`, and no OpenRouter-specific
  `http-referer`, `x-title`, or `x-openrouter` headers on a custom profile.
- `:202` adds exactly the optional usage request; `:332` freezes built-in endpoint and
  credential policy. `test/openrouter.test.mjs:532` keeps Ollama local routing and zero
  external credentials; `:479` keeps provider endpoints and credentials bound to the
  selected provider.
- Observed: custom profiles receive no OpenRouter-specific options or headers, and
  legacy adapters remain compatible.

### PV-08 — Fragmented stream and tool loop — PASS

- `test/openrouter.test.mjs:567` covers CRLF, optional spaces, multiline data, UTF-8, and
  arbitrary byte splits; `:281` gives unindexed parallel deltas stable assembly keys;
  `:324` proves exactly one `done` for a normal content stream.
- `test/provider-integration.test.mjs:115` drives a real tool round over loopback;
  `test/provider-probe.test.mjs:110` fragments tool name and arguments and verifies the
  follow-up `tool_call_id` matches the original call.
- Observed: content/tool arguments reconstruct correctly, follow-up IDs match, and
  terminal events occur once in the existing order.

### PV-09 — Auth errors, partial streams, retries — PASS

- `test/provider-transport.test.mjs:263` missing-key refusal; `test/openrouter.test.mjs:367`
  surfaces HTTP and provider errors honestly; `:651` a truncated stream cannot finish
  cleanly.
- `test/openrouter.test.mjs:846` retries safe failures with backoff and `Retry-After`;
  `:893` bounds retries and never retries permanent statuses; `:940` never retries after
  consumed stream bytes; `:971` caller abort interrupts backoff and clears timers.
- The prepared target is immutable for the run (`test/provider-transport.test.mjs:152`),
  and the integration credential is bound once per run (`:177`), so retries do not
  re-resolve endpoint, auth, or request options.
- Observed: bounded honest errors, no replay after emitted work, and no duplicate tool
  execution.

### PV-10 — Cancel, timeout and size limits — PASS

- `test/provider-transport.test.mjs:301` cancellation closes one terminal error and
  releases the connection; `test/openrouter.test.mjs:727` early generator return cancels
  the reader; `:768` settles connection, idle-stream, and total deadlines.
- `test/openrouter.test.mjs:679` enforces hard byte budgets for error bodies and pending
  SSE events; `test/provider-probe.test.mjs:761` rejects an oversized SSE event at the
  shared parser bound; `:837` stops fragmented over-limit arguments before `DONE`.
- `test/process.test.mjs:116` aborts the whole child process and `:129` enforces a
  timeout.
- Observed: requests/streams close, no runaway retries or late tool effects, and
  oversized data fails within the declared bound.

### PV-11 — Discovery absent or broken — PASS

- `test/provider-catalog.test.mjs:116` keeps Local Forge visible with an invalid custom
  file; `:177` keeps the last snapshot as stale after a failed refresh and invents no
  models; `:210` refuses redirects, missing keys, and unknown providers; `:419` keeps a
  failure visible until success.
- `test/provider-commands.test.mjs:953` projects a real refresh and retains a failure
  visibly.
- Observed: manual models stay usable; prior cache is retained and labeled stale; a
  malformed, 401, 404, or timed-out response cannot overwrite configuration.

### PV-12 — Hostile/large discovery — PASS

- New fixture `pv12-hostile-discovery.mjs` observed:
  - 1,000 returned models, `truncated: true`, one request to `/v1/models`, no implicit
    pagination, and the returned URL/instructions ignored;
  - oversized body rejected while the prior `vendor/prior` cache remained, marked stale;
  - control text absent from cached models;
  - timeout bound observed at 152 ms with the prior cache retained.
- Log: `/tmp/opencode/prv107-kit/logs/pv12-hostile-discovery.log`.

### PV-13 — Offline startup/picker/doctor — PASS

- New fixture `pv13-offline-inventory.mjs` observed zero server requests, Local Forge
  visible in both catalog and picker, malformed configuration reported as `invalid` with
  a visible diagnostic, CLI exit 1 with `status: invalid`, and per-profile credential
  availability `true` / `false` / `true` for set, missing, and anonymous profiles.
- `test/provider-catalog.test.mjs:116`, `test/provider-picker.test.mjs:118`, and the
  doctor test in the provider suite cover the same behavior in the default suite.
- Logs: `/tmp/opencode/prv107-kit/logs/pv13-offline-inventory.log`,
  `pv13-bad-out.txt`, `pv13-bad-err.txt`.

### PV-14 — UI manual entry and selection — PASS

- `test/provider-picker.test.mjs:78` gives every entry a stable unique key even when two
  providers expose the same model ID; `:132` projects manual exact IDs into real picker
  rows; `:169` prefers exact keys and IDs over names.
- `test/app-interaction.test.mjs:706` selects named provider models; `:852` refuses an
  overlong manual ID instead of truncating; `:869` allows an exact model when no catalog
  models exist; `:909` saves, reloads, and requires reselection after an endpoint change;
  `:963` applies an endpoint change only to the next run; `:1024` completes a real
  patch-and-verify workflow from manual entry.
- `test/screens.test.mjs:136` checks picker controls at 40×20, 60×22, 80×26, 100×30, and
  140×40; the screen-reader and narrow-width cases pass.
- Observed: arbitrary entry works, same IDs stay distinguishable, selection survives
  reload/reselection, and narrow/accessibility paths remain usable.

### PV-15 — Profile mutation during active run — PASS

- `test/app-interaction.test.mjs:963` mutates the saved endpoint during an active run and
  observes the first request at the old endpoint and only the second run at the new one.
- `test/provider-integration.test.mjs:177` changes the environment credential after the
  first request and verifies later tool rounds keep the original bound key.
- `test/provider-transport.test.mjs:152` freezes request options in the prepared target.
- Observed: the active stream, retries, and later tool rounds keep the original
  endpoint/auth/options; the next run reflects explicit reselection.

### PV-16 — Session restore/migration — PASS

- `test/provider-session.test.mjs:80` accepts the exact profile and refuses missing,
  changed, invalid, and unloaded providers; `:141` round-trips exact arbitrary built-in
  IDs; `:182` restores an uncatalogued manual model without discovery.
- `test/cli-integration.test.mjs:534` refuses a changed provider binding, refuses
  `--offline`, and repairs only after explicit `--provider` and `--model`.
- The persisted session identity contains only `{ id, modelId, digest }`
  (`lib/session.mjs:265-278`), so a stored endpoint or key is never used; validation
  re-resolves against current configuration.
- Status records the independent removal demonstration: zero requests to either endpoint
  after removal, preserved binding, then explicit replacement with one request to the
  replacement endpoint.
- Observed: known legacy sessions work; changed profiles block remote execution until
  explicit reselection; forged stored endpoint/key data is not used.

### PV-17 — Actual coding task and exact undo — PASS

- `docs/next-phase/fixtures/provider-p1-loopback.mjs` ran on Node 24.21.0 and Node
  22.23.1 against a temporary repository and `MATRIX_HOME`.
- Both runs observed default denial, separate headless test denial, terminal edit and
  test approval, four real passing tests, exact byte undo, six requests to the expected
  endpoint with the exact model ID, and the fake canary absent from inspected artifacts.
- Logs: `/tmp/opencode/prv107-kit/logs/provider-p1-loopback-node24.log` and
  `...-node22.log`.

### PV-18 — Denied authority and protected files — PASS

- The loopback fixture observed headless default edit denial and separate test denial,
  then explicit terminal approval for both.
- `test/app-interaction.test.mjs:316` proves a denied gate leaves exact bytes untouched
  and creates no undo; `:436` requires reapproval for test trust.
- `test/cli-integration.test.mjs:272` covers real headless apply/deny; `:366` proves test
  trust is separate from `--yes` and writes execution audits; `:421` refuses a silent
  Local Forge fallback.
- `test/provider-probe.test.mjs:515` refuses local, unknown, missing-key, and malformed
  selections before any request.
- Observed: headless denial, edit-only `--yes`, separate test consent, and protected
  reads/writes remain enforced for custom models.

### PV-19 — Capability honesty — PASS

- `test/provider-commands.test.mjs:926` renders declared capability, context, and failure
  state separately; `:148` preserves `not-evaluated` tool state.
- `test/provider-picker.test.mjs:94` carries declared/observed availability and
  capabilities per entry; `test/app-interaction.test.mjs:805` separates a failed observed
  probe from declared capability and hides stale evidence; `:758` refuses an interactive
  provider model without tool support.
- `test/provider-probe.test.mjs:680` keeps partial usage unknown and labeled incomplete;
  `:905` keeps malformed usage unknown; `test/usage.test.mjs:87` keeps unknown cost
  `null` rather than zero or free.
- Observed: declared/observed/unknown remain distinct; unsupported tools fail coding
  selection; unknown cost/usage is not rendered as zero/free.

### PV-20 — Probe tool round trip and caps — PASS

- `test/provider-probe.test.mjs:110` completes a synthetic text and tool round trip in
  exactly three requests, with `max_tokens=256` and the follow-up `tool_call_id` linked.
- `:226` fails an ignored tool call; `:249` fails schema-invalid arguments with no
  follow-up request; `:290` retries HTTP failures zero times; `:336` fails inside the
  total deadline.
- `lib/provider-probe.mjs:47-51` fixes the request cap at 3, completion tokens at 256,
  and timeout at 30,000 ms.
- Observed: synthetic no-op only, malformed tool calls fail, and all three caps hold.

### PV-21 — Probe/cache invalidation and storage bounds — PASS

- `test/provider-probe.test.mjs:361` invalidates every recorded badge after an endpoint
  change; `:387` keeps the latest record per model and evicts the oldest; `:436` never
  follows a symlinked store.
- `test/provider-commands.test.mjs:117` hides discovery/probe records after replacement;
  `:168` prevents in-flight old results from publishing after reversion; `:308` covers
  direct A → B → A edits.
- `test/provider-catalog.test.mjs:243` invalidates discovery on a configuration change;
  `:472` refuses to promote a snapshot without a generation.
- Observed: profile change invalidates evidence, records are bounded, and no stale
  success is reused for a different endpoint or model.

### PV-22 — Credential canaries — PASS

- `test/provider-commands.test.mjs:491` stores only the environment name, never a key
  value. `test/provider-transport.test.mjs:429` covers literal, URI, JSON, base64, and
  base64url forms in error bodies; `:555` proves a header credential cannot reappear
  through the persisted run-log projection.
- `test/provider-catalog.test.mjs:265` redacts discovery error bodies in every encoding;
  `test/provider-probe.test.mjs:549` redacts unexpected tool names and stores no key;
  `test/provider-eval.test.mjs` verifies the evaluator CLI, report, and text output never
  contain the fake key.
- `test/controller.test.mjs:21` keeps fake repository secrets out of children, follow-up
  provider messages, and run logs; session transcript redaction preserves exact undo
  recovery.
- The loopback fixture explicitly recorded `canaryAbsent: true`.
- Observed: exact, escaped, and encoded canary forms were absent from configuration,
  cache, session, export, log, error, and report artifacts; echoed server content was
  redacted.

### PV-23 — Evaluation identity and evidence — PASS

- `npm run eval` stays offline: 16/16 contract pass, baseline PASS, zero safety
  violations, no live runner. Logs:
  `/tmp/opencode/prv107-kit/logs/eval-node24.log` and `eval-node22.log`.
- `test/provider-eval.test.mjs:794` requires an explicit provider and exact model;
  the CLI regression asserts provider identity, `taskRevision`, task digest, network
  class, runtime, usage, cleanup, and the opt-in evidence class.
- The report's evidence string explicitly says one opt-in coding run only, with no
  availability, quality, pricing, context-length, or latency claim.
- **Limitation:** F-2 means `taskSuccess` can be satisfied by a proposal that hard-codes
  the fixture vectors. PV-23 passes for identity, offline separation, and evidence
  labeling, not for general behavioral certification.

### PV-24 — Compatibility and package contents — PASS

- `npm run check` on Node 24: exit 0, 758/758 tests pass, 0 fail/skip, 178 modules
  syntax-checked, coverage 94.18% lines / 84.12% branches / 94.62% functions, all floors
  pass. The 758 count includes the untracked DUR-001 test; the candidate-only count is 757. Log: `/tmp/opencode/prv107-kit/logs/check-node24.log`.
- `npm run eval` on both runtimes: 16/16 contract pass. `npm run smoke` on Node 24: 32
  frames across 4 geometries. `npm run pack:check` on both runtimes: 90 files packed in
  dry-run, no tarball, private/main/bin posture verified. `git diff --check`: exit 0.
- `test/openrouter.test.mjs` preserves the legacy adapter, exact built-in routing, and
  Ollama local aliases; `test/provider-session.test.mjs` preserves session paths; the
  full check includes existing eval/smoke/undo/security regressions.
- `scripts/check-pack.mjs` enumerates every `.mjs` under `bin/`, `lib/`, and `src/` and
  compares the real npm dry-run pack against that complete list, so new provider modules
  are included.
- Observed: compatibility and package contents pass on both runtimes.

## 4. Engineering gates

| Gate                              | Node 24.21.0                           | Node 22.23.1                                  | Evidence                                                 |
| --------------------------------- | -------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| Provider-focused suite (14 files) | 187/187 pass, 0 fail/skip              | 187/187 pass, 0 fail/skip                     | `provider-suite-node24.log`, `provider-suite-node22.log` |
| Full `npm run check`              | 758/758 pass, 0 fail/skip, 178 modules | Preserved in STATUS: 758/758 on the same tree | `check-node24.log`; STATUS                               |
| `npm run eval`                    | 16/16 contract pass, baseline PASS     | 16/16 contract pass, baseline PASS            | `eval-node24.log`, `eval-node22.log`                     |
| `npm run smoke`                   | 32 frames, 4 geometries                | Preserved in STATUS                           | `smoke-node24.log`; STATUS                               |
| `npm run pack:check`              | 90 files, no tarball                   | 90 files, no tarball                          | `pack-node24.log`, `pack-node22.log`                     |
| `git diff --check`                | exit 0                                 | n/a                                           | `git-diff-check.log`                                     |
| UI/CLI interaction                | 58/58 pass                             | n/a                                           | `ui-cli-node24.log`                                      |
| Controller/session/usage          | 41/41 pass                             | n/a                                           | `controller-usage-session-node24.log`                    |
| Screens/contrast                  | 20/20 pass                             | n/a                                           | `screens-node24.log`                                     |

The Node 22 full gate and smoke result are preserved from `STATUS.md`; this review
re-executed the 187 provider-focused tests, eval, and pack checks on Node 22.23.1. The
sandboxed workspace test command uses `process.execPath` directly, so the earlier
external-npm portability failure does not affect the provider-eval path. A generic
`npm`-based test plan installed outside `/usr` remains outside this matrix.

## 5. P3 advisory dispositions

### F-1 — `checks.target` is a hardcoded pass and is excluded from `taskSuccess`

- Location: `eval/provider-eval.mjs:683`.
- Reproduced: the check is literally `target: { status: "pass" }`; the failing F-3 run
  still reports `target: pass`, and `taskSuccess` at `:699-706` does not include it.
- Consequence: the target check is decorative; a report consumer cannot use it to
  distinguish an exact-target run from a failed run.
- Disposition: **Fix before using the evaluator report as a behavior certificate.**
  Either bind `checks.target` to a real provider/model/request assertion and include it
  in `taskSuccess`, or remove it from the report. This is a P3 report-integrity issue,
  not a provider-runtime blocker.

### F-2 — Behavioral gate reuses the authoritative fixture vectors

- Location: the behavioral verification path in `eval/provider-eval.mjs`.
- Reproduced by `advisories-f1-f4.mjs`: a source hard-coded to return `[1,2]` for the
  fixture input `[2,3]` passes both authoritative and behavioral gates with
  `passed: 1, failed: 0`.
- Consequence: an overfit proposal can reach `taskSuccess: true` without correct general
  behavior. The report's evidence class correctly says one opt-in coding run only, but
  `taskSuccess` must not be read as behavioral certification.
- Disposition: **Fix before any quality or behavioral-generalization claim, or record an
  explicit deferral that limits `taskSuccess` to fixture conformance.** A transformed or
  different vector distribution for the behavioral run is the preferred repair.

### F-3 — `checks.edit` conflates byte binding with scoring

- Location: `eval/provider-eval.mjs:684-691`.
- Reproduced by `advisories-f1-f4.mjs`: a conditional source reports a byte-correct
  applied proposal (`appliedSourceMatchesProposal: true`), but `checks.edit: fail`
  because `authoritativeOk` is false. The workspace verification passes 1/0 and both
  scoring gates fail 0/1.
- Consequence: `edit: fail` cannot distinguish a byte-substitution attack from a
  byte-correct proposal that is behaviorally wrong. The composition is conservative and
  does not weaken the ceiling, but it is not a pure binding check.
- Disposition: **Fix before relying on `checks.edit` as a substitution detector.** Split
  the pure byte-binding predicate from the scoring coupling, or expose both an
  `editBinding` and `editVerification` field with the approved and scored digests.

### F-4 — Invoker binding is discoverable by name

- Location: the evaluation context invoker installation in `eval/provider-eval.mjs`.
- Reproduced: `getOwnPropertyNames` reveals `__matrix_invoke_pv107_probe`; replacement
  or deletion raises `TypeError`, and direct invocation is not an advantage over the
  tool path. The completion token is not inferable from the context.
- Consequence: structure disclosure only; no privilege escalation was demonstrated.
- Disposition: **Defer as non-blocking hardening.** A later evaluator cleanup should pass
  the invoker as an explicit argument rather than installing it as an enumerable context
  global.

## 6. Tracing and isolation boundary

The independent Yama verification closes the same-UID scoring-forgery finding
conditionally, for this candidate and the documented host model:

- On the real scope-0 host, the provider-eval CLI exited 1 with the Yama error, made zero
  provider requests, wrote no report, and created no eval temp directory.
- In a disposable scope-2 VM, an unprivileged UID 1000 probe received `EPERM` for
  `PTRACE_ATTACH` and `process_vm_readv`, and `EACCES` for `/proc/<pid>/mem`, against
  the evaluator and both scoring children on Node 24.21.0 and 22.23.1.
- The correct edit passed; the workspace-passing but behaviorally wrong edit failed both
  scoring gates and exited 1 on both runtimes.

Residual limits, recorded rather than waived:

- Root or `CAP_SYS_PTRACE` can still trace at scope 2; scope 3 denies even root, but a
  malicious root is outside any local policy.
- A privileged attacker who can change the sysctl mid-run and restore it is outside the
  tested model.
- Direct callers of the exported lower-level `runAuthoritativeVerification` bypass the
  guard; `runProviderEvaluation()` and the CLI enforce it.
- A malicious runtime or checkout is out of scope; the guard reads kernel evidence
  through the running Node process.
- The host remains at `kernel.yama.ptrace_scope=0`, so the evaluator is not runnable
  here without an explicit host-policy change. No such change was made.

The proposal-binding/substitution family is independently accepted within the tested
scope; the scoring boundary is a host-policy enforcement, not a new sandbox around the
result-phase children.

## 7. Remaining blockers and limits

1. **Evaluator certificate use:** F-1 and F-3 must be fixed before `checks` or
   `taskSuccess` is cited as a behavior certificate; F-2 must be fixed or explicitly
   scoped to fixture conformance before quality claims.
2. **Host policy:** live provider evaluation requires Yama scope 2/3 and an untraced
   evaluator. This host is scope 0, so the real CLI correctly refuses and no live
   evaluator result is claimed.
3. **Live provider evidence:** none. All provider traffic was loopback with fake keys.
   Availability, quality, pricing, context length, and latency remain NOT EVALUATED.
4. **Administrative closure:** the chief must record this verdict and the F-1 through
   F-4 dispositions on the status board. This report does not edit `STATUS.md` or mark
   any task ACCEPTED.
5. **Generic external-npm sandbox test plans:** the provider-eval path now uses
   `process.execPath` directly; a different test plan that invokes an npm CLI outside
   `/usr` can still hit the existing Bubblewrap mount limitation. That is outside the
   PV matrix and remains a portability note.

## 8. Evidence retention

Repository evidence:

- `test/provider-*.test.mjs`, `test/openrouter.test.mjs`, `test/process.test.mjs`,
  `test/app-interaction.test.mjs`, `test/cli-integration.test.mjs`,
  `test/controller.test.mjs`, `test/usage.test.mjs`, `test/session-workspace.test.mjs`,
  `test/screens.test.mjs`, `test/contrast.test.mjs`.
- `docs/next-phase/fixtures/provider-p1-loopback.mjs`.

External review kit:

- `/tmp/opencode/prv107-kit/fixtures/pv02-config-fifo.mjs`
- `/tmp/opencode/prv107-kit/fixtures/pv04-concurrent-same-model.mjs`
- `/tmp/opencode/prv107-kit/fixtures/pv12-hostile-discovery.mjs`
- `/tmp/opencode/prv107-kit/fixtures/pv13-offline-inventory.mjs`
- `/tmp/opencode/prv107-kit/fixtures/advisories-f1-f4.mjs`
- `/tmp/opencode/prv107-kit/logs/` (all runs cited above)
- `/tmp/opencode/review-kit/` (independent Yama harness and VM evidence)

No credential, private key, or full canary value is included in this report or the
retained logs.

## 9. Recommended disposition

Record **PRV-107 ACCEPTED** for the provider acceptance matrix, with:

- F-1 and F-3 as required evaluator follow-ups before certificate use;
- F-2 as a required fix or an explicitly recorded fixture-conformance limitation;
- F-4 as a deferred hardening item;
- the Yama scope 2/3 and untraced-evaluator requirement as a deployment prerequisite;
- live provider compatibility and quality explicitly NOT EVALUATED.

Subject to those records, the provider phase's mandatory P0/P1/P2 gates are satisfied
and the deferred durable phase may be released.
