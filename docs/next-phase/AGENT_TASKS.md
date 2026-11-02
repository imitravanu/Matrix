# Agent assignments

> Deferred durable-execution phase. Implement PRV-101 through PRV-107 first.
> See [NEXT_PHASE.md](../../NEXT_PHASE.md) and [STATUS.md](STATUS.md) for current dispatch.

All tasks below are unimplemented at planning baseline `e1b3c66`. Claim exactly one.
Read `../../NEXT_PHASE.md`, `ARCHITECTURE.md`, `AUDIT.md` and `STATUS.md` first.
Paths in this document are repository-relative. New modules are proposed ownership
boundaries; changing them requires updating the interface map before another agent depends on them.

## Common execution contract

1. Record task ID, checkout, base revision and owned files. Inspect local changes first.
2. Read the existing implementation named in your assignment. List compatibility risks.
3. Write acceptance tests or a minimal executable characterization before changing behavior.
4. Implement the smallest coherent layer. Keep fake providers, clocks and filesystem failures
   injectable at explicit test boundaries; production cannot select test-only authorities.
5. Observe the evidence specified below. Do not judge success from UI text or mock call counts alone.
6. Run focused tests, then the required repository gates. Include failures and skipped tests.
7. Submit an evidence packet using AUDIT.md. Mark SUBMITTED, never ACCEPTED.
8. Leave unrelated files, dependencies and Git history untouched. No commit/push unless authorized.

If you discover a contract ambiguity, submit a concrete proposed decision, its alternatives,
tradeoffs and a small proof. Continue independent tests/design while awaiting chief review.
Do not silently change a shared API, hide a failure with an increased timeout, weaken a
coverage floor, regenerate a baseline, or add success predicates outside the existing outcome model.

## DUR-001 — schemas, state machine and writer-lock proof

**Owner:** runtime-contract implementer. **Dependencies:** none. **Initial status:** READY.

**Own:** proposed `lib/goal-contracts.mjs`, `test/goal-contracts.test.mjs`,
`test/goal-lock-spike.test.mjs`, and `docs/next-phase/decisions/DUR-001.md`.
The chief applies any approved changes to shared `lib/contracts.mjs` and tool configuration.
Do not refactor the controller in this task.

**Read:** `lib/contracts.mjs`, `lib/outcome.mjs`, `lib/controller.mjs`,
`lib/parallel-approvals.mjs`, `lib/process.mjs`, `lib/test-policy.mjs`,
`lib/cli.mjs`, `src/session-codec.mjs`, and ARCHITECTURE.md.

**Do / how:**

1. Specify goal/attempt/operation identifiers, versions, state transitions, typed criteria,
   budget reservations, event types, serialization and public result shapes. Provide a
   transition table including forbidden transitions and mapping to existing outcomes.
2. Define interfaces for store, reconciler, executor, policy bridge and UI adapter. Include
   who owns each write, what can throw, how errors are represented and cancellation order.
3. Freeze limits, CLI grammar, exit codes and invalid-input behavior. Preserve ordinary CLI
   parsing and headless edit/test authorization semantics.
4. Implement the Linux lock spike described in ARCHITECTURE.md. Two independent Node
   processes must contend on the same workspace. Exercise supervisor death, worker death,
   inherited children, stale ownership and root replacement. Prove how legacy writers join.
5. Record the selected lock/process ownership design with runnable commands and observed
   process/descriptor behavior. Explain unavailable-capability refusal. A speculative design
   is insufficient; the chief must see the proof before dependent agents code against it.

**Observe:** actual process starts, lock ownership across death, filesystem effects, state
transitions, and generation fencing. Count any action by a rejected second writer as a failure.

**Evaluate:** table-driven legal/illegal transitions; JSON round trips; invalid versions,
IDs, paths, NaN/Infinity, duplicate IDs; stale events; two-writer subprocess tests. Report
which guarantees were tested and which require the full executor. No mocked OS lock acceptance.

**Deliver:** contract module, tests, interface table and decision record. **Accept only if:**
no unresolved ownership, authority, interruption or budget-accounting decision blocks DUR-002–005.

## EVAL-101 — real-task evaluation protocol and initial baseline

**Owner:** evaluation implementer. **Dependencies:** none. **Initial status:** READY.

**Own:** proposed `eval/capability/` and `test/capability-protocol.test.mjs`.
Existing `eval/baselines/`, `eval/cases.mjs` and fixture versions are reserved; do not rewrite them.
Shared scripts/CI changes go through the chief.

**Read:** `eval/README.md`, `eval/runner.mjs`, `eval/isolation.mjs`, `eval/provider.mjs`,
`eval/snapshot.mjs`, `eval/report.mjs`, `eval/baseline.mjs` and `RELEASE.md`.

**Do / how:**

1. Create a manifest for 30 candidate tasks across at least five pinned repositories, using
   TypeScript/JavaScript and Python. Cover bug repair, multi-file features, refactoring and
   test failures. Record source/license, issue description, exact base revision, environment,
   dependency setup, allowed commands and evaluation criteria. Do not invent task provenance.
2. Separate development tasks from a held-out set before tuning. Keep assessor-only checks
   and expected patches outside the agent-visible workspace and tool context.
3. Build network-free harness/protocol tests with fake providers. Make real-provider runs a
   separate opt-in command and evidence class with explicit model/provider/version settings,
   budgets and authorization. This task does not authorize spending or sending user code.
4. Record baseline results for only runs actually executed. Unavailable environments or
   missing live authorization are NOT EVALUATED with reasons, not failures disguised as scores.
5. Define a paired comparison using identical task revisions, model settings, budget and
   retry policy before and after an implementation. Preserve individual failed trajectories.

**Observe:** functional outcome, regression checks, final diff quality, intervention count,
elapsed time, token/cost provenance, tool actions, unexpected modifications and cleanup.
Record tests that were weakened/deleted; require independent review of their legitimacy.

**Evaluate:** harness self-tests for wrong patch, changed assessor files, fake success text,
missing test runner, timed-out run, incomplete result, cleanup leak and redaction canaries.
Report exact denominators and per-task results. Do not call mocked responses model quality.

**Deliver:** manifest, isolation/reproducibility instructions, harness, machine-readable report
schema and baseline status. **Accept protocol separately from live baseline:** the phase can
pass durability without a live benchmark, but no capability-improvement claim is permitted
until comparable real runs and independent patch review exist.

## DUR-002 — authoritative store, journal and capacity

**Owner:** persistence implementer. **Dependencies:** accepted DUR-001.

**Own:** proposed `lib/goal-store.mjs`, `lib/goal-lock.mjs`,
`test/goal-store.test.mjs`, `test/goal-lock.test.mjs`. Lock ownership follows the approved spike.
Do not modify `lib/session.mjs` retention as a shortcut to durable goal storage.

**Read:** `lib/session.mjs`, `lib/integration-intent.mjs`, `lib/pinned-write.mjs`,
`lib/isolated-manifest.mjs`, `test/integration-recovery.test.mjs`, `test/snapshot-races.test.mjs`.

**Do / how:**

1. Implement bounded versioned reads, private goal directories, blob hashes and monotonic
   append/sync records. Validate generation/lease on every authoritative mutation.
2. Implement checkpoint publication and loading with the selected crash rules. An append
   error must not be swallowed as a harmless UI save warning.
3. Implement quotas/reservations and an inspect-only status API. Retain referenced recovery
   data on all error paths. Explain orphan temp cleanup without deleting live state.
4. Use subprocess crash barriers around write/sync/rename boundaries, plus injected disk-full,
   permission, partial-write and fsync failures. Keep deterministic barriers, not fixed sleeps.

**Observe:** exact bytes, modes, sequence continuity, reopen behavior, files left after errors,
which generations can mutate, and whether a second writer starts any work.

**Evaluate:** AUDIT cases CR-01, CR-02, CR-10–14, CR-18. Test truncated tail versus corrupted
committed interior separately. Refuse oversized/FIFO/symlink state. Test that retention cannot
delete referenced originals. Existing sessions and backups must still load normally.

**Deliver:** store/lock APIs, corruption matrix, crash evidence, limits and cleanup report.
**Accept only if:** no tested failure invents state, loses offered recovery or permits two writers.

## DUR-003 — effect reconciliation and recovery images

**Owner:** recovery implementer. **Dependencies:** accepted DUR-001; use its store interface
while DUR-002 is in progress. Final acceptance requires the real DUR-002 store.

**Own:** proposed `lib/goal-operations.mjs`, `lib/goal-recovery.mjs`,
`test/goal-operations.test.mjs`, `test/goal-recovery.test.mjs`.
Existing controller/write-path edits belong to DUR-005.

**Read:** `lib/controller.mjs` undo, `lib/workspace.mjs`, `lib/pinned-write.mjs`,
`lib/integration-intent.mjs`, `lib/isolated-manifest.mjs`, `lib/local-agent.mjs`,
`lib/model-agent.mjs` write branches and relevant undo/integration tests.

**Do / how:**

1. Prepare exact validated operation intents and recovery blobs before effects. Separate
   operation plan identity from provider tool-call IDs.
2. Implement read-only reconciliation for before/after/divergent/missing/type-changed states.
   Record observed effects without applying or rolling back a pending patch.
3. Recover exact undo entries for repeated same-file edits and partially completed multi-file
   work. Preserve modes, CRLF, no-final-newline and empty-original/creation distinctions.
4. Invalidate dependent facts/verification on workspace drift. Treat interrupted tests and
   provider calls as uncertain; do not infer completion from logs.

**Observe:** original, post-run, post-crash, post-reconcile and post-undo snapshots; original
and updated hashes; operation dispatch count; pending entries; external files and symlinks.

**Evaluate:** CR-03–09, CR-14, CR-16 and CR-19, using the real store for final evidence.
Inject a crash after rename but before receipt and prove a fresh process does not rewrite
the file. Changed/corrupted files must remain untouched and recovery must remain inspectable.

**Deliver:** reconciliation table implemented as tests, operation evidence and exact-undo proof.
**Accept only if:** every exposed effect has a conservative defined outcome at every interruption point.

## DUR-004 — resumable executor, context and cumulative budgets

**Owner:** executor implementer. **Dependencies:** accepted DUR-001; accepted DUR-002/003
for integration. **Own:** proposed `lib/goal-executor.mjs`, `lib/goal-context.mjs`,
`lib/goal-budget.mjs` and matching `test/goal-*.test.mjs` files. Reserve existing
`lib/model-agent.mjs` only after a chief-approved handoff from its prior owner.

**Read:** remote/local loops, `lib/outcome.mjs`, `lib/controller.mjs`, `lib/openrouter.mjs`,
`lib/task.mjs`, context/usage tests, existing failure-after-write and healing tests.

**Do / how:**

1. Implement explicit transitions and operation boundaries. Add a narrow adapter to existing
   agent engines; do not replace the tested engines or reset their outcomes on resume.
2. Persist all attempt/call reservations before dispatch, enforce cumulative ceilings and
   retain uncertain provider usage. Validate explicit budget amendments and upper limits.
3. Reconstruct bounded context from verified facts and operation summaries. Handle a crash
   halfway through streamed content or a multi-tool response without orphan tool messages.
4. Implement pause/cancel/generation fencing and the initial no-progress rule. Produce an
   actionable stop reason and continuation requirement; do not keep an idle process alive
   simply to claim continuous work.
5. Make criteria completion a trusted executor decision, including human-review criteria.

**Observe:** actual provider/child starts, ledger reservation totals before/after crashes,
context payload sent to mocked providers, stale callbacks and unchanged failure fingerprints.

**Evaluate:** CR-01, CR-07–09, CR-15–17, CR-20; restart during streaming, uncertain cost,
budget exhaustion after restart, repeated failures with/without changed evidence, and
prompt injection attempting to modify criteria/budgets/authority. Existing 16 eval contracts
must remain intact. No baseline update to accommodate a regression.

**Deliver:** executor adapter, budget/context tests and a two-source-file scripted-provider
demonstration that resumes in a fresh process. **Accept only if:** no retry resets budget,
no old callback can mutate current state, and model completion text alone never completes a goal.

## DUR-005 — controller, write gates and process ownership integration

**Owner:** authority/integration implementer. **Dependencies:** accepted DUR-001/002/003;
coordinate serially with DUR-004. **Own:** reserved `lib/controller.mjs`, necessary
`lib/local-agent.mjs` hooks, proposed `lib/goal-policy.mjs`, and focused integration tests.
Changes to `lib/model-agent.mjs` require explicit file handoff. No concurrent edits there.

**Read:** controller lifecycle, test/command policy, process audits, both agent write paths,
ordinary and parallel CLI execution, publication ownership, current approval tests.

**Do / how:**

1. Put durable intent before every supported goal write, and receipt after observable
   completion. A journal failure prevents new effects; rendering cannot bypass this rule.
2. Bind approval to operation/workspace/generation. Expire pending authority on restart,
   including auto-approve for the old invocation. Keep edits, tests and commands independent.
3. Implement the approved cross-process lease/control design across relevant existing
   writers. Resolve cancellation of owned test trees; never signal a PID on name alone.
4. Keep standalone non-goal workflows compatible and prevent them bypassing an active lease.
   Preserve exact backup/undo integrity and integration-intent behavior.
5. Disable unsupported command capabilities in the new goal workflow with a clear error;
   leave existing command functionality unchanged outside it.

**Observe:** decisions, write/test dispatches, start/end audits, journal ordering, process
ownership after death, ordinary-command behavior while a goal owns the workspace.

**Evaluate:** real approval deny/apply/restart cases; stale generation decisions; Ctrl+C at
approval, before write and during tests; SIGKILL with descendants; process-ID reuse fixtures;
disk failure before intent and after effect; all existing controller/trust/command tests.

**Deliver:** integrated runtime path and ownership proof. **Accept only if:** a second
writer, old approval, missing audit or failed intent cannot start an unauthorized side effect.

## DUR-006 — CLI and user-visible continuation

**Owner:** CLI/UI implementer. **Dependencies:** accepted DUR-004/005 interface.
**Own:** reserved `lib/cli.mjs`, `bin/matrix.mjs`, `src/matrix.mjs`, appropriate new goal
screen/adapter, `test/goal-cli.test.mjs`, `test/goal-app.test.mjs`. Shared codec/types changes
need chief review and file handoff. Keep persistence out of rendering code.

**Read:** CLI validation, controller event reducer, keyboard routing, session snapshots,
parallel CLI/PTY tests, smoke/accessibility tests.

**Do / how:** implement the frozen command grammar and UI state projection. Display remaining
criteria, budget, last durable operation, reason for stopping and exact next command. Preserve
ordinary `--resume` and every current flag meaning. List/inspect are read-only. Use bounded,
redacted JSON; reject malformed flags before creating state. Provide distinct results for
loaded session, reconciled goal, resumed goal and completed goal.

**Observe:** stdout/stderr, exit codes, actual child starts and file changes, prompt ownership,
keyboard cancellation and screen-reader text. A pretty screen is not evidence of correct state.

**Evaluate:** subprocess CLI plus real PTY kill/restart; missing/changed workspace; unknown
goal/schema; no-provider-key; read-only inspection; responsive layouts at existing geometries
and 40×20 where applicable; reduced motion and screen-reader paths; existing CLI/UI suites.

**Deliver:** usable goal workflow and CLI/PTY evidence. **Accept only if:** every stop state
explains why and how to proceed without implying a successful task or silently starting work.

## QA-101 — independent durability adversary

**Owner:** validation implementer who did not write the target production modules.
**Dependencies:** can prepare fixtures after DUR-001; execute against accepted runtime adapters.
**Own:** proposed `test/goal-adversarial.test.mjs`, `eval/durability/` and sanitized reports.
Production edits go back to the responsible implementer as findings.

**Do / how:** implement the full CR matrix in AUDIT.md using real subprocess boundaries and
temporary homes/workspaces. Independently derive expected outcomes. Use deterministic fault
barriers to SIGKILL then start a fresh process. Test success, denial, failure, exhaustion,
uncertainty and cancellation. Include process/fixture cleanup and canary forwarding checks.

**Observe:** whole workspace inventory, bytes, modes, external sentinel files, process tree,
provider requests, exact approvals, replay counts, recovery data and final classifications.

**Evaluate:** every CR case; no skips on supported Linux. Repeat concurrency tests to probe
both critical orderings, without hiding flakes behind retry-to-green. Record a reproducible
seed/barrier trace for every failure. Kill tests prove process interruption, not physical power loss.

**Deliver:** independent report with PASS/FAIL/NOT EVALUATED for each case and minimal
reproductions for findings. **Accept only if:** the report is reproducible and no mandatory
case remains untested; chief acceptance still requires correcting discovered defects.

## INT-101 — final integration and chief audit

**Owner:** chief/integrator. **Dependencies:** submitted implementation tasks and QA evidence.
**Own:** shared docs/config, integration decisions, final diff and audit verdict.

Integrate in dependency order. Inspect actual call paths and ownership, reproduce the new
failure cases independently, and run exact-candidate gates in AUDIT.md. Do not trust an
agent's success summary or its test totals without reading the evidence. Require revision
updates after any material fix. Update README/MATRIX only for behavior that now exists.
Record capability-benchmark status independently of runtime correctness. Preserve private
package posture. Commit/push/release only when separately authorized by the user.

## Copyable assignment message

> Work on TASK-ID in `/home/mitravanu/matrix`. Read `AGENTS.md`, `NEXT_PHASE.md`, and
> `docs/next-phase/{ARCHITECTURE,AGENT_TASKS,AUDIT,STATUS}.md`. Claim the task and reserve
> its files before editing. Follow its dependencies; do not implement against unaccepted
> contracts. Deliver the code, meaningful tests, observed evidence and the audit packet.
> Preserve other agents' work. Do not change unrelated files, weaken checks, update evaluation
> baselines, commit or push. Mark your work SUBMITTED for chief review, not ACCEPTED.
