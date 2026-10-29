import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

import { createRunController } from "../lib/controller.mjs";
import { createParallelRun } from "../lib/parallel-run.mjs";
import { inspectIntegrationIntent } from "../lib/integration-intent.mjs";
import { loadSession } from "../lib/session.mjs";
import { copyDemo, patchEnv, waitFor } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";

for (const changedFile of ["src/processor.py", "check.test.cjs", "generated.txt"]) {
  test(`non-Git publication refuses a passing test that modifies ${changedFile}`, async (t) => {
    const demo = copyDemo("matrix-nongit-test-drift-");
    const home = join(demo.root, "home");
    const restore = patchEnv({ MATRIX_HOME: home });
    writeFileSync(
      join(demo.workspace, "package.json"),
      JSON.stringify({ scripts: { test: "node --test check.test.cjs" } }),
    );
    writeFileSync(
      join(demo.workspace, "check.test.cjs"),
      `const test = require('node:test'); const fs = require('node:fs'); test('passes', () => fs.writeFileSync(${JSON.stringify(changedFile)}, 'unexpected test edit\\n'));\n`,
    );
    const original = existsSync(join(demo.workspace, changedFile))
      ? readFileSync(join(demo.workspace, changedFile))
      : null;
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
    const plan = run.createPlan([
      { path: "src/processor.py", source: "agent", agentId: "agent-01" },
    ]);
    const approval = run.requestIntegrationApproval(plan);
    run.decide({
      agentId: "integration",
      approvalId: approval.approvalId,
      kind: "integration",
      decision: "y",
    });
    assert.equal(run.integrate(plan, approval).integrationStatus, "integrated");
    const approved = existsSync(join(plan.root, changedFile))
      ? readFileSync(join(plan.root, changedFile))
      : null;
    const verification = await run.verify({ requestTestApproval: async () => "y" });
    assert.equal(verification.verification.verified, true);
    const publication = run.publish();
    assert.equal(publication.status, "failed");
    assert.equal(publication.publicationStatus, "failed");
    assert.equal(publication.verification.verified, false);
    assert.match(publication.publicationError, /Result changed/);
    assert.equal(
      readFileSync(join(publication.resultWorkspace, changedFile), "utf8"),
      "unexpected test edit\n",
    );
    if (original) assert.deepEqual(readFileSync(join(demo.workspace, changedFile)), original);
    else assert.equal(existsSync(join(demo.workspace, changedFile)), false);
    if (approved) writeFileSync(join(publication.resultWorkspace, changedFile), approved);
    else rmSync(join(publication.resultWorkspace, changedFile));
    const retried = run.publish();
    assert.equal(retried.publicationStatus, "published");
    assert.equal(retried.status, "unverified");
    assert.equal(retried.verification.verified, false);
    assert.equal((await run.discard()).ok, true);
    assert.ok(existsSync(publication.resultWorkspace));
  });
}

test("repeated directory publication rechecks the result instead of returning cached success", async (t) => {
  const demo = copyDemo("matrix-parallel-republish-");
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
  const integrated = run.integrate(plan, approval);
  await run.verify({ requestTestApproval: async () => "n" });
  assert.equal(run.publish().publicationStatus, "published");
  writeFileSync(join(integrated.resultWorkspace, "src", "processor.py"), "later edit\n");
  const next = run.publish();
  assert.equal(next.publicationStatus, "failed");
  assert.equal(next.status, "failed");
  assert.match(next.publicationError, /Result changed/);
});

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
  assert.notEqual(result.resultWorkspace, demo.workspace);
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
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
  assert.ok(existsSync(join(result.resultWorkspace, "src", "processor.py")));
  const session = loadSession(result.recoverySessionId, { home, cwd: result.resultWorkspace });
  const recovery = createRunController({ home });
  t.after(() => recovery.dispose());
  assert.equal(
    recovery.restoreFromSession(session.undoRun, { root: result.resultWorkspace }),
    true,
  );
  assert.equal(recovery.undoLast().ok, true);
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
});

test("external edits during integration remain in the original workspace", async (t) => {
  const demo = copyDemo("matrix-parallel-external-edit-");
  const home = join(demo.root, "home");
  const target = join(demo.workspace, "src", "processor.py");
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
    onEvent(event) {
      if (event.type === "integration:started") {
        execFileSync(process.execPath, [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1], "external edit\\n")',
          target,
        ]);
      }
    },
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
  assert.equal(
    run.pendingApprovals().find((item) => item.approvalId === approval.approvalId).request
      .destination,
    plan.root,
  );
  run.decide({
    agentId: "integration",
    approvalId: approval.approvalId,
    kind: "integration",
    decision: "y",
  });
  const result = run.integrate(plan, approval);
  assert.equal(result.integrationStatus, "integrated");
  assert.equal(readFileSync(target, "utf8"), "external edit\n");
  assert.match(
    readFileSync(join(result.resultWorkspace, "src", "processor.py"), "utf8"),
    /bounds\[0:len\(bounds\)\]/,
  );
  assert.equal((await run.discard()).ok, true);
  assert.equal(readFileSync(target, "utf8"), "external edit\n");
  assert.ok(existsSync(result.resultWorkspace));
});

test("a process exit after a result write leaves inspectable write-ahead evidence", (t) => {
  const demo = copyDemo("matrix-parallel-crash-intent-");
  t.after(() => demo.cleanup());
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  const script = `
    import { createParallelRun } from './lib/parallel-run.mjs';
    import { writeSync } from 'node:fs';
    const [root, home, scratchDir] = process.argv.slice(1);
    const task = ${JSON.stringify(TASK)};
    const run = createParallelRun({root, home, scratchDir, headless: true,
      jobs: [{task, autoApprove: true}, {task, autoApprove: true}],
      onEvent(event) { if (event.type === 'integration:applied') process.exit(29); }});
    await run.done;
    run.analyze();
    const plan = run.createPlan([{path: 'src/processor.py', source: 'agent', agentId: 'agent-01'}]);
    const approval = run.requestIntegrationApproval(plan);
    run.decide({agentId: 'integration', approvalId: approval.approvalId, kind: 'integration', decision: 'y'});
    writeSync(1, JSON.stringify({root: plan.root, sessionId: 'parallel-' + run.batchId}) + '\\n');
    run.integrate(plan, approval);
  `;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      demo.workspace,
      join(demo.root, "home"),
      join(demo.root, "scratch"),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(child.status, 29, child.stderr);
  const resultRoot = JSON.parse(child.stdout.trim()).root;
  const sessionId = JSON.parse(child.stdout.trim()).sessionId;
  const intent = inspectIntegrationIntent(join(resultRoot, "..", "integration-intent.json"));
  assert.deepEqual(intent.entries, [{ path: "src/processor.py", state: "matches-after" }]);
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
  const recovered = loadSession(sessionId, { home: join(demo.root, "home"), cwd: resultRoot });
  assert.equal(recovered.integrationRecovery, "postimages-present");
  assert.equal(recovered.undoRun.entries.length, 1);
  const cliRecovery = spawnSync(
    process.execPath,
    ["bin/matrix.mjs", "recover", join(resultRoot, "..", "integration-intent.json")],
    {
      cwd: process.cwd(),
      env: { ...process.env, MATRIX_HOME: join(demo.root, "home") },
      encoding: "utf8",
    },
  );
  assert.equal(cliRecovery.status, 0, cliRecovery.stderr);
  assert.equal(JSON.parse(cliRecovery.stdout).undoEntries, 1);
  const controller = createRunController({ home: join(demo.root, "home") });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(recovered.undoRun, { root: resultRoot }), true);
  assert.equal(controller.undoLast().ok, true);
  assert.deepEqual(readFileSync(join(resultRoot, "src", "processor.py")), original);
  writeFileSync(join(resultRoot, "src", "processor.py"), "later edit\n");
  const warnings = [];
  const refused = loadSession(sessionId, {
    home: join(demo.root, "home"),
    cwd: resultRoot,
    onWarning: (warning) => warnings.push(warning),
  });
  assert.equal(refused.integrationRecovery, "refused");
  assert.equal(refused.undoRun, null);
  assert.ok(warnings.some((warning) => warning.code === "integration-recovery-refused"));
  assert.equal(
    inspectIntegrationIntent(join(resultRoot, "..", "integration-intent.json")).entries[0].state,
    "diverged",
  );
  const inspection = spawnSync(
    process.execPath,
    ["bin/inspect-integration.mjs", join(resultRoot, "..", "integration-intent.json")],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.equal(JSON.parse(inspection.stdout).entries[0].state, "diverged");
  writeFileSync(join(resultRoot, "..", "integration-intent.json"), "{}");
  assert.throws(
    () => inspectIntegrationIntent(join(resultRoot, "..", "integration-intent.json")),
    /malformed or changed/,
  );
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
  assert.equal(result.integrationStatus, "failed");
  assert.match(result.error, /disk full/);
  assert.equal(result.recoverySessionId, null);
  assert.equal(result.undoRun, null);
});

test("a recovery update failure retains the partial result without changing the original", async (t) => {
  const demo = copyDemo("matrix-parallel-session-update-failure-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  let saves = 0;
  const run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
    saveSessionImpl: () =>
      ++saves === 1 ? { ok: true } : { ok: false, warnings: [{ message: "disk full" }] },
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
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
  assert.equal((await run.discard()).ok, true);
  assert.ok(existsSync(result.resultWorkspace));
});

test("parallel run cancellation during integration persists the applied recovery prefix", async (t) => {
  const demo = copyDemo("matrix-parallel-integration-abort-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  let run;
  run = createParallelRun({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    headless: true,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
    onEvent(event) {
      if (event.type === "integration:applied") run.abort();
    },
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
  assert.equal(result.status, "aborted");
  assert.equal(result.integrationStatus, "partial");
  assert.ok(result.recoverySessionId);
  const session = loadSession(result.recoverySessionId, { home, cwd: result.resultWorkspace });
  const recovery = createRunController({ home });
  t.after(() => recovery.dispose());
  assert.equal(
    recovery.restoreFromSession(session.undoRun, { root: result.resultWorkspace }),
    true,
  );
  assert.equal(recovery.undoLast().ok, true);
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
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
  const saved = loadSession(result.recoverySessionId, { home, cwd: result.resultWorkspace });
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
  assert.equal((await run.discard()).ok, true);
  assert.equal(existsSync(plan.root), false);
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
  const head = git("rev-parse", "HEAD");
  const index = readFileSync(join(demo.workspace, ".git", "index"));
  const published = run.publish();
  assert.equal(published.publicationStatus, "published", published.publicationError);
  assert.equal(published.status, "unverified");
  assert.match(
    git("show", `${published.publication.commit}:src/processor.py`),
    /bounds\[0:len\(bounds\)\]/,
  );
  assert.equal(git("rev-parse", "HEAD"), head);
  assert.deepEqual(readFileSync(join(demo.workspace, ".git", "index")), index);
  assert.equal(git("rev-parse", published.publication.ref), published.publication.commit);
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
