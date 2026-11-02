# Chief audit and evaluation protocol

This protocol determines acceptance. It is not a record of successful future tests.
Implementation self-review is required, but it does not replace an independent audit.

Use [REVIEW_METHOD.md](REVIEW_METHOD.md) for the concrete review procedure,
Matrix-specific counterexamples, tool choices and submission requirements.

The submission packet, evidence classes and chief review rules apply to both phases.
The crash matrix below belongs to the deferred durable phase. Active provider work uses
[PROVIDER_AUDIT.md](PROVIDER_AUDIT.md) as its mandatory acceptance matrix.

## Evidence classes

| Class                        | What it establishes                                            | What it cannot establish                                           |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Unit/contract                | Deterministic API, transition and error behavior               | Full process recovery or real model quality                        |
| Mocked remote                | Provider protocol, policy, context and lifecycle behavior      | Whether a real model solves an unfamiliar issue                    |
| Real local subprocess        | Actual writes, process starts, kill/restart, locks and cleanup | Physical power-loss durability or remote service behavior          |
| Real repository + live model | Observed task performance under recorded settings              | Universal correctness, superiority or future provider availability |
| Independent patch review     | Requirement alignment and unintended behavior assessment       | Formal proof of all possible behavior                              |

Keep these classes separate in reports. A successful mocked failure-path test means its
contract passed; it does not mean the simulated coding task was completed.

## Mandatory crash and adversarial matrix

All cases use temporary workspaces and `MATRIX_HOME`. Fake provider keys and synthetic
secret canaries only. Never mutate the checked-in demo or use the user's repositories as
destructive test fixtures. Record before/after inventory, content hashes, modes and symlinks.

| ID    | Injection / scenario                                                               | Required observation                                                                                                     |
| ----- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CR-01 | Kill during provider streaming, before a validated response                        | No partial tool action dispatched; uncertain usage remains accounted; fresh request has valid context                    |
| CR-02 | Crash before intent sync, during append, or before checkpoint rename               | No effect starts from uncommitted intent; reopen uses a verified state or refuses                                        |
| CR-03 | Crash after durable edit intent but before file write                              | Current before image preserved; no silent write on inspection/resume without fresh authority                             |
| CR-04 | Crash after atomic file rename but before receipt sync                             | New process recognizes after image, reconstructs undo and does not apply the same operation twice                        |
| CR-05 | Two files, one applied and one pending                                             | Exact partial state reported; applied file retained; pending action requires valid current authority                     |
| CR-06 | Same file edited twice, crash at second edit                                       | Original pre-goal bytes remain recoverable; current image reconciles against ordered operation history                   |
| CR-07 | Pending or granted approval at process death                                       | Old decision/token cannot authorize a new operation or generation; denied work remains denied                            |
| CR-08 | Kill during tests with child/grandchild processes                                  | No false test success; old owned processes are verified stopped or resume refuses; no duplicate test                     |
| CR-09 | Completed test, then source mutation or missing final receipt                      | Evidence is stale/uncertain; completion cannot use it as current verification                                            |
| CR-10 | Truncated tail, corrupt interior, sequence gap, unsupported schema                 | Distinguish provably uncommitted tail from damaged committed data; preserve artifacts and refuse unsafe execution        |
| CR-11 | Disk full, denied permissions, partial write, sync/rename failure                  | New effects stop; pending recovery remains; UI cannot claim durable success                                              |
| CR-12 | Two processes resume/start the same workspace/goal                                 | Exactly one writer owns dispatch; the loser performs no effects or authority grants                                      |
| CR-13 | Supervisor/worker death, stale lock and PID reuse                                  | No lock theft while an owner survives; no arbitrary PID kill; reclaim only under the proven ownership rule               |
| CR-14 | Workspace/parent replaced, leaf symlink, mode/type change, FIFO or oversized state | Refusal is bounded and nonblocking; outside sentinels untouched; exact recovery state retained                           |
| CR-15 | Crash/restart at budget reservation and completion boundaries                      | Counters do not reset or undercount; uncertain calls retain reservations; no action beyond the cap                       |
| CR-16 | Cancel races approval, dispatch or completion; late callback from old attempt      | No new action after the dispatch cutoff; already dispatched effects reconciled; stale events cannot mutate current state |
| CR-17 | Repeated identical failure; then a separate case with changed code/diagnostics     | Stalled loop stops with explanation; meaningful bounded progress remains possible                                        |
| CR-18 | Quota/retention pressure with active and completed goals                           | No referenced undo/intent data pruned; new work refuses before exceeding capacity; cleanup is scoped                     |
| CR-19 | Missing/corrupted backup; CRLF, no-final-newline, empty original, creation         | Restore exact bytes or refuse; never replace valid files with unverified backup content                                  |
| CR-20 | Repository/tool/checkpoint text asks to change criteria, budget or approvals       | Content remains untrusted data; policy unchanged; fake success text cannot complete the goal                             |

For CR-04 also inspect modification events/dispatch counts, not just final bytes: applying
the same bytes twice can hide duplicate execution. For CR-08 inspect process ownership,
not merely the immediate parent's exit. For CR-10 prove no symlink/FIFO is followed by
recovery reads. For CR-14 include ordinary goal edits and existing integration recovery.
For CR-16 test both sides of the dispatch boundary with deterministic barriers.

The minimum mandatory matrix covers existing-file edits and creations. Unsupported future
delete/rename/command effects must be rejected before dispatch, not left outside the test report.
Any future capability adds its own operation-kind cases before exposure to models.

## Tests that demonstrate actual behavior

- Kill a spawned Node executor, then start a new Node process against its retained state.
  Throwing an exception in the same process is an additional test, not a crash substitute.
- Place explicit test-only barriers at journal/effect boundaries. Wait for barrier acknowledgement
  before injecting failure; do not use arbitrary sleeps to guess when a write happened.
- Verify recovery by reading actual files and state, then exercising the next permitted action.
- Use sanitized outgoing mocked-provider requests to detect canary leakage and invalid tool context.
- Measure test command dispatch with an external sentinel/audit rather than a success-shaped mock.
- Assert clean shutdown of all owned processes, temporary mounts/worktrees and descriptors.
  If cleanup fails, retain a discoverable record and fail the case.
- Test observer/render failures independently: they cannot create authority, erase undo or turn
  an unknown result into success. Test storage failures separately from observer failures.
- Never reduce coverage thresholds or rewrite baseline expectations merely to make a patch pass.

## Submission packet for every agent

Use this structure in a task-specific report under `docs/next-phase/submissions/`:

```text
Task ID and owner:
Base revision and candidate revision/patch SHA-256:
Checkout and reserved files:
Problem and resulting behavior:
Design decisions / approved interface revision:
Files changed and why:
Acceptance criteria -> test/evidence mapping:
Commands, runtime versions, exit codes, pass/fail/skip counts:
Crash barriers, seeds and exact reproduction commands:
Observed filesystem/process/provider effects:
Compatibility and migration behavior:
Security/privacy/resource-limit observations:
Known failures, limitations and NOT EVALUATED items:
Cleanup results:
Requested review verdict:
```

Logs must be available locally or as an explicitly attached sanitized artifact. Do not
commit raw transcripts, source-containing recovery blobs, credentials, huge test logs or
machine-specific temporary paths as permanent fixtures. Never claim a command was run
unless its actual output and exit status were observed. A test command proposed for later
execution must be labeled proposed. Uncommitted work uses a reproducible patch digest and
lists untracked files; a Git HEAD alone does not identify that candidate.

## Chief review procedure

1. **Identify candidate.** Check base revision, actual diff/untracked files, ownership conflicts
   and dependencies. Stop integration if another active agent owns the same files.
2. **Inspect correctness.** Follow every path from model input or resume request to authority,
   durable reservation/intent, effect, receipt and public outcome. Verify error paths too.
3. **Inspect recovery.** Independently reproduce at least one before-effect crash, one
   after-effect/before-receipt crash, partial multi-file work, stale approval and corrupt backup.
4. **Inspect containment and concurrency.** Reproduce root/parent changes and writer contention;
   inspect process ownership and cancellation. Do not infer safety from atomic rename alone.
5. **Inspect evidence quality.** Read assertions, not just test names. Check that independent
   expected values cannot be copied from the implementation under test. Review missing cases.
6. **Check compatibility.** Ordinary Local Forge, remote mocked loop, current undo/session paths,
   command opt-in, parallel integration and headless deny-by-default must remain functional.
7. **Run integrated gates.** Use the exact candidate and report failures honestly.
8. **Issue verdict.** ACCEPTED, CHANGES REQUIRED, or NOT EVALUATED. Name concrete findings,
   severity, source lines, trigger, impact, requested fix and acceptance proof.

No P0/P1 finding may be waived for this milestone. An unmet mandatory acceptance criterion
also blocks acceptance regardless of severity label. A minor unrelated issue can be recorded
as follow-on only if the chief explains why it does not weaken the milestone contract.
Any material fix invalidates affected prior evidence and requires a new candidate review.

## Exact-candidate verification

First run focused tests for the changed layer. The integrator runs the following gates
serially where they start process/sandbox-heavy suites, to avoid exhausting Linux namespaces:

```sh
npm run check
npm run eval
npm run smoke
npm run pack:check
git diff --check
```

Repeat `npm run check` under supported Node 22 and Node 24 using documented executable
paths for the current machine, not assumed temporary paths from an old chat. The chief
must wire a separate durability-profile command after reviewing QA-101; its intended role
is `node eval/durability/run.mjs`, but that command does not exist at planning time.
Run all CR cases through that reviewed harness. Existing evaluation baselines remain unchanged
unless a deliberate contract change receives separate review. New profiles need their own
schema/fixture identities and reviewed baseline, not an overwrite of the original 16 cases.

Run `npm run bench` before/after relevant indexing/rendering changes and compare on the same
machine with the same load/settings. Measure journal bytes and checkpoint/recovery latency
at empty, typical and near-limit sizes; freeze any thresholds only after recording the baseline.
Do not publish invented latency/SLA numbers. A storage operation that blocks the UI noticeably
requires investigation even when its unit tests pass.

If shared configs or dependencies change, verify a fresh lockfile install in a disposable
checkout and run the audit/package checks. For a release candidate, follow RELEASE.md,
including fresh hosted Node 22/24 CI. Local green checks do not satisfy hosted-CI evidence.
Do not install dependencies into or mutate the user's demo as part of evaluation.

## Capability evaluation and advancement

EVAL-101's initial candidate set is a proposed 30 tasks across at least five pinned repositories.
Freeze the split, task criteria and settings before comparing implementations. Report:

- completed correctly / attempted, and separately failed, cancelled and not evaluated;
- pass rate of task-specific acceptance checks plus broader regressions;
- independent final-diff findings and unresolved behavior questions;
- human interventions and reasons, including approval requests separately from rescue actions;
- elapsed time, provider attempts, tokens and actual/estimated/unavailable cost provenance;
- replayed effects, unsafe actions, stale-verification successes and process/fixture leaks.

Use paired before/after results, identical model settings and comparable budgets. If multiple
runs are used, predeclare run count and report all results rather than selecting the best.
Thirty tasks are an initial engineering sample, not proof of universal superiority. A withheld
test suite and human patch inspection remain necessary: passing tests can still admit an
incorrect patch. See the [empirical SWE-bench patch study](https://arxiv.org/abs/2503.15223).

Durability advancement requires every mandatory CR case passing with no unsafe action,
duplicate effect, stale-authority execution or cleanup leak in the tested scenarios.
Live capability improvement is a separate claim requiring actual paired live evidence.
If no such runs were authorized/performed, report "durability accepted; capability improvement
not evaluated". Do not represent the 574 engineering tests as 574 coding tasks solved.

## Handoff and ongoing audit

Agents submit reports and patches to the chief through the project's approved collaboration
channel. An assignment does not authorize sending messages to unrelated chats or external services.
The chief reviews each submission when it arrives or when asked; this document does not create
an unattended monitoring service. Use STATUS.md to make the next unblocked assignment obvious.
Keep the original failing reproduction with the fix so later agents cannot regress it silently.
