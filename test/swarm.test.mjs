import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { runLocalAgent } from "../lib/local-agent.mjs";
import { detectProject } from "../lib/project.mjs";
import {
  applySwarmEvent,
  createSwarmState,
  focusLane,
  getSwarmLayout,
  laneById,
  laneList,
} from "../lib/swarm.mjs";
import { copyDemo } from "./helpers.mjs";

const PLAN = [
  { title: "Index workspace", status: "done" },
  { title: "Read scopes", status: "done" },
  { title: "Propose patch", status: "active" },
  { title: "Verify tests", status: "pending" },
];

test("swarm state starts idle and never mutates its input", () => {
  const project = {
    name: "demo-project",
    root: "/tmp/demo-project",
    branch: "main",
    fileCount: 2,
    test: { display: "python3 -m pytest -q" },
  };
  const initial = createSwarmState({ task: "", project });
  assert.equal(initial.mode, "idle");
  assert.equal(initial.lanes.planner.status, "idle");
  assert.equal(laneList(initial).length, 3);
  assert.equal(laneById(initial, "forge").title, "FORGE");
  assert.equal(laneById(initial, "nope"), null);
  const next = applySwarmEvent(initial, {
    type: "run:start",
    task: "fix the bug",
    mode: "local",
    plan: PLAN,
  });
  assert.notEqual(next, initial);
  assert.equal(initial.mode, "idle");
  assert.equal(initial.lanes.planner.logs.length, 0);
  assert.equal(next.mode, "running");
  assert.equal(next.task, "fix the bug");
  assert.equal(next.lanes.planner.status, "active");
  assert.deepEqual(next.lanes.planner.steps.map((step) => step.title), PLAN.map((step) => step.title));
  assert.equal(next.lanes.planner.agent, "matrix/local");
  assert.equal(next.lanes.forge.agent, "matrix/local");
  assert.ok(next.lanes.planner.logs[0].text.includes("fix the bug"));
});

test("swarm state follows proposal, approval, apply, verification and result", () => {
  let state = createSwarmState({ task: "fix", project: { name: "demo", fileCount: 2 } });
  state = applySwarmEvent(state, { type: "run:start", task: "fix", modelName: "Claude", mode: "remote", plan: PLAN });
  assert.equal(state.lanes.planner.agent, "Claude");
  assert.equal(state.lanes.forge.agent, "Claude");
  state = applySwarmEvent(state, { type: "phase", phase: "editing" });
  assert.equal(state.lanes.planner.status, "done");
  assert.equal(state.lanes.forge.status, "active");
  state = applySwarmEvent(state, {
    type: "proposal",
    proposal: {
      file: "src/x.py",
      scope: "class X › def y",
      stats: { adds: 2, dels: 1 },
      patch: "@@ -1,2 +1,2 @@\n-old\n+new\n",
    },
  });
  assert.equal(state.mode, "waiting");
  assert.equal(state.lanes.forge.status, "waiting");
  assert.equal(state.lanes.forge.file, "src/x.py");
  assert.equal(state.lanes.forge.stats.adds, 2);
  assert.match(state.lanes.forge.statusText, /awaiting approval/);
  state = applySwarmEvent(state, { type: "approval:request" });
  state = applySwarmEvent(state, { type: "approval:result", decision: "y" });
  assert.equal(state.lanes.forge.status, "active");
  state = applySwarmEvent(state, {
    type: "applied",
    file: "src/x.py",
    stats: { adds: 2, dels: 1 },
    backupPath: "/tmp/backup",
  });
  assert.equal(state.lanes.forge.status, "applied");
  assert.match(state.lanes.forge.statusText, /applied/);
  assert.ok(state.lanes.forge.logs.some((log) => log.text.includes("backup saved")));
  state = applySwarmEvent(state, { type: "verify:start", command: "pytest" });
  assert.equal(state.lanes.radar.status, "active");
  state = applySwarmEvent(state, { type: "verify:line", line: "4 passed" });
  assert.equal(state.lanes.radar.logs.at(-1).text, "4 passed");
  state = applySwarmEvent(state, {
    type: "verify:end",
    result: { ok: true, passed: 4, failed: 0, summary: "4 passed", durationMs: 42, command: "pytest" },
  });
  assert.equal(state.lanes.radar.status, "done");
  assert.equal(state.lanes.radar.passed, 4);
  assert.equal(state.lanes.radar.duration, "42ms");
  state = applySwarmEvent(state, {
    type: "metrics",
    metrics: { elapsedMs: 1234, rounds: 2, toolCalls: 3, cost: 0.01 },
  });
  assert.equal(state.elapsedMs, 1234);
  assert.equal(state.metrics.toolCalls, 3);
  state = applySwarmEvent(state, {
    type: "result",
    result: {
      summary: "4 passed",
      editFile: { path: "src/x.py", scope: "class X", stats: { adds: 2, dels: 1 }, status: "approved", diff: ["+new"] },
      verifyTests: { passed: 4, failed: 0, summary: "4 passed", duration: "42ms", cmd: "pytest", ok: true },
    },
  });
  assert.equal(state.mode, "done");
  assert.equal(state.lanes.planner.status, "done");
  assert.equal(state.lanes.forge.statusText, "applied");
  assert.equal(state.lanes.radar.status, "done");
});

test("denial and errors terminate the relevant lanes truthfully", () => {
  let state = createSwarmState({ task: "fix" });
  state = applySwarmEvent(state, { type: "run:start", task: "fix" });
  state = applySwarmEvent(state, { type: "approval:result", decision: "n" });
  assert.equal(state.mode, "done");
  assert.equal(state.lanes.forge.status, "denied");
  state = applySwarmEvent(state, { type: "verify:skipped", reason: "no test runner" });
  assert.equal(state.lanes.radar.status, "skipped");
  assert.match(state.lanes.radar.summary, /no test runner/);
  state = applySwarmEvent(state, { type: "error", error: "boom" });
  assert.equal(state.mode, "error");
  assert.ok(state.lanes.planner.logs.some((log) => log.text === "boom"));
  const failed = applySwarmEvent(state, {
    type: "verify:end",
    result: { ok: false, failed: 2, passed: 1, summary: "1 passed · 2 failed" },
  });
  assert.equal(failed.lanes.radar.status, "error");
});

test("focusLane cycles deterministically", () => {
  let state = createSwarmState();
  assert.equal(state.focusedLane, 0);
  state = focusLane(state, 1);
  assert.equal(state.focusedLane, 1);
  state = focusLane(state, 1);
  assert.equal(state.focusedLane, 2);
  state = focusLane(state, 1);
  assert.equal(state.focusedLane, 0);
  state = focusLane(state, -1);
  assert.equal(state.focusedLane, 2);
});

test("responsive lane geometry always fits the terminal exactly", () => {
  for (const [cols, mode, count] of [
    [140, "triple", 3],
    [96, "triple", 3],
    [95, "dual", 2],
    [64, "dual", 2],
    [63, "tabbed", 1],
    [40, "tabbed", 1],
  ]) {
    const layout = getSwarmLayout(cols, 2);
    assert.equal(layout.mode, mode, `${cols} columns`);
    assert.equal(layout.lanes.length, count);
    assert.equal(
      layout.widths.reduce((sum, width) => sum + width, 0) + layout.gap * (layout.widths.length - 1),
      cols
    );
    assert.equal(layout.focusedLane, 2);
    if (mode === "dual") assert.deepEqual(layout.lanes, [2, 0]);
  }
});

test("logs are bounded even under a stream of events", () => {
  let state = createSwarmState({ task: "long" });
  state = applySwarmEvent(state, { type: "run:start", task: "long" });
  for (let i = 0; i < 120; i++) {
    state = applySwarmEvent(state, { type: "thought", text: `thinking ${i}` });
  }
  assert.equal(state.lanes.planner.logs.length, 80);
  assert.match(state.lanes.planner.logs.at(-1).text, /thinking 119/);
});

test("real Local Forge events drive all three lanes to completion", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const events = [];
  const previousHome = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = join(demo.root, "home");
  t.after(() => {
    if (previousHome === undefined) delete process.env.MATRIX_HOME;
    else process.env.MATRIX_HOME = previousHome;
  });
  const result = await runLocalAgent({
    task: "Fix the off-by-one in the bounds slice in src/processor.py",
    project,
    autoApprove: true,
    onEvent: (event) => events.push(event),
  });
  let state = createSwarmState({ task: "fix", project });
  for (const event of events) state = applySwarmEvent(state, event);
  assert.equal(result.editFile.status, "applied");
  assert.equal(state.mode, "done");
  assert.equal(state.lanes.planner.status, "done");
  assert.ok(["applied", "done"].includes(state.lanes.forge.status));
  assert.equal(state.lanes.radar.status, "done");
  assert.equal(state.lanes.radar.passed, 4);
  assert.equal(state.lanes.radar.failed, 0);
  assert.ok(state.lanes.planner.steps.length > 0);
  assert.ok(state.lanes.planner.steps.every((step) => step.status === "done" || step.status === "skipped"));
  assert.ok(state.metrics.elapsedMs >= 0);
});
