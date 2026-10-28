import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createRunController } from "../lib/controller.mjs";
import { createIntegrationCoordinator } from "../lib/integration.mjs";
import { createParallelBatch } from "../lib/parallel-batch.mjs";
import { loadSession, saveSession } from "../lib/session.mjs";
import { copyDemo, patchEnv, waitFor } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";

function approvalIdentity(event) {
  return {
    agentId: event.agentId,
    approvalId: event.approvalId,
    kind: event.kind ?? "edit",
  };
}

test("real controllers edit sibling copies with independent gates, run IDs, fresh roots, and retained cleanup", async (t) => {
  const demo = copyDemo("matrix-parallel-gates-");
  const home = join(demo.root, "home");
  const restoreEnv = patchEnv({ MATRIX_HOME: home });
  const events = [];
  const controllers = [];
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  const batch = createParallelBatch({
    root: demo.workspace,
    batchId: "batch-real-gates",
    scratchDir: join(demo.root, "scratch"),
    home,
    headless: true,
    jobs: [
      { task: TASK, autoApprove: false },
      { task: TASK, autoApprove: false },
    ],
    controllerFactory(options) {
      const controller = createRunController(options);
      controllers.push(controller);
      return controller;
    },
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await batch.discard();
    restoreEnv();
    demo.cleanup();
  });

  const requests = await waitFor(() => {
    const found = events.filter((event) => event.type === "approval:request");
    return found.length === 2 ? found : null;
  });
  assert.ok(requests, "both real controllers reach their own edit gate");
  assert.equal(controllers.length, 2);
  assert.equal(new Set(controllers).size, 2);
  assert.notEqual(requests[0].agentId, requests[1].agentId);
  assert.notEqual(requests[0].approvalId, requests[1].approvalId);
  assert.notEqual(requests[0].agentRunId, requests[1].agentRunId);
  assert.ok(requests.every((event) => event.runId === event.agentRunId));
  assert.ok(requests.every((event) => event.workspaceKind === "copy"));
  assert.ok(requests.every((event) => event.proposal.absPath.startsWith(demo.workspace) === false));

  assert.equal(batch.decide({ ...approvalIdentity(requests[0]), decision: "y" }).ok, true);
  const firstSettled = await waitFor(() => batch.getState().agents[0].status === "settled");
  assert.ok(firstSettled);
  assert.equal(batch.getState().agents[1].status, "running");
  assert.equal(batch.getState().agents[0].result.applied, 1);
  const applied = events.find(
    (event) => event.type === "applied" && event.agentId === requests[0].agentId,
  );
  assert.ok(applied.backupPath, "isolated edits have a recovery backup");
  assert.equal(
    applied.backupPath.startsWith(home),
    false,
    "child backup must not enter the parent home",
  );
  assert.ok(
    applied.backupPath.startsWith(join(demo.root, "scratch")),
    "child backup belongs to its private home",
  );
  assert.equal(
    batch.pendingApprovals().length,
    1,
    "the first edit grant does not approve its sibling",
  );
  assert.equal(batch.decide({ ...approvalIdentity(requests[0]), decision: "n" }).ok, false);

  assert.equal(batch.decide({ ...approvalIdentity(requests[1]), decision: "n" }).ok, true);
  const result = await batch.done;
  assert.equal(result.agents[0].result.status, "unverified");
  assert.equal(result.agents[1].result.status, "denied");
  assert.equal(result.integrationAvailable, true);
  const retained = batch.getIntegrationInput();
  assert.equal(retained.agents.length, 2);
  assert.ok(retained.agents.every((agent) => agent.before.complete && agent.after.complete));
  assert.ok(retained.agents.every((agent) => !("undoRun" in agent) && !("recoveryPaths" in agent)));
  const roots = events
    .filter((event) => event.type === "workspace:ready")
    .map((event) => event.workspaceRoot);
  assert.equal(roots.length, 2);
  assert.ok(roots.every((root) => existsSync(root)));
  assert.ok(
    events.every((event) => "batchId" in event && "agentId" in event && "approvalId" in event),
  );

  const integration = createIntegrationCoordinator({
    root: demo.workspace,
    home,
    broker: batch.approvals,
    onUndo(undoRun) {
      const saved = saveSession(
        { id: "parallel-recovery", cwd: demo.workspace, undoRun },
        { home },
      );
      assert.equal(saved.ok, true);
    },
  });
  const analysis = integration.analyze(retained);
  const plan = integration.createPlan(analysis);
  const approval = integration.requestApproval(plan);
  assert.equal(
    batch.decide({
      agentId: "integration",
      approvalId: approval.approvalId,
      kind: "integration",
      decision: "y",
    }).ok,
    true,
  );
  const integrated = integration.integrateApproved(plan, approval);
  assert.equal(integrated.integrationStatus, "integrated");
  assert.equal(integrated.status, "unverified", "integration does not infer combined verification");
  assert.ok(
    readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(
      "bounds[0:len(bounds)]",
    ),
  );
  assert.ok(integrated.undoRun.entries.every((entry) => entry.absPath.startsWith(demo.workspace)));

  const cleaned = await batch.discard();
  assert.equal(cleaned.ok, true, cleaned.error);
  assert.ok(
    roots.every((root) => !existsSync(root)),
    "discard also cleans completed leases",
  );
  assert.equal((await batch.discard()).ok, true);
  const saved = loadSession("parallel-recovery", { home, cwd: demo.workspace });
  const recovered = createRunController({ home });
  t.after(() => recovered.dispose());
  assert.equal(recovered.restoreFromSession(saved.undoRun, { root: demo.workspace }), true);
  assert.equal(recovered.undoLast().ok, true);
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
});

test("a per-agent test allow decision does not replay into a sibling isolated root", async (t) => {
  const demo = copyDemo("matrix-parallel-test-authority-");
  const home = join(demo.root, "home");
  const restoreEnv = patchEnv({ MATRIX_HOME: home });
  writeFileSync(
    join(demo.workspace, "package.json"),
    JSON.stringify({ name: "parallel-test-authority", scripts: { test: "node verify.mjs" } }),
  );
  writeFileSync(
    join(demo.workspace, "verify.mjs"),
    'console.log("# pass 1\\n# fail 0\\n# duration_ms 1");\n',
  );
  const events = [];
  const batch = createParallelBatch({
    root: demo.workspace,
    batchId: "batch-test-authority",
    scratchDir: join(demo.root, "scratch"),
    home,
    jobs: [
      { task: TASK, autoApprove: true, allowTests: true },
      { task: TASK, autoApprove: true, allowTests: false },
    ],
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await batch.discard();
    restoreEnv();
    demo.cleanup();
  });

  const request = await waitFor(() =>
    events.find((event) => event.type === "approval:request" && event.kind === "test"),
  );
  assert.ok(request, "the sibling without its own test decision must ask");
  assert.equal(request.agentId, "agent-02");
  const roots = events
    .filter((event) => event.type === "workspace:ready")
    .map((event) => event.workspaceRoot);
  assert.equal(roots.length, 2);
  assert.equal(roots.includes(request.request.workspace), true);
  assert.notEqual(request.request.workspace, demo.workspace);
  assert.equal(
    events.some(
      (event) =>
        event.type === "approval:request" && event.kind === "test" && event.agentId === "agent-01",
    ),
    false,
    "the explicitly allowed agent consumes only its own policy",
  );
  assert.equal(batch.decide({ ...approvalIdentity(request), decision: "n" }).ok, true);
  const result = await batch.done;
  assert.equal(result.agents[0].result.status, "success");
  assert.equal(result.agents[1].result.status, "unverified");
  assert.equal(result.agents[1].result.result.verifyTests.trustStatus, "denied");
});

test("abort with A waiting, B executing, and C queued denies gates, awaits B, and cleans every lease", async (t) => {
  const demo = copyDemo("matrix-parallel-abort-");
  const home = join(demo.root, "home");
  const restoreEnv = patchEnv({ MATRIX_HOME: home });
  writeFileSync(
    join(demo.workspace, "package.json"),
    JSON.stringify({ name: "parallel-abort-fixture", scripts: { test: "node wait.mjs" } }),
  );
  writeFileSync(join(demo.workspace, "wait.mjs"), "setInterval(() => {}, 1000);\n");
  const events = [];
  const controllers = [];
  const batch = createParallelBatch({
    root: demo.workspace,
    batchId: "batch-real-abort",
    scratchDir: join(demo.root, "scratch"),
    home,
    jobs: [
      { task: TASK, autoApprove: false, allowTests: false },
      { task: TASK, autoApprove: true, allowTests: true },
      { task: TASK, autoApprove: true, allowTests: true },
    ],
    controllerFactory(options) {
      const controller = createRunController(options);
      controllers.push(controller);
      return controller;
    },
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await batch.discard();
    restoreEnv();
    demo.cleanup();
  });

  const ready = await waitFor(() => {
    const waiting = events.find(
      (event) => event.type === "approval:request" && event.agentId === "agent-01",
    );
    const executing = events.find(
      (event) => event.type === "verify:start" && event.agentId === "agent-02",
    );
    return waiting && executing ? { waiting, executing } : null;
  });
  assert.ok(ready, "A is waiting while B is really executing verification");
  assert.equal(controllers.length, 2);
  assert.deepEqual(
    batch.getState().agents.map((agent) => agent.status),
    ["running", "running", "queued"],
  );
  assert.equal(
    events.some((event) => event.type === "run:start" && event.agentId === "agent-03"),
    false,
  );
  const roots = events
    .filter((event) => event.type === "workspace:ready")
    .map((event) => event.workspaceRoot);
  assert.equal(roots.length, 2);

  assert.equal(batch.abort(), true);
  const result = await batch.done;
  assert.equal(result.aborted, true);
  assert.equal(result.cleanup.ok, true, result.cleanup.error);
  assert.equal(controllers.length, 2, "C never starts after the abort");
  assert.equal(result.agents[2].result.status, "aborted");
  assert.equal(batch.pendingApprovals().length, 0);
  assert.equal(batch.decide({ ...approvalIdentity(ready.waiting), decision: "y" }).ok, false);
  assert.ok(roots.every((root) => !existsSync(root)));
  assert.throws(() => batch.getIntegrationInput(), /unavailable/);
  const abortedApproval = events.find(
    (event) => event.type === "approval:result" && event.agentId === "agent-01",
  );
  assert.equal(abortedApproval?.approvalId, ready.waiting.approvalId);
});

test("real batches use detached worktrees for a clean temporary repository without changing its baseline", async (t) => {
  const demo = copyDemo("matrix-parallel-worktree-batch-");
  const home = join(demo.root, "home");
  const restoreEnv = patchEnv({ MATRIX_HOME: home });
  const git = (...args) =>
    execFileSync("git", ["-C", demo.workspace, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "matrix-fixture@example.invalid");
  git("config", "user.name", "Matrix Fixture");
  git("add", ".");
  git("commit", "-q", "-m", "parallel fixture base");
  const original = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  const events = [];
  const batch = createParallelBatch({
    root: demo.workspace,
    batchId: "batch-worktrees",
    scratchDir: join(demo.root, "scratch"),
    home,
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
    onEvent: (event) => events.push(event),
  });
  t.after(async () => {
    await batch.discard();
    restoreEnv();
    demo.cleanup();
  });

  const result = await batch.done;
  assert.ok(result.agents.every((agent) => agent.workspaceKind === "worktree"));
  assert.ok(result.agents.every((agent) => agent.result.applied === 1));
  assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8"), original);
  assert.equal(git("status", "--porcelain"), "");
  const retained = batch.getIntegrationInput();
  assert.match(retained.baseRevision, /^[a-f0-9]{40}$/);
  assert.ok(retained.agents.every((agent) => agent.setup.detachedHead === retained.baseRevision));
  const roots = retained.agents.map((agent) => agent.workspaceRoot);
  assert.equal((await batch.discard()).ok, true);
  assert.ok(roots.every((root) => !existsSync(root)));
  assert.equal(git("worktree", "list", "--porcelain").includes(roots[0]), false);
  assert.ok(
    events.every((event) => event.workspaceKind == null || event.workspaceKind === "worktree"),
  );
});

test("cleanup refuses a child-supplied recovery path in the parent home", async (t) => {
  const demo = copyDemo("matrix-parallel-foreign-recovery-");
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  const backupDir = join(home, "backups");
  mkdirSync(backupDir, { recursive: true });
  const otherBackup = join(backupDir, "other-run");
  writeFileSync(otherBackup, "keep me");
  const batch = createParallelBatch({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    jobs: [{ task: TASK }],
    controllerFactory: () => ({
      start: async () => ({ ok: false, status: "unverified" }),
      currentRun: () => null,
      abort: () => false,
      approve: () => false,
      getUndoRun: () => ({ entries: [{ backupPath: otherBackup }] }),
      clearUndo: () => {},
      dispose: () => {},
    }),
  });
  await batch.done;
  const cleanup = await batch.discard();
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.error, /unsafe isolated recovery path/);
  assert.equal(readFileSync(otherBackup, "utf8"), "keep me");
});

test("batch validation rejects inferred authorities and invalid jobs before scratch side effects", (t) => {
  const demo = copyDemo("matrix-parallel-validation-");
  t.after(() => demo.cleanup());
  const scratch = join(demo.root, "not-created");
  assert.throws(
    () =>
      createParallelBatch({
        root: demo.workspace,
        jobs: [{ task: TASK }],
        autoApprove: true,
        scratchDir: scratch,
      }),
    /per-agent only/,
  );
  assert.throws(
    () =>
      createParallelBatch({
        root: demo.workspace,
        jobs: [{ task: TASK }, { task: "" }],
        scratchDir: scratch,
      }),
    /empty task/,
  );
  assert.throws(
    () =>
      createParallelBatch({
        root: demo.workspace,
        jobs: [{ task: TASK }],
        maxActive: 0,
        scratchDir: scratch,
      }),
    /maxActive/,
  );
  assert.throws(
    () =>
      createParallelBatch({
        root: demo.workspace,
        jobs: [{ task: TASK, enableCommands: false, approvedCommandPlanHash: "0".repeat(64) }],
        scratchDir: scratch,
      }),
    /without the command capability/,
  );
  assert.throws(
    () =>
      createParallelBatch({
        root: demo.workspace,
        jobs: [{ task: TASK }],
        scratchDir: scratch,
        manifestLimits: { entries: 1 },
      }),
    /Original base manifest is incomplete/,
  );
  assert.equal(existsSync(scratch), false);
});
