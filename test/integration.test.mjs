import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  renameSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { createRunController } from "../lib/controller.mjs";
import {
  captureManifest,
  captureManifestEntry,
  diffManifests,
  readManifestText,
} from "../lib/isolated-manifest.mjs";
import { classifyCombinedVerification, createIntegrationCoordinator } from "../lib/integration.mjs";
import { createApprovalBroker } from "../lib/parallel-approvals.mjs";
import { writeFileAtomic } from "../lib/workspace.mjs";
import { writePinnedAtomic } from "../lib/pinned-write.mjs";
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

test("characterizes the unresolved external edit race on an existing destination", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-external-race-");
  const destination = join(original, "file.txt");
  writeFileSync(destination, "baseline\n");
  const baseManifest = captureManifest(original);
  const copy = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(copy, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "file.txt"), "approved\n"),
  );
  const { broker, coordinator } = coordinatorFor(original, home, {
    writeFile(path, content, entry) {
      // The writer hook is the barrier after final validation and before rename.
      // The child must exit before the rename, so this ordering never relies on sleep.
      execFileSync(process.execPath, [
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], "external edit\\n")',
        destination,
      ]);
      writePinnedAtomic(path, content, entry.after.mode);
    },
  });
  const plan = coordinator.createPlan(
    coordinator.analyze({
      batchId: "batch-external-race",
      root: original,
      baseManifest,
      agents: [agent],
    }),
  );
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);

  // This documents the existing defect, not the desired contract. Replace these
  // assertions with preservation/conflict assertions when publication is fixed.
  assert.equal(result.integrationStatus, "integrated");
  assert.equal(readFileSync(destination, "utf8"), "approved\n");
  assert.equal(result.undoRun.entries[0].original, "baseline\n");
});

test("a concurrent creation is never overwritten or claimed as an integrated write", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-create-race-");
  const baseManifest = captureManifest(original);
  const copy = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(copy, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "new.txt"), "same content\n"),
  );
  const { broker, coordinator } = coordinatorFor(original, home, {
    writeFile(path, content, entry) {
      writeFileSync(path, content, { flag: "wx", mode: entry.after.mode });
      writePinnedAtomic(path, content, entry.after.mode, { createOnly: true });
    },
  });
  const plan = coordinator.createPlan(
    coordinator.analyze({
      batchId: "batch-create-race",
      root: original,
      baseManifest,
      agents: [agent],
    }),
  );
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);
  assert.equal(result.integrationStatus, "failed");
  assert.deepEqual(result.applied, []);
  assert.equal(result.undoRun, null);
  assert.equal(readFileSync(join(original, "new.txt"), "utf8"), "same content\n");
});

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

test("modified conflict analysis cannot bypass an explicit resolution", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-analysis-mutation-");
  writeFileSync(join(original, "a.txt"), "base\n");
  const baseManifest = captureManifest(original);
  const agents = ["a", "b"].map((name, index) => {
    const copy = copyAgent(original, root, `agent-${name}`);
    return agentSnapshot(copy, `agent-0${index + 1}`, (workspace) =>
      writeFileSync(join(workspace, "a.txt"), `${name}\n`),
    );
  });
  const { coordinator } = coordinatorFor(original, home);
  const analysis = coordinator.analyze({
    batchId: "batch-conflict",
    root: original,
    baseManifest,
    agents,
  });
  analysis.requiredResolutions.length = 0;
  analysis.candidates.push(analysis.changes[0]);
  assert.throws(() => coordinator.createPlan(analysis), /analysis.*changed/i);
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "base\n");
});

test("integration recovery identity cannot change after plan creation", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-plan-identity-");
  writeFileSync(join(original, "a.txt"), "base\n");
  const baseManifest = captureManifest(original);
  const copy = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(copy, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "a.txt"), "after\n"),
  );
  const { coordinator } = coordinatorFor(original, home);
  const plan = coordinator.createPlan(
    coordinator.analyze({
      batchId: "batch-identity",
      root: original,
      baseManifest,
      agents: [agent],
    }),
  );
  plan.integrationRunId = "other-run";
  const altered = structuredClone(plan);
  delete altered.planHash;
  plan.planHash = createHash("sha256").update(JSON.stringify(altered)).digest("hex");
  assert.throws(() => coordinator.requestApproval(plan), /plan changed/i);
});

test("integration events cannot corrupt the recovery record", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-event-recovery-");
  writeFileSync(join(original, "a.txt"), "base\n");
  const baseManifest = captureManifest(original);
  const copy = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(copy, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "a.txt"), "after\n"),
  );
  let persisted;
  let plan;
  const { broker, coordinator } = coordinatorFor(original, home, {
    onEvent(event) {
      if (event.type === "integration:started") plan.integrationRunId = "observer-run";
      if (event.type === "integration:undo") event.undoRun.entries[0].original = "corrupted";
      if (event.type === "integration:result")
        event.result.undoRun.entries[0].original = "corrupted";
    },
    onUndo(undo) {
      persisted = structuredClone(undo);
    },
  });
  plan = coordinator.createPlan(
    coordinator.analyze({
      batchId: "batch-recovery",
      root: original,
      baseManifest,
      agents: [agent],
    }),
  );
  const approvedRunId = plan.integrationRunId;
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);
  assert.equal(persisted.entries[0].original, "base\n");
  assert.equal(result.undoRun.entries[0].original, "base\n");
  assert.equal(result.undoRun.runId, approvedRunId);
  result.undoRun.entries[0].original = "caller replacement";
  assert.equal(coordinator.getPlanState(plan).result.undoRun.entries[0].original, "base\n");
  const state = coordinator.getPlanState(plan);
  state.result.undoRun.entries[0].original = "state replacement";
  assert.equal(coordinator.getPlanState(plan).result.undoRun.entries[0].original, "base\n");
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

test("abort between integration writes preserves the completed recovery prefix", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-cancel-prefix-");
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
  const cancellation = new AbortController();
  let saved;
  const { broker, coordinator } = coordinatorFor(original, home, {
    signal: cancellation.signal,
    onEvent(event) {
      if (event.type === "integration:applied") cancellation.abort();
    },
    onUndo(undo) {
      saved = undo;
    },
  });
  const plan = coordinator.createPlan(
    coordinator.analyze({
      batchId: "batch-cancel-prefix",
      root: original,
      baseManifest,
      agents,
    }),
  );
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);
  assert.equal(result.status, "aborted");
  assert.equal(result.integrationStatus, "partial");
  assert.deepEqual(
    result.applied.map((entry) => entry.path),
    ["a.txt"],
  );
  assert.deepEqual(result.pending, ["b.txt"]);
  assert.equal(saved.entries.length, 1);
  assert.equal(readFileSync(join(original, "a.txt"), "utf8"), "a after\n");
  assert.equal(readFileSync(join(original, "b.txt"), "utf8"), "b base\n");
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

test("manifest reads refuse a symlinked ancestor even when outside bytes match", (t) => {
  const { root, original } = fixture(t, "matrix-manifest-parent-symlink-");
  const inside = join(original, "nested");
  const outside = join(root, "outside");
  mkdirSync(inside);
  mkdirSync(outside);
  writeFileSync(join(inside, "file.txt"), "matching bytes\n");
  writeFileSync(join(outside, "file.txt"), "matching bytes\n");
  const expected = captureManifestEntry(original, "nested/file.txt");
  rmSync(inside, { recursive: true });
  symlinkSync(outside, inside);
  assert.throws(() => captureManifestEntry(original, "nested/file.txt"));
  assert.throws(() => readManifestText(original, expected));
});

test("integration never follows an ancestor swapped to an outside symlink at write time", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-parent-swap-");
  const nested = join(original, "nested");
  const outside = join(root, "outside");
  mkdirSync(nested);
  mkdirSync(outside);
  writeFileSync(join(nested, "file.txt"), "base\n");
  writeFileSync(join(outside, "file.txt"), "outside canary\n");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "nested", "file.txt"), "after\n"),
  );
  const { broker, coordinator } = coordinatorFor(original, home, {
    writeFile(path, content) {
      rmSync(nested, { recursive: true });
      symlinkSync(outside, nested);
      return writeFileAtomic(path, content);
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
  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(outside, "file.txt"), "utf8"), "outside canary\n");
});

test("a replaced parent with matching approved bytes is not reported as an applied write", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-false-postimage-");
  const nested = join(original, "nested");
  const outside = join(root, "outside");
  mkdirSync(nested);
  mkdirSync(outside);
  writeFileSync(join(nested, "file.txt"), "base\n");
  writeFileSync(join(outside, "file.txt"), "after\n");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "nested", "file.txt"), "after\n"),
  );
  const { broker, coordinator } = coordinatorFor(original, home, {
    writeFile(path, content) {
      rmSync(nested, { recursive: true });
      symlinkSync(outside, nested);
      return writeFileAtomic(path, content);
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
  assert.equal(result.integrationStatus, "failed");
  assert.deepEqual(result.applied, []);
  assert.equal(result.undoRun, null);
  assert.equal(readFileSync(join(outside, "file.txt"), "utf8"), "after\n");
});

test("a writer throwing after rename still publishes exact recovery", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-after-rename-");
  writeFileSync(join(original, "file.txt"), "base\n");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "file.txt"), "after\n"),
  );
  const { broker, coordinator } = coordinatorFor(original, home, {
    writeFile(path, content) {
      writeFileAtomic(path, content);
      throw new Error("after rename");
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
  assert.equal(result.undoRun.entries.length, 1);
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
  assert.equal(controller.undoLast().ok, true);
  assert.equal(readFileSync(join(original, "file.txt"), "utf8"), "base\n");
});

for (const throwsAfterWrite of [false, true]) {
  test(`a pinned parent moved during a write retains recovery (writer throws: ${throwsAfterWrite})`, (t) => {
    const { root, original, home } = fixture(t, "matrix-integration-parent-moved-");
    const nested = join(original, "nested");
    const moved = join(original, "moved");
    const outside = join(root, "outside");
    mkdirSync(nested);
    mkdirSync(outside);
    writeFileSync(join(nested, "file.txt"), "base\n");
    writeFileSync(join(outside, "file.txt"), "outside canary\n");
    const baseManifest = captureManifest(original);
    const agentRoot = copyAgent(original, root, "agent-a");
    const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
      writeFileSync(join(workspace, "nested", "file.txt"), "after\n"),
    );
    const { broker, coordinator } = coordinatorFor(original, home, {
      writeFile(path, content) {
        renameSync(nested, moved);
        symlinkSync(outside, nested);
        const written = writeFileAtomic(path, content);
        if (throwsAfterWrite) throw new Error("after rename");
        return written;
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
    assert.equal(readFileSync(join(outside, "file.txt"), "utf8"), "outside canary\n");
    assert.equal(readFileSync(join(moved, "file.txt"), "utf8"), "after\n");
    assert.equal(result.undoRun.entries[0].absPath, join(moved, "file.txt"));
    const controller = createRunController({ home });
    t.after(() => controller.dispose());
    assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
    assert.equal(controller.undoLast().ok, true);
    assert.equal(readFileSync(join(moved, "file.txt"), "utf8"), "base\n");
  });
}

test("undo refuses a path replaced by an outside symlink after integration", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-undo-escape-");
  const nested = join(original, "nested");
  const outside = join(root, "outside");
  mkdirSync(nested);
  mkdirSync(outside);
  writeFileSync(join(nested, "file.txt"), "base\n");
  writeFileSync(join(outside, "file.txt"), "after\n");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "nested", "file.txt"), "after\n"),
  );
  const { broker, coordinator } = coordinatorFor(original, home);
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
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
  rmSync(nested, { recursive: true });
  symlinkSync(outside, nested);
  const undone = controller.undoLast();
  assert.equal(undone.ok, false);
  assert.equal(readFileSync(join(outside, "file.txt"), "utf8"), "after\n");
});

for (const changeWhen of ["before restore", "after restore"]) {
  test(`integration undo preserves recorded original when its backup changes ${changeWhen}`, (t) => {
    const { root, original, home } = fixture(t, "matrix-integration-backup-changed-");
    writeFileSync(join(original, "file.txt"), "original\n");
    const baseManifest = captureManifest(original);
    const agentRoot = copyAgent(original, root, "agent-a");
    const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
      writeFileSync(join(workspace, "file.txt"), "after\n"),
    );
    const { broker, coordinator } = coordinatorFor(original, home);
    const plan = coordinator.createPlan(
      coordinator.analyze({
        batchId: "batch-backup-changed",
        root: original,
        baseManifest,
        agents: [agent],
      }),
    );
    const approval = coordinator.requestApproval(plan);
    decideIntegration(broker, approval);
    const result = coordinator.integrateApproved(plan, approval);
    const backup = result.undoRun.entries[0].backupPath;
    if (changeWhen === "before restore") writeFileSync(backup, "tampered\n");
    const controller = createRunController({ home });
    t.after(() => controller.dispose());
    assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
    if (changeWhen === "after restore") writeFileSync(backup, "tampered\n");
    assert.equal(controller.undoLast().ok, true);
    assert.equal(readFileSync(join(original, "file.txt"), "utf8"), "original\n");
  });
}

test("integration undo does not delete a backup through a swapped backup directory", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-backup-symlink-");
  writeFileSync(join(original, "file.txt"), "original\n");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "file.txt"), "after\n"),
  );
  const { broker, coordinator } = coordinatorFor(original, home);
  const plan = coordinator.createPlan(
    coordinator.analyze({
      batchId: "batch-backup-symlink",
      root: original,
      baseManifest,
      agents: [agent],
    }),
  );
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
  const outside = join(root, "outside");
  mkdirSync(outside);
  const canary = join(outside, basename(result.undoRun.entries[0].backupPath));
  writeFileSync(canary, "keep\n");
  renameSync(join(home, "backups"), join(home, "backups-moved"));
  symlinkSync(outside, join(home, "backups"));
  assert.equal(controller.undoLast().ok, true);
  assert.equal(readFileSync(canary, "utf8"), "keep\n");
  assert.equal(readFileSync(join(original, "file.txt"), "utf8"), "original\n");
});

test("integration undo ignores a recovery record's backup outside its private home", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-foreign-backup-");
  const file = join(original, "file.txt");
  const outside = join(root, "outside.txt");
  writeFileSync(file, "after\n");
  writeFileSync(outside, "keep\n");
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  assert.equal(
    controller.restoreFromSession(
      {
        version: 1,
        runId: "integration-test",
        entries: [
          {
            absPath: file,
            file: "file.txt",
            original: "original\n",
            updatedText: "after\n",
            backupPath: outside,
            isCreation: false,
          },
        ],
      },
      { root: original },
    ),
    true,
  );
  assert.equal(controller.undoLast().ok, true);
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
  assert.equal(readFileSync(file, "utf8"), "original\n");
});

test("integration undo stays pinned if its parent is swapped during restore", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-undo-swap-");
  const nested = join(original, "nested");
  const moved = join(original, "moved");
  const outside = join(root, "outside");
  mkdirSync(nested);
  mkdirSync(outside);
  writeFileSync(join(nested, "file.txt"), "base\n");
  writeFileSync(join(outside, "file.txt"), "outside canary\n");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "nested", "file.txt"), "after\n"),
  );
  const { broker, coordinator } = coordinatorFor(original, home);
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
  const controller = createRunController({
    home,
    writeUndo(path, content) {
      renameSync(nested, moved);
      symlinkSync(outside, nested);
      writeFileAtomic(path, content);
    },
  });
  t.after(() => controller.dispose());
  assert.equal(
    controller.restoreFromSession(result.undoRun),
    false,
    "integration recovery requires its workspace root",
  );
  assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
  const undo = controller.undoLast();
  assert.equal(undo.ok, false);
  assert.match(undo.error, /parent directory moved/);
  assert.equal(readFileSync(join(outside, "file.txt"), "utf8"), "outside canary\n");
  assert.equal(readFileSync(join(moved, "file.txt"), "utf8"), "base\n");
});

test("backup stores validated original bytes when the target is swapped during backup", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-backup-swap-");
  const target = join(original, "file.txt");
  const secret = join(root, "outside.txt");
  writeFileSync(target, "base\n");
  writeFileSync(secret, "outside secret\n");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) =>
    writeFileSync(join(workspace, "file.txt"), "after\n"),
  );
  let savedBytes;
  const { broker, coordinator } = coordinatorFor(original, home, {
    backup(name, content) {
      savedBytes = Buffer.from(content);
      rmSync(target);
      symlinkSync(secret, target);
      return { path: join(home, "dummy-backup") };
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
  assert.equal(result.integrationStatus, "failed");
  assert.deepEqual(result.applied, []);
  assert.equal(savedBytes.toString(), "base\n");
  assert.equal(readFileSync(secret, "utf8"), "outside secret\n");
});

test("approved executable creation preserves its mode and can be undone", (t) => {
  const { root, original, home } = fixture(t, "matrix-integration-create-mode-");
  const baseManifest = captureManifest(original);
  const agentRoot = copyAgent(original, root, "agent-a");
  const agent = agentSnapshot(agentRoot, "agent-01", (workspace) => {
    const path = join(workspace, "script.sh");
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o751);
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
  const approval = coordinator.requestApproval(plan);
  decideIntegration(broker, approval);
  const result = coordinator.integrateApproved(plan, approval);
  assert.equal(result.integrationStatus, "integrated");
  assert.equal(statSync(join(original, "script.sh")).mode & 0o777, 0o751);
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(result.undoRun, { root: original }), true);
  assert.equal(controller.undoLast().ok, true);
  assert.equal(exists(join(original, "script.sh")), false);
});
