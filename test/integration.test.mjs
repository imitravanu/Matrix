import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { createRunController } from "../lib/controller.mjs";
import { captureManifest, diffManifests } from "../lib/isolated-manifest.mjs";
import { classifyCombinedVerification, createIntegrationCoordinator } from "../lib/integration.mjs";
import { createApprovalBroker } from "../lib/parallel-approvals.mjs";
import { writeFileAtomic } from "../lib/workspace.mjs";
import { makeTempDir } from "./helpers.mjs";

function fixture(t, prefix = "matrix-integration-") {
  const root = makeTempDir(prefix);
  const original = join(root, "original");
  const home = join(root, "home");
  mkdirSync(original);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, original, home };
}

function agentSnapshot(root, agentId, mutate) {
  const before = captureManifest(root);
  mutate(root);
  const after = captureManifest(root);
  return {
    agentId,
    agentRunId: `run-${agentId}`,
    workspaceKind: "copy",
    workspaceRoot: root,
    before,
    after,
    result: { ok: true, status: "success" },
  };
}

function copyAgent(original, parent, name) {
  const root = join(parent, name);
  cpSync(original, root, { recursive: true, verbatimSymlinks: true });
  return root;
}

function coordinatorFor(original, home, options = {}) {
  const broker = options.broker ?? createApprovalBroker({ batchId: "batch-integration" });
  const coordinator = createIntegrationCoordinator({
    root: original,
    home,
    broker,
    ...options,
  });
  return { broker, coordinator };
}

function decideIntegration(broker, request, decision = "y") {
  return broker.decide({
    agentId: "integration",
    approvalId: request.approvalId,
    kind: request.kind ?? "integration",
    decision,
  });
}

test("path conflicts need explicit resolutions; approved serial integration publishes exact undo prefixes", async (t) => {
  const { root, original, home } = fixture(t);
  for (const [name, text] of [
    ["a.txt", "a\n"],
    ["b.txt", "b\n"],
    ["same.txt", "same\n"],
  ]) {
    writeFileSync(join(original, name), text);
  }
  const baseManifest = captureManifest(original);
  const aRoot = copyAgent(original, root, "agent-a");
  const bRoot = copyAgent(original, root, "agent-b");
  const agents = [
    agentSnapshot(aRoot, "agent-01", (workspace) => {
      writeFileSync(join(workspace, "a.txt"), "a from one\n");
      writeFileSync(join(workspace, "same.txt"), "same from one\n");
      writeFileSync(join(workspace, "created.txt"), "create from one\n");
    }),
    agentSnapshot(bRoot, "agent-02", (workspace) => {
      writeFileSync(join(workspace, "b.txt"), "b from two\n");
      writeFileSync(join(workspace, "same.txt"), "same from two\n");
      writeFileSync(join(workspace, "created.txt"), "create from two\n");
    }),
  ];
  const undoEvents = [];
  const { broker, coordinator } = coordinatorFor(original, home, {
    onUndo: (undo) => undoEvents.push(undo),
  });
  const analysis = coordinator.analyze({
    batchId: "batch-integration",
    root: original,
    baseManifest,
    agents,
  });
  assert.deepEqual(
    analysis.conflicts.map((conflict) => conflict.path),
    ["created.txt", "same.txt"],
  );
  assert.deepEqual(
    analysis.candidates.map((candidate) => candidate.path),
    ["a.txt", "b.txt"],
  );
  assert.throws(() => coordinator.createPlan(analysis), /Unresolved integration conflict/);
  assert.throws(
    () => coordinator.createPlan(analysis, { resolutions: [{ path: "same.txt", source: "base" }] }),
    /created.txt/,
  );

  const plan = coordinator.createPlan(analysis, {
    resolutions: [
      { path: "same.txt", source: "agent", agentId: "agent-02" },
      { path: "created.txt", source: "agent", agentId: "agent-01" },
    ],
  });
  assert.deepEqual(
    plan.entries.map((entry) => entry.path),
    ["a.txt", "b.txt", "created.txt", "same.txt"],
  );
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  const approval = coordinator.requestApproval(plan);
  const review = broker.inspect({
    agentId: "integration",
    approvalId: approval.approvalId,
    kind: "integration",
  });
  assert.deepEqual(
    review.request.changes.map(({ path, original, updatedText }) => ({
      path,
      original,
      updatedText,
    })),
    [
      { path: "a.txt", original: "a\n", updatedText: "a from one\n" },
      { path: "b.txt", original: "b\n", updatedText: "b from two\n" },
      { path: "created.txt", original: "", updatedText: "create from one\n" },
      { path: "same.txt", original: "same\n", updatedText: "same from two\n" },
    ],
  );
  const beforeApproval = coordinator.integrateApproved(plan, approval);
  assert.equal(beforeApproval.integrationStatus, "approval-required");
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "a\n");
  assert.equal(decideIntegration(broker, { ...approval, kind: "command" }).ok, false);
  assert.equal(
    coordinator.integrateApproved(plan, approval).integrationStatus,
    "approval-required",
  );
  assert.equal(decideIntegration(broker, approval).ok, true);

  const result = coordinator.integrateApproved(plan, approval);
  assert.equal(result.integrationStatus, "integrated");
  assert.equal(result.writeOk, true);
  assert.equal(result.status, "unverified");
  assert.equal(result.verificationStatus, "unverified");
  assert.deepEqual(result.pending, []);
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "a from one\n");
  assert.equal(readFileSync(join(original, "b.txt"), "utf8"), "b from two\n");
  assert.equal(readFileSync(join(original, "same.txt"), "utf8"), "same from two\n");
  assert.equal(readFileSync(join(original, "created.txt"), "utf8"), "create from one\n");
  assert.deepEqual(
    undoEvents.map((undo) => undo.entries.length),
    [1, 2, 3, 4],
  );
  assert.equal(JSON.stringify(result.undoRun).includes(aRoot), false);
  assert.equal(JSON.stringify(result.undoRun).includes(bRoot), false);
  assert.equal(
    coordinator.integrateApproved(plan, approval).integrationStatus,
    "approval-required",
  );

  const verified = classifyCombinedVerification(result, {
    ok: true,
    verified: true,
    verificationStatus: "verified",
  });
  assert.equal(verified.status, "success");
  const failed = classifyCombinedVerification(result, {
    ok: false,
    verified: false,
    verificationStatus: "failed",
    summary: "combined tests failed",
  });
  assert.equal(failed.status, "failed");

  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
  const undone = controller.undoLast();
  assert.equal(undone.ok, true, undone.error);
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "a\n");
  assert.equal(readFileSync(join(original, "b.txt"), "utf8"), "b\n");
  assert.equal(readFileSync(join(original, "same.txt"), "utf8"), "same\n");
  assert.equal(exists(join(original, "created.txt")), false);
});

test("deletion, type, symlink, and binary changes require conservative base resolutions", async (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-unsupported-");
  writeFileSync(join(original, "safe.txt"), "safe\n");
  writeFileSync(join(original, "gone.txt"), "delete me\n");
  writeFileSync(join(original, "binary.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(original, "type.txt"), "file\n");
  symlinkSync("safe.txt", join(original, "alias.txt"));
  const baseManifest = captureManifest(original);
  const aRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(aRoot, "agent-01", (workspace) => {
    writeFileSync(join(workspace, "safe.txt"), "safe after\n");
    rmSync(join(workspace, "gone.txt"));
    writeFileSync(join(workspace, "binary.bin"), Buffer.from([0, 9]));
    rmSync(join(workspace, "type.txt"));
    mkdirSync(join(workspace, "type.txt"));
    rmSync(join(workspace, "alias.txt"));
    symlinkSync("gone.txt", join(workspace, "alias.txt"));
  });
  const { broker, coordinator } = coordinatorFor(original, home);
  const analysis = coordinator.analyze({
    batchId: "batch-integration",
    root: original,
    baseManifest,
    agents: [agent],
  });
  assert.deepEqual(analysis.requiredResolutions, [
    "alias.txt",
    "binary.bin",
    "gone.txt",
    "type.txt",
  ]);
  assert.throws(
    () =>
      coordinator.createPlan(analysis, {
        resolutions: [
          ...analysis.requiredResolutions.map((path) => ({ path, source: "base" })),
          { path: "gone.txt", source: "agent", agentId: "agent-01" },
        ],
      }),
    /duplicate/,
  );
  assert.throws(
    () =>
      coordinator.createPlan(analysis, {
        resolutions: analysis.requiredResolutions.map((path) =>
          path === "gone.txt"
            ? { path, source: "agent", agentId: "agent-01" }
            : { path, source: "base" },
        ),
      }),
    /resolve it to base/,
  );

  const plan = coordinator.createPlan(analysis, {
    resolutions: analysis.requiredResolutions.map((path) => ({ path, source: "base" })),
  });
  assert.deepEqual(
    plan.entries.map((entry) => entry.path),
    ["safe.txt"],
  );
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);
  assert.equal(result.integrationStatus, "integrated");
  assert.equal(readFileSync(join(original, "safe.txt"), "utf8"), "safe after\n");
  assert.equal(readFileSync(join(original, "gone.txt"), "utf8"), "delete me\n");
  assert.equal(readFileSync(join(original, "type.txt"), "utf8"), "file\n");
  assert.deepEqual(readFileSync(join(original, "binary.bin")), Buffer.from([0, 1, 2]));
  assert.equal(readlinkSync(join(original, "alias.txt")), "safe.txt");
});

test("external base drift and plan mutation are rejected before any original write", async (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-drift-");
  writeFileSync(join(original, "a.txt"), "base\n");
  const baseManifest = captureManifest(original);
  const aRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(aRoot, "agent-01", (workspace) => {
    writeFileSync(join(workspace, "a.txt"), "after\n");
  });
  const { broker, coordinator } = coordinatorFor(original, home);
  const analysis = coordinator.analyze({
    batchId: "batch-integration",
    root: original,
    baseManifest,
    agents: [agent],
  });
  const driftPlan = coordinator.createPlan(analysis);
  const driftApproval = coordinator.requestApproval(driftPlan);
  decideIntegration(broker, driftApproval);
  writeFileSync(join(original, "a.txt"), "external\n");
  const drift = coordinator.integrateApproved(driftPlan, driftApproval);
  assert.equal(drift.integrationStatus, "failed");
  assert.deepEqual(drift.applied, []);
  assert.deepEqual(drift.pending, ["a.txt"]);
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "external\n");

  writeFileSync(join(original, "a.txt"), "base\n");
  const second = coordinatorFor(original, home);
  const secondAnalysis = second.coordinator.analyze({
    batchId: "batch-integration",
    root: original,
    baseManifest,
    agents: [agent],
  });
  const changedPlan = second.coordinator.createPlan(secondAnalysis);
  const changedApproval = second.coordinator.requestApproval(changedPlan);
  decideIntegration(second.broker, changedApproval);
  changedPlan.entries[0].after = { ...changedPlan.entries[0].after, hash: "0".repeat(64) };
  const changed = second.coordinator.integrateApproved(changedPlan, changedApproval);
  assert.equal(changed.integrationStatus, "approval-required");
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "base\n");
});

test("a later writer failure reports an applied prefix and pending paths without rollback", async (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-partial-");
  writeFileSync(join(original, "a.txt"), "a base\n");
  writeFileSync(join(original, "b.txt"), "b base\n");
  const baseManifest = captureManifest(original);
  const aRoot = copyAgent(original, root, "agent-a");
  const bRoot = copyAgent(original, root, "agent-b");
  const agents = [
    agentSnapshot(aRoot, "agent-01", (workspace) =>
      writeFileSync(join(workspace, "a.txt"), "a after\n"),
    ),
    agentSnapshot(bRoot, "agent-02", (workspace) =>
      writeFileSync(join(workspace, "b.txt"), "b after\n"),
    ),
  ];
  const { broker, coordinator } = coordinatorFor(original, home, {
    writeFile(path, content, entry) {
      if (entry.path === "b.txt") throw new Error("injected integration writer failure");
      return writeFileAtomic(path, content);
    },
  });
  const analysis = coordinator.analyze({
    batchId: "batch-integration",
    root: original,
    baseManifest,
    agents,
  });
  const plan = coordinator.createPlan(analysis);
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);

  assert.equal(result.integrationStatus, "partial");
  assert.equal(result.status, "failed");
  assert.match(result.error, /injected/);
  assert.deepEqual(
    result.applied.map((entry) => entry.path),
    ["a.txt"],
  );
  assert.deepEqual(result.pending, ["b.txt"]);
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "a after\n");
  assert.equal(readFileSync(join(original, "b.txt"), "utf8"), "b base\n");
  assert.deepEqual(
    result.undoRun.entries.map((entry) => entry.file),
    ["a.txt"],
  );

  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
  assert.equal(controller.undoLast().ok, true);
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "a base\n");
});

test("recovery persistence failure stops further writes and returns the applied undo prefix", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-persist-failure-");
  writeFileSync(join(original, "a.txt"), "a base\n");
  writeFileSync(join(original, "b.txt"), "b base\n");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) => {
    writeFileSync(join(workspace, "a.txt"), "a after\n");
    writeFileSync(join(workspace, "b.txt"), "b after\n");
  });
  const { broker, coordinator } = coordinatorFor(original, home, {
    onUndo() {
      throw new Error("storage unavailable");
    },
  });
  const plan = coordinator.createPlan(
    coordinator.analyze({
      batchId: "batch-integration",
      root: original,
      baseManifest,
      agents: [agent],
    }),
  );
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);
  assert.equal(result.integrationStatus, "partial");
  assert.match(result.error, /Recovery persistence failed.*storage unavailable/);
  assert.deepEqual(result.pending, ["b.txt"]);
  assert.equal(readFileSync(join(original, "b.txt"), "utf8"), "b base\n");
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
  assert.equal(controller.undoLast().ok, true);
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "a base\n");
});

test("base is revalidated between serial writes and an external later-path edit is preserved", async (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-window-");
  writeFileSync(join(original, "a.txt"), "a base\n");
  writeFileSync(join(original, "b.txt"), "b base\n");
  const baseManifest = captureManifest(original);
  const aRoot = copyAgent(original, root, "agent-a");
  const bRoot = copyAgent(original, root, "agent-b");
  const agents = [
    agentSnapshot(aRoot, "agent-01", (workspace) =>
      writeFileSync(join(workspace, "a.txt"), "a after\n"),
    ),
    agentSnapshot(bRoot, "agent-02", (workspace) =>
      writeFileSync(join(workspace, "b.txt"), "b after\n"),
    ),
  ];
  const { broker, coordinator } = coordinatorFor(original, home, {
    writeFile(path, content, entry) {
      const written = writeFileAtomic(path, content);
      if (entry.path === "a.txt") writeFileSync(join(original, "b.txt"), "external b\n");
      return written;
    },
  });
  const analysis = coordinator.analyze({
    batchId: "batch-integration",
    root: original,
    baseManifest,
    agents,
  });
  const plan = coordinator.createPlan(analysis);
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);
  assert.equal(result.integrationStatus, "partial");
  assert.deepEqual(
    result.applied.map((entry) => entry.path),
    ["a.txt"],
  );
  assert.deepEqual(result.pending, ["b.txt"]);
  assert.equal(readFileSync(join(original, "b.txt"), "utf8"), "external b\n");
});

test("oversized integration reviews fail before requesting approval or writing", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-review-budget-");
  const before = "a".repeat(5 * 1024 * 1024);
  writeFileSync(join(original, "large.txt"), before);
  const baseManifest = captureManifest(original);
  const aRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(aRoot, "agent-01", (workspace) => {
    writeFileSync(join(workspace, "large.txt"), "b".repeat(5 * 1024 * 1024));
  });
  const { broker, coordinator } = coordinatorFor(original, home);
  const plan = coordinator.createPlan(
    coordinator.analyze({
      batchId: "batch-integration",
      root: original,
      baseManifest,
      agents: [agent],
    }),
  );
  assert.throws(() => coordinator.requestApproval(plan), /review exceeds its byte budget/);
  assert.deepEqual(broker.pending(), []);
  assert.equal(readFileSync(join(original, "large.txt"), "utf8"), before);
});

test("incomplete manifests cannot silently become an exact integration base", (t) => {
  const { original } = fixture(t, "matrix-integration-capped-");
  writeFileSync(join(original, "a.txt"), "a\n");
  writeFileSync(join(original, "b.txt"), "b\n");
  const complete = captureManifest(original);
  const capped = captureManifest(original, { entries: 1 });
  assert.equal(complete.complete, true);
  assert.equal(capped.complete, false);
  assert.equal(capped.exact, false);
  assert.throws(() => diffManifests(capped, complete), /incomplete/);
});

function exists(path) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
