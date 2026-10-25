# Matrix agent evaluation (EVAL-001)

This is a versioned, serial, network-free evaluation of real Matrix controller/agent behavior. It is
not a second unit-test suite and it is not live model benchmarking. Every case uses a new temporary
workspace, `HOME`, and `MATRIX_HOME`; the latter two are outside the workspace and outside its file
digests. A fetch trap supplies only reviewed canned responses. Child-process starts are observed,
and environment, fetch, spawn, processes, and temporary trees are cleaned on success and failure.

## Commands

From the Matrix source checkout:

```bash
npm run eval                       # default 16-case eval + strict baseline comparison
node eval/run.mjs --json           # the same run, with the sanitized JSON report on stdout
node eval/run.mjs --stress         # separate opt-in 10,000-file stress profile
node --test test/eval.test.mjs     # focused tests; runs only one small eval smoke case
```

`npm run eval` is exactly `node eval/run.mjs`. No live-provider credentials, Python packages, or
network access are required. The default run is intentionally short; wall time is machine-dependent
and is not an SLA. Stress is never selected by default.

Artifacts:

- `eval/baselines/default-v1.json` — reviewed default expectations and thresholds.
- `eval/baselines/stress-v1.json` — separately reviewed stress expectations.
- `eval/reports/default.json` and `default.txt` — generated latest default report.
- `eval/reports/stress.json` and `stress.txt` — generated opt-in stress report, when run.

`eval/reports/` is generated evidence and is gitignored; only reviewed baselines are versioned. CI
uploads the sanitized default report on failure. JSON and text reports contain no raw provider request bodies, credentials,
full canary values, or temporary absolute paths. Reports retain relative workspace evidence.

## Cases and evidence classes

`local-forge` means deterministic offline capability/lifecycle evidence. It covers:

1. `local-fix`
2. `local-rename-limited`
3. `local-deny` (denied completion is **not** task completion)
4. `local-abort`
5. `local-exact-undo` (CRLF bytes, modes, binary inventory, and symlink inventory)
6. `local-noisy-verification` (late summary and bounded output)
7. `local-large-repository-budget` (bounded index/search and explicit partial metadata)
8. `local-session-recovery` (save/load/re-arm/exact undo)
9. `local-undo-refusal` (external post-write change is preserved)

`mocked-remote-policy` means protocol/policy evidence from canned providers only. It covers:

1. `remote-create`
2. `remote-malformed-tools`
3. `remote-malformed-transport`
4. `remote-prompt-injection-containment`
5. `remote-retry-usage-provenance`
6. `remote-unknown-cost`
7. `remote-failure-after-write-recovery`

These mocked cases do **not** establish provider availability, model quality, current tool support,
current prices, or live latency. `local-large-repository-stress` is the only stress-profile case.

## Metric semantics

- `taskSuccess` is case-specific and is evaluated from bytes, content, and the actual terminal
  outcome. It is `false` for denied, aborted, transport-failed, and failure-after-write tasks. It is
  `null` for pure safety/protocol/work-budget probes where task completion is not meaningful.
- `contractPass` is independent of `taskSuccess`. An expected failed transport can satisfy its
  honesty/recovery contract while not completing the task. A denied run can satisfy the denial
  contract while `taskSuccess` remains `false`.
- Actual outcomes are classified through `lib/outcome.mjs`; there is no eval-only success predicate.
- `safetyViolations` is a structured list, not a weighted score. Inspection covers every `applied`
  event, unexpected path/type/content/mode/target changes, direct process starts and their
  executable/cwd/shell state, provider calls/endpoints/tool schemas, command events, lingering
  processes, and forbidden canary forwarding. Any violation fails the case and baseline comparison.
- Workspace snapshots contain the complete relative path inventory, entry types, full-file SHA-256
  and byte counts, POSIX modes where applicable, and symlink targets without following links.
  `before`, `afterRun`, `preRecovery`, and `final` snapshots are retained. Recovery is reported as
  `exact`, `refused`, `failed`, or `not-attempted`, with exact mismatch entries.
- Each attempt preserves separate verification records: `processOk`, `verified`,
  `verificationStatus`, trust and start/end audit evidence, parser confidence, output line counts,
  retention/truncation flags, and raw duration. Counters remain independent raw values: HTTP
  attempts/statuses, retryable HTTP responses, model rounds, tool calls, healing attempts, and
  verification attempts. `latencyMs` contains raw run/index/HTTP-header/verification samples. There
  are no universal timing thresholds; the 60-second watchdog only prevents a hung evaluation.
- Local Forge token and monetary usage is `not-applicable` with null fields, never fabricated zero
  model usage. Remote usage retains provider/estimated/mixed/unavailable provenance, per-source
  token subtotals and charges, and round provenance. Unknown cost stays `null`. The report never
  averages provider plus estimated costs or averages costs across cases/models.
- Non-enumerable `searchRepo` fields (`scanned`, `scannedBytes`, `partial`, `truncated`, `aborted`,
  and `reason`) are explicitly projected. Other missing metadata is serialized as explicit `null`.

## Versions and fail-closed comparison

Schema, fixture, and baseline versions are independent (`EVAL_SCHEMA_VERSION`,
`EVAL_FIXTURE_VERSION`, and `EVAL_BASELINE_VERSION`). A SHA-256 fixture identity covers tasks,
fixtures, canned responses, models, approvals, recovery, and declarative expectations. Comparison
requires an exact case set and reviewed baseline provenance. It fails on unsupported versions,
fixture identity changes, missing/unbaselined/duplicate cases, unreviewed metadata, cleanup failure,
any unsafe action, any case contract failure, or any stable evidence mismatch. Raw timing is excluded
from baseline expectations. Baselines contain no latency thresholds and are never auto-updated.

## Reviewed baseline-update policy

After an intentional behavior/fixture/contract change, first run and inspect the complete sanitized
report. Only a human-reviewed, fully passing and safe actual run may become a baseline:

```bash
node eval/run.mjs --update-baseline --reviewed-by "reviewer identity and review date"
node eval/run.mjs
node eval/run.mjs --stress --update-baseline --reviewed-by "reviewer identity and review date"
node eval/run.mjs --stress
```

The update command refuses `CI`, requires `--reviewed-by`, and refuses failed/unsafe reports. Record
the source report SHA-256 and runtime in the baseline, review the baseline diff, then run comparison
again without update flags. Bump the relevant version(s) for intentional incompatible changes and
review default and stress independently. CI must run comparison only; it must never regenerate or
accept an unreviewed baseline. Timing-only variation is not a reason to update a baseline.

## Stress and live-provider boundaries

Stress uses 10,000 deterministic hard-linked (or copied, where links are unavailable) files and small
index budgets. It remains local and has its own fixture digest/baseline, so opting in cannot weaken
or silently expand the default case set.

There is deliberately no live-provider runner or `live` profile. A future live adapter must be a
separate explicit opt-in interface with its own evidence class, authorized low-risk fixtures,
credential/redaction policy, exact provider/model/date metadata, and separate reports. It must not
reuse mocked results, invent missing samples, alter this default baseline, or generalize one model's
quality/price/availability to another. Until such an interface exists, live quality evidence is
simply absent.
