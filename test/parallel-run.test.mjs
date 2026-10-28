import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { createRunController } from "../lib/controller.mjs";
import { createParallelRun } from "../lib/parallel-run.mjs";
import { loadSession } from "../lib/session.mjs";
import { copyDemo, patchEnv, waitFor } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";

test("parallel lifecycle resolves conflicts, persists recovery, and requires separate combined test trust", async (t) => {
  const demo = copyDemo("matrix-parallel-lifecycle-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  const run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
  });
  t.after(async () => {
    await run.discard();
    restore();
    demo.cleanup();
  });
  assert.throws(() => run.analyze(), /unavailable/);
  const settled = await run.done;
  assert.equal(settled.agents.length, 2);
  assert.ok(settled.agents.every((agent) => agent.result.applied === 1));
  const analysis = run.analyze();
  assert.deepEqual(analysis.requiredResolutions, ["src/processor.py"]);
  assert.throws(() => run.createPlan(), /Unresolved/);
  const plan = run.createPlan([{ path: "src/processor.py", source: "agent", agentId: "agent-01" }]);
  const approval = run.requestIntegrationApproval(plan);
  assert.equal(run.integrate(plan, approval).integrationStatus, "approval-required");
  assert.equal(
    run.decide({
      agentId: "integration",
      approvalId: approval.approvalId,
      kind: "integration",
      decision: "y",
    }).ok,
    true,
  );
  const result = run.integrate(plan, approval);
  assert.equal(result.integrationStatus, "integrated");
  assert.equal(result.status, "unverified");
  assert.ok(result.recoverySessionId);
  await assert.rejects(run.verify(), /explicit test approval/);
  let requests = 0;
  const verified = await run.verify({
    requestTestApproval: async () => {
      requests += 1;
      return "n";
    },
  });
  assert.equal(requests, 1);
  assert.equal(verified.verification.verified, false);
  assert.equal(verified.status, "unverified");
  assert.equal((await run.discard()).ok, true);
  const session = loadSession(result.recoverySessionId, { home, cwd: demo.workspace });
  const recovery = createRunController({ home });
  t.after(() => recovery.dispose());
  assert.equal(recovery.restoreFromSession(session.undoRun, { root: demo.workspace }), true);
  assert.equal(recovery.undoLast().ok, true);
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
});

test("combined test approval executes against the integrated workspace and reports real results", async (t) => {
  const demo = copyDemo("matrix-parallel-combined-verify-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  const run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
  });
  t.after(async () => {
    await run.discard();
    restore();
    demo.cleanup();
  });
  await run.done;
  run.analyze();
  const plan = run.createPlan([{ path: "src/processor.py", source: "agent", agentId: "agent-01" }]);
  const approval = run.requestIntegrationApproval(plan);
  run.decide({
    agentId: "integration",
    approvalId: approval.approvalId,
    kind: "integration",
    decision: "y",
  });
  assert.equal(run.integrate(plan, approval).integrationStatus, "integrated");
  const requests = [];
  const result = await run.verify({
    requestTestApproval: async (request) => {
      requests.push(request.kind);
      return "y";
    },
  });
  assert.deepEqual(requests, ["workspace", "test-plan"]);
  assert.equal(result.verification.verified, true);
  assert.equal(result.verification.passed, 4);
  assert.equal(result.status, "success");
});

test("failed recovery persistence never advertises a saved session", async (t) => {
  const demo = copyDemo("matrix-parallel-session-failure-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  const run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
    saveSessionImpl: () => ({ ok: false, warnings: [{ message: "disk full" }] }),
  });
  t.after(async () => {
    await run.discard();
    restore();
    demo.cleanup();
  });
  await run.done;
  run.analyze();
  const plan = run.createPlan([{ path: "src/processor.py", source: "agent", agentId: "agent-01" }]);
  const approval = run.requestIntegrationApproval(plan);
  run.decide({
    agentId: "integration",
    approvalId: approval.approvalId,
    kind: "integration",
    decision: "y",
  });
  const result = run.integrate(plan, approval);
  assert.equal(result.integrationStatus, "partial");
  assert.match(result.error, /disk full/);
  assert.equal(result.recoverySessionId, null);
  assert.equal(result.undoRun.entries.length, 1);
});

test("cancelling combined verification terminates the real test process and preserves recovery", async (t) => {
  const demo = copyDemo("matrix-parallel-verify-cancel-");
  const home = join(demo.root, "home");
  const marker = join(demo.root, "test-started");
  const restore = patchEnv({ MATRIX_HOME: home });
  writeFileSync(
    join(demo.workspace, "package.json"),
    JSON.stringify({ name: "cancel-fixture", scripts: { test: "node wait.mjs" } }),
  );
  writeFileSync(
    join(demo.workspace, "wait.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started"); setInterval(() => {}, 1000);\n`,
  );
  const run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
  });
  t.after(async () => {
    await run.discard();
    restore();
    demo.cleanup();
  });
  await run.done;
  run.analyze();
  const plan = run.createPlan([{ path: "src/processor.py", source: "agent", agentId: "agent-01" }]);
  const approval = run.requestIntegrationApproval(plan);
  run.decide({
    agentId: "integration",
    approvalId: approval.approvalId,
    kind: "integration",
    decision: "y",
  });
  const integrated = run.integrate(plan, approval);
  const cancellation = new AbortController();
  const verifying = run.verify({
    signal: cancellation.signal,
    requestTestApproval: async () => "y",
  });
  assert.ok(await waitFor(() => existsSync(marker)), "combined test actually started");
  assert.equal(run.abort(), true);
  const result = await verifying;
  assert.equal(result.verification.aborted, true);
  assert.equal(result.status, "aborted");
  assert.equal(result.recoverySessionId, integrated.recoverySessionId);
  const saved = loadSession(result.recoverySessionId, { home, cwd: demo.workspace });
  assert.ok(saved.undoRun.entries.length);
});

test("aborting a settled batch revokes its pending final integration approval", async (t) => {
  const demo = copyDemo("matrix-parallel-settled-abort-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  const run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
  });
  t.after(async () => {
    await run.discard();
    restore();
    demo.cleanup();
  });
  await run.done;
  run.analyze();
  const plan = run.createPlan([{ path: "src/processor.py", source: "agent", agentId: "agent-01" }]);
  const approval = run.requestIntegrationApproval(plan);
  assert.equal(run.abort(), true);
  assert.equal(run.abort(), false);
  assert.equal(
    run.decide({
      agentId: "integration",
      approvalId: approval.approvalId,
      kind: "integration",
      decision: "y",
    }).ok,
    false,
  );
  assert.throws(() => run.integrate(plan, approval), /aborted/);
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
});

test("abort interrupts a pending combined test-trust callback and discard settles", async (t) => {
  const demo = copyDemo("matrix-parallel-verify-pending-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  const run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
  });
  t.after(async () => {
    await run.discard();
    restore();
    demo.cleanup();
  });
  await run.done;
  run.analyze();
  const plan = run.createPlan([{ path: "src/processor.py", source: "agent", agentId: "agent-01" }]);
  const approval = run.requestIntegrationApproval(plan);
  run.decide({
    agentId: "integration",
    approvalId: approval.approvalId,
    kind: "integration",
    decision: "y",
  });
  run.integrate(plan, approval);
  let requested = false;
  const verification = run.verify({
    requestTestApproval: () => {
      requested = true;
      return new Promise(() => {});
    },
  });
  assert.ok(await waitFor(() => requested));
  const cleanup = run.discard();
  const result = await verification;
  assert.equal(result.status, "aborted");
  assert.equal(result.verification.aborted, true);
  assert.equal((await cleanup).ok, true);
});

test("real worktree batch and combined discovery never run repository filter commands", async (t) => {
  const demo = copyDemo("matrix-parallel-git-filter-");
  const home = join(demo.root, "home");
  const marker = join(demo.root, "filter-ran");
  const filter = join(demo.root, "filter.sh");
  const restore = patchEnv({ MATRIX_HOME: home });
  const git = (...args) =>
    execFileSync("git", ["-C", demo.workspace, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "matrix-fixture@example.invalid");
  git("config", "user.name", "Matrix Fixture");
  writeFileSync(join(demo.workspace, ".gitattributes"), "src/processor.py filter=fixture\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(filter, 0o755);
  git("config", "filter.fixture.clean", filter);
  git("config", "filter.fixture.smudge", filter);
  git("config", "core.fsmonitor", filter);
  const discovered = [];
  const run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    onEvent: (event) => {
      if (event.type === "workspace:ready") discovered.push(event.project);
    },
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
  });
  t.after(async () => {
    await run.discard();
    restore();
    demo.cleanup();
  });
  const result = await run.done;
  assert.ok(
    result.agents.every(
      (agent) => agent.workspaceKind === "worktree" && agent.result.applied === 1,
    ),
  );
  run.analyze();
  const plan = run.createPlan([{ path: "src/processor.py", source: "agent", agentId: "agent-01" }]);
  const approval = run.requestIntegrationApproval(plan);
  run.decide({
    agentId: "integration",
    approvalId: approval.approvalId,
    kind: "integration",
    decision: "y",
  });
  assert.equal(run.integrate(plan, approval).integrationStatus, "integrated");
  const verification = await run.verify({ requestTestApproval: async () => "n" });
  assert.equal(verification.status, "unverified");
  assert.equal(
    existsSync(marker),
    false,
    "no repository filter runs during discovery, isolation, or integration",
  );
  assert.equal(discovered.length, 2);
  assert.ok(
    discovered.every((project) => project.gitStatus === "unavailable" && project.dirty === null),
  );
  assert.equal((await run.discard()).ok, true);
  assert.equal(existsSync(marker), false);
});
