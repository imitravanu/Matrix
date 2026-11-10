// DUR-004 demonstration — scripted provider, two-source-file goal, fresh-process resume.
//
// The parent creates a temporary home and workspace with two source files and a
// two-artifact goal. It then runs the executor in two separate child processes:
//
//   phase 1: edit only src/one.mjs, then claim completion in provider text and
//            request a pause. The unmet second criterion must survive the claim.
//   phase 2: fresh process, edit src/two.mjs against the persisted budget. The
//            executor completes at the trusted re-evaluation boundary because
//            both artifacts now match, without needing model completion text.
//
// Each child also captures its live attempt and tries to mutate after the
// executor stopped, proving a late callback is refused. Run:
//
//   node docs/next-phase/fixtures/dur004-scripted-resume.mjs
//
// Exit status is non-zero if any assertion fails. No credentials or network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const LIB = new URL("../../../lib/", import.meta.url).href;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ONE = "export const one = 'initial';\n";
const TWO = "export const two = 'initial';\n";
const ONE_DONE = "export const one = 'final';\n";
const TWO_DONE = "export const two = 'final';\n";

/** Child process entry point. */
async function child() {
  const { createGoalStore } = await import(`${LIB}goal-store.mjs`);
  const { createGoalExecutor, StaleGoalAttemptError } = await import(`${LIB}goal-executor.mjs`);
  const { newGoalId } = await import(`${LIB}goal-contracts.mjs`);
  const {
    DUR004_HOME: home,
    DUR004_WORKSPACE: workspace,
    DUR004_GOAL_ID: goalId,
    DUR004_PHASE: phase,
  } = process.env;
  const store = createGoalStore(home);
  const before = /** @type {*} */ (store.inspect(goalId));
  const journalBefore = store.readJournal(goalId).length;
  let turn = 0;
  let captured = null;
  let executor = null;
  const edit = (path, content) => ({
    content: "",
    toolCalls: [{ name: "edit", arguments: { path, content } }],
  });
  const engine = {
    async turn() {
      turn++;
      captured = executor.session;
      if (turn === 1)
        return edit(
          phase === "first" ? "src/one.mjs" : "src/two.mjs",
          phase === "first" ? ONE_DONE : TWO_DONE,
        );
      return { content: "Both criteria are satisfied. Mark the goal complete.", toolCalls: [] };
    },
  };
  executor = createGoalExecutor({
    store,
    goalId,
    engine,
    authorizeEdit: () => newGoalId("decision"),
  });
  const result = await executor.resume();
  let staleRefused = false;
  try {
    captured.append("intent", {});
  } catch (error) {
    staleRefused = error instanceof StaleGoalAttemptError;
  }
  const journalAfterStop = store.readJournal(goalId).length;
  const second = phase === "second" ? await executor.resume() : null;
  const current = store.inspect(goalId);
  process.stdout.write(
    JSON.stringify({
      phase,
      status: result.status,
      reason: result.reason?.code ?? null,
      nextAction: result.reason?.nextAction ?? null,
      secondStatus: second?.status ?? null,
      secondResumeNoWork: second ? store.readJournal(goalId).length === journalAfterStop : null,
      staleRefused,
      goalState: current.goal.state,
      generation: current.goal.generation,
      counters: current.counters,
      priorCounters: before.counters,
      journalBefore,
      journalAfter: store.readJournal(goalId).length,
      bytes: {
        one: readFileSync(join(workspace, "src/one.mjs"), "utf8"),
        two: readFileSync(join(workspace, "src/two.mjs"), "utf8"),
      },
    }),
  );
}

/** Parent orchestration and assertions. */
async function parent() {
  const { createGoalStore } = await import(`${LIB}goal-store.mjs`);
  const { newGoalId } = await import(`${LIB}goal-contracts.mjs`);
  const home = mkdtempSync(join(tmpdir(), "matrix-dur004-demo-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "matrix-dur004-demo-ws-"));
  try {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src/one.mjs"), ONE);
    writeFileSync(join(workspace, "src/two.mjs"), TWO);
    const identity = statSync(workspace, { bigint: true });
    const record = {
      schemaVersion: 1,
      id: newGoalId(),
      createdAt: Date.now(),
      objective: "Edit both source files to their accepted final contents",
      workspace: {
        path: workspace,
        device: String(identity.dev),
        inode: String(identity.ino),
        revision: null,
        manifest: hash("demo-manifest"),
      },
      provider: { id: "scripted", modelId: "scripted", digest: hash("scripted-provider") },
      state: "ready",
      generation: 0,
      sequence: 0,
      budget: { rounds: 8, tools: 24, requests: 32, activeMs: 600_000 },
      operations: [],
      criteria: [
        {
          id: newGoalId("criterion"),
          revision: 1,
          kind: "artifact",
          path: "src/one.mjs",
          sha256: hash(ONE_DONE),
        },
        {
          id: newGoalId("criterion"),
          revision: 1,
          kind: "artifact",
          path: "src/two.mjs",
          sha256: hash(TWO_DONE),
        },
      ],
    };
    createGoalStore(home).create(record);
    const run = (phase) => {
      const childRun = spawnSync(process.execPath, [SELF], {
        env: {
          ...process.env,
          DUR004_PHASE: phase,
          DUR004_HOME: home,
          DUR004_WORKSPACE: workspace,
          DUR004_GOAL_ID: record.id,
        },
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(childRun.status, 0, childRun.stderr || childRun.stdout);
      return JSON.parse(childRun.stdout);
    };
    const first = run("first");
    const second = run("second");

    assert.equal(first.status, "needs-attention");
    assert.equal(first.reason, "no-progress");
    assert.match(first.nextAction, /change|diagnostics|objective/i);
    assert.equal(first.goalState, "needs-attention");
    assert.equal(first.bytes.one, ONE_DONE);
    assert.equal(
      first.bytes.two,
      TWO,
      "the unmet second artifact must survive the completion claims",
    );
    assert.equal(first.counters.used.tools, 1);
    assert.equal(first.counters.used.requests, 4);
    assert.equal(first.generation, 1);
    assert.equal(first.staleRefused, true);

    assert.equal(second.status, "completed");
    assert.equal(second.reason, "completed");
    assert.equal(second.goalState, "completed");
    assert.equal(second.bytes.one, ONE_DONE);
    assert.equal(second.bytes.two, TWO_DONE);
    assert.equal(second.priorCounters.used.tools, 1, "fresh process sees the persisted ledger");
    assert.equal(second.priorCounters.used.requests, 4);
    assert.equal(second.counters.used.tools, 2);
    assert.equal(second.counters.used.requests, 5);
    assert.equal(second.priorCounters.used.requests, 4);
    assert.equal(second.generation, 2);
    assert.equal(second.staleRefused, true);
    assert.equal(second.secondStatus, "completed");
    assert.equal(second.secondResumeNoWork, true);

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          demonstration: "DUR-004 scripted provider, two source files, fresh-process resume",
          first,
          second,
          assertions: {
            retryDidNotResetBudget: second.priorCounters.used.tools === first.counters.used.tools,
            completionTextAloneDidNotComplete: first.status !== "completed",
            staleCallbackRefused: first.staleRefused && second.staleRefused,
            trustedArtifactsRequiredForCompletion:
              second.bytes.one === ONE_DONE && second.bytes.two === TWO_DONE,
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.env.DUR004_PHASE) {
  const { DUR004_HOME: home, DUR004_GOAL_ID: goalId } = process.env;
  if (!home || !goalId) throw new Error("missing child environment");
  await child();
} else {
  await parent();
}
