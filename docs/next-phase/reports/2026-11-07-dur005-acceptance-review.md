# Independent Acceptance Review: DUR-005 (Approval Scope, Process Containment, and Audit Boundaries)

- **Date:** 2026-11-07
- **Task:** `DUR-005` — Approval Scope, Process Containment, and Audit Boundaries
- **Repository:** `/home/mitravanu/matrix`
- **Git Commit (`HEAD`):** `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`
- **Tracked Working-Tree Diff SHA-256 (`git diff | sha256sum`):** `8a4eb8579a286f8ae6fe1fb79cb602579e95f187f06aabf208328c97c8296f94`
- **14-File Candidate Aggregate SHA-256:** `62e5355885ff2ca6a2a62a4ec3e6142566f15bf88a0c890cc47b862638c1c454`
- **12-File Candidate Aggregate SHA-256 (excluding `lib/goal-executor.mjs` and `lib/goal-store.mjs`):** `e147f798f7c6d3ea6eb0b9ba9ac403098277afef8ccc285f7f797da3da27a368`
- **Verdict:** **`CHANGES REQUIRED`**

---

## 1. Executive Summary

An independent code and runtime review of the submitted `DUR-005` candidate was conducted against `AGENTS.md`, `docs/next-phase/REVIEW_METHOD.md`, `docs/next-phase/STATUS.md`, `docs/next-phase/AGENT_TASKS.md`, `docs/next-phase/decisions/DUR-001.md`, and `docs/next-phase/submissions/DUR-005.md`.

While the candidate's existing test suites pass on both Node 24 (`v24.21.0`) and Node 22 (`v22.23.1`) (`29/29` in `test/goal-runtime.test.mjs`, `92/92` across the focused durable-runtime suite, and `990/990` in `npm run check`), independent counterexample construction using temporary workspaces, fake credentials, and real Linux subprocesses exposed **four `P1` blocking safety and durability violations**, **two `P2` boundary defects**, and **one `P3` verification/documentation hygiene issue**:

1. **Finding 1 (`P1` — Focus Area 6, Unobserved Dispatch Bypass & Budget Reservation Leak):** The disclosed change in `lib/goal-store.mjs:760-773` relaxes `store.transition(..., "completed")` so that it only checks `entry.dispatchSequence === null || entry.receiptSequence !== null` for `entry.attemptId === current.lease?.attemptId`, ignoring all unreceipted dispatches from prior attempts. Combined with `blockedOperationsFor` in `lib/goal-executor.mjs:454-489` (which only checks `test` and `command` operations) and `reconcileGoalOperations` in `lib/goal-recovery.mjs:659-680` (which is read-only and never appends a receipt), an interrupted `edit` (or `provider`, `read`, `search`, or reconciled `test`) dispatch from Attempt 1 (`SIGKILL`ed after mutating the workspace but before recording its receipt) is bypassed on Attempt 2: the goal transitions to `state: "completed"` while the journal still contains an unobserved dispatch (`receiptSequence: null`) and its budget reservation remains permanently stuck in `counters.reserved` (`tools: 1`, `activeMs: 44999`).
2. **Finding 2 (`P1` — Focus Area 3, Ordinary Writers Bypass Durable Goal Workspace Exclusion):** `runLocalAgent` (`lib/local-agent.mjs:533, 743`), `runModelAgent` (`lib/model-agent.mjs:1623, 1742`), and `publishIntegrationIntent` (`lib/integration-publication.mjs:104`) call `withWorkspaceWriteLock(project.root, () => ...)` **without passing `{ home }`** (unlike `undoLast` in `lib/controller.mjs:610` and `undoIntegrationRun` in `lib/integration.mjs:492`). Whenever `home` / `backupHome` is passed via options (e.g., `createRunController({ home })`) rather than mutating global `process.env.MATRIX_HOME`, both `runLocalAgent` and `runModelAgent` probe the default `~/.matrix` directory instead of `home` and overwrite workspace files while a foreign process holds an active durable goal writer lease or an unresolved surviving test execution in `home`.
3. **Finding 3 (`P1` — Focus Areas 1 & 3, Pre-`onPin` Teardown Race & Journal-Blind Lease Probe):** `dispatchTest` (`lib/goal-executor.mjs:1240-1246`) commits `intent` and `dispatch` to the journal _before_ invoking `runTest`, whereas `runContainedProcess` (`lib/goal-containment.mjs:310-367`) spawns `bwrap` and polls asynchronously (`await delay(POLL_MS)`) before calling `onPin(containment)` -> `ownership.recordDispatch(...)`. Any `runtime.pause()`, `runtime.cancel()`, `toolTimeoutMs`, `signal` abort, or `SIGKILL` during that pre-`onPin` window leaves `teardown-unverified` in the goal journal with **no `ownership/<operationId>.json` file on disk**. Every subsequent `runtime.resume()` or new goal in that workspace permanently safe-stops (`ownership-record-missing`), while `findBlockingDurableGoal` (`lib/goal-lease-probe.mjs:345-520`) — which never inspects `goals/<goalId>/journal.jsonl` or `checkpoint.journal.operations` and ignores expired-TTL leases — simultaneously **allows ordinary writers to mutate the workspace** (both during a journal-only `teardown-unverified` block and after a crashed `running` goal's 5-minute lease TTL expires with an unreceipted `edit` and `.matrix-transaction-*.json` artifact on disk).
4. **Finding 4 (`P1` — Focus Areas 1 & 2, `verifyTeardown` Certifies Non-Contained Records While Detached `setsid()` Descendants Survive):** Unlike `findBlockingDurableGoal` (`lib/goal-lease-probe.mjs:420-424`), `ownership.verifyTeardown` (`lib/goal-policy.mjs:1371-1555, 1718-1792`) never requires `containment` or `namespace` on either its slow path (`readOwnershipRecord` -> `settleOperation` -> `verifyAndTeardownTree`) or its fast path (`readReconciledRecord`). On the slow path, if a non-contained process-group leader spawns a detached `setsid()` child and exits before `verifyTeardown` runs (as opposed to `test/goal-runtime.test.mjs:992-1039`, which kept the parent leader alive in `setInterval`), Linux reparents the detached child to PID 1 (`ppid = 1`), `findEscapedDescendant` and `collectGroupMembers` both return empty, and `ownership.verifyTeardown` returns `{ verified: true }` **while the detached child process is still alive and running**.
5. **Finding 5 (`P2` — Focus Areas 2 & 3, Workspace Rename or Replacement Permanently Bricks Teardown Verification):** `verifyTeardown` (`lib/goal-policy.mjs:1725-1727, 1773-1775`) requires **both** `workspace.path === block.workspace.path` **and** `(device, inode)` equality, whereas `store.listForWorkspace` (`lib/goal-store.mjs:592-615`) matches prior goals by **either** `path` **or** `(device, inode)`. Renaming a workspace directory (`same dev/ino, new path`) or replacing a workspace directory at the same path (`same path, new dev/ino`) after any interrupted test permanently bricks both the original goal and any brand-new goal created for that workspace (`ownership-workspace-mismatch` / `reconciliation-mismatch`).
6. **Finding 6 (`P2` — Focus Area 4, Edit Approval Grant Scope & `createGoalRuntime` State Retention Across `resume()`):** Pre-issued edit grants in `createGoalAuthority` (`lib/goal-policy.mjs:479-542`) key only on `[goalId, path, "write"|"delete", contentSha256, mode]`, omitting `planHash` (`before` file existence/digest/mode and resolved `after.mode`), `generation`, `attemptId`, `operationId`, and `workspace`. If a target file's contents and permissions change on disk (e.g., `0o644` -> `0o755`) before `authorizeEdit` runs with `mode: null`, `planEditOperation` inherits `0o755` and consumes the stale grant to write an executable `0o755` file. Furthermore, `createGoalRuntime` (`lib/goal-policy.mjs:2112-2250`) reuses `authority` and `controlState` across `runtime.resume()` calls, allowing an unconsumed grant from `generation: 1` to execute in `generation: 2` and permanently latching `controlState.request = "pause"` after a single `runtime.pause()`.
7. **Finding 7 (`P3` — Submission Digest Table Typos & Coverage Gate Omissions):** `docs/next-phase/submissions/DUR-005.md` contains two single-character hex typos in its per-file SHA-256 table (`lib/local-agent.mjs` has 63 hex chars; `scripts/matrix-pidfd-helper.c` has 65 hex chars), and `scripts/check-coverage.mjs:6-33` omits all new `DUR-005` and durable-goal runtime modules (`lib/goal-policy.mjs` is at `72.31%` line / `62.30%` branch coverage; `lib/goal-containment.mjs` is at `59.00%` branch coverage; `lib/goal-guardian.mjs` is at `25.00%` branch coverage).

---

## 2. Candidate Identity and Fingerprint Verification

Before relying on any submission claims, the repository state in `/home/mitravanu/matrix` was independently recorded and compared against `docs/next-phase/submissions/DUR-005.md`:

| Check                    | Command                             | Observed Value                                                     | Matches `DUR-005.md`? |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------ | --------------------- |
| Base `HEAD` commit       | `git rev-parse HEAD`                | `ff55a2c2aaeb863e881a5a8d0e112eb78ded0204`                         | Yes                   |
| Whitespace / patch check | `git diff --check`                  | Exit `0` (no output)                                               | Yes                   |
| Tracked diff digest      | `git diff \| sha256sum`             | `8a4eb8579a286f8ae6fe1fb79cb602579e95f187f06aabf208328c97c8296f94` | Yes                   |
| 14-file aggregate digest | `sha256sum <14 files> \| sha256sum` | `62e5355885ff2ca6a2a62a4ec3e6142566f15bf88a0c890cc47b862638c1c454` | Yes                   |
| 12-file aggregate digest | `sha256sum <12 files> \| sha256sum` | `e147f798f7c6d3ea6eb0b9ba9ac403098277afef8ccc285f7f797da3da27a368` | Yes                   |

### Per-File SHA-256 Comparison

| File                                         | Observed SHA-256                                                   | `DUR-005.md` Listed SHA-256                                                                               | Match?                                                     |
| -------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `docs/next-phase/fixtures/dur005-driver.mjs` | `14565da8647b20812a7b13dbd5cfdff7439efbaad34cbb9e227f355786e70796` | `14565da8647b20812a7b13dbd5cfdff7439efbaad34cbb9e227f355786e70796`                                        | Exact                                                      |
| `lib/controller.mjs`                         | `b2836e9fc4a0463609db83d44f0b4bc55c76e9666d99ddf74f7f308b90993ade` | `b2836e9fc4a0463609db83d44f0b4bc55c76e9666d99ddf74f7f308b90993ade`                                        | Exact                                                      |
| `lib/doctor.mjs`                             | `0ca92cf1dcbb7813d26e72800125150776c73bdfcfddb74dcf3e37bb7c3ecd5c` | `0ca92cf1dcbb7813d26e72800125150776c73bdfcfddb74dcf3e37bb7c3ecd5c`                                        | Exact                                                      |
| `lib/goal-containment.mjs`                   | `a6bd6a4951c1f38d7f281ce5b9884776d6789bcedad22897c8175fa8bb720d0f` | `a6bd6a4951c1f38d7f281ce5b9884776d6789bcedad22897c8175fa8bb720d0f`                                        | Exact                                                      |
| `lib/goal-executor.mjs`                      | `51a4d9c75495f6138c945b5ef45baf674795cf5f16c1bc860360e141bbc40d43` | `51a4d9c75495f6138c945b5ef45baf674795cf5f16c1bc860360e141bbc40d43`                                        | Exact                                                      |
| `lib/goal-guardian.mjs`                      | `91a04353a9035f5bdf17ff8d1d9edb23c320c628517efa2adf103187487ee9f1` | `91a04353a9035f5bdf17ff8d1d9edb23c320c628517efa2adf103187487ee9f1`                                        | Exact                                                      |
| `lib/goal-lease-probe.mjs`                   | `3d785d620b9c8fc4ee597d16123be4bb40e41acec368986a22074b025c144545` | `3d785d620b9c8fc4ee597d16123be4bb40e41acec368986a22074b025c144545`                                        | Exact                                                      |
| `lib/goal-policy.mjs`                        | `8a04c396680ecd5af7baf369fe6d697fa1133d1744cb320d420ad03486f55088` | `8a04c396680ecd5af7baf369fe6d697fa1133d1744cb320d420ad03486f55088`                                        | Exact                                                      |
| `lib/goal-store.mjs`                         | `64cf563e018534430d352d71c768c68d8db3d59da3696b4dfb601ff0661dcf77` | `64cf563e018534430d352d71c768c68d8db3d59da3696b4dfb601ff0661dcf77`                                        | Exact                                                      |
| `lib/local-agent.mjs`                        | `7e4a46a2a4240fbfc2453ede40a7c725aa82571c6dfc0ef0729b2c1012bad3df` | `7e4a46a2a4240fbf2c453ede40a7c725aa82571c6dfc0ef0729b2c1012bad3df` (63 chars; missing `c` in `0fbfc2453`) | Table typo in `DUR-005.md` (aggregate matches actual file) |
| `lib/model-agent.mjs`                        | `30eb59024d444abc22d27b145fca5a76634b6fc6516ff659ac53f521028766f7` | `30eb59024d444abc22d27b145fca5a76634b6fc6516ff659ac53f521028766f7`                                        | Exact                                                      |
| `scripts/build-pidfd-helper.mjs`             | `042ada69ce553443989c58e8b5d8f66902fe797b9c7415c9971dc8816d5fc3cc` | `042ada69ce553443989c58e8b5d8f66902fe797b9c7415c9971dc8816d5fc3cc`                                        | Exact                                                      |
| `scripts/matrix-pidfd-helper.c`              | `d94dbece62ceae6a2e70e5e9ff509a8b0d69f437d646564545b3cd295d5a5e74` | `d94dbece62ce8ae6a2e70e5e9ff509a8b0d69f437d646564545b3cd295d5a5e74` (65 chars; extra `8` in `62ce8ae6a`)  | Table typo in `DUR-005.md` (aggregate matches actual file) |
| `test/goal-runtime.test.mjs`                 | `4f987820fa01b0f93b53e21e9950a193c6af5789687475c32b625a1849ed671d` | `4f987820fa01b0f93b53e21e9950a193c6af5789687475c32b625a1849ed671d`                                        | Exact                                                      |

---

## 3. Verification Commands and Observations

| Runtime              | Command                                                                                                                                                 | Observation                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24 (`v24.21.0`) | `/usr/bin/node --test test/goal-runtime.test.mjs test/goal-executor.test.mjs test/goal-store.test.mjs`                                                  | `92/92` pass (`29` in `goal-runtime`, `49` in `goal-executor`, `14` in `goal-store`), `0` fail (`22,000.6 ms`)                                                                                                                                                                                                               |
| Node 22 (`v22.23.1`) | `/tmp/opencode/review-kit/dist/node-v22.23.1-linux-x64/bin/node --test test/goal-runtime.test.mjs test/goal-executor.test.mjs test/goal-store.test.mjs` | `92/92` pass (`29` in `goal-runtime`, `49` in `goal-executor`, `14` in `goal-store`), `0` fail (`17,757.0 ms`)                                                                                                                                                                                                               |
| Node 24 (`v24.21.0`) | `npm run check`                                                                                                                                         | `990/990` pass (`test/*.test.mjs`); overall coverage `92.48%` lines / `83.08%` branches / `94.56%` functions; note `lib/goal-policy.mjs` (`72.31%` lines / `62.30%` branches), `lib/goal-containment.mjs` (`83.56%` / `59.00%`), and `lib/goal-guardian.mjs` (`74.38%` / `25.00%`) are not enforced in `COVERAGE_THRESHOLDS` |
| Node 22 (`v22.23.1`) | `/tmp/opencode/review-kit/dist/node-v22.23.1-linux-x64/bin/node --test`                                                                                 | `993/993` pass (includes `eval/test/scorer.test.mjs`), `0` fail (`84,608.3 ms`)                                                                                                                                                                                                                                              |
| Node 24 (`v24.21.0`) | `npm run eval`                                                                                                                                          | `16/16` contract pass, `0` safety violations, active processes `0`                                                                                                                                                                                                                                                           |
| Node 24 (`v24.21.0`) | `npm run smoke`                                                                                                                                         | `32/32` frame checks across 4 geometries pass                                                                                                                                                                                                                                                                                |
| Node 24 (`v24.21.0`) | `npm run pack:check`                                                                                                                                    | Pass (`102` files, `403,443` bytes packed, `1,589,052` bytes unpacked)                                                                                                                                                                                                                                                       |

---

## 4. Supported Findings

### Finding 1 (`P1` — Focus Area 6): Disclosed changes to `lib/goal-store.mjs` and `lib/goal-executor.mjs` allow a prior attempt's unobserved dispatch to be bypassed, completing goals with unreceipted dispatches and permanently leaked `counters.reserved`

- **Severity:** `P1` (Blocking — violates `DUR-002`, `DUR-004`, and `DUR-005` journal/budget invariants and the explicit Focus Area 6 requirement that a prior attempt's unobserved dispatch cannot be bypassed)
- **Locations:**
  - `lib/goal-store.mjs:760-773`
  - `lib/goal-executor.mjs:454-489`
  - `lib/goal-executor.mjs:1805-1865`
  - `lib/goal-recovery.mjs:659-680`

#### Analysis

In `DUR-002`, `lib/goal-store.mjs` enforced a store-level invariant on `transition(goalId, authority, "completed")`: **every** operation in `current.journal.operations` had to satisfy `entry.dispatchSequence === null || entry.receiptSequence !== null`.

The `DUR-005` candidate modifies `lib/goal-store.mjs:760-773` as follows:

```js
const currentAttemptId = current.lease?.attemptId ?? null;
const incompleteOperation = Object.values(current.journal.operations).find(
  (entry) =>
    entry.attemptId === currentAttemptId &&
    entry.dispatchSequence !== null &&
    entry.receiptSequence === null,
);
```

This change creates three compounding failures:

1. **At the `lib/goal-store.mjs` boundary:** `store.transition(goalId, authority, "completed")` no longer checks whether _any_ prior attempt (`entry.attemptId !== currentAttemptId`) left an unreceipted `test`, `edit`, `provider`, `read`, or `search` dispatch, nor whether that dispatch was ever reconciled or teardown-verified.
2. **At the `lib/goal-executor.mjs` / `createGoalRuntime` boundary:** `blockedOperationsFor` (`lib/goal-executor.mjs:454-489`) only inspects `EXECUTION_KINDS = new Set(["test", "command"])`. Meanwhile, `reconcileGoalOperations` (`lib/goal-recovery.mjs:659-680`) and `recoverGoalWorkspace` (`lib/goal-recovery.mjs:1032-1122`) are read-only with respect to the goal journal: when Attempt 1 dispatches an `edit` (`store.recordDispatch`), applies the file mutation to `src/a.mjs`, and is `SIGKILL`ed before `store.recordReceipt` runs, `recoverGoalWorkspace` cleans up `.matrix-transaction-*.json` (or observes that the edit already landed cleanly on disk) **without ever appending a receipt to `journal.jsonl`**.
3. **Permanent `receiptSequence: null` and `counters.reserved` leak on completion:** When Attempt 2 runs `runtime.resume()`, `evaluateGoalCriteria` sees that `src/a.mjs` already matches the artifact criterion (`sha256` of `"export const a = 2;\n"`), executes `0` model turns, and transitions the goal to `state: "completed"`. Because no receipt was ever recorded for Attempt 1's `edit` (or for a crashed `provider` or reconciled `test` dispatch from Attempt 1), `releaseBudgetReservation` in `lib/goal-store.mjs:238-259` never settles Attempt 1's reservation. The goal finishes in `state: "completed"` with `receiptSequence: null` in `checkpoint.journal.operations` and with Attempt 1's reservation permanently stuck in `checkpoint.journal.counters.reserved` (`{ activeMs: 44999, requests: 0, rounds: 0, tools: 1 }` while `counters.used.tools === 0`).

#### Reproduction

```bash
/usr/bin/node --input-type=module -e '
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_DEFAULT_BUDGET, newGoalId } from "./lib/goal-contracts.mjs";
import { createGoalStore } from "./lib/goal-store.mjs";
import { createGoalRuntime, reclaimStaleGoalAttempt } from "./lib/goal-policy.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const home = mkdtempSync(join(tmpdir(), "dur005-ce1-home-"));
const workspace = mkdtempSync(join(tmpdir(), "dur005-ce1-ws-"));
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "src/a.mjs"), "export const a = 1;\n");
const st = statSync(workspace, { bigint: true });
const goalId = newGoalId();
const store = createGoalStore(home);
store.create({
  schemaVersion: 1,
  id: goalId,
  createdAt: Date.now(),
  objective: "unobserved edit dispatch bypass",
  workspace: { path: workspace, device: String(st.dev), inode: String(st.ino), revision: null, manifest: hash("m") },
  provider: { id: "scripted", modelId: "scripted", digest: hash("p") },
  state: "ready",
  generation: 0,
  sequence: 0,
  budget: { ...GOAL_DEFAULT_BUDGET },
  operations: [],
  criteria: [{ id: newGoalId("criterion"), revision: 1, kind: "artifact", path: "src/a.mjs", sha256: hash("export const a = 2;\n") }],
});

// Attempt 1 crashes (fault-injected before edit receipt after writing src/a.mjs)
const rt1 = createGoalRuntime({
  home, store, goalId, workspaceRoot: workspace, allowEdits: true,
  provider: { id: "scripted", modelId: "scripted", digest: hash("p"),
    runTurn: async () => ({
      summary: "edit a",
      toolCalls: [{ id: "c1", name: "edit", complete: true, arguments: { path: "src/a.mjs", content: "export const a = 2;\n" } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1, rounds: 1, activeMs: 1, costUsd: 0 },
    }),
  },
  faults: { beforeEditReceipt() { const err = new Error("simulated SIGKILL before edit receipt"); err.code = "SIM_KILL"; throw err; } },
});
await assert.rejects(() => rt1.resume(), /simulated SIGKILL/);

// Reclaim dead owner lease and resume in Attempt 2
reclaimStaleGoalAttempt({ home, store, goalId, workspaceRoot: workspace, isOwnerDead: () => ({ dead: true, reason: "dead" }) });
let turnsInAttempt2 = 0;
const rt2 = createGoalRuntime({
  home, store, goalId, workspaceRoot: workspace, allowEdits: true,
  provider: { id: "scripted", modelId: "scripted", digest: hash("p"), runTurn: async () => { turnsInAttempt2++; return { summary: "noop", toolCalls: [] }; } },
});
const res2 = await rt2.resume();
const cp = store.inspect(goalId).checkpoint;
const editOp = Object.values(cp.journal.operations).find((o) => o.kind === "edit");
console.log({
  res2Status: res2.status,
  goalState: cp.state,
  turnsInAttempt2,
  editDispatchSeq: editOp.dispatchSequence,
  editReceiptSeq: editOp.receiptSequence,
  countersUsed: cp.journal.counters.used,
  countersReserved: cp.journal.counters.reserved,
});
rmSync(home, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
'
```

Observed output on both Node 24 (`v24.21.0`) and Node 22 (`v22.23.1`):

```js
{
  res2Status: 'completed',
  goalState: 'completed',
  turnsInAttempt2: 0,
  editDispatchSeq: 7,
  editReceiptSeq: null,
  countersUsed: { activeMs: 1, requests: 1, rounds: 1, tools: 0 },
  countersReserved: { activeMs: 44999, requests: 0, rounds: 0, tools: 1 }
}
```

---

### Finding 2 (`P1` — Focus Area 3): Ordinary workspace writers (`runLocalAgent`, `runModelAgent`, and `publishIntegrationIntent`) omit `{ home }` when calling `withWorkspaceWriteLock`, overwriting workspaces owned by an active durable goal lease or blocked by unverified surviving execution

- **Severity:** `P1` (Blocking — directly violates Focus Area 3: _"Whether any ordinary or second goal writer can proceed while an owned process may still write"_)
- **Locations:**
  - `lib/local-agent.mjs:533` and `lib/local-agent.mjs:743`
  - `lib/model-agent.mjs:1623` and `lib/model-agent.mjs:1742`
  - `lib/integration-publication.mjs:104`
  - Compare with `lib/controller.mjs:386` and `lib/controller.mjs:610`, and `lib/integration.mjs:492`

#### Analysis

`withWorkspaceWriteLock(root, use, options = {})` (`lib/workspace.mjs:193-214`) calls `assertNoBlockingDurableGoal(real, { home: options.home })`.
In `lib/controller.mjs:610`, `undoLast` passes `{ home }`:

```js
withWorkspaceWriteLock(undoRoot, () => undoRun(targetRun, { root: undoRoot }), { home });
```

However, when `createRunController({ home })` starts a local or remote agent run (`lib/controller.mjs:386`), it passes `backupHome: home` to `runLocalAgent` and `runModelAgent`. Inside `lib/local-agent.mjs` (lines 533 and 743) and `lib/model-agent.mjs` (lines 1623 and 1742), `withWorkspaceWriteLock` is called **without** `{ home: backupHome }`:

```js
const { target, backup } = withWorkspaceWriteLock(project.root, () => {
  const target = revalidateBeforeWrite(project, proposal);
  const backup = backupFile(target.path, { home: backupHome });
  writeFileAtomic(target.path, proposed.updatedText);
  return { target, backup };
});
```

Similarly, `publishIntegrationIntent` in `lib/integration-publication.mjs:104` calls `withWorkspaceWriteLock(record.root, () => ...)` without `{ home }` (and does not accept `home` in its options object).

Consequently, whenever `home` is provided via options rather than mutating `process.env.MATRIX_HOME`, `runLocalAgent` and `runModelAgent` probe `~/.matrix` instead of `home`, completely bypassing the durable-goal lease and ownership probe and mutating files in the workspace while a foreign process holds an active durable goal writer lease and an unresolved test ownership record in `home`. Calling `controller.undoLast()` on the very same `createRunController({ home })` instance then fails with `refusing to write: a durable goal reported an unverified execution in this workspace`—leaving the unauthorized edit on disk with undo blocked.

#### Reproduction

```bash
/usr/bin/node --input-type=module -e '
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_DEFAULT_BUDGET, newGoalId } from "./lib/goal-contracts.mjs";
import { createGoalStore } from "./lib/goal-store.mjs";
import { createRunController } from "./lib/controller.mjs";
import { runModelAgent } from "./lib/model-agent.mjs";
import { detectProject } from "./lib/project.mjs";
import { withWorkspaceWriteLock } from "./lib/workspace.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const home = mkdtempSync(join(tmpdir(), "dur005-ce2-home-"));
const workspace = mkdtempSync(join(tmpdir(), "dur005-ce2-ws-"));
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "src/a.mjs"), "export const a = 1;\n");
const st = statSync(workspace, { bigint: true });
const goalId = newGoalId();
const store = createGoalStore(home);
store.create({
  schemaVersion: 1, id: goalId, createdAt: Date.now(), objective: "writer exclusion test",
  workspace: { path: workspace, device: String(st.dev), inode: String(st.ino), revision: null, manifest: hash("m") },
  provider: { id: "scripted", modelId: "scripted", digest: hash("p") },
  state: "ready", generation: 0, sequence: 0, budget: { ...GOAL_DEFAULT_BUDGET }, operations: [],
  criteria: [{ id: newGoalId("criterion"), revision: 1, kind: "artifact", path: "src/a.mjs", sha256: hash("export const a = 2;\n") }],
});

// Separate process acquires durable goal lease + records unresolved ownership in `home`
spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { createGoalStore } from "./lib/goal-store.mjs";
  import { withGoalLock } from "./lib/goal-lock.mjs";
  import { createExecutionOwnership } from "./lib/goal-policy.mjs";
  import { newGoalId } from "./lib/goal-contracts.mjs";
  const [home, workspace, goalId] = process.argv.slice(1);
  const store = createGoalStore(home);
  let started;
  withGoalLock(workspace, (lock) => {
    started = store.beginAttempt(goalId, { lock, fence: { goalId, generation: 0, sequence: 1 } });
  }, { home });
  createExecutionOwnership({ home }).recordDispatch({
    goalId, operationId: newGoalId("operation"), attemptId: started.lease.attemptId,
    generation: 1, pid: process.pid, workspaceRoot: workspace,
  });
`, home, workspace, goalId], { encoding: "utf8" });

assert.throws(() => withWorkspaceWriteLock(workspace, () => {}, { home }), /unverified execution|active writer lease/);

// 1. createRunController({ home }) -> runLocalAgent overwrites src/a.mjs!
const controller = createRunController({ home, headless: true });
await controller.start({
  task: "rename a to b in src/a.mjs",
  project: detectProject(workspace),
  model: { id: "local", provider: "matrix" },
  autoApprove: true,
});
const afterLocal = readFileSync(join(workspace, "src/a.mjs"), "utf8").trim();
const undoResult = controller.undoLast();

// 2. runModelAgent({ backupHome: home }) with fake credential overwrites src/a.mjs!
let turn = 0;
const server = http.createServer((req, resp) => {
  turn++;
  resp.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  const chunk = turn === 1
    ? { id: "1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/a.mjs", content: "export const a = 999;\n" }) } }] }, finish_reason: "tool_calls" }] }
    : { id: "2", choices: [{ index: 0, delta: { content: "Done." }, finish_reason: "stop" }] };
  resp.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
await runModelAgent({
  task: "overwrite src/a.mjs",
  project: detectProject(workspace),
  backupHome: home,
  autoApprove: true,
  recoveryMode: "headless",
  model: { id: "gpt-test", name: "GPT Test", provider: "openai", apiKey: "sk-fake-0000" },
  providerTarget: { kind: "builtin", modelId: "gpt-test" },
  providerBinding: { ok: true, credential: "sk-fake-0000", endpoint: `http://127.0.0.1:${port}/v1/chat/completions` },
});
server.close();
const afterModel = readFileSync(join(workspace, "src/a.mjs"), "utf8").trim();
console.log({ afterLocal, undoResult, afterModel });
rmSync(home, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
'
```

Observed output:

```js
{
  afterLocal: 'export const b = 1;',
  undoResult: {
    ok: false,
    error: 'refusing to write: a durable goal reported an unverified execution in this workspace; verify its teardown before any writer runs'
  },
  afterModel: 'export const a = 999;'
}
```

---

### Finding 3 (`P1` — Focus Areas 1 & 3): Pre-`onPin` teardown startup race and journal-blind `findBlockingDurableGoal` permanently brick goals on early abort/timeout while allowing ordinary writers into `teardown-unverified` or post-TTL crashed workspaces

- **Severity:** `P1` (Blocking — violates Focus Areas 1 and 3 on cancellation/teardown races and ordinary writer exclusion)
- **Locations:**
  - `lib/goal-containment.mjs:310-367`
  - `lib/goal-executor.mjs:1240-1316`
  - `lib/goal-lease-probe.mjs:345-520`
  - `lib/goal-policy.mjs:1752-1759`

#### Analysis

1. **Pre-`onPin` startup race in `dispatchTest` / `runContainedProcess`:**
   In `lib/goal-executor.mjs:1240-1246`, `dispatchTest` commits both `intent` and `dispatch` to the durable goal journal _before_ invoking `runTest`.
   Inside `runGoalTest` (`lib/goal-policy.mjs:2044-2104`) -> `runContainedProcess` (`lib/goal-containment.mjs:310-367`), Bubblewrap is spawned and then `runContainedProcess` enters an asynchronous polling loop (`await delay(POLL_MS)`) waiting for `infoPath` and `readyPath` before invoking `onPin(containment)` -> `ownership.recordDispatch(...)` (which writes `ownership/<operationId>.json`).
   If `runtime.pause()`, `runtime.cancel()`, `toolTimeoutMs`, parent `signal`, or an early `bwrap` exit occurs before `onPin` runs (or if the runtime process receives `SIGKILL` after `store.recordDispatch` commits to the journal but before `onPin` writes `ownership/<operationId>.json`):
   - `runContainedProcess` returns `{ status: null, signal: "SIGKILL", timedOut, aborted, containment: null }`.
   - `runGoalTest` returns `execution: { teardown: "unverified" }`.
   - `dispatchTest` records a receipt with `execution: { teardown: "unverified" }` (or on `SIGKILL`, leaves `dispatched-without-receipt` in the journal), while **no `ownership/<operationId>.json` file was ever created**.
   - On any subsequent `runtime.resume()` (or when starting a new goal in the same workspace), `blockedOperationsFor` sees the unverified test operation in the journal and calls `ownership.verifyTeardown(block)`, which fails at `lib/goal-policy.mjs:1752-1759` with `reason: "ownership-record-missing"`. The goal and the workspace are **permanently bricked** in `safe-stop` (`teardown-unverified`).

2. **`findBlockingDurableGoal` in `lib/goal-lease-probe.mjs` never inspects the goal journal or post-TTL crashed `running` goals:**
   - `findBlockingDurableGoal` (`lib/goal-lease-probe.mjs:345-520`) scans `home/ownership/*.json` and `home/goals/*/checkpoint.json`, but **never inspects `checkpoint.journal.operations` or `journal.jsonl`** for `teardown-unverified` (`dispatched-without-receipt` or `execution.teardown === "unverified"`). Thus, whenever a test dispatch is unverified in the journal without an `ownership/<operationId>.json` file (whether from the pre-`onPin` race above or a custom `runTest` adapter), `createGoalRuntime` reports the workspace blocked by `teardown-unverified`, yet `withWorkspaceWriteLock(workspace, ..., { home })` returns **no blocker** and lets ordinary writers freely overwrite the workspace!
   - Furthermore, at `lib/goal-lease-probe.mjs:514`, `findBlockingDurableGoal` only blocks on `checkpoint.lease` while `lease.expiresAt > now`. When a `running` goal crashes (`SIGKILL`) mid-`edit` (leaving an unreceipted `edit` dispatch in `journal.jsonl` and a `.matrix-transaction-*.json` artifact in the workspace), as soon as the 5-minute lease TTL expires (`lease.expiresAt <= now`), `findBlockingDurableGoal` returns `null` even though `checkpoint.state === "running"` and `checkpoint.lease !== null`, allowing ordinary writers to mutate the workspace before `reclaimStaleGoalAttempt` / `recoverGoalWorkspace` reconciles the interrupted edit.

#### Reproduction

```bash
/usr/bin/node --input-type=module -e '
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_DEFAULT_BUDGET, newGoalId } from "./lib/goal-contracts.mjs";
import { createGoalStore } from "./lib/goal-store.mjs";
import { createGoalRuntime } from "./lib/goal-policy.mjs";
import { inspectTestPlan } from "./lib/test-policy.mjs";
import { withWorkspaceWriteLock } from "./lib/workspace.mjs";
import { findBlockingDurableGoal } from "./lib/goal-lease-probe.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const home = mkdtempSync(join(tmpdir(), "dur005-ce3-home-"));
const workspace = mkdtempSync(join(tmpdir(), "dur005-ce3-ws-"));
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "pkg", version: "1.0.0", scripts: { test: "node --test" } }));
writeFileSync(join(workspace, "src/a.mjs"), "export const a = 2;\n");
writeFileSync(join(workspace, "a.test.mjs"), "import test from \"node:test\"; test(\"ok\", () => {});\n");
spawnSync(process.execPath, ["./scripts/build-pidfd-helper.mjs"], { env: { ...process.env, MATRIX_HOME: home }, stdio: "ignore" });

const plan = inspectTestPlan({ kind: "node-test", command: `${process.execPath} --test`, file: process.execPath, args: ["--test"], cwd: workspace }, workspace);
const st = statSync(workspace, { bigint: true });
const goalId = newGoalId();
const store = createGoalStore(home);
store.create({
  schemaVersion: 1, id: goalId, createdAt: Date.now(), objective: "pre-onPin race",
  workspace: { path: workspace, device: String(st.dev), inode: String(st.ino), revision: null, manifest: hash("m") },
  provider: { id: "scripted", modelId: "scripted", digest: hash("p") },
  state: "ready", generation: 0, sequence: 0, budget: { ...GOAL_DEFAULT_BUDGET }, operations: [],
  criteria: [{ id: newGoalId("criterion"), revision: 1, kind: "test", planHash: plan.planHash }],
});

let rt1;
rt1 = createGoalRuntime({
  home, store, goalId, workspaceRoot: workspace, allowTests: true,
  testPlans: { defaultPlan: { kind: "node-test", command: `${process.execPath} --test`, file: process.execPath, args: ["--test"], cwd: workspace } },
  provider: { id: "scripted", modelId: "scripted", digest: hash("p"),
    runTurn: async () => ({ summary: "run test", toolCalls: [{ id: "t1", name: "test", complete: true, arguments: {} }] }),
  },
  faults: { afterTestDispatch() { rt1.pause(); } },
});
const res1 = await rt1.resume();
const ownershipFiles = existsSync(join(home, "ownership")) ? readdirSync(join(home, "ownership")).filter((f) => f.endsWith(".json")) : [];

// Resume in a fresh runtime: permanently bricked with teardown-unverified!
const rt2 = createGoalRuntime({
  home, store, goalId, workspaceRoot: workspace, allowTests: true,
  testPlans: { defaultPlan: { kind: "node-test", command: `${process.execPath} --test`, file: process.execPath, args: ["--test"], cwd: workspace } },
  provider: { id: "scripted", modelId: "scripted", digest: hash("p"), runTurn: async () => ({ summary: "done", toolCalls: [] }) },
});
const res2 = await rt2.resume();

// Yet withWorkspaceWriteLock({ home }) allows ordinary writers into the teardown-unverified workspace!
const ordinaryWriterAllowed = withWorkspaceWriteLock(workspace, () => true, { home });
console.log({
  attempt1Status: res1.status,
  ownershipFiles,
  attempt2Status: res2.status,
  attempt2ReasonCode: res2.reason?.code,
  ordinaryWriterAllowed,
});
rmSync(home, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
'
```

Observed output:

```js
{
  attempt1Status: 'paused',
  ownershipFiles: [],
  attempt2Status: 'safe-stop',
  attempt2ReasonCode: 'teardown-unverified',
  ordinaryWriterAllowed: true
}
```

---

### Finding 4 (`P1` — Focus Areas 1 & 2): `ownership.verifyTeardown` accepts non-contained ownership and reconciliation records on both its slow and fast paths, certifying `verified: true` while a detached `setsid()` descendant is still alive after its group leader exits

- **Severity:** `P1` (Blocking — violates Focus Areas 1 and 2 on detached descendants and process-containment attestation)
- **Locations:**
  - `lib/goal-policy.mjs:1065-1102` (`findEscapedDescendant`)
  - `lib/goal-policy.mjs:1371-1555` (`verifyAndTeardownTree`)
  - `lib/goal-policy.mjs:1718-1792` (`verifyTeardown`)
  - Compare with `lib/goal-lease-probe.mjs:420-424` (`containmentBound` / `sameContainment`) and `test/goal-runtime.test.mjs:992-1039`

#### Analysis

In `docs/next-phase/submissions/DUR-005.md`, the submission states:

> _"Legacy process-group-only reconciliation records cannot release an ownership block; `findBlockingDurableGoal` requires a matched `containment` identity (`kind: "pid-namespace"`, namespace inode, monitor, and namespace init) on both the ownership and reconciliation records."_

However, that requirement was only implemented in `findBlockingDurableGoal` (`lib/goal-lease-probe.mjs:420-424`), **not** in `ownership.verifyTeardown` (`lib/goal-policy.mjs:1696-1816`)!
Specifically:

1. **Slow path (`lib/goal-policy.mjs:1752-1792` -> `settleOperation` -> `verifyAndTeardownTree` at `1371-1555`):**
   When `record.namespace` and `record.containment` are absent on an ownership record (created via `ownership.recordDispatch({ ..., pid })`, the exact call used in `test/goal-runtime.test.mjs:1020-1027`), `verifyAndTeardownTree` does **not** refuse the record. Instead, it falls back to `findEscapedDescendant(record)` (`lib/goal-policy.mjs:1065-1102`) and `collectGroupMembers(record.pgid, process.pid)`.
   In `test/goal-runtime.test.mjs:992-1039` (`"detached descendants prevent a verified process-tree teardown"`), the test kept the parent leader alive (`setInterval(() => {}, 1000)`), allowing `findEscapedDescendant` to walk `/proc` `ppid` links from `record.pid` to the detached `child`.
   **As soon as the parent leader (`record.pid`) exits while its `setsid()` detached child (`escapedPid`) continues running:**
   - Linux reparents `escapedPid` to `init` / subreaper (`ppid = 1`), so `findEscapedDescendant(record)` returns `null`.
   - `record.pgid` has no remaining members (`collectGroupMembers` returns `[]`).
   - `verifyAndTeardownTree` returns `{ ok: true, mechanism: "already-exited", tree: [] }`, `settleOperation` writes `reconciled/<operationId>.json` (with `containment: null`), and **`ownership.verifyTeardown` returns `{ verified: true }` while `escapedPid` is still alive and running!**
2. **Fast path (`lib/goal-policy.mjs:1718-1751`):**
   `verifyTeardown` reads `reconciled/<operationId>.json` _before_ reading `ownership/<operationId>.json`, never checks `reconciled.containment`, and returns `{ verified: true }` even when `reconciled.containment === null` (or when `ownership/<operationId>.json` has a different containment), causing `verifyTeardown` to release the goal while `findBlockingDurableGoal` in `lib/goal-lease-probe.mjs:420-424` continues to block the workspace.

#### Reproduction

```bash
/usr/bin/node --input-type=module -e '
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createExecutionOwnership } from "./lib/goal-policy.mjs";
import { newGoalId } from "./lib/goal-contracts.mjs";
import { findBlockingDurableGoal } from "./lib/goal-lease-probe.mjs";

const home = mkdtempSync(join(tmpdir(), "dur005-ce4-home-"));
const workspace = mkdtempSync(join(tmpdir(), "dur005-ce4-ws-"));
spawnSync(process.execPath, ["./scripts/build-pidfd-helper.mjs"], { env: { ...process.env, MATRIX_HOME: home }, stdio: "ignore" });

const marker = join(workspace, "escaped-pid");
const parent = spawn(process.execPath, ["-e", `
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
  setTimeout(() => process.exit(0), 150);
`], { detached: true, stdio: "ignore" });

const ownership = createExecutionOwnership({ home });
const goalId = newGoalId();
const operationId = newGoalId("operation");
const attemptId = newGoalId("attempt");
ownership.recordDispatch({ goalId, operationId, attemptId, generation: 1, pid: parent.pid, workspaceRoot: workspace });

while (!existsSync(marker)) await new Promise((r) => setTimeout(r, 20));
const escapedPid = Number(readFileSync(marker, "utf8"));
await new Promise((r) => setTimeout(r, 250)); // parent exits; detached child stays alive

const st = statSync(workspace, { bigint: true });
const slowPathResult = ownership.verifyTeardown({
  goalId,
  workspace: { path: workspace, device: String(st.dev), inode: String(st.ino) },
  operations: [{ goalId, operationId, attemptId, generation: 1 }],
});
const fastPathResult = ownership.verifyTeardown({
  goalId,
  workspace: { path: workspace, device: String(st.dev), inode: String(st.ino) },
  operations: [{ goalId, operationId, attemptId, generation: 1 }],
});
const leaseProbeBlocker = findBlockingDurableGoal(workspace, { home });
const escapedChildStillAlive = (() => { try { process.kill(escapedPid, 0); return true; } catch { return false; } })();

console.log({
  escapedChildStillAlive,
  slowPathVerified: slowPathResult.verified,
  fastPathVerified: fastPathResult.verified,
  leaseProbeBlocked: Boolean(leaseProbeBlocker),
});
try { process.kill(escapedPid, "SIGKILL"); } catch {}
rmSync(home, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
'
```

Observed output:

```js
{
  escapedChildStillAlive: true,
  slowPathVerified: true,
  fastPathVerified: true,
  leaseProbeBlocked: true
}
```

---

### Finding 5 (`P2` — Focus Areas 2 & 3): `ownership.verifyTeardown` requires both path equality and `(device, inode)` equality, permanently bricking both existing and new goals after either a workspace rename or a workspace replacement

- **Severity:** `P2` (Substantive boundary defect — contradicts `createGoalRuntime`'s renamed-workspace support and permanently bricks new goals in renamed or replaced workspaces)
- **Locations:**
  - `lib/goal-policy.mjs:1725-1727` and `lib/goal-policy.mjs:1773-1775`
  - `lib/goal-policy.mjs:2140-2177`
  - `lib/goal-store.mjs:592-615` (`listForWorkspace`)
  - `lib/goal-executor.mjs:476-488` (`blockedOperationsFor`)

#### Analysis

- `createGoalRuntime` (`lib/goal-policy.mjs:2140-2177`) explicitly allows a workspace to be renamed if its `(device, inode)` is unchanged (covered by `test/goal-runtime.test.mjs:815`: `"goal runtime accepts a renamed workspace with the same identity"`).
- However, `verifyTeardown` (`lib/goal-policy.mjs:1725-1727, 1773-1775`) requires **both** `record.workspace.path === workspace?.path` **and** `String(record.workspace.device) === String(workspace?.device) && String(record.workspace.inode) === String(workspace?.inode)`.
- Meanwhile, `store.listForWorkspace(workspaceRoot)` (`lib/goal-store.mjs:592-615`) returns any prior goal that matches **either** `path` **or** `(device, inode)`, and `blockedOperationsFor` (`lib/goal-executor.mjs:476-488`) collects all unverified operations across `store.listForWorkspace(workspaceRoot)` and passes `workspace: current.workspace` (the new/current workspace identity) to `verifyTeardown`.
- As a result, after any timed-out, paused, cancelled, or `SIGKILL`ed test operation in `goal1`:
  1. If the workspace directory is **renamed** (`same dev/ino, new path`), neither `goal1` nor any brand-new `goal2` created at the new path can ever pass `verifyTeardown` (`ownership-workspace-mismatch` / `reconciliation-mismatch`).
  2. If the workspace directory is **deleted and recreated at the same path** (`same path, new dev/ino`), even after `goal1`'s old test process is completely dead and `reconciled`, any brand-new `goal3` created at that path inherits `goal1` from `store.listForWorkspace` and permanently safe-stops in `verifyTeardown` because `goal1`'s record has the old `(device, inode)`!

#### Reproduction

Verified in `probe-counterexamples-3.mjs` (Case 2) on both Node 24 and Node 22:

```js
{
  renamedGoal2Status: 'safe-stop',
  renamedGoal2Reason: 'teardown-unverified',
  replacedGoal3Status: 'safe-stop',
  replacedGoal3Reason: 'teardown-unverified'
}
```

---

### Finding 6 (`P2` — Focus Area 4): Pre-issued edit approvals in `createGoalAuthority` omit `planHash` / `before` file state, resolved file `mode`, `generation`, `attemptId`, `operationId`, and `workspace`, and `createGoalRuntime` retains `authority` grants and latches `controlState` across `resume()` calls

- **Severity:** `P2` (Approval scope and runtime lifecycle defect across Focus Area 4)
- **Locations:**
  - `lib/goal-policy.mjs:479-542` (`registerEditApproval`, `authorizeEdit`)
  - `lib/goal-policy.mjs:2112-2250` (`createGoalRuntime`)
  - `lib/goal-executor.mjs:1070-1092` (`planEditOperation`)

#### Analysis

1. **Unbound `before` state and inherited `0o755` file mode when `mode: null`:**
   In `lib/goal-policy.mjs:495-503` and `520-528`, `grantKey("edit", [goalId, path, content === null ? "delete" : "write", contentSha256, mode])` hashes only the requested `mode` argument (which is `null` by default), omitting `binding.planHash` (which commits to `before.exists`, `before.sha256`, `before.mode`, resolved `after.mode`, and `workspace`), `generation`, `attemptId`, and `operationId`.
   When `mode` is `null`, `planEditOperation` (`lib/goal-executor.mjs:1079-1084`) computes `targetMode = mode ?? (before.exists ? before.mode : 0o644)`. If `src/a.mjs` is modified and `chmod`ded from `0o644` to `0o755` on disk after `registerEditApproval` (with `mode: null`) and before `authorizeEdit` runs, `authorizeEdit` consumes the grant (`mode: null`) and overwrites the modified file with executable mode `0o755`.
2. **Cross-generation grant replay and latched `controlState.request` on the same `runtime` instance:**
   `createGoalRuntime` (`lib/goal-policy.mjs:2112-2250`) creates `authority` and `controlState = { request: null }` once per `createGoalRuntime(...)` call and reuses them across all `runtime.resume()` invocations:
   - A grant registered during `generation: 1` (before attempt 1 pauses) remains in `authority.grants` and is consumed in `generation: 2` on a subsequent `runtime.resume()`.
   - Calling `runtime.pause()` sets `controlState.request = "pause"` and `runtime.resume()` never resets `controlState.request = null`, so every subsequent `runtime.resume()` on that `runtime` object immediately returns `{ status: "paused", reason: { code: "paused" } }`.

#### Reproduction

Verified in `probe-counterexamples-2.mjs` (`CE_D`) on both Node 24 and Node 22:

```js
{
  staleBeforeAndMode755Completed: 'completed',
  resultingFileModeOctal: '0o755',
  gen1PauseStatus: 'paused',
  sameRuntimeResumeAfterPauseStatus: 'paused',
  sameRuntimeResumeAfterPauseReason: 'paused',
  gen2ReplayedGen1GrantStatus: 'completed'
}
```

---

### Finding 7 (`P3` — Submission & Verification Gate Hygiene): Per-file SHA-256 table typos in `docs/next-phase/submissions/DUR-005.md` and missing coverage thresholds for `DUR-005` runtime modules in `scripts/check-coverage.mjs`

- **Severity:** `P3`
- **Locations:**
  - `docs/next-phase/submissions/DUR-005.md:113, 116`
  - `scripts/check-coverage.mjs:6-33`

#### Details

1. In `docs/next-phase/submissions/DUR-005.md`:
   - Line 113 lists `lib/local-agent.mjs` as `7e4a46a2a4240fbf2c453ede40a7c725aa82571c6dfc0ef0729b2c1012bad3df` (63 hex characters; missing the `c` in `0fbfc2453` of actual `7e4a46a2a4240fbfc2453ede40a7c725aa82571c6dfc0ef0729b2c1012bad3df`).
   - Line 116 lists `scripts/matrix-pidfd-helper.c` as `d94dbece62ce8ae6a2e70e5e9ff509a8b0d69f437d646564545b3cd295d5a5e74` (65 hex characters; extra `8` in `62ce8ae6a` vs actual `d94dbece62ceae6a2e70e5e9ff509a8b0d69f437d646564545b3cd295d5a5e74`).
2. `COVERAGE_THRESHOLDS` in `scripts/check-coverage.mjs:6-33` includes `lib/goal-contracts.mjs` but omits `lib/goal-policy.mjs` (`72.31%` line / `62.30%` branch / `89.29%` func), `lib/goal-containment.mjs` (`83.56%` / `59.00%` / `84.85%`), `lib/goal-guardian.mjs` (`74.38%` / `25.00%` / `62.50%`), `lib/goal-lease-probe.mjs` (`93.28%` / `72.97%` / `96.15%`), `lib/goal-executor.mjs` (`88.45%` / `79.15%` / `93.41%`), `lib/goal-recovery.mjs` (`83.07%` / `82.76%` / `100.00%`), `lib/goal-operations.mjs`, `lib/goal-budget.mjs`, `lib/goal-context.mjs`, `lib/goal-lock.mjs`, and `lib/goal-store.mjs`.

---

## 5. Assessment Across Required Focus Areas & Verified Strengths

| Focus Area                                                                 | What Held Up Under Independent Testing                                                                                                                                                                                                                                                                                                                                                                   | Blocking / Substantive Gaps Found                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. PID-namespace & guardian containment**                                | Once `onPin` completes, Bubblewrap (`--unshare-user --unshare-pid --die-with-parent`) + `lib/goal-guardian.mjs` (`PR_SET_PDEATHSIG(SIGKILL)`) + `matrix-pidfd-helper` (`pidfd_open` + `/proc/<pid>/stat` `starttime` + `pidfd_send_signal`) reliably tear down detached `setsid()` grandchildren on normal completion, timeout, cancellation, and `SIGKILL` of the parent runtime (`dur005-driver.mjs`). | **Finding 3 (`P1`):** Pause/cancel/timeout/`SIGKILL` before `onPin` writes no ownership record, permanently bricking the goal/workspace while leaving ordinary writers unblocked. **Finding 4 (`P1`):** Non-contained records pass `verifyTeardown` after the leader exits while a detached `setsid()` child is still alive.                                                                                                  |
| **2. PID reuse, boot/host identity, helper evidence**                      | `matrix-pidfd-helper.c` opens a `pidfd` first, re-reads `/proc/<pid>/stat` `starttime` and `/proc/sys/kernel/random/boot_id`, and refuses with exit `3` (`identity-mismatch`) without signalling when a PID is reused by an unrelated process. Host/boot mismatches with different `machineId` fail closed (`host-identity-mismatch`). World-writable helper binary/dir is rejected.                     | **Finding 4 (`P1`):** `verifyTeardown` fast and slow paths omit the `containment` binding enforced by `goal-lease-probe.mjs`. **Finding 5 (`P2`):** `verifyTeardown` requires both path and `(dev, ino)` equality, failing forever after workspace rename or replacement.                                                                                                                                                     |
| **3. Ordinary & second goal writer exclusion**                             | When `{ home }` is passed (or matches `MATRIX_HOME`) and an ownership record exists or a lease is unexpired, `withWorkspaceWriteLock` and `withGoalLock` block writers; workspace rename and replacement checks in `goal-lease-probe.mjs` match by path or `(dev, ino)`.                                                                                                                                 | **Finding 2 (`P1`):** `runLocalAgent`, `runModelAgent`, and `publishIntegrationIntent` omit `{ home }` in `withWorkspaceWriteLock`, overwriting leased/blocked workspaces. **Finding 3 (`P1`):** `goal-lease-probe.mjs` ignores journal-only `teardown-unverified` blocks and post-TTL crashed `running` goals with unreceipted edits. **Finding 5 (`P2`):** Renamed/replaced workspaces brick new goals in `verifyTeardown`. |
| **4. Approval binding & stale grants after restart**                       | Approvals are kept in-memory (not persisted across process restart), reject cross-goal reuse, distinguish `delete` (`content: null`) from empty-string write (`""`), reject explicit `mode` mismatches (`0o644` vs `0o755`), keep edit/test approvals independent, and refuse `command` tools in the durable workflow.                                                                                   | **Finding 6 (`P2`):** Edit grants omit `planHash` / `before` file identity, inherited `0o755` mode when `mode: null`, `generation`, `attemptId`, `operationId`, and `workspace`; `createGoalRuntime` retains unconsumed grants and latches `controlState.request = "pause"` across `resume()`.                                                                                                                                |
| **5. Journal & audit failures before and after effects**                   | Pre-effect journal sync failure or `goal:decision` / `goal:test-start` audit failure (`requireComplete: true`) aborts before mutating the workspace or spawning the child process. Post-effect receipt/audit failure leaves the goal non-completed.                                                                                                                                                      | **Finding 1 (`P1`):** When a process crashes after an `edit` effect (or `test`/`provider` dispatch) before its receipt is recorded, a subsequent attempt can complete the goal with `receiptSequence: null` and unsettled `counters.reserved`.                                                                                                                                                                                |
| **6. Disclosed changes to `lib/goal-executor.mjs` & `lib/goal-store.mjs`** | `EXECUTION_KINDS` in `lib/goal-executor.mjs` tracks prior unverified `test`/`command` operations across attempts when ownership records exist.                                                                                                                                                                                                                                                           | **Finding 1 (`P1`):** `lib/goal-store.mjs:760-773` only checks `entry.attemptId === currentAttemptId`, allowing prior attempts' unobserved `edit`/`provider`/`read`/`search` dispatches (and reconciled `test` dispatches) to remain `receiptSequence: null` with leaked `counters.reserved` in a `"completed"` goal.                                                                                                         |

---

## 6. Required Changes Before Re-Submission

1. **Restore the Unobserved-Dispatch & Budget Settlement Invariant (`Finding 1` — `P1`):**
   - Do not allow `store.transition(goalId, authority, "completed")` to ignore unreceipted dispatches from prior attempts without a durable reconciliation receipt that settles both `receiptSequence` and `counters.reserved` (`releaseBudgetReservation`).
   - Ensure `reconcileGoalOperations` / `recoverGoalWorkspace` and `verifyTeardown` durably settle prior attempts' interrupted dispatches (`edit`, `test`, `provider`, `read`, `search`) in the journal before a subsequent attempt can transition the goal to `"completed"`.
2. **Thread `{ home }` Through Every Ordinary Workspace Writer (`Finding 2` — `P1`):**
   - Pass `{ home: backupHome }` to `withWorkspaceWriteLock` at `lib/local-agent.mjs:533, 743` and `lib/model-agent.mjs:1623, 1742`, and thread `{ home }` into `publishIntegrationIntent` at `lib/integration-publication.mjs:104`.
3. **Close the Pre-`onPin` Ownership Recording Race and Make `findBlockingDurableGoal` Journal-Aware (`Finding 3` — `P1`):**
   - Ensure an ownership record (or pre-spawn containment gate record) is durably written _before_ or atomically with test dispatch / `bwrap` spawn so that an abort, pause, cancel, timeout, or `SIGKILL` before `onPin` never leaves a journal `teardown-unverified` operation without a reconcilable ownership record, or allow `verifyTeardown` to reconcile a pre-`onPin` aborted dispatch after proving no namespace/child process survived.
   - Update `findBlockingDurableGoal` in `lib/goal-lease-probe.mjs` so that (a) any goal whose journal has an unresolved `teardown-unverified` operation blocks ordinary writers even if `ownership/<operationId>.json` is missing, and (b) a crashed `running` goal with an expired lease TTL and unreceipted `edit` / pending `.matrix-transaction-*.json` artifact blocks ordinary writers until `reclaimStaleGoalAttempt` / `recoverGoalWorkspace` reconciles the workspace.
4. **Enforce `containment` Identity in `verifyTeardown` on Both Slow and Fast Paths (`Finding 4` — `P1`):**
   - In `lib/goal-policy.mjs`, require valid `pid-namespace` containment on both `readOwnershipRecord` (slow path) and `readReconciledRecord` + `readOwnershipRecord` (fast path) in `verifyTeardown`, matching `lib/goal-lease-probe.mjs:420-424`, so a non-contained process-group record whose leader exited after spawning a `setsid()` detached child can never be certified as `{ verified: true }`.
5. **Align Workspace Identity Matching in `verifyTeardown` Across Renamed and Replaced Workspaces (`Finding 5` — `P2`):**
   - Allow `verifyTeardown` to reconcile an ownership record when `(device, inode)` matches after a workspace rename (consistent with `createGoalRuntime`), and when a workspace directory has been replaced at the same path (`same path, new dev/ino`), allow `verifyTeardown` to verify that the old goal's process tree is gone using the ownership record's recorded workspace identity rather than failing forever with `ownership-workspace-mismatch`.
6. **Bind Edit Approvals to `before` State / Resolved `mode` / `generation` and Reset Per-Attempt Runtime State (`Finding 6` — `P2`):**
   - Include `planHash` (or `before` file identity + resolved `targetMode`), `workspace`, and `generation` in `createGoalAuthority` edit grants, and reset `controlState.request` and stale single-attempt grants across `runtime.resume()` invocations.
7. **Fix `DUR-005.md` Digest Typos and Add `DUR-005` Modules to `COVERAGE_THRESHOLDS` (`Finding 7` — `P3`).**
