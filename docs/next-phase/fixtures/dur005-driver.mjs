import { statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The driver is copied into a temporary workspace before it runs, so it cannot
// resolve the checkout from its own location. The caller passes the package
// root explicitly instead of hardcoding one developer's home directory.
const PACKAGE_ROOT = process.env.DUR005_PACKAGE_ROOT;
if (!PACKAGE_ROOT) {
  console.error("DUR005-RESULT " + JSON.stringify({ error: "DUR005_PACKAGE_ROOT is required" }));
  process.exit(2);
}
const moduleUrl = (relative) => pathToFileURL(join(PACKAGE_ROOT, relative)).href;

const { createGoalStore } = await import(moduleUrl("lib/goal-store.mjs"));
const { createGoalRuntime, createGoalAuthority, reclaimStaleGoalAttempt } = await import(
  moduleUrl("lib/goal-policy.mjs")
);
const { inspectTestPlan } = await import(moduleUrl("lib/test-policy.mjs"));

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
