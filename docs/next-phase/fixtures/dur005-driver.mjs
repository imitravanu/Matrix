import { statSync } from "node:fs";
import { createGoalStore } from "/home/mitravanu/matrix/lib/goal-store.mjs";
import { createGoalRuntime, createGoalAuthority } from "/home/mitravanu/matrix/lib/goal-policy.mjs";
import { inspectTestPlan } from "/home/mitravanu/matrix/lib/test-policy.mjs";

const home = process.env.DUR005_HOME;
const workspace = process.env.DUR005_WORKSPACE;
const mode = process.env.DUR005_MODE || "run";
const testPlan = JSON.parse(process.env.DUR005_TEST_PLAN);
const toolTimeoutMs = Number(process.env.DUR005_TOOL_TIMEOUT_MS || 800);

function loadGoal() {
  const store = createGoalStore(home);
  const identity = statSync(workspace, { bigint: true });
  const goals = store.listWorkspaceGoals({
    path: workspace,
    device: String(identity.dev),
    inode: String(identity.ino),
  });
  return { store, goalId: goals[0].id };
}

if (mode === "reclaim") {
  const { goalId } = loadGoal();
  const { reclaimStaleGoalAttempt } = await import("/home/mitravanu/matrix/lib/goal-policy.mjs");
  const result = reclaimStaleGoalAttempt({ home, goalId, workspace });
  console.log("DUR005-RESULT " + JSON.stringify(result));
  process.exit(0);
}

if (mode === "inspect") {
  const store = createGoalStore(home);
  const { goalId } = loadGoal();
  const status = store.inspect(goalId);
  console.log(
    "DUR005-RESULT " +
      JSON.stringify({
        state: status.goal.state,
        generation: status.goal.generation,
        lease: status.lease,
        journalLength: store.readJournal(goalId).length,
      }),
  );
  process.exit(0);
}

if (mode === "run") {
  const store = createGoalStore(home);
  const identity = statSync(workspace, { bigint: true });
  const goalId = process.env.DUR005_GOAL_ID;
  const authority = createGoalAuthority({
    home,
    workspace: { path: workspace, device: String(identity.dev), inode: String(identity.ino) },
  });
  const inspected = inspectTestPlan(testPlan, { cwd: testPlan.cwd });
  let turn = 0;
  const engine = {
    async turn() {
      turn += 1;
      if (turn === 1) {
        authority.registerTestGrant({ planHash: inspected.plan.planHash, approved: true, goalId });
        return {
          content: "",
          toolCalls: [{ name: "test", arguments: { planHash: inspected.plan.planHash } }],
        };
      }
      return { content: "done", toolCalls: [] };
    },
  };
  const runtime = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine,
    testPlan,
    authority,
    headless: true,
    allowTests: true,
    toolTimeoutMs,
    helperPath: process.env.DUR005_HELPER || null,
  });
  const result = await runtime.resume();
  console.log(
    "DUR005-RESULT " +
      JSON.stringify({
        status: result.status,
        state: result.goal?.state,
        generation: result.goal?.generation,
        reason: result.reason,
        journalLength: store.readJournal(goalId).length,
      }),
  );
  process.exit(0);
}
