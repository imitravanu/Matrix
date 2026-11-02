# Next-phase status and dispatch board

The latest v4 evaluator repair passes the full engineering gate on Node 22 and
Node 24: 746 tests each, with no failures or skips. VM-constructor escapes,
forged output and incomplete assertion runs fail; equivalent valid solutions pass.
The default offline evaluation and package checks pass on both versions. See
[final repair evidence](reports/2026-11-02-eval-final-repair.md) for candidate
identity, regressions and limits. Independent phase acceptance remains open.

The early-exit scoring bypass has a repair submitted for independent review.
Task revision v3 requires a separate pure-function behavioral gate whose assertions
run outside the submitted module context. Both that gate and the original fixture
verification must pass. Early exit, forged TAP and wrong-return regressions are
included; acceptance remains open.
The full Node 24 gate passed 745 tests without failures or skips. Node 22's
15-test provider-evaluation suite and the 16-case default offline baseline passed.
Logs: `/tmp/matrix-exit-check.log`, `/tmp/matrix-exit-tests22.log`, and
`/tmp/matrix-exit-offline.log`. The original early-exit reproduction now reports
failed edit/verification checks and taskSuccess false.

The three evaluation-review findings have a repair submitted for independent
review: both test runs use an allowlisted environment, cancellation aborts the
controller, and behavioral verification accepts equivalent edits. The fixture
revision is now v2. Test execution is not a filesystem or network sandbox.
Node 24's full check passed 744 tests without failures or skips; the 14-test
provider evaluation suite also passed on Node 22. The default offline evaluation
passed all 16 baseline cases. These are implementer checks, not acceptance.

The evaluation review returned **CHANGES REQUIRED** on the earlier candidate:
the first verification exposed credentials with custom environment names,
evaluation cancellation was not connected to the controller, and exact source
matching rejected a correct alternative solution. All three were reproduced; see
[the review and reproduction](reports/2026-11-02-provider-eval-review.md).
This follow-up review does not establish PRV-106 independence or acceptance.

The latest candidate displays saved probe observations separately from declared
capabilities in the picker and provider details. Endpoint changes hide stale
observations. The Node 24 full gate passed 741 tests without failures or skips;
see [integration evidence](reports/2026-11-02-integration-evidence.md) for the
candidate identity, other checks and remaining independent acceptance work.

The direct-edit A → B → A cache case now fails closed using a tracked configuration
file stamp and per-profile generations. Before an explicit probe or refresh adopts
an externally edited configuration, it invalidates earlier observations under the
configuration lock. Tests cover a late old probe, corrupt stamp, cancellation and
fresh evidence after adoption. This implementation still needs independent audit
and platform/filesystem-specific failure testing; it is not acceptance evidence.

The provider picker now offers explicit local catalog reload and explicit saving
of a highlighted custom model. Reload refuses execution against a changed selected
profile until it is reselected; an active run retains its original target. A
provider-bound session with a changed configuration can be resumed after explicit
`--provider` and exact `--model` reselection. These changes are submitted for
independent review, not accepted; re-run the P1/P2 matrix on the final candidate.

The CLI now has a complete-profile `providers replace` operation requiring the
previously observed configuration digest. File parsing is bounded, profile
validation and atomic mutation use the existing store, and stale digests are
refused. Endpoint changes hide discovery and probe records with an older target
digest. A per-profile generation now invalidates observations across endpoint
reversion and remove/re-add, and publication takes the configuration lock and
checks the captured generation. Targeted fake-provider tests cover A → B → A,
in-flight old probe and discovery responses, and fresh observations afterward.
The Node 24 full check passed 729 tests with no failures or skips; the affected
provider suites passed 67 tests on Node 22. The repair and crash/failure behavior
still require independent review; neither the command nor this repair constitutes
phase acceptance.

The authoritative evaluation verifier starts with a minimal sanitized child
environment and a disposable home. It now uses the shared process runner with
owned process-group cleanup and lifecycle regressions. Independent review of
the repair and the shared trusted test-execution/audit integration remains
outstanding; this change is not phase acceptance.

The interactive unsupported-tools refusal identified in the picker recheck is now
implemented at the UI and controller boundaries, with UI and controller regression
tests. The opt-in `providers test` probe is also implemented: synthetic fixtures only,
three requests / 256 completion tokens / 30 seconds per invocation, and bounded records
keyed to the provider/model/configuration digest. Its independent reviews returned four
findings; all are repaired at cause and the reviewer must reproduce them again. These
deliveries do not constitute acceptance of PRV-104 or the provider phase.

Updated 2026-11-02. Baseline `e1b3c66` plus the PRV-101–105 candidate in the working tree.
**Dynamic custom providers are first.** An independent review of the 617-test candidate
returned **CHANGES REQUIRED** (R1–R5) — see [the report](reports/2026-11-01-provider-review.md).
A second independent pass over the 634-test repair then returned **CHANGES REQUIRED**
again (RR1–RR3) — see [the re-review](reports/2026-11-01-provider-re-review.md) — and a
third pass on the 640-test repair found two discovery contract gaps (D1–D2) — see
[the third review](reports/2026-11-01-provider-review-3.md) — and a fourth check found one
remaining D2 path, the timeout that skipped persisted failure status — see
[check 4](reports/2026-11-01-provider-check-4.md). Check 5 then confirmed the timeout
repair with no new findings. Every reproduced finding is repaired with a regression case.
The provider management CLI (`providers list/add/show/update/remove/models`) now exists;
an independent [CLI review](reports/2026-11-01-provider-cli-review.md) found one projection
mismatch (a cached read hid the failed refresh), and a second
[show/update review](reports/2026-11-01-provider-cli-show-update-review.md) found one
default-model erasure. Both are repaired with regressions. The interactive model picker now lists named-provider
models with per-provider availability and the exact target, sessions bind
provider/model/configuration identity with repair-or-refuse resume, and a TTY `--provider`
preset plus direct exact-ID entry use the same resolved target. A separate picker/resume review
reproduced three defects (a remote wire ID named `local`, lost built-in resume identity, and
uncatalogued manual resume); all three are repaired with regressions. The PRV-105 opt-in
provider evaluation is now delivered and SUBMITTED (see its section below). Its independent
recheck then reproduced a package.json test-script substitution; the evaluator now denies every
non-source edit, protects the fixture/package bytes and scores against an independent run of the
original fixture (see the package/test-runner repair below). The phase is **not complete and not
accepted**: independent re-review of that repair, the adversarial audit and the release decision
remain open.

States: READY → CLAIMED → IMPLEMENTING → SUBMITTED → ACCEPTED.
Use CHANGES REQUIRED after review, BLOCKED for an unresolved prerequisite and DEFERRED
for later phases. Only the chief records ACCEPTED against exact candidate evidence.

## Active provider phase

| Task    | Status    | Owner / checkout                                         | Prerequisite / next action                                                                                                                                                                                                             | Evidence / verdict                                                                                                                                                                               |
| ------- | --------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PRV-101 | SUBMITTED | Chief/contracts implementer, `/home/mitravanu/matrix`    | R2/R4/RR1/RR3 repaired 2026-11-01; independent re-review required                                                                                                                                                                      | 16 config tests; repaired-candidate gate below                                                                                                                                                   |
| PRV-102 | SUBMITTED | Chief/transport implementer, owner-directed exception    | R3/R5 repaired 2026-11-01; PRV-101 still not independently accepted                                                                                                                                                                    | 14 transport + 20 legacy tests; repaired-candidate gate below                                                                                                                                    |
| PRV-103 | SUBMITTED | Chief/catalog implementer, owner-directed exception      | R3/RR3/D1/D2 and check-4 timeout repaired 2026-11-01                                                                                                                                                                                   | 16 catalog tests; repaired-candidate gate below                                                                                                                                                  |
| PRV-104 | PARTIAL   | Chief/integration implementer                            | Picker, exact target, session binding, explicit built-in routing, TTY `--provider` preset, exact-ID entry and `providers test` delivered 2026-11-01; picker/resume and probe review defects repaired; probe hostile-stream cases added | Picker/app/session/probe/CLI regressions; 719-test gate; re-review required                                                                                                                      |
| PRV-105 | SUBMITTED | Compatibility/eval implementer, `/home/mitravanu/matrix` | Opt-in evaluation delivered 2026-11-02; package/test-runner integrity & VM constructor escape repaired; PRV-102/103/104 still SUBMITTED/PARTIAL; re-review required                                                                    | 15 provider-eval tests; package-script denial, VM escape & completion token regressions; 745-test gate; default eval PASS; [repair report](reports/2026-11-02-provider-eval-vm-escape-repair.md) |
| PRV-106 | BLOCKED   | Unassigned                                               | P0 for fixture preparation; integrated candidate for audit                                                                                                                                                                             | None                                                                                                                                                                                             |
| PRV-107 | BLOCKED   | Chief role; no active implementation reservation         | Submitted PRV-101–106 evidence; independent review and P3                                                                                                                                                                              | None                                                                                                                                                                                             |

## Deferred durable phase

| Task     | Status   | Owner      | Release condition                                                |
| -------- | -------- | ---------- | ---------------------------------------------------------------- |
| DUR-001  | DEFERRED | Unassigned | PRV-107 accepted; chief releases durable phase                   |
| EVAL-101 | DEFERRED | Unassigned | PRV-107 accepted; capability protocol uses new provider identity |
| DUR-002  | DEFERRED | Unassigned | Durable phase released; accepted DUR-001                         |
| DUR-003  | DEFERRED | Unassigned | Durable phase released; accepted DUR-001; integrates DUR-002     |
| DUR-004  | DEFERRED | Unassigned | Accepted DUR-001/002/003                                         |
| DUR-005  | DEFERRED | Unassigned | Accepted DUR-001/002/003; shared-file handoff with DUR-004       |
| DUR-006  | DEFERRED | Unassigned | Accepted DUR-004/005 interface                                   |
| QA-101   | DEFERRED | Unassigned | DUR-001 contracts; integrated durable runtime for final audit    |
| INT-101  | DEFERRED | Chief role | Durable implementations and independent QA evidence              |

Preserved durable contracts/tasks are in [DURABLE_PHASE.md](DURABLE_PHASE.md),
[ARCHITECTURE.md](ARCHITECTURE.md) and [AGENT_TASKS.md](AGENT_TASKS.md). Their internal
READY labels indicate later-phase readiness only; this board governs current dispatch.

## File reservations

PRV-101 reserved and delivered these paths at base `e1b3c66`, candidate in the working tree:
`lib/provider-contracts.mjs`, `lib/provider-config.mjs`, `test/provider-contracts.test.mjs`,
`test/provider-config.test.mjs`, `docs/next-phase/decisions/PRV-101.md`, plus the ratchet/config
edits to `scripts/check-coverage.mjs` and `jsconfig.json`. No caller, CLI, UI, session or
transport file was modified. The reservation stays open until independent review; PRV-103
may read these exports but must not edit them without a handoff.

PRV-102 then touched, under an explicit owner-directed gate exception recorded in the audit
log: `lib/provider-transport.mjs` (new), `lib/openrouter.mjs` (streaming core extraction and
legacy adapter only), `test/provider-transport.test.mjs` (new), the `MATRIX.md` runtime row,
and the `provider-transport` coverage floor. It did not touch `lib/credentials.mjs`,
`lib/model-agent.mjs`, `lib/controller.mjs`, the CLI or the UI. PRV-103 still owns
`lib/models.mjs` and must not edit these paths without a handoff.

## Open proof gates

1. PRV-101: validated schema, immutable target/digest, precedence and session migration contracts.
   **Delivered in the candidate; self-reviewed only.**
2. PRV-101: safe bounded configuration mutation and concurrent-writer/process-death proof.
   **Delivered: kernel-held abstract-socket lock (no reclaim), immediate crash release,
   SIGSTOP-paused-owner exclusion, directory fallback that never steals, two-writer test,
   atomic-write conflict test and pre-write byte-limit refusal. Independent reproduction is
   still required.**
3. PRV-102/104: endpoint/key isolation through the entire actual tool loop. **Open.**
4. PRV-106/107: independent matrix evidence and exact integrated-candidate checks. **Open.**

These are deliverables, not requests for the owner to make routine implementation choices.

## Independent review and R1–R5 repairs (2026-11-01)

The review reproduced five defects against the 617-test candidate. Each is repaired at
cause and now has a durable regression case; no assertion was weakened or suppressed.

| Finding                                      | Repair                                                                                                                                                                                                                              | Regression evidence                                                                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 P1 TTY task bypassed `--provider`         | `assertProviderTerminalSupport` refuses every TTY provider invocation before the legacy resolver; headless tasks are unchanged                                                                                                      | `cli.test` cases for arbitrary ID, legacy alias and omitted model, plus a real PTY run asserting exit 1 and no `unknown model`; headless CLI run reaches the exact endpoint/model |
| R2 P1 delayed reclaimer stole a fresh lock   | Exclusion is an abstract Unix socket held by the kernel on Linux: crash release is automatic and **no code path reclaims a lock**. The non-Linux directory fallback never removes a dead owner's lock, it reports the recovery path | live-holder contention, SIGSTOP-paused holder, crash-then-immediate reacquire, concurrent writers, directory-fallback no-steal, token checks                                      |
| R3 P1 encoded credentials leaked             | One redaction module expands each secret to literal/URI/JSON/base64 and base64url forms, matches short secrets as tokens, redacts before truncation, and withholds a detail when any 4-char fragment survives                       | redaction unit tests, loopback HTTP 400 bodies echoing every encoding, a boundary-straddling key, a short key, and discovery error bodies                                         |
| R4 P2 mutation could exceed the loader limit | The writer serializes once and rejects `CONFIG_TOO_LARGE` before opening a temp file, leaving prior bytes intact                                                                                                                    | repeated large-profile growth with byte-for-byte comparison after the refused add                                                                                                 |
| R5 P2 credential re-resolved per tool round  | `bindProviderCredential` resolves once per run; transport and command audit share it; a fresh run resolves again                                                                                                                    | two-round agent run mutating the environment after round one: both requests carry the original key, the next run uses the replacement                                             |

Interface change: provider-config mutators and lock functions are asynchronous. Kernel-held
acquisition is asynchronous by nature and the candidate has no production callers yet, so
this was treated as a correctness fix rather than compatibility debt.

Historical note: the R1 TTY refusal guard was superseded on 2026-11-01 by the deliberate
`--provider` TUI preset in the PRV-104 interaction completion below; headless behavior and
endpoint/model freezing are unchanged. The guard no longer exists in `lib/cli.mjs`.

Gate on the R1–R5 repair, before the re-review, Node 24.21.0: `npm run check` exit 0 —
**634 tests, 634 pass, 0 fail, 0 skipped**; 166 modules syntax-checked; coverage 93.98%
lines / 83.67% branches / 94.41% functions, every floor passing. `npm run pack:check`:
86 files packed (dry-run), no tarball.

### Re-review RR1–RR3 (2026-11-01)

The re-review confirmed R1–R5 for their reproduced cases and found three remaining
defects. Each is repaired at cause:

| Finding                                        | Repair                                                                                                                                                                                                                                               | Regression evidence                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RR1 P1 path aliases bypass the kernel lock     | Lock names hash the configuration directory's `dev:ino`, not its lexical path, so real and symlinked homes share one lock. Identity is re-derived after binding and immediately before the rename; a changed directory aborts with `CONFIG_CONFLICT` | acquiring through a symlinked home blocks while the real home holds the lock, then two concurrent processes add through both spellings and both updates survive |
| RR2 P2 Content-Type truncated before redaction | The complete untrusted header is redacted and bounded with fragment withholding; provider error codes are now redacted with the message instead of being interpolated afterwards                                                                     | HTTP 200 with a 70-character header prefix followed by the key leaks no fragment; a provider `code` echoing the key is redacted                                 |
| RR3 P2 FIFO cache hangs catalog loading        | Cache reads open with `O_NONBLOCK \| O_NOFOLLOW` and validate the opened descriptor as a regular file, so a FIFO cannot block and a symlink is treated as absent                                                                                     | a FIFO cache in a child process finishes within the hard timeout and keeps configured models; a valid payload read through a symlink is rejected                |

Gate on the RR1–RR3 repaired candidate, Node 24.21.0: `npm run check` exit 0 —
**640 tests, 640 pass, 0 fail, 0 skipped**; 166 modules syntax-checked; every coverage
floor passing. `npm run pack:check`: 86 files, no tarball.

### Review 3 D1–D2 (2026-11-01)

The third review confirmed every earlier reproduction and found two discovery contract
failures. Both are repaired:

| Finding                                     | Repair                                                                                                                                                                                                                                                                         | Regression evidence                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 P2 discovery ignored caller cancellation | `refreshProviderModels` accepts a caller `signal`, composes it with the deadline, checks before fetch, after the body and before cache replacement, and cancels a stalled reader. Cancellation never records a provider failure                                                | already-aborted call issues zero requests; abort during body streaming and abort after the bytes arrive both preserve the prior snapshot and commit nothing                                            |
| D2 P2 catalog dropped discovery freshness   | Each profile now keeps a bounded, redacted `refresh.json` outcome beside its snapshot. `buildProviderCatalog` exposes `provider.discovery` (`outcome`, `stale`, `error`, `fetchedAt`) and per-entry `stale`/`fetchedAt`/`discoveryError`, separate from configuration validity | failed refresh followed by a rebuilt catalog reports `error`/`stale` with the retained snapshot; a later success clears it; a pre-status snapshot is treated as fresh; digest change still invalidates |

Gate on the D1–D2 repaired candidate, Node 24.21.0: `npm run check` exit 0 —
**645 tests, 645 pass, 0 fail, 0 skipped**; 166 modules syntax-checked; every coverage floor
passing. `pack:check`: 86 files, no tarball.

### Check 4 — timeout status path (2026-11-01)

Check 4 confirmed D1 and the HTTP-failure half of D2, and found one remaining D2 path: a
deadline that cancels a stalled reader makes `readBoundedBody` resolve with partial bytes,
and that branch returned a failure without persisting it, so a rebuilt catalog still said
fresh. The branch now routes through the persistent failure recorder; explicit user
cancellation remains separate and still records nothing.

Gate on the check-4 repaired candidate, Node 24.21.0: `npm run check` exit 0 —
**647 tests, 647 pass, 0 fail, 0 skipped**; 166 modules syntax-checked; coverage 93.94%
lines / 83.65% branches / 94.45% functions, every floor passing (`provider-config`
87.56/77.36/96.00 against 85/70/95, `provider-catalog` 100.00/84.78/100.00 against
100/75/100, `provider-discovery` 90.30/76.34/91.67 against 85/68/85). `pack:check`: 86
files, no tarball. Node 22 and hosted CI were not run.

These repairs did not by themselves close the delivery gaps. The management half of the
CLI gap is now closed (below), as are the TUI picker/manual entry, session binding,
built-in explicit selection, the bounded `providers test` probe and the opt-in provider
evaluation (below); independent review of the evaluation, the full adversarial matrix and the
release decision are still missing.
PRV-101–104 remain SUBMITTED/PARTIAL; a repair or a self-tested delivery is not an
acceptance.

### Provider management CLI (2026-11-01)

The headless management path no longer requires editing `~/.matrix/providers.json`:

- `providers list` projects the catalog without a network call, showing named profiles,
  model counts, credential state (anonymous profiles report `no key required`, never a
  phantom key) and discovery freshness/staleness from the persisted status. An invalid
  configuration is printed as a diagnostic and exits 1; Local Forge and built-ins remain
  listed.
- `providers add` validates `--id`, `--base-url`, `--auth bearer|none`, `--name` and
  `--model`, then writes through the existing bounded, kernel-locked mutator. There is no
  flag that accepts a key value; only the environment-variable name is stored. Duplicate
  ids are refused rather than replaced.
- `providers show <id> [--json]` prints one profile: endpoint, transport, auth type and
  env-var name, default model, configured models with tool/capability and context state,
  discovered models, and the persisted refresh outcome. It never has access to the key value.
- `providers update <id> ...` changes only the fields named by flags (`--name`,
  `--base-url`, `--api-key-env`, `--auth`, `--model`, `--remove-model`,
  `--default-model`). It preserves unmentioned fields, including a valid default model
  that is not in the configured list (and accepts any syntactically valid exact ID for
  `--default-model`), refuses a duplicate model, and writes with the digest it read so a
  concurrent edit is refused instead of overwritten. The default is cleared only when
  this command removes the model it names; a replacement default in the same command
  wins. A changed endpoint/auth makes the old snapshot unreadable; a rename keeps it.
- `providers remove` deletes one exact id and refuses an unknown one.
- `providers models <id> [--refresh]` lists configured models plus cached discovered ones
  (configured always wins). `--refresh` is the only path that touches the network, uses
  that profile's endpoint and key, and a failed refresh is printed with the retained
  snapshot and exits 1 instead of looking fresh. A failure with no snapshot says so;
  it does not claim one was preserved.
- Untrusted provider text reaches the terminal only through redaction, ANSI stripping and
  single-line bounding, so a response body cannot paint escape sequences or forge extra
  output rows.
- A cached read (`models` without `--refresh`) now uses the same exported discovery
  summary as the catalog, so it warns when the last refresh failed instead of silently
  presenting the old snapshot as current. The formatter also renders an `error` outcome
  as stale, so a malformed or older summary cannot hide the failure either.
- `--json` is available on `list`, `show`, `update` and `models`; every subcommand
  refuses unrelated flags and positional arguments at parse time.

Gate after adding the CLI and its ratchet, Node 24.21.0: `npm run check` exit 0 —
**662 tests, 662 pass, 0 fail, 0 skipped**; 168 modules syntax-checked; coverage 94.05%
lines / 84.00% branches / 94.53% functions, every floor passing (`provider-catalog`
100.00/88.24/100.00 and `provider-commands` 100.00/95.19/97.44). `pack:check`: 87
files, no tarball.
The new tests cover parsing failures, the bounded store mutations, show/update round trips
with retained fields, an unlisted default surviving name/URL/auth edits, explicit default
removal and same-command replacement, a real loopback refresh with
configured/discovered filtering, cache invalidation on a target change but not on a
rename, a failed refresh that preserves the prior snapshot, a fresh CLI process reading
that failure from disk (text and JSON, no new request), anonymous profiles, hostile
multi-line/escaped provider text, and formatter output for built-in/fresh/stale/absent
states. This is
self-reviewed implementation evidence only; it does not satisfy P1, which still requires
the interactive workflow and a session that survives restart.

### Provider probe — `providers test` (2026-11-01)

- `providers test <id> --model <exact-id> [--checks text,tools] [--json]` is the only
  explicit probe path. It sends synthetic fixtures only, never repository contents, and
  no filesystem, shell or real Matrix tool is reachable from it.
- `text` requires a terminal completion event and records the observed content length.
  `tools` requires exactly one schema-valid `matrix_probe_noop` call with an id, then a
  clean follow-up: `finish_reason: "stop"`, non-empty text and no additional tool call.
  An ignored, malformed or mismatched call, a bare `[DONE]`, a `length` finish, a repeated
  tool request or an empty answer fails the check. Both checks send
  `max_tokens`/`max_completion_tokens` = 256 according to the profile request contract.
- Provider-controlled text in an error (an unexpected tool name or finish reason) is
  redacted with the bound credential in literal, URI, JSON and base64 forms before it is
  bounded; a surviving fragment withholds the detail instead of truncating a credential
  prefix. Errors reach the result, terminal output and stored bytes only after that step.
- The invocation cap is three requests (text one, tools two), retries are disabled, and a
  30-second deadline covers the whole invocation. Caller cancellation sends nothing
  further and writes no record; a provider or deadline failure is recorded honestly.
- Records are stored at `$MATRIX_HOME/provider-cache/<id>.probes.json` with mode 0600,
  one latest record per model, capped at 256 models with oldest eviction and a 512 KiB
  file bound. They carry the provider, exact model, configuration digest, timestamp,
  requested and actual checks, per-check pass/fail/not-evaluated, request count and usage
  when returned. Missing token fields stay absent, and `usageComplete` is true only when every
  request returned all three counts; a partial sum is labeled partial. No key or prompt
  bytes are stored. A changed endpoint, auth reference or request option makes matching
  records unreadable; display/catalog-only edits do not invalidate execution evidence.
- The store read is non-blocking and no-follow, so a FIFO cannot stall the command and a
  symlink cannot redirect a private read.
- Tests cover text/tool success with fragmented arguments, ignored and malformed tools,
  HTTP failure with zero retries, pre-aborted cancellation, the total deadline, digest
  invalidation, 256-model eviction, symlink refusal, a built-in OpenRouter target with an
  arbitrary exact model, pre-flight refusals, canary tool names in exact/URL/JSON forms,
  repeated/bare/truncated/empty follow-ups, partial usage, unfollowed redirects, abrupt
  disconnects, oversized SSE events, malformed tool-call IDs/arguments and malformed
  usage. A real CLI subprocess case covers the text/tool pass, JSON output and a failing
  endpoint.

Gate after adding the probe, Node 24.21.0: `npm run check` exit 0 — **703 tests, 703 pass,
0 fail, 0 skipped**; 174 modules syntax-checked; coverage 94.18% lines / 84.04% branches /
94.46% functions, every floor passing (`provider-probe` 92.65/78.47/100.00 against
90/75/95). `npm run pack:check`: 90 files packed (dry-run), no tarball. This is
initial implementation evidence; the independent review below then found one P1 and two
P2 defects, which are repaired with regressions. A probe pass is not a coding-quality,
context-length or full protocol claim.

### Provider probe review repairs (2026-11-01)

The independent [probe review](reports/2026-11-01-provider-probe-review.md) returned
**CHANGES REQUIRED** on the 703-test candidate with one P1 and two P2 findings. All three
are repaired at cause with regressions:

| Finding                                      | Repair                                                                                                                                                                                                                 | Regression evidence                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 unexpected tool name exposed credentials  | Error text from provider-controlled fields now goes through `redactedDetail` with the bound credential before bounding; literal, URI, JSON and base64 forms are removed, and a surviving fragment withholds the detail | exact, URL-encoded and JSON-escaped canaries are absent from result JSON, formatted output and persisted bytes                                                |
| P2 follow-up could pass without a round trip | The follow-up must complete with `finish_reason: "stop"`, contain text and carry no further tool call; a bare `[DONE]`, `length`, repeated calls and empty answers fail                                                | table-driven cases for repeat, bare, truncated and empty follow-ups, each exactly two requests                                                                |
| P2 missing usage became zero                 | Only observed token fields are aggregated; missing fields stay absent and `usageComplete` is true only when every request returned all three counts                                                                    | a `{completion_tokens: 2}` response stays partial (`prompt_tokens`/`total_tokens` absent) in the report, record and `providers test` output labeled `partial` |

Gate on the repaired candidate, Node 24.21.0: `npm run check` exit 0 — **706 tests, 706
pass, 0 fail, 0 skipped**; 174 modules syntax-checked; coverage 94.19% lines / 84.14%
branches / 94.59% functions, every floor passing (`provider-probe` 92.32/81.03/100.00
against 90/75/95). `npm run pack:check`: 90 files packed (dry-run), no tarball. The
reviewer must re-run the three reproductions; this repair is not an acceptance.

### Provider probe hostile-stream hardening (2026-11-01)

- A redirect is surfaced as an HTTP failure and never followed; the second origin
  receives zero requests, so the frozen credential cannot be forwarded.
- A mid-stream disconnect fails the check, records the failure and does not hang; a
  success is never invented from partial bytes.
- An SSE event above the shared 1 MiB parser bound is rejected before it becomes a probe
  observation.
- The synthetic tool-call id must be a string of at most 200 characters with no control
  characters, and the synthetic arguments must stay within 4 KiB before parsing. Violations
  fail before any follow-up request and are not echoed into the result or store.
- Usage counts are only accepted as non-negative safe integers. Strings, negatives,
  fractions and oversized numbers stay unknown; they never become zero, a floored value or
  a complete total.

Five new deterministic cases cover the redirect, disconnect, oversized event, invalid
id/oversized arguments and malformed usage. Gate, Node 24.21.0: `npm run check` exit 0 —
**711 tests, 711 pass, 0 fail, 0 skipped**; 174 modules syntax-checked; coverage 94.19%
lines / 84.20% branches / 94.53% functions, every floor passing (`provider-probe`
92.30/82.79/97.67 against 90/75/95). `npm run pack:check`: 90 files packed (dry-run), no
tarball. This remains self-tested until the independent re-review.

### Provider probe stream-bound repair (2026-11-02)

The independent [stream-bound review](reports/2026-11-02-probe-stream-bound-review.md)
reproduced one P2: `consume()` appended every tool-argument fragment and retained every
call/finish event until stream completion, so the 4 KiB argument bound was enforced only
after unbounded accumulation. The [repair report](reports/2026-11-02-probe-stream-bound-repair.md)
records the cause and evidence.

| Finding                                            | Repair                                                                                                                                                                                                                                       | Regression                                                                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2 argument bound enforced after stream completion | `consume()` tracks bytes per call as fragments arrive, breaks before appending the first fragment that would cross 4 KiB, and lets the stream generator's `finally` cancel the reader; only one call and the last finish reason are retained | 100 open-ended SSE events with 1,024-byte fragments: the probe fails with the bound error in under 2 s of a 4 s budget, sends one request and no follow-up, and the server observes cancellation |

Gate, Node 24.21.0: `npm run check` exit 0 — **719 tests, 719 pass, 0 fail, 0 skipped**;
176 modules syntax-checked; coverage 94.20% lines / 84.20% branches / 94.59% functions,
every floor passing (`provider-probe` 92.59/82.52/100.00 against 90/75/95). This remains
self-tested; the reviewer must re-run the fragmented-stream reproduction.

### Show/update review and default-model repair (2026-11-01)

A second independent [CLI review](reports/2026-11-01-provider-cli-show-update-review.md)
reproduced one P2 in `updateProvider`: a name-only update cleared a valid `defaultModel`
whenever it was absent from the configured model list, even though the provider contract
explicitly allows an exact unlisted default (model selection must not depend on a
catalog). The branch now clears the default only when `--remove-model` names that exact
default, and a `--default-model` replacement in the same command takes precedence.
Regressions cover name, endpoint and auth updates with an unlisted default (re-resolving
the default through `resolveProviderSelection` after each), setting an unlisted exact-ID
default through the command, explicit removal of a listed default, and same-command
removal plus replacement. A real CLI subprocess regression renames a profile that has an
unlisted default and checks the receipt and the stored state.

### Check 5, full engineering check and CLI review (2026-11-01)

- [Check 5](reports/2026-11-01-provider-check-5.md) reproduced the check-4 timeout case
  and confirmed the repair: the failure persists, the prior snapshot survives, a later
  success clears it, and caller cancellation still records nothing. 70 focused tests and
  a 647-test gate passed. No new finding.
- [Full engineering verification](reports/2026-11-01-full-engineering-check.md) passed the
  engineering gate, hostile-environment suite, 16-contract offline evaluation, 32-frame
  smoke and package dry-run on both Node 22.23.4 and 24.21.0. That candidate hash covers
  647 tests, not the current CLI work. It also found `npm audit` failing with five moderate
  development-chain advisories (minimatch/ESLint chain); `npm audit --omit=dev` is clean.
  Lockfile repair remains an open, separately reviewed task.
- The [CLI review](reports/2026-11-01-provider-cli-review.md) accepted the management
  commands as delivered and found one P2: `modelsReport` omitted the staleness flag and
  the text formatter keyed only on it, so `providers models <id>` after a failed refresh
  printed the cached models with no warning. Models, list and catalog now share one
  discovery summary, and the formatter also treats `outcome: "error"` as stale. Both
  text and JSON regressions run successful refresh → failed refresh → a new CLI process
  reading the cache, and assert the warning, the retained manual models and zero
  additional requests. Show/update/replace actions remain absent from the parser and are
  future management scope.
- This repair is self-tested; the independent reviewer has not re-run the new regression.

## Interactive provider picker and session binding (2026-11-01)

- `src/provider-picker.mjs` builds one picker list from the static registry plus configured
  and discovered profile models. Each entry carries a stable `provider:<id>:<model>` key,
  the profile display name, its resolved `providerTarget`, per-entry availability and
  discovery staleness. An invalid provider file degrades to the built-in list; nothing here
  reads a key value or performs network I/O.
- The Alt+M model screen renders the combined list, marks `[CUSTOM]`/`[DISC]`, shows
  per-provider "needs key" state, and keeps the exact target when selected. `/model <query>`
  matches the provider-scoped key, exact wire ID, display name, alias or provider name. A
  custom model without a usable target or credential is reported before the run starts
  instead of silently falling back to Local Forge.
- A run started from a picker selection passes the resolved `providerTarget` to the
  controller and model agent.
- Sessions persist `{id, modelId, digest}` with no key bytes. Resume refuses a missing
  profile, a changed endpoint/auth/request digest, a model no longer in the catalog,
  `--model`, and `--offline`, with an actionable message. Legacy model-only sessions keep
  their existing behavior. Provider identity accepts the full 512-character wire-ID limit.
- Tests: picker construction/lookup/custom-target regressions, two real app-interaction
  runs (selection and exact provider request), a provider-bound resume render, session
  round-trip/mismatch/limit cases, and a real TTY CLI run refusing a changed provider and
  `--offline`. This first picker candidate was self-tested, not independently reviewed.
- Follow-up delivery (same day): see the interaction-completion section below for the TTY
  preset, explicit built-ins and exact-ID entry. `providers test` was delivered later (see
  the probe section), as was the opt-in provider evaluation (2026-11-02, see its section);
  independent review, audit and the release decision remain open.

## PRV-104 interaction completion (2026-11-01)

- `--provider <id>` now presets the TUI instead of being refused. A named profile uses
  `--model` or its own `defaultModel`; the built-in ids `matrix`, `openrouter` and `ollama`
  route through `explicitBuiltinTarget`, which refuses a cross-provider model and requires
  an exact model for remote built-ins. The preset is projected by `pickerModelFromTarget`
  and installed as the initial selection, so the first frame is already on that exact
  target. This deliberately supersedes the earlier R1 refusal guard; the legacy model
  resolver still never runs for an explicit provider.
- Built-in explicit binding freezes the provider's own endpoint and credential policy:
  OpenRouter ignores `MATRIX_API_BASE`/`MATRIX_API_KEY` redirection, Ollama uses
  `OLLAMA_HOST` and its documented placeholder key, and a missing OpenRouter key fails
  before any network activity. Custom profiles keep the catalog/digest path.
- `e` in the model picker opens exact-ID entry for the selected provider. It accepts any
  valid wire ID, including one absent from the configured model list, and resolves the
  same custom target the headless CLI uses. Invalid IDs and missing keys stay visible in
  the picker instead of falling back to Local Forge.
- Tests: picker projection for presets/manual IDs, explicit built-in resolver precedence
  and refusal cases, built-in endpoint/key isolation, a preset render without the picker,
  a manual exact-ID app run that approves a proposed patch, verifies 4 passing tests and
  asserts both provider rounds carry the exact model, a real PTY launch of
  `matrix --provider lab` that renders the preset and exits without the old resolver, and
  headless `--provider local`/`--provider ollama` runs (the latter against loopback with
  `MATRIX_API_BASE` set to a decoy to prove the explicit endpoint wins). The headless local
  run also repaired a crash where a local resolved target was dereferenced as custom.
  Gate, Node 24.21.0: `npm run check` exit 0 — **682 tests, 682 pass, 0 fail, 0 skipped**;
  172 modules syntax-checked; coverage 94.19% lines / 84.11% branches / 94.43% functions,
  every floor passing. `npm run pack:check`: 89 files packed (dry-run), no tarball.
- `providers test <id> --model <exact-id> [--checks text,tools] [--json]` now runs the
  opt-in synthetic probe. `text` observes stream completion; `tools` requires a
  schema-valid no-op call and a completed response to its tool result. Retries are
  disabled, so the three-request cap is exact; a 30-second deadline covers the whole
  invocation. Records are bounded and private, keyed by provider/model/configuration
  digest, and caller cancellation writes nothing. A profile endpoint/auth/request change
  makes prior records unreadable rather than displaying stale badges. Unit cases cover
  pass/fail/not-evaluated, ignored and malformed tools, HTTP failure with zero retries,
  cancellation, the deadline, eviction at 256 models, symlink refusal and a built-in
  target; a real CLI subprocess case covers text+tool pass, JSON output and a failing
  endpoint.
- Not delivered at that point: PRV-105 evaluation selection (delivered 2026-11-02 below),
  PRV-106 adversarial audit and PRV-107 release decision. The probe review's P1/P2 findings
  are repaired above; an independent re-review of this repaired candidate is still required.

## PRV-104 picker/resume review repairs (2026-11-01)

An independent picker/resume review reproduced three defects on the 682-test candidate and
returned **CHANGES REQUIRED**. Each is repaired at cause; runtime files were otherwise left
as reviewed.

| Finding                                         | Repair                                                                                                                                                                                                         | Regression                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remote wire model named `local` ran Local Forge | The controller routes an explicit non-local target to the model agent before the legacy `model.id === "local"` heuristic                                                                                       | Real controller run against a loopback profile serving `local`: one request to `/v1/chat/completions` with `model: "local"`, no Local Forge result |
| Built-in identities were discarded on resume    | `sessionProviderIdentity` persists explicit built-in provider/model with a fixed `builtinSessionDigest`; validation checks that digest and re-resolves the exact model without requiring profile configuration | Save/load/validate for arbitrary OpenRouter and raw Ollama IDs, plus UI resume rendering both without Local Forge                                  |
| Manual uncatalogued models could not resume     | Validation re-resolves the exact saved model against the unchanged profile instead of requiring catalog membership; the TUI rebuilds the picker selection from the saved provider target                       | Session validation with an empty catalog and UI resume of an unlisted manual model                                                                 |

A real PTY `--resume` test also restores an arbitrary OpenRouter ID from the saved sidecar.
Gate, Node 24.21.0: `npm run check` exit 0 — **688 tests, 688 pass, 0 fail, 0 skipped**;
172 modules syntax-checked; coverage 94.19% lines / 84.17% branches / 94.43% functions,
every floor passing. `npm run pack:check`: 89 files packed (dry-run), no tarball.
Self-tested only; the reviewer must re-run the three reproductions.

## PRV-105 opt-in provider evaluation (2026-11-02)

- `eval/provider-eval.mjs` is a separate explicit opt-in path, not a new profile in
  `eval/run.mjs`. It requires `--provider <id>` and `--model <exact-id>`, resolves the same
  validated target as normal execution, and runs one deterministic coding task through the
  real controller/model agent against that exact target. No repository contents are sent
  and shell/command tools stay disabled.
- The temporary workspace contains a buggy `src/bounds.js`, its test and `package.json`.
  Approvals are scoped to that disposable copy. Preflight rejects an unknown profile, a
  local/Local Forge selection and a missing credential before any request; a 60-second
  watchdog aborts. Task success requires the exact edited bytes, a passing verification
  through the separate test-approval path (auto-approved only inside the disposable copy),
  an `ok` outcome and confirmed workspace removal. Prose-only output remains a failed task
  even when the agent outcome is `success`.
- The report separates `target`, `edit`, `test`, `verification` and `cleanup` as
  pass/fail/not evaluated. The `test` check compares the final test-file bytes and rejects
  any applied edit to that file, including an edit later reverted; a weakened assertion
  cannot produce task success even when its verification passes. The report records
  provider/model/config identity and digest, endpoint, auth type and env-var name (never
  the value), task revision/digest, runtime, network class, outcome, verification,
  rounds/tool calls, finish reason, usage provenance and null unknown cost. Writes go to
  gitignored `eval/reports/provider.json`/`.txt`; the reviewed default baseline is never
  touched. `--json` prints the same report.
- The binding produced by the preflight is passed through the controller and model agent as
  `providerBinding`; execution uses that exact credential and endpoint instead of
  rebinding `process.env`. Callers that omit it keep the existing one-bind-per-run
  behavior.
- Tests: seven cases (six against a loopback fake provider) cover a full
  edit/approval/write/test run, a weakened-test rejection, explicit-credential execution,
  a prose-only non-success, an HTTP 503 reported honestly with cleanup, a real CLI
  subprocess that writes and redacts its report, and strict argument parsing. Canary and
  temporary absolute paths are asserted absent from serialized output.
- Gate, Node 24.21.0: `npm run check` exit 0 — **719 tests, 719 pass, 0 fail, 0 skipped**;
  `node --test test/provider-eval.test.mjs` 7/7 pass; 176 modules syntax-checked; coverage
  94.20% lines / 84.20% branches / 94.59% functions, every floor passing. `npm run eval`:
  16/16 contract pass, baseline PASS, 0 safety violations, cleanup complete. `npm run
pack:check`: 90 files packed (dry-run), no tarball.
- No live/paid provider was called. The evidence class is `opt-in-provider`; one run is not
  availability, quality, pricing, context-length or latency evidence. PRV-105 remains
  SUBMITTED, its dependencies remain unaccepted, and independent review is required. See
  the [initial report](reports/2026-11-02-provider-eval.md) and the
  [P1/P2 repair report](reports/2026-11-02-provider-eval-review-repairs.md).

## PRV-105 package/test-runner integrity repair (2026-11-02)

The independent [evaluation recheck](reports/2026-11-02-provider-eval-recheck.md) found the
previous repair incomplete: the evaluator approved every edit and trusted the workspace's
`npm test` command. A model could replace the `package.json` test script with a command that
printed a fake pass summary while leaving `test/bounds.test.mjs` untouched, and the report said
`taskSuccess: true` even though the original regression never ran.

- The approval gate now approves only the exact task source `src/bounds.js`. Every other
  proposal is denied with `n`, recorded in `deniedPaths`, and fails the new `scope` check. An
  unknown or escaping path is denied too.
- The `test` check still requires byte-identical test bytes and rejects an applied test edit. A
  new `package` check requires byte-identical `package.json` and rejects an applied package edit.
- `authoritativeVerification` independently runs `node --test test/bounds.test.mjs` in a fresh
  directory built from the original fixture test/package bytes and the final source bytes. It
  removes inherited `NODE_TEST_CONTEXT`/`NODE_OPTIONS`/`NODE_V8_COVERAGE` so a nested runner
  cannot silently skip files or write coverage, and it never uses the workspace's package script.
- `checks.verification` passes only when the run's own verification and the independent fixture
  verification both pass. `taskSuccess`/`ok` require `edit`, `test`, `package`, `scope`,
  `verification` and `cleanup`.
- The report adds `authoritativeVerification`, `package`, `scope` and `deniedPaths`; the text
  report prints all of them.

Regression: a loopback provider proposes a `package.json` test-script substitution, then applies
the correct source edit and finishes. The package edit is denied, the package/test bytes stay
intact, the run's own verification and the authoritative fixture run both pass, and the report
still records `scope: fail`, `taskSuccess: false` and `ok: false`. A second regression denies a
test-file edit; a third proves the authoritative run ignores replaced workspace runner files.
Gate, Node 24.21.0: `node --test test/provider-eval.test.mjs` 9/9 pass;
`npm run check` exit 0 — **721 tests, 721 pass, 0 fail, 0 skipped**; 176 modules
syntax-checked; coverage 94.20% lines / 84.19% branches / 94.59% functions, every floor
passing; `npm run eval` 16/16 contract pass, baseline PASS; `npm run pack:check` 90 files,
no tarball. This is self-tested; the independent reviewer must reproduce the package-script
case. See the [repair report](reports/2026-11-02-provider-eval-package-repair.md).

## Audit log

| Date       | Candidate                                      | Reviewer                                         | Verdict                           | Follow-up                                                                                               |
| ---------- | ---------------------------------------------- | ------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 2026-10-29 | Planning package against e1b3c66               | Chief planning self-review                       | Prepared for PRV-101 dispatch     | All runtime/provider compatibility acceptance pending                                                   |
| 2026-10-30 | PRV-101 candidate (working tree, base e1b3c66) | Chief self-review, not independent               | SUBMITTED                         | 598 tests pass, 0 fail/skip; check exit 0; Node 24 only. Independent PRV-106-style reproduction pending |
| 2026-10-30 | PRV-102 candidate (working tree, base e1b3c66) | Owner-directed gate exception; chief self-review | SUBMITTED, not accepted           | 11 transport + 20 legacy tests pass; full gate below. PRV-101 independent review still outstanding      |
| 2026-10-30 | PRV-103 + partial PRV-104 candidate            | Owner-directed gate exception; chief self-review | SUBMITTED / PARTIAL, not accepted | 8 new tests pass; UI, session binding, probes, audit and release decision remain open                   |
| 2026-11-01 | PRV-101–104 candidate (617 tests)              | Independent review                               | CHANGES REQUIRED (R1–R5)          | All five reproduced against the candidate; see the review report                                        |
| 2026-11-01 | Repaired candidate (634 tests)                 | Chief self-review, not independent               | SUBMITTED, not accepted           | R1–R5 fixed at cause with regressions; independent re-review required                                   |
| 2026-11-01 | Repaired candidate (634 tests)                 | Independent re-review                            | CHANGES REQUIRED (RR1–RR3)        | Shared-file alias lock, header truncation and FIFO cache reproduced                                     |
| 2026-11-01 | Repaired candidate (640 tests)                 | Chief self-review, not independent               | SUBMITTED, not accepted           | RR1–RR3 fixed at cause; independent re-review required                                                  |
| 2026-11-01 | Repaired candidate (640 tests)                 | Independent review 3                             | CHANGES REQUIRED (D1–D2)          | Caller cancellation and catalog freshness reproduced; earlier repros pass                               |
| 2026-11-01 | Repaired candidate (645 tests)                 | Chief self-review, not independent               | SUBMITTED, not accepted           | D1–D2 fixed at cause; independent re-review required                                                    |
| 2026-11-01 | Repaired candidate (645 tests)                 | Independent check 4                              | CHANGES REQUIRED (timeout status) | D1 and HTTP-failure D2 pass; timeout path rebuilt the catalog as fresh                                  |
| 2026-11-01 | Repaired candidate (647 tests)                 | Chief self-review, not independent               | SUBMITTED, not accepted           | Timeout now records failure status; independent re-review required                                      |
| 2026-11-01 | Repaired candidate (647 tests)                 | Independent check 5                              | PASS, no new findings             | Timeout persistence confirmed; phase still incomplete                                                   |
| 2026-11-01 | Candidate `8ccc334a…` (647 tests)              | Independent full engineering check               | PASS on Node 22/24; audit fails   | 5 moderate dev-chain advisories; production audit clean; not the CLI candidate                          |
| 2026-11-01 | Provider CLI candidate (656 tests)             | Independent CLI review                           | CHANGES REQUIRED (cached stale)   | Cached `models` read hid the failed refresh                                                             |
| 2026-11-01 | Provider CLI repair (656 tests)                | Chief self-review, not independent               | SUBMITTED, not accepted           | Shared discovery summary plus real text/JSON CLI regression; re-review required                         |
| 2026-11-01 | Provider CLI show/update (660 tests)           | Chief self-implementation, not independent       | SUBMITTED, not accepted           | Show/update actions with digest-safe writes; independent re-review required                             |
| 2026-11-01 | Provider CLI show/update (660 tests)           | Independent show/update review                   | CHANGES REQUIRED (default erased) | Name-only update cleared an unlisted valid default; reproduced through the CLI                          |
| 2026-11-01 | Provider CLI default repair (662 tests)        | Chief self-review, not independent               | SUBMITTED, not accepted           | Default preserved unless explicitly removed; independent re-review required                             |
| 2026-11-01 | Provider picker/session candidate (675 tests)  | Chief self-implementation, not independent       | SUBMITTED, not accepted           | Picker, exact target and digest-bound resume; independent review required                               |
| 2026-11-01 | PRV-104 interaction candidate (682 tests)      | Chief self-implementation, not independent       | SUBMITTED, not accepted           | TTY preset, explicit built-ins and exact-ID entry; independent review required                          |
| 2026-11-01 | PRV-104 interaction candidate (682 tests)      | Independent picker/resume review                 | CHANGES REQUIRED (3 defects)      | Remote `local`, built-in resume identity and uncatalogued manual resume reproduced                      |
| 2026-11-01 | Picker/resume repair candidate (688 tests)     | Chief self-implementation, not independent       | SUBMITTED, not accepted           | All three defects repaired at cause with regressions; re-review required                                |
| 2026-11-02 | PRV-105 opt-in eval candidate (716 tests)      | Chief self-implementation, not independent       | SUBMITTED, not accepted           | 5 provider-eval tests and a fake-provider CLI run; default eval unchanged; independent review required  |
| 2026-11-02 | Probe stream-bound repair (717 tests)          | Chief self-implementation, not independent       | SUBMITTED, not accepted           | P2 early argument-bound termination and reader cancellation regression; re-review required              |
| 2026-11-02 | PRV-105 eval review repairs (719 tests)        | Chief self-implementation, not independent       | SUBMITTED, not accepted           | Weakened-test rejection and preflight credential binding; re-review required                            |
| 2026-11-02 | PRV-105 package/test-runner repair (721 tests) | Chief self-implementation, not independent       | SUBMITTED, not accepted           | Non-source edits denied; package/test bytes protected; authoritative fixture verification               |

## Historical baseline

At `e1b3c66`, prior checks passed 574 tests with no skips on Node 22.23.4 and 24.21.0,
16 evaluation contracts, 32 render smoke checks and the 81-file package check. These are
pre-phase results, not new provider evidence. Hosted CI and live model capability have
not been established by this board.

Re-run on 2026-10-30 before any edit, Node 24.21.0: `npm run check` exit 0, 574 tests,
574 pass, 0 fail, 0 skipped; coverage 93.99% lines / 83.62% branches / 94.15% functions;
155 modules syntax-checked. The planned 574-test figure was therefore accurate on this host.
PRV-101 candidate evidence is recorded in [decisions/PRV-101.md](decisions/PRV-101.md) and
in the candidate section below, not in this historical paragraph.

## PRV-101 candidate evidence (2026-10-30)

- `node --test test/provider-contracts.test.mjs test/provider-config.test.mjs`: 24 passed,
  0 failed, 0 skipped. Covers schema limits, reserved IDs, exact wire IDs, URL/auth rules,
  digest stability, precedence, secret canaries, private atomic writes, stale-digest refusal,
  corrupt/symlink/oversized files, live-lock blocking, dead-PID and crash recovery, and two
  concurrent writer processes.
- `npm run check` on the candidate, Node 24.21.0: exit 0; 598 tests, 598 pass, 0 fail,
  0 skipped; 159 modules syntax-checked; coverage 93.95% lines / 83.62% branches /
  94.46% functions. New ratcheted floors pass: `provider-config` 88.64/75.59/100.00 vs
  85/70/95 and `provider-contracts` 96.51/88.07/100.00 vs 95/85/100.
- Manual library demo on a temporary home: `${MATRIX_HOME}/providers.json` creation,
  `https://inference.example/team/v1/` normalized to `.../team/v1`, exact
  `vendor/Model-X:latest` identity preserved, 64-hex target digest, availability true/false
  by environment, key resolved privately, and no key bytes in the descriptor or file.
- `npm run pack:check`: 83 files packed (dry-run), posture verified, no tarball created.
- TypeScript `checkJs` now includes both new modules (clean). Coverage floors were added for
  both: `provider-config` 85/70/95 and `provider-contracts` 95/85/100 (line/branch/functions).
- Host coverage: only Node 24.21.0 is installed on this machine; the Node 22 line was not
  re-run for this candidate. That is a limitation of the current evidence, not a pass.
- Not done and not claimed: any CLI, UI, session, transport or catalog wiring; live inference;
  independent adversarial reproduction. Those belong to PRV-102 through PRV-107.

## PRV-103 / partial PRV-104 candidate evidence (2026-10-30)

- `lib/provider-catalog.mjs` exposes one read-only catalog for built-ins and configured
  profiles, availability per profile (built-ins stay `null`, Local Forge stays true), exact
  tuple lookup, grouping and an invalid-config diagnostic that keeps Local Forge usable.
- `lib/provider-discovery.mjs` performs an explicit `/models` GET with that profile's own
  base URL and auth, refuses redirects, bounds the body to 1 MiB / 1,000 entries / 15 s,
  writes a private per-profile cache keyed by the configuration digest, and returns the last
  snapshot as stale on failure. Manual models never depend on it; configured metadata wins.
- `node --test test/provider-catalog.test.mjs`: 6 passed, 0 failed, 0 skipped. Covers catalog
  availability, invalid-file diagnostic, authenticated discovery with duplicate/invalid IDs,
  private cache, stale failure behavior, redirect refusal, digest invalidation.
- Partial PRV-104: `--provider` parses and validates; headless runs resolve the target, fail
  on a missing key or declared-unsupported tools before fetching, route through
  `streamProviderChat`, and keep the legacy adapter untouched. `node --test
test/provider-integration.test.mjs`: 2 passed against a real loopback server, including a
  complete model-agent run with exact path, bearer key, exact model ID and tools payload.
- `npm run check` on the combined candidate, Node 24.21.0: exit 0; 617 tests, 617 pass,
  0 fail, 0 skipped; 165 modules syntax-checked; coverage 93.86% lines / 83.51% branches /
  94.45% functions. New floors pass: `provider-catalog` 100.00/78.95/100.00 vs 100/75/100
  and `provider-discovery` 88.06/70.51/88.24 vs 85/68/85.
- `npm run pack:check`: 86 files packed (dry-run), no tarball created.
- **Not delivered:** TUI provider selection/picker, session provider/digest persistence and
  mismatch repair, doctor/help output, `providers add/list/models/test` CLI subcommands,
  probes (PRV-105), independent audit (PRV-106) and the integrated release decision
  (PRV-107). The TUI explicitly refuses `--provider` rather than ignoring it, and the phase
  is **not** complete.

## PRV-102 candidate evidence (2026-10-30, owner-directed gate exception)

The owner directed work to continue while PRV-101 remains SUBMITTED. PRV-102 is **not**
accepted, and this exception does not establish that PRV-101 passed independent review.

- `lib/provider-transport.mjs` builds one frozen endpoint/payload/credential decision per run
  and delegates to the existing SSE parser, retry and deadline core. `streamOpenRouter` remains
  the legacy adapter with its original payload, headers and error text.
- `node --test test/provider-transport.test.mjs`: 11 passed, 0 failed, 0 skipped against real
  loopback HTTP servers. Covers two profiles sharing one exact wire model with distinct
  endpoints/keys, closed payload shape, `max_completion_tokens`, optional usage request,
  auth-none, redirect refusal with zero destination requests, missing-key-before-network,
  echoed-key redaction, cancellation, built-in refusal, target validation and optional
  payload fields.
- `node --test test/openrouter.test.mjs`: 20 passed, 0 failed after the core extraction.
- `npm run check` on the candidate, Node 24.21.0: exit 0; 609 tests, 609 pass, 0 fail,
  0 skipped; 161 modules syntax-checked; coverage 93.99% lines / 83.68% branches /
  94.48% functions; `provider-transport` 100.00/93.75/100.00 against a 90/80/95 floor.
- `npm run pack:check`: 84 files packed (dry-run), no tarball created.
- Deliberate compatibility note: redirects are now refused by the shared core, so the legacy
  OpenRouter adapter no longer follows 3xx either. This is intentional credential hardening;
  all 20 legacy streaming tests still pass. Built-in explicit-selection endpoint isolation is
  not wired here and remains PRV-104 work.
- Not done and not claimed: model-agent/controller/CLI/UI/session wiring, catalog or discovery,
  live provider inference, probes, and independent adversarial reproduction.

## Next handoff

PRV-101, PRV-102 and PRV-103 are SUBMITTED, and PRV-104 is PARTIAL. The 2026-11-01
reviews found R1–R5, RR1–RR3 and D1–D2, check 4 found the timeout status path, the first
CLI review found the cached-stale projection, and the show/update review found the
unlisted-default erasure; every reproduction is repaired with a regression case, but a
repair submission is not an acceptance. An independent reviewer must re-run
the lock (including aliased homes), secret-boundary (including headers and error codes),
isolation, catalog, cache-entry and CLI evidence on the repaired candidate before the
chief releases the remaining phase; the chief's own self-review cannot satisfy that gate.
The picker, digest-bound resume, TTY preset, explicit built-ins, exact-ID entry, profile
replacement and the `providers test` probe are implemented; an independent reviewer must
still check their target identity, availability, refusal and retention paths. The PRV-105
opt-in provider evaluation is SUBMITTED; independent re-review, the PRV-106 adversarial
audit and PRV-107 integration are still open. A development dependency override
resolved the five reported advisories, but its major-version compatibility still
needs independent review. **The dynamic-provider phase is not complete.**
Record actual ownership and evidence as work occurs. Do not prefill future success.
