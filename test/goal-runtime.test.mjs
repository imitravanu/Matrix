// DUR-005 — integrated durable-goal runtime and process-ownership evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGE_ROOT, makeTempDir } from "./helpers.mjs";
import { GOAL_DEFAULT_BUDGET, newGoalId } from "../lib/goal-contracts.mjs";
import {
  applyEditOperation,
  prepareEditOperation,
  prepareOperationIntent,
} from "../lib/goal-operations.mjs";
import { findBlockingDurableGoal } from "../lib/goal-lease-probe.mjs";
import { createGoalStore } from "../lib/goal-store.mjs";
import {
  createGoalRuntime,
  reclaimStaleGoalAttempt,
  createGoalAuthority,
  createExecutionOwnership,
  createGoalTestRunner,
} from "../lib/goal-policy.mjs";
import { inspectTestPlan } from "../lib/test-policy.mjs";
import { withWorkspaceWriteLock } from "../lib/workspace.mjs";
import { withGoalLock } from "../lib/goal-lock.mjs";
import {
  createContainmentProcessRunner,
  createGoalTestIsolation,
} from "../lib/goal-containment.mjs";
import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from "../lib/linux-snapshot.mjs";

const linux = { skip: process.platform !== "linux", timeout: 60_000 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const DRIVER = readFileSync(
  join(PACKAGE_ROOT, "docs", "next-phase", "fixtures", "dur005-driver.mjs"),
  "utf8",
);

function createFixture(t, { files = {}, criteria = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "matrix-dur005-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "matrix-dur005-ws-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  for (const [path, content] of Object.entries(files)) {
    const target = join(workspace, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  const identity = statSync(workspace, { bigint: true });
  const record = {
    schemaVersion: 1,
    id: newGoalId(),
    createdAt: Date.now(),
    objective: "DUR-005 test goal",
    workspace: {
      path: workspace,
      device: String(identity.dev),
      inode: String(identity.ino),
      revision: null,
      manifest: hash("manifest"),
    },
    provider: { id: "scripted", modelId: "scripted", digest: hash("provider") },
    state: "ready",
    generation: 0,
    sequence: 0,
    budget: { ...GOAL_DEFAULT_BUDGET },
    operations: [],
    criteria: criteria ?? [
      {
        id: newGoalId("criterion"),
        revision: 1,
        kind: "artifact",
        path: "src/a.mjs",
        sha256: hash("export const a = 2;\n"),
      },
    ],
  };
  const store = createGoalStore(home);
  store.create(record);
  return { home, workspace, record, store, goalId: record.id };
}

function readRunLog(home, goalId) {
  try {
    return readFileSync(join(home, "runs", `${goalId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function scriptedEngine(turns) {
  let turn = 0;
  const engine = {
    async turn() {
      turn += 1;
      const step = turns[turn - 1];
      if (!step) return { content: "done", toolCalls: [] };
      return typeof step === "function" ? step() : step;
    },
  };
  return engine;
}

function readProcIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rparen = stat.lastIndexOf(")");
  const fields = stat.slice(rparen + 2).split(" ");
  return {
    state: fields[0],
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    startTime: fields[19],
  };
}

function namespaceInodeOf(pid) {
  try {
    const match = /^pid:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/ns/pid`));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** NSpid chain of a process; the last entry is its pid in its own PID namespace. */
function namespacePidsOf(pid) {
  try {
    const match = /^NSpid:\s*(.+)$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? match[1].trim().split(/\s+/).map(Number) : null;
  } catch {
    return null;
  }
}

/**
 * Host processes in one recorded PID-namespace instance,
 * `{ inode, initPid, initStartTime }`. Linux reuses nsfs inode numbers once a
 * namespace is freed, so an inode alone does not name a namespace after its
 * tree has gone. Among inode matches, the process with namespace-local pid 1
 * is that namespace's init. If it is visible and its host pid or start time
 * differs from the record, the inode now belongs to another namespace and
 * none of its processes are members. With no visible init, an unreadable
 * init, or an unknown recorded start time (`null`), every inode match is
 * counted, so the oracle fails closed.
 */
function recordedNamespaceProcesses(namespace) {
  assert.equal(typeof namespace?.inode, "string", "a recorded namespace identity is required");
  const candidates = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    if (namespaceInodeOf(pid) !== namespace.inode) continue;
    candidates.push({ pid, nsPids: namespacePidsOf(pid) });
  }
  if (typeof namespace.initStartTime !== "string") return candidates;
  const init = candidates.find((candidate) => candidate.nsPids?.at(-1) === 1);
  if (!init) return candidates;
  if (init.pid !== namespace.initPid) return [];
  let startTime;
  try {
    startTime = readProcIdentity(init.pid).startTime;
  } catch {
    return candidates;
  }
  return startTime === namespace.initStartTime ? candidates : [];
}

/** Map a namespace-local PID to the host PID of the same process. */
function hostPidInNamespace(namespace, localPid) {
  const match = recordedNamespaceProcesses(namespace).find(
    (candidate) => candidate.nsPids?.at(-1) === localPid,
  );
  return match ? match.pid : null;
}

/** Live (non-zombie) host processes in one recorded PID namespace. */
function namespaceLiveMembers(namespace) {
  const members = [];
  for (const { pid } of recordedNamespaceProcesses(namespace)) {
    let identity;
    try {
      identity = readProcIdentity(pid);
    } catch {
      continue;
    }
    if (identity.state !== "Z") members.push({ pid, identity });
  }
  return members;
}

/**
 * Hold an nsfs reference to a recorded namespace whose init is known to be
 * alive. The held reference keeps the namespace, and so its inode number, from
 * being freed and reused for the rest of the test.
 */
function pinNamespace(t, namespace) {
  const fd = openSync(`/proc/${namespace.initPid}/ns/pid`, "r");
  t.after(() => closeSync(fd));
  assert.equal(
    String(fstatSync(fd).ino),
    namespace.inode,
    "the pinned PID namespace must be the recorded one",
  );
  assert.equal(
    readProcIdentity(namespace.initPid).startTime,
    namespace.initStartTime,
    "the recorded namespace init must still be alive when it is pinned",
  );
}

function readOwnershipRecords(home) {
  const directory = join(home, "ownership");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^operation_[a-f0-9]{32}\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

/** Run Bubblewrap once and return a PID-namespace inode that is now empty. */
function deadNamespaceInode() {
  const directory = makeTempDir("matrix-dur005-nsprobe-");
  const infoFile = join(directory, "info.json");
  const fd = openSync(infoFile, "w+");
  try {
    const result = spawnSync(
      "/usr/bin/bwrap",
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--chdir",
        "/tmp",
        "--info-fd",
        "3",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { stdio: ["ignore", "ignore", "ignore", fd], timeout: 10_000 },
    );
    if (result.status !== 0) throw new Error("bubblewrap namespace probe failed");
  } finally {
    closeSync(fd);
  }
  const info = JSON.parse(readFileSync(infoFile, "utf8"));
  rmSync(directory, { recursive: true, force: true });
  return String(info["pid-namespace"]);
}

const editTurn = (path, content) => ({
  content: "",
  toolCalls: [{ name: "edit", arguments: { path, content } }],
});

test("the guardian rejects invalid launch specs and reports child startup failures", linux, (t) => {
  const { workspace } = createFixture(t);
  const guardian = join(PACKAGE_ROOT, "lib", "goal-guardian.mjs");
  const launch = (spec) =>
    spawnSync(process.execPath, [guardian], {
      input: spec,
      encoding: "utf8",
      timeout: 5_000,
    });
  const invalid = launch("{");
  assert.equal(invalid.status, 125);
  assert.match(invalid.stderr, /launch spec is not valid JSON/);

  const gate = join(workspace, "ready");
  const spec = {
    schemaVersion: 1,
    gate,
    cwd: workspace,
    file: join(workspace, "missing"),
    args: [],
  };
  writeFileSync(gate, "", { mode: 0o600 });
  const missing = launch(JSON.stringify(spec));
  assert.equal(missing.status, 125);
  assert.match(missing.stderr, /approved command could not be started/);
  assert.equal(existsSync(gate), false);

  writeFileSync(gate, "", { mode: 0o600 });
  const observed = launch(
    JSON.stringify({
      ...spec,
      file: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      input: "approved input",
    }),
  );
  assert.equal(observed.status, 0);
  assert.equal(observed.stdout, "approved input");
  assert.equal(existsSync(gate), false);
});

test("goal runtime refuses a replaced workspace at the same path", linux, (t) => {
  const { home, workspace, goalId } = createFixture(t);
  const original = `${workspace}-original`;
  renameSync(workspace, original);
  t.after(() => rmSync(original, { recursive: true, force: true }));
  mkdirSync(workspace);
  assert.throws(
    () => createGoalRuntime({ home, workspace, goalId, engine: scriptedEngine([]) }),
    /workspace identity/,
  );
});

test("goal runtime accepts a renamed workspace with the same identity", linux, (t) => {
  const { home, workspace, goalId } = createFixture(t);
  const renamed = `${workspace}-renamed`;
  renameSync(workspace, renamed);
  t.after(() => rmSync(renamed, { recursive: true, force: true }));
  const runtime = createGoalRuntime({
    home,
    workspace: renamed,
    goalId,
    engine: scriptedEngine([]),
  });
  assert.equal(runtime.workspace, renamed);
});

test(
  "doctor reports containment only when pidfd and PID-namespace probes both pass",
  linux,
  async (t) => {
    const { home, workspace } = createFixture(t);
    const helper = await ensureHelper(t);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true, mode: 0o700 });
    chmodSync(bin, 0o700);
    writeFileSync(join(bin, "matrix-pidfd-helper"), readFileSync(helper), { mode: 0o700 });
    const { runDoctor } = await import("../lib/doctor.mjs");
    const report = runDoctor({ cwd: workspace, env: { ...process.env, MATRIX_HOME: home } });
    const ownership = report.checks.find((entry) => entry.name === "goal-ownership");
    assert.equal(ownership.status, "ok");
    assert.match(ownership.detail, /containment/i);
    const missing = runDoctor({
      cwd: workspace,
      env: { ...process.env, MATRIX_HOME: home },
      bwrapPath: "/definitely/not/bwrap",
    });
    const missingOwnership = missing.checks.find((entry) => entry.name === "goal-ownership");
    assert.equal(missingOwnership.status, "warn");
    assert.match(missingOwnership.detail, /containment/i);
  },
);

async function ensureHelper(t) {
  const dir = makeTempDir("matrix-dur005-helper-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync("node", ["scripts/build-pidfd-helper.mjs", "--out", dir], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`pidfd helper could not be built: ${result.stderr || result.stdout}`);
  }
  const helper = join(dir, "matrix-pidfd-helper");
  const probe = spawnSync(helper, ["probe"], { encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error(`pidfd helper probe failed: ${probe.stderr || probe.stdout}`);
  }
  return helper;
}

// --------------------------------------------------------------------------
// A. Approval gate
// --------------------------------------------------------------------------

test("pre-issued grants cannot cross goals or confuse deletion with empty content", linux, (t) => {
  const { home } = createFixture(t);
  const authority = createGoalAuthority({ home, headless: true });
  const goalA = newGoalId();
  const goalB = newGoalId();
  const intent = {
    attemptId: newGoalId("attempt"),
    generation: 1,
    operationId: newGoalId("operation"),
  };
  const path = "src/a.mjs";
  authority.registerEditGrant({ path, content: null, approved: true, goalId: goalA });
  assert.equal(
    authority.authorizeEdit({ path, content: "", planHash: null, intent, goal: { id: goalA } }),
    null,
  );
  assert.equal(
    authority.authorizeEdit({ path, content: null, planHash: null, intent, goal: { id: goalB } }),
    null,
  );
  assert.equal(
    typeof authority.authorizeEdit({
      path,
      content: null,
      planHash: null,
      intent,
      goal: { id: goalA },
    }),
    "string",
  );
  const planHash = hash("plan");
  authority.registerTestGrant({ planHash, approved: true, goalId: goalA });
  assert.equal(authority.authorizeTest({ planHash, intent, goal: { id: goalB } }), null);
  assert.equal(typeof authority.authorizeTest({ planHash, intent, goal: { id: goalA } }), "string");
  authority.registerEditGrant({
    path,
    content: "data",
    mode: 0o644,
    approved: true,
    goalId: goalA,
  });
  assert.equal(
    authority.authorizeEdit({
      path,
      content: "data",
      mode: 0o600,
      planHash: null,
      intent,
      goal: { id: goalA },
    }),
    null,
  );
  assert.equal(
    typeof authority.authorizeEdit({
      path,
      content: "data",
      mode: 0o644,
      planHash: null,
      intent,
      goal: { id: goalA },
    }),
    "string",
  );
});

test("an edit with changed permissions cannot consume an approved proposal", linux, async (t) => {
  const { home, workspace, record, store, goalId } = createFixture(t, {
    files: { "src/a.mjs": "before\n" },
  });
  const authority = createGoalAuthority({ home, workspace: record.workspace });
  const engine = scriptedEngine([
    () => {
      authority.registerEditGrant({
        path: "src/a.mjs",
        content: "after\n",
        mode: 0o644,
        approved: true,
        goalId,
      });
      return {
        content: "",
        toolCalls: [
          { name: "edit", arguments: { path: "src/a.mjs", content: "after\n", mode: 0o600 } },
        ],
      };
    },
  ]);
  const runtime = createGoalRuntime({ home, goalId, workspace, engine, authority, headless: true });
  const result = await runtime.resume();
  assert.equal(result.reason.code, "tool-denied");
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "before\n");
  assert.equal(
    store
      .readJournal(goalId)
      .filter((entry) => entry.kind === "intent" && entry.payload.kind === "edit").length,
    0,
  );
});

test(
  "approval is invalidated by before-image drift and a pause expires pending grants",
  linux,
  async (t) => {
    const { home, workspace, goalId } = createFixture(t, { files: { "src/a.mjs": "before" } });
    const target = join(workspace, "src/a.mjs");
    const path = "src/a.mjs";
    const content = "approved";
    const register = () =>
      runtime.authority.registerEditGrant({ path, content, approved: true, goalId });
    const runtime = createGoalRuntime({
      home,
      workspace,
      goalId,
      engine: scriptedEngine([
        () => {
          register();
          chmodSync(target, 0o755);
          return editTurn(path, content);
        },
        () => {
          register();
          runtime.pause();
          return editTurn(path, content);
        },
        editTurn(path, content),
      ]),
    });
    assert.equal((await runtime.resume()).reason.code, "tool-denied");
    assert.equal(readFileSync(target, "utf8"), "before");
    assert.equal((await runtime.resume()).status, "paused");
    assert.equal(runtime.authority.inspect().pendingGrants, 0);
    assert.equal((await runtime.resume()).reason.code, "tool-denied");
    assert.equal(readFileSync(target, "utf8"), "before");
  },
);

test(
  "an interrupted edit stays exclusive and is charged before the successor completes",
  linux,
  async (t) => {
    const { home, workspace, store, goalId } = createFixture(t, {
      files: { "src/a.mjs": "before" },
    });
    let intent;
    withGoalLock(workspace, (lock) => {
      const fence = (status) => ({
        goalId,
        generation: status.goal.generation,
        sequence: status.goal.sequence,
      });
      let status = store.beginAttempt(goalId, {
        lock,
        fence: fence(store.inspect(goalId)),
        ttlMs: 30_000,
      });
      const auth = () => ({ lock, fence: fence(status), leaseId: status.lease.leaseId });
      const prep = prepareEditOperation({
        goal: status.goal,
        attemptId: status.lease.attemptId,
        generation: 1,
        path: "src/a.mjs",
        content: "export const a = 2;\n",
        authority: newGoalId("decision"),
      });
      intent = prep.intent;
      status = store.append(goalId, auth(), "intent", intent, { blobs: prep.blobs });
      status = store.append(goalId, auth(), "dispatch", { ...intent, state: "dispatched" });
      applyEditOperation(workspace, intent, prep.afterBytes, { lock, store });
      assert.equal(
        findBlockingDurableGoal(workspace, { home, now: Date.now() + 60_000 }).reason,
        "active-lease",
      );
      store.reclaimAttempt(goalId, { lock, fence: fence(status) });
    });
    assert.throws(
      () => withWorkspaceWriteLock(workspace, () => {}, { home }),
      /unresolved dispatch/,
    );
    const runtime = createGoalRuntime({ home, workspace, goalId, engine: scriptedEngine([]) });
    assert.equal((await runtime.resume()).status, "completed");
    const settled = store.inspect(goalId);
    assert.equal(settled.counters.reserved.tools, 0);
    assert.equal(settled.counters.used.tools, intent.reservation.tools);
    const receipt = store.readJournal(goalId).find((entry) => entry.kind === "recovery-receipt");
    assert.equal(receipt.operationId, intent.operationId);
    assert.equal(receipt.payload.status, "uncertain");
  },
);

for (const change of ["rename", "replace"]) {
  test(
    `a staged test dispatch is recoverable before pinning after workspace ${change}`,
    linux,
    async (t) => {
      const content = "export const a = 2;\n";
      const { home, workspace, store, goalId, record } = createFixture(t, {
        files: { "src/a.mjs": content },
      });
      const ownership = createExecutionOwnership({ home });
      let operationId;
      withGoalLock(workspace, (lock) => {
        const fence = (status) => ({
          goalId,
          generation: status.goal.generation,
          sequence: status.goal.sequence,
        });
        let status = store.beginAttempt(goalId, { lock, fence: fence(store.inspect(goalId)) });
        const auth = () => ({ lock, fence: fence(status), leaseId: status.lease.leaseId });
        const { intent } = prepareOperationIntent({
          goal: status.goal,
          attemptId: status.lease.attemptId,
          generation: 1,
          kind: "test",
          authority: newGoalId("decision"),
        });
        operationId = intent.operationId;
        status = store.append(goalId, auth(), "intent", intent);
        ownership.stageDispatch({ ...intent, workspaceRoot: workspace });
        status = store.append(goalId, auth(), "dispatch", { ...intent, state: "dispatched" });
        store.reclaimAttempt(goalId, { lock, fence: fence(status) });
      });
      assert.throws(
        () => withWorkspaceWriteLock(workspace, () => {}, { home }),
        /unverified execution/,
      );
      const renamed = `${workspace}-old`;
      renameSync(workspace, renamed);
      t.after(() => rmSync(renamed, { recursive: true, force: true }));
      let root = renamed;
      if (change === "replace") {
        root = workspace;
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src/a.mjs"), content);
      }
      const identity = statSync(root, { bigint: true });
      const sibling = newGoalId();
      store.create({
        ...record,
        id: sibling,
        workspace: {
          ...record.workspace,
          path: root,
          device: String(identity.dev),
          inode: String(identity.ino),
        },
      });
      const result = await createGoalRuntime({
        home,
        workspace: root,
        goalId: sibling,
        engine: scriptedEngine([]),
      }).resume();
      assert.equal(result.status, "completed", JSON.stringify(result.reason));
      const sealed = JSON.parse(
        readFileSync(join(ownership.reconciledDir, `${operationId}.json`), "utf8"),
      );
      assert.equal(sealed.mechanism, "gate-not-released");
      assert.equal(
        withWorkspaceWriteLock(root, () => true, { home }),
        true,
      );
      if (change === "rename") {
        const old = await createGoalRuntime({
          home,
          workspace: root,
          goalId,
          engine: scriptedEngine([]),
        }).resume();
        assert.equal(old.status, "completed", JSON.stringify(old.reason));
        assert.equal(store.inspect(goalId).counters.reserved.tools, 0);
      }
    },
  );
}

test("a denied edit produces no durable intent, no bytes and a safe stop", linux, async (t) => {
  const { home, workspace, store, goalId } = createFixture(t, {
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const engine = scriptedEngine([editTurn("src/a.mjs", "export const a = 2;\n")]);
  const runtime = createGoalRuntime({ home, goalId, workspace, engine, headless: true });
  const result = await runtime.resume();
  assert.equal(result.status, "needs-attention");
  assert.equal(result.reason.code, "tool-denied");
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 1;\n");
  const editIntents = store
    .readJournal(goalId)
    .filter((record) => record.kind === "intent" && record.payload.kind === "edit");
  assert.equal(editIntents.length, 0);
});

test(
  "an approved edit is bound to the exact operation, workspace and generation",
  linux,
  async (t) => {
    const { home, workspace, record, store, goalId } = createFixture(t, {
      files: { "src/a.mjs": "export const a = 1;\n" },
    });
    const authority = createGoalAuthority({ home, workspace: record.workspace });
    const engine = scriptedEngine([
      () => {
        authority.registerEditGrant({
          path: "src/a.mjs",
          content: "export const a = 2;\n",
          approved: true,
          goalId,
        });
        return editTurn("src/a.mjs", "export const a = 2;\n");
      },
      { content: "done", toolCalls: [] },
    ]);
    const runtime = createGoalRuntime({
      home,
      goalId,
      workspace,
      engine,
      authority,
      headless: true,
    });
    const result = await runtime.resume();
    assert.equal(result.status, "completed");
    assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 2;\n");
    const journal = store.readJournal(goalId);
    const editIntentIndex = journal.findIndex(
      (r) => r.kind === "intent" && r.payload.kind === "edit",
    );
    const editDispatchIndex = journal.findIndex(
      (r) => r.kind === "dispatch" && r.operationId === journal[editIntentIndex].operationId,
    );
    const editReceiptIndex = journal.findIndex(
      (r) => r.kind === "receipt" && r.operationId === journal[editIntentIndex].operationId,
    );
    assert.ok(
      editIntentIndex > 0 &&
        editDispatchIndex > editIntentIndex &&
        editReceiptIndex > editDispatchIndex,
    );
    assert.equal(journal[editIntentIndex].payload.authority.kind, "edit");
    const runLog = readRunLog(home, goalId);
    const decisions = runLog.filter((e) => e.type === "goal:decision");
    assert.equal(decisions.length, 1);
    const editDecision = decisions.find((e) => e.kind === "edit");
    assert.equal(editDecision.decision, "approved");
    assert.equal(editDecision.path, "src/a.mjs");
    assert.equal(editDecision.generation, journal[editIntentIndex].payload.generation);
    assert.equal(editDecision.operationId, journal[editIntentIndex].operationId);
    assert.equal(editDecision.attemptId, journal[editIntentIndex].payload.attemptId);
  },
);

test("a fresh invocation cannot replay the old invocation's approval", linux, async (t) => {
  const { home, workspace, goalId } = createFixture(t, {
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const allowRuntime = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine: scriptedEngine([
      editTurn("src/a.mjs", "export const a = 2;\n"),
      { content: "done", toolCalls: [] },
    ]),
    headless: true,
    allowEdits: true,
  });
  const first = await allowRuntime.resume();
  assert.equal(first.status, "completed");
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 2;\n");
  const second = createFixture(t, { files: { "src/a.mjs": "export const a = 1;\n" } });
  const restarted = createGoalRuntime({
    home: second.home,
    goalId: second.goalId,
    workspace: second.workspace,
    engine: scriptedEngine([editTurn("src/a.mjs", "export const a = 2;\n")]),
    headless: true,
    allowEdits: false,
  });
  const result = await restarted.resume();
  assert.equal(result.reason.code, "tool-denied");
  assert.equal(readFileSync(join(second.workspace, "src/a.mjs"), "utf8"), "export const a = 1;\n");
});

test("the headless edit allowance survives only within its own invocation", linux, async (t) => {
  const { home, workspace, goalId } = createFixture(t, {
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const first = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine: scriptedEngine([
      editTurn("src/a.mjs", "export const a = 9;\n"),
      { content: "done", toolCalls: [] },
    ]),
    headless: true,
    allowEdits: true,
  });
  const result = await first.resume();
  assert.notEqual(result.status, "completed");
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 9;\n");
  const restart = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine: scriptedEngine([
      editTurn("src/a.mjs", "export const a = 2;\n"),
      { content: "done", toolCalls: [] },
    ]),
    headless: true,
    allowEdits: false,
  });
  const second = await restart.resume();
  assert.equal(second.reason.code, "tool-denied");
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 9;\n");
});

test("edit and test approvals are independent of each other", linux, async (t) => {
  const passing = join(makeTempDir("matrix-dur005-pass-"), "passing.test.mjs");
  mkdirSync(join(passing, ".."), { recursive: true });
  writeFileSync(
    passing,
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n",
  );
  t.after(() => rmSync(join(passing, ".."), { recursive: true, force: true }));
  const testPlan = {
    file: process.execPath,
    args: ["--test", passing],
    cwd: passing.replace(/[^/]*$/, ""),
    framework: "node --test",
  };
  const inspected = inspectTestPlan(testPlan, { cwd: testPlan.cwd });
  assert.equal(inspected.ok, true, inspected.error);
  const { home, workspace, record, store, goalId } = createFixture(t, {
    files: { "src/a.mjs": "export const a = 1;\n" },
    criteria: [
      {
        id: newGoalId("criterion"),
        revision: 1,
        kind: "artifact",
        path: "src/a.mjs",
        sha256: hash("export const a = 2;\n"),
      },
      { id: newGoalId("criterion"), revision: 1, kind: "test", planHash: inspected.plan.planHash },
    ],
  });
  const authority = createGoalAuthority({ home, workspace: record.workspace });
  const engine = scriptedEngine([
    () => {
      authority.registerEditGrant({
        path: "src/a.mjs",
        content: "export const a = 2;\n",
        approved: true,
        goalId,
      });
      return editTurn("src/a.mjs", "export const a = 2;\n");
    },
    {
      content: "",
      toolCalls: [{ name: "test", arguments: { planHash: inspected.plan.planHash } }],
    },
  ]);
  const runtime = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine,
    authority,
    testPlan,
    headless: true,
  });
  const result = await runtime.resume();
  assert.equal(result.reason.code, "tool-denied");
  const testDispatchers = store
    .readJournal(goalId)
    .filter((r) => r.kind === "dispatch" && r.payload.kind === "test");
  assert.equal(testDispatchers.length, 0);
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 2;\n");
});

test("a headless allowTests grant covers exactly one plan per invocation", linux, async (t) => {
  const passing = join(makeTempDir("matrix-dur005-allow-"), "passing.test.mjs");
  mkdirSync(join(passing, ".."), { recursive: true });
  writeFileSync(passing, "import test from 'node:test';\ntest('ok', () => {});\n");
  t.after(() => rmSync(join(passing, ".."), { recursive: true, force: true }));
  const planA = {
    file: process.execPath,
    args: ["--test", passing],
    cwd: passing.replace(/[^/]*$/, ""),
    framework: "node --test",
  };
  const hashA = inspectTestPlan(planA, { cwd: planA.cwd }).plan.planHash;
  const allowHome = makeTempDir("matrix-dur005-allow-home-");
  t.after(() => rmSync(allowHome, { recursive: true, force: true }));
  const authority = createGoalAuthority({ home: allowHome, headless: true, allowTests: true });
  const intent = {
    attemptId: newGoalId("attempt"),
    generation: 1,
    operationId: newGoalId("operation"),
  };
  const goalId = newGoalId();
  const first = authority.authorizeTest({ planHash: hashA, intent, goal: { id: goalId } });
  assert.equal(typeof first, "string");
  const second = authority.authorizeTest({ planHash: hashA, intent, goal: { id: goalId } });
  assert.equal(second, null);
  const foreign = authority.authorizeTest({
    planHash: "f".repeat(64),
    intent,
    goal: { id: goalId },
  });
  assert.equal(foreign, null);
});

test("the durable workflow refuses command tools with a clear error", linux, async (t) => {
  const commandHome = makeTempDir("matrix-dur005-cmd-home-");
  t.after(() => rmSync(commandHome, { recursive: true, force: true }));
  const authority = createGoalAuthority({ home: commandHome });
  assert.throws(
    () => authority.authorizeCommand(),
    (error) => {
      assert.equal(error.code, "goal-command-unsupported");
      assert.match(error.message, /run_sandboxed_command/);
      return true;
    },
  );
  const { home, workspace, goalId } = createFixture(t, {
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const engine = scriptedEngine([
    {
      content: "",
      toolCalls: [{ name: "run_sandboxed_command", arguments: { script: "echo hi" } }],
    },
  ]);
  const runtime = createGoalRuntime({ home, goalId, workspace, engine, headless: true });
  const result = await runtime.resume();
  assert.equal(result.reason.code, "unsupported-tool");
  assert.match(result.reason.message, /run_sandboxed_command/);
  assert.match(result.reason.message, /not available/);
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 1;\n");
});

// --------------------------------------------------------------------------
// B. Ctrl+C / cancellation
// --------------------------------------------------------------------------

test("Ctrl+C at approval denies the operation", linux, async (t) => {
  const { home, workspace, store, goalId } = createFixture(t, {
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  let runtime;
  const engine = scriptedEngine([
    () => {
      runtime.cancel();
      return editTurn("src/a.mjs", "export const a = 2;\n");
    },
  ]);
  runtime = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine,
    headless: true,
    allowEdits: true,
  });
  const result = await runtime.resume();
  assert.equal(result.status, "cancelled");
  assert.equal(result.reason.code, "provider-interrupted");
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 1;\n");
  const editIntents = store
    .readJournal(goalId)
    .filter((r) => r.kind === "intent" && r.payload.kind === "edit");
  assert.equal(editIntents.length, 0);
});

// --------------------------------------------------------------------------
// D. Process ownership: pid reuse and host identity
// --------------------------------------------------------------------------

test("a pid reused by an unrelated process is never signalled", linux, async (t) => {
  const helper = await ensureHelper(t);
  const home = makeTempDir("matrix-dur005-reuse-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { createExecutionOwnership } = await import("../lib/goal-policy.mjs");
  const ownership = createExecutionOwnership({ home, helperPath: helper });
  const innocent = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      process.kill(innocent.pid, "SIGKILL");
    } catch {
      /* already exited */
    }
  });
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (existsSync(`/proc/${innocent.pid}/stat`)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const stat = readFileSync(`/proc/${innocent.pid}/stat`, "utf8");
  const rparen = stat.lastIndexOf(")");
  const fields = stat.slice(rparen + 2).split(" ");
  const startTime = fields[19];
  const pgid = Number(fields[2]);
  const operationId = newGoalId("operation");
  const goalId = newGoalId();
  const attemptId = newGoalId("attempt");
  const workspace = { path: "/tmp/dur005-reuse-ws", device: "1", inode: "2" };
  const ownershipDir = join(home, "ownership");
  mkdirSync(ownershipDir, { recursive: true, mode: 0o700 });
  chmodSync(ownershipDir, 0o700);
  const deadInode = deadNamespaceInode();
  const record = {
    schemaVersion: 1,
    operationId,
    goalId,
    attemptId,
    generation: 1,
    kind: "test",
    planHash: "a".repeat(64),
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    machineId: readFileSync("/etc/machine-id", "utf8").trim(),
    pid: innocent.pid,
    pgid,
    startTime: String(Number(startTime) - 7),
    startedAt: Date.now(),
    workspace,
    namespace: {
      initPid: innocent.pid,
      initStartTime: "1",
      inode: deadInode,
    },
  };
  record.containment = {
    kind: "pid-namespace",
    monitor: { pid: record.pid, startTime: record.startTime },
    init: { pid: record.namespace.initPid, startTime: record.namespace.initStartTime },
    namespace: record.namespace,
  };
  writeFileSync(join(ownershipDir, `${operationId}.json`), JSON.stringify(record), { mode: 0o600 });
  chmodSync(join(ownershipDir, `${operationId}.json`), 0o600);
  const block = {
    goalId,
    workspace,
    operations: [{ operationId, kind: "test", attemptId, generation: 1 }],
  };
  const attestation = ownership.verifyTeardown(block);
  assert.equal(attestation.verified, true, JSON.stringify(attestation));
  let alive;
  try {
    process.kill(innocent.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  assert.equal(alive, true, "the pid-reused occupant must survive verification");
});

test("a host or boot identity mismatch refuses attestation", linux, async (t) => {
  const helper = await ensureHelper(t);
  const home = makeTempDir("matrix-dur005-hostid-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { createExecutionOwnership } = await import("../lib/goal-policy.mjs");
  const ownership = createExecutionOwnership({ home, helperPath: helper });
  const operationId = newGoalId("operation");
  const goalId = newGoalId();
  const attemptId = newGoalId("attempt");
  const workspace = { path: "/tmp/dur005-hostid-ws", device: "1", inode: "2" };
  const machineId = readFileSync("/etc/machine-id", "utf8").trim();
  const ownershipDir = join(home, "ownership");
  mkdirSync(ownershipDir, { recursive: true, mode: 0o700 });
  // A legacy record without containment is insufficient even on a new boot.
  writeFileSync(
    join(ownershipDir, `${operationId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      operationId,
      goalId,
      attemptId,
      generation: 1,
      kind: "test",
      planHash: "a".repeat(64),
      bootId: "00000000-0000-0000-0000-000000000000",
      machineId,
      pid: process.pid,
      pgid: process.pid,
      startTime: "1",
      startedAt: Date.now(),
      workspace,
      namespace: { initPid: process.pid, initStartTime: "1", inode: "1" },
    }),
    { mode: 0o600 },
  );
  chmodSync(join(ownershipDir, `${operationId}.json`), 0o600);
  const block = {
    goalId,
    workspace,
    operations: [{ operationId, kind: "test", attemptId, generation: 1 }],
  };
  const reboot = ownership.verifyTeardown(block);
  assert.equal(reboot.verified, false);
  assert.equal(reboot.reason, "containment-unverified");
  // Foreign machine: refused outright.
  const foreignOp = newGoalId("operation");
  writeFileSync(
    join(ownershipDir, `${foreignOp}.json`),
    JSON.stringify({
      schemaVersion: 1,
      operationId: foreignOp,
      goalId,
      attemptId,
      generation: 1,
      kind: "test",
      planHash: "a".repeat(64),
      bootId: "00000000-0000-0000-0000-000000000000",
      machineId: "0".repeat(32),
      pid: process.pid,
      pgid: process.pid,
      startTime: "1",
      startedAt: Date.now(),
      workspace,
      namespace: { initPid: process.pid, initStartTime: "1", inode: "1" },
    }),
    { mode: 0o600 },
  );
  chmodSync(join(ownershipDir, `${foreignOp}.json`), 0o600);
  const foreignBlock = {
    goalId,
    workspace,
    operations: [{ operationId: foreignOp, kind: "test", attemptId, generation: 1 }],
  };
  const refused = ownership.verifyTeardown(foreignBlock);
  assert.equal(refused.verified, false);
  assert.equal(refused.reason, "host-identity-mismatch");
});

// --------------------------------------------------------------------------
// E. Concurrent writers: rename and replacement
// --------------------------------------------------------------------------

test("ordinary writers are refused while a durable goal owns the workspace", linux, async (t) => {
  const home = makeTempDir("matrix-dur005-conc-home-");
  const workspace = makeTempDir("matrix-dur005-conc-ws-");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.mjs"), "export const a = 1;\n");
  const identity = statSync(workspace, { bigint: true });
  const store = createGoalStore(home);
  const goalId = newGoalId();
  store.create({
    schemaVersion: 1,
    id: goalId,
    createdAt: Date.now(),
    objective: "concurrent owner",
    workspace: {
      path: workspace,
      device: String(identity.dev),
      inode: String(identity.ino),
      revision: null,
      manifest: hash("manifest"),
    },
    provider: { id: "scripted", modelId: "scripted", digest: hash("provider") },
    state: "ready",
    generation: 0,
    sequence: 0,
    budget: { ...GOAL_DEFAULT_BUDGET },
    operations: [],
    criteria: [
      {
        id: newGoalId("criterion"),
        revision: 1,
        kind: "artifact",
        path: "src/a.mjs",
        sha256: hash("x"),
      },
    ],
  });
  withGoalLock(workspace, (lock) => {
    const fence = { goalId, generation: 0, sequence: 1 };
    const begun = store.beginAttempt(goalId, { lock, fence });
    assert.ok(begun.lease);
  });
  const runChild = (target, body) =>
    spawnSync(
      process.execPath,
      ["--input-type=module", "-e", body.replace(/__TARGET__/g, JSON.stringify(target))],
      { encoding: "utf8", timeout: 10_000, env: { ...process.env, MATRIX_HOME: home } },
    );
  const child = runChild(
    workspace,
    `const fs = await import("node:fs");
const { withWorkspaceWriteLock } = await import("${join(PACKAGE_ROOT, "lib", "workspace.mjs")}");
try { withWorkspaceWriteLock(__TARGET__, () => { fs.writeFileSync(__TARGET__.replace(/\\/$/, "") + "/src/a.mjs", "BYPASS\\n"); }); console.log("WROTE"); }
catch (error) { console.log("REFUSED:" + error.message); process.exit(1); }`,
  );
  assert.match(child.stdout + child.stderr, /REFUSED/);
  assert.equal(readFileSync(join(workspace, "src", "a.mjs"), "utf8"), "export const a = 1;\n");
  const renamed = workspace + "-renamed";
  renameSync(workspace, renamed);
  const child2 = runChild(
    renamed,
    `const fs = await import("node:fs");
const { withWorkspaceWriteLock } = await import("${join(PACKAGE_ROOT, "lib", "workspace.mjs")}");
try { withWorkspaceWriteLock(__TARGET__, () => { fs.writeFileSync(__TARGET__.replace(/\\/$/, "") + "/src/a.mjs", "BYPASS\\n"); }); console.log("WROTE"); }
catch (error) { console.log("REFUSED:" + error.message); process.exit(1); }`,
  );
  assert.match(child2.stdout + child2.stderr, /REFUSED/);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.mjs"), "replacement\n");
  const child3 = runChild(
    workspace,
    `const fs = await import("node:fs");
const { withWorkspaceWriteLock } = await import("${join(PACKAGE_ROOT, "lib", "workspace.mjs")}");
try { withWorkspaceWriteLock(__TARGET__, () => { fs.writeFileSync(__TARGET__.replace(/\\/$/, "") + "/src/a.mjs", "BYPASS\\n"); }); console.log("WROTE"); }
catch (error) { console.log("REFUSED:" + error.message); process.exit(1); }`,
  );
  assert.match(child3.stdout + child3.stderr, /REFUSED/);
  const other = makeTempDir("matrix-dur005-other-ws-");
  t.after(() => rmSync(other, { recursive: true, force: true }));
  mkdirSync(join(other, "src"), { recursive: true });
  writeFileSync(join(other, "src", "a.mjs"), "original\n");
  const child4 = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const fs = await import("node:fs");
       const { withWorkspaceWriteLock } = await import("${join(PACKAGE_ROOT, "lib", "workspace.mjs")}");
       withWorkspaceWriteLock(${JSON.stringify(other)}, () => { fs.writeFileSync(${JSON.stringify(join(other, "src", "a.mjs"))}, "allowed\\n"); });
       console.log("WROTE");`,
    ],
    { encoding: "utf8", timeout: 10_000, env: { ...process.env, MATRIX_HOME: home } },
  );
  assert.match(child4.stdout, /WROTE/);
  assert.equal(readFileSync(join(other, "src", "a.mjs"), "utf8"), "allowed\n");
  rmSync(workspace, { recursive: true, force: true });
  renameSync(renamed, workspace);
});

test(
  "an ownership record blocks its workspace without blocking unrelated workspaces",
  linux,
  (t) => {
    const { home, workspace, goalId } = createFixture(t);
    const other = makeTempDir("matrix-dur005-unrelated-ws-");
    t.after(() => rmSync(other, { recursive: true, force: true }));
    createExecutionOwnership({ home }).recordDispatch({
      operationId: newGoalId("operation"),
      goalId,
      attemptId: newGoalId("attempt"),
      generation: 1,
      pid: process.pid,
      workspaceRoot: workspace,
    });
    assert.throws(
      () => withWorkspaceWriteLock(workspace, () => {}, { home }),
      /unverified execution/,
    );
    assert.equal(
      withWorkspaceWriteLock(other, () => "allowed", { home }),
      "allowed",
    );
  },
);

test(
  "a live detached execution blocks its workspace with a missing or empty goals directory",
  linux,
  async (t) => {
    const home = makeTempDir("matrix-dur005-ownership-only-home-");
    const workspace = makeTempDir("matrix-dur005-ownership-only-ws-");
    const other = makeTempDir("matrix-dur005-ownership-only-other-");
    t.after(() => {
      for (const path of [home, workspace, other, `${workspace}.lock`, `${other}.lock`]) {
        rmSync(path, { recursive: true, force: true });
      }
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    t.after(async () => {
      child.kill("SIGKILL");
      await closed;
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const operationId = newGoalId("operation");
    createExecutionOwnership({ home }).recordDispatch({
      operationId,
      goalId: newGoalId(),
      attemptId: newGoalId("attempt"),
      generation: 1,
      pid: child.pid,
      workspaceRoot: workspace,
    });
    const goals = join(home, "goals");
    const target = join(workspace, "unexpected-write");
    assert.equal(existsSync(goals), false);
    for (const createGoals of [false, true]) {
      if (createGoals) mkdirSync(goals, { mode: 0o700 });
      assert.throws(
        () => withWorkspaceWriteLock(workspace, () => writeFileSync(target, "bypass"), { home }),
        (error) =>
          error.blocker?.reason === "surviving-execution-unverified" &&
          error.blocker?.operationId === operationId,
      );
      assert.equal(existsSync(target), false);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
      assert.equal(
        withWorkspaceWriteLock(other, () => true, { home }),
        true,
      );
    }
  },
);

test(
  "controller edits respect a durable lease in its explicit state directory",
  linux,
  async (t) => {
    const { home, workspace, store, goalId } = createFixture(t, {
      files: { "src/a.mjs": "export const a = 1;\n" },
    });
    const { createRunController } = await import("../lib/controller.mjs");
    const { detectProject } = await import("../lib/project.mjs");
    const start = (controller) =>
      controller.start({
        task: "rename a to b in src/a.mjs",
        project: detectProject(workspace),
        model: { id: "local", provider: "matrix" },
        autoApprove: true,
      });
    withGoalLock(workspace, (lock) => {
      store.beginAttempt(goalId, { lock, fence: { goalId, generation: 0, sequence: 1 } });
    });
    const controller = createRunController({ home, headless: true });
    await start(controller);
    assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 1;\n");
    withGoalLock(workspace, (lock) => {
      const { goal } = store.inspect(goalId);
      store.reclaimAttempt(goalId, {
        lock,
        fence: { goalId, generation: goal.generation, sequence: goal.sequence },
      });
    });
    await start(createRunController({ home, headless: true }));
    assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const b = 1;\n");
  },
);

test(
  "an orphaned detached descendant cannot be released by legacy process-group evidence",
  linux,
  async (t) => {
    const helper = await ensureHelper(t);
    const { home, workspace, goalId, record } = createFixture(t);
    const marker = join(workspace, "escaped-pid");
    const childCode = "setInterval(() => {}, 1000)";
    const parentCode = `const {spawn}=require("node:child_process");
    const fs=require("node:fs");
    const child=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],
      {detached:true,stdio:"ignore"});
    child.unref(); fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));
    setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["-e", parentCode], { detached: true, stdio: "ignore" });
    let escapedPid;
    t.after(() => {
      try {
        if (escapedPid) process.kill(escapedPid, "SIGKILL");
      } catch {
        /* already exited */
      }
      try {
        parent.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    });
    const ownership = createExecutionOwnership({ home, helperPath: helper });
    const operationId = newGoalId("operation");
    const attemptId = newGoalId("attempt");
    ownership.recordDispatch({
      goalId,
      operationId,
      attemptId,
      generation: 1,
      pid: parent.pid,
      workspaceRoot: workspace,
    });
    for (let i = 0; i < 100 && !existsSync(marker); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(existsSync(marker), "the detached descendant must start");
    escapedPid = Number(readFileSync(marker, "utf8"));
    const exited = new Promise((resolve) => parent.once("exit", resolve));
    parent.kill("SIGKILL");
    await exited;
    const block = {
      goalId,
      workspace: record.workspace,
      operations: [{ goalId, operationId, attemptId, generation: 1 }],
    };
    assert.equal(ownership.verifyTeardown(block).verified, false);
    const owned = JSON.parse(
      readFileSync(join(ownership.ownershipDir, `${operationId}.json`), "utf8"),
    );
    mkdirSync(ownership.reconciledDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(ownership.reconciledDir, `${operationId}.json`),
      JSON.stringify({
        ...owned,
        verifiedAt: Date.now(),
        mechanism: "already-exited",
        helperSha256: createHash("sha256").update(readFileSync(helper)).digest("hex"),
      }),
      { mode: 0o600 },
    );
    assert.equal(ownership.verifyTeardown(block).verified, false);
    assert.notEqual(readProcIdentity(escapedPid).state, "Z");
  },
);

test(
  "the namespace oracle counts the recorded namespace and ignores a reused inode",
  linux,
  async (t) => {
    const directory = makeTempDir("matrix-dur005-nsoracle-");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const infoFile = join(directory, "info.json");
    const infoFd = openSync(infoFile, "w+");
    const sandbox = spawn(
      "/usr/bin/bwrap",
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--chdir",
        "/tmp",
        "--info-fd",
        "3",
        "--",
        process.execPath,
        "-e",
        "setInterval(() => {}, 1000);",
      ],
      { stdio: ["ignore", "ignore", "ignore", infoFd], detached: true },
    );
    closeSync(infoFd);
    const sandboxExit = new Promise((resolve) => sandbox.on("exit", resolve));
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try {
        process.kill(-sandbox.pid, "SIGKILL");
      } catch {
        /* already exited */
      }
      await sandboxExit;
    };
    t.after(stop);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    await waitFor(
      () => existsSync(infoFile) && readFileSync(infoFile, "utf8").trim().endsWith("}"),
      "bubblewrap namespace identity",
    );
    const info = JSON.parse(readFileSync(infoFile, "utf8"));
    const initPid = info["child-pid"];
    const inode = String(info["pid-namespace"]);
    const live = { initPid, initStartTime: readProcIdentity(initPid).startTime, inode };
    // The pin keeps this inode bound to sandbox B until the test ends.
    pinNamespace(t, live);
    await waitFor(
      () => namespaceLiveMembers(live).length >= 2,
      "the sandbox init and its command to start",
    );
    const members = namespaceLiveMembers(live);
    assert.ok(
      members.some((member) => member.pid === initPid),
      "the live namespace init must be reported",
    );
    assert.equal(hostPidInNamespace(live, 1), initPid);

    // A dead recorded namespace whose inode number now belongs to this sandbox.
    const reusedStart = { ...live, initStartTime: String(BigInt(live.initStartTime) - 1n) };
    const reusedPid = { ...live, initPid: process.pid };
    for (const [label, recorded] of [
      ["a different init start time", reusedStart],
      ["a different init pid", reusedPid],
    ]) {
      assert.deepEqual(
        namespaceLiveMembers(recorded),
        [],
        `a reused inode with ${label} must not count as the recorded namespace`,
      );
      assert.equal(hostPidInNamespace(recorded, 1), null);
    }
    // Without a recorded init start time the oracle cannot tell instances
    // apart, so it fails closed and reports every inode match.
    assert.deepEqual(
      namespaceLiveMembers({ ...live, initStartTime: null })
        .map((member) => member.pid)
        .sort((a, b) => a - b),
      namespaceLiveMembers(live)
        .map((member) => member.pid)
        .sort((a, b) => a - b),
    );

    await stop();
    await waitFor(() => namespaceLiveMembers(live).length === 0, "the sandbox to stop");
    for (const member of members) {
      let identity = null;
      try {
        identity = readProcIdentity(member.pid);
      } catch {
        /* reaped */
      }
      assert.ok(
        identity === null ||
          identity.state === "Z" ||
          identity.startTime !== member.identity.startTime,
        `sandbox process ${member.pid} must not survive cleanup`,
      );
    }
  },
);

test(
  "a contained descendant that detaches from its process group is torn down",
  linux,
  async (t) => {
    const helper = await ensureHelper(t);
    const { home, workspace, goalId, record } = createFixture(t);
    const childMarker = join(workspace, "detached-child.pid");
    const parentMarker = join(workspace, "detached-parent.pid");
    const infoFile = join(workspace, "contained-info.json");
    const childCode = `const fs=require("node:fs");
const m=fs.readFileSync("/proc/self/status","utf8").match(/NSpid:\\s*(\\d+)/);
fs.writeFileSync(${JSON.stringify(childMarker)},String(Number(m[1])));
setInterval(()=>{},1000);`;
    const parentCode = `const {spawn}=require("node:child_process");
const fs=require("node:fs");
const localPid=()=>{const m=fs.readFileSync("/proc/self/status","utf8").match(/NSpid:\\s*(\\d+)/);return Number(m[1].trim().split(/\\s+/).pop());};
const child=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{detached:true,stdio:"ignore",env:process.env});
child.unref();
fs.writeFileSync(${JSON.stringify(parentMarker)},String(localPid()));
setInterval(()=>{},1000);`;
    const script = join(workspace, "detach.cjs");
    writeFileSync(script, parentCode);
    const infoFd = openSync(infoFile, "w+");
    const bwrap = spawn(
      "/usr/bin/bwrap",
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--chdir",
        workspace,
        "--info-fd",
        "3",
        "--",
        process.execPath,
        script,
      ],
      { cwd: workspace, stdio: ["ignore", "pipe", "pipe", infoFd], detached: true },
    );
    closeSync(infoFd);
    let initPid = null;
    t.after(() => {
      for (const pid of [initPid, bwrap.pid]) {
        try {
          if (pid) process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    });
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    await waitFor(
      () => existsSync(infoFile) && readFileSync(infoFile, "utf8").trim().endsWith("}"),
      "bubblewrap namespace identity",
    );
    const info = JSON.parse(readFileSync(infoFile, "utf8"));
    initPid = info["child-pid"];
    const namespaceInode = String(info["pid-namespace"]);
    const initIdentity = readProcIdentity(initPid);
    const recordedNamespace = {
      initPid,
      initStartTime: initIdentity.startTime,
      inode: namespaceInode,
    };
    pinNamespace(t, recordedNamespace);
    await waitFor(
      () => existsSync(parentMarker) && existsSync(childMarker),
      "the detached tree to start",
    );
    const parentLocalPid = Number(readFileSync(parentMarker, "utf8"));
    const childLocalPid = Number(readFileSync(childMarker, "utf8"));
    await waitFor(
      () =>
        hostPidInNamespace(recordedNamespace, parentLocalPid) !== null &&
        hostPidInNamespace(recordedNamespace, childLocalPid) !== null,
      "the detached tree to appear in the host PID table",
    );
    const parentHostPid = hostPidInNamespace(recordedNamespace, parentLocalPid);
    const childHostPid = hostPidInNamespace(recordedNamespace, childLocalPid);
    const guardianIdentity = readProcIdentity(bwrap.pid);
    const childIdentity = readProcIdentity(childHostPid);
    assert.notEqual(
      childIdentity.pgrp,
      guardianIdentity.pgrp,
      "the descendant must leave the recorded process group",
    );
    const ownership = createExecutionOwnership({ home, helperPath: helper });
    const operationId = newGoalId("operation");
    const attemptId = newGoalId("attempt");
    ownership.recordDispatch({
      goalId,
      operationId,
      attemptId,
      generation: 1,
      pid: bwrap.pid,
      pgid: guardianIdentity.pgrp,
      containment: {
        kind: "pid-namespace",
        monitor: { pid: bwrap.pid, startTime: guardianIdentity.startTime },
        init: { pid: initPid, startTime: initIdentity.startTime },
        namespace: {
          initPid,
          initStartTime: initIdentity.startTime,
          inode: String(info["pid-namespace"]),
        },
      },
      workspaceRoot: workspace,
    });
    const result = ownership.verifyTeardown({
      goalId,
      workspace: record.workspace,
      operations: [{ goalId, operationId, attemptId, generation: 1 }],
    });
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.match(result.operations[0].mechanism, /pidfd|already-exited/);
    for (const pid of [parentHostPid, childHostPid]) {
      await waitFor(() => {
        try {
          return readProcIdentity(pid).state === "Z";
        } catch {
          return true;
        }
      }, `pid ${pid} to stop`);
    }
    assert.deepEqual(namespaceLiveMembers(recordedNamespace), []);
  },
);

/**
 * A disposable-snapshot isolation for the direct containment-runner tests. The
 * test owns the snapshot, so it can inspect what the isolated command wrote
 * without the live workspace ever seeing it.
 */
function goalIsolation(t, workspace) {
  const snapshot = createWorkspaceSnapshot(workspace, { matrixHome: null });
  t.after(() => cleanupWorkspaceSnapshot(snapshot));
  const isolation = async ({ file, cwd, env, gateRoot }) => {
    const built = createGoalTestIsolation({
      workspace,
      cwd,
      executable: file,
      gateRoot,
      snapshot,
      env,
    });
    return { bwrapArgs: built.bwrapArgs, gateMount: built.gateMount };
  };
  return { isolation, snapshot };
}

test(
  "cancelling a contained run kills its detached descendant before returning",
  linux,
  async (t) => {
    const helper = await ensureHelper(t);
    const { home, workspace, goalId } = createFixture(t);
    const parentMarker = join(workspace, "cancel-parent.pid");
    const childMarker = join(workspace, "cancel-child.pid");
    const childCode = `const fs=require("node:fs");
const host=Number(fs.readFileSync("/proc/self/status","utf8").match(/NSpid:\\s*(.+)/)[1].trim().split(/\\s+/)[0]);
fs.writeFileSync(${JSON.stringify(childMarker)},String(host));
setInterval(()=>{},1000);`;
    const parentCode = `const {spawn}=require("node:child_process");
const fs=require("node:fs");
const host=Number(fs.readFileSync("/proc/self/status","utf8").match(/NSpid:\\s*(.+)/)[1].trim().split(/\\s+/)[0]);
const child=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{detached:true,stdio:"ignore",env:process.env});
child.unref();
fs.writeFileSync(${JSON.stringify(parentMarker)},String(host));
setInterval(()=>{},1000);`;
    const script = join(workspace, "cancel-parent.cjs");
    writeFileSync(script, parentCode);
    const ownership = createExecutionOwnership({ home, helperPath: helper });
    const operationId = newGoalId("operation");
    const attemptId = newGoalId("attempt");
    const { isolation: isolationFactory, snapshot } = goalIsolation(t, workspace);
    const runner = createContainmentProcessRunner({
      ownership,
      gateRoot: join(home, "containment"),
      isolation: isolationFactory,
      onPin: (containment) =>
        ownership.recordDispatch({
          operationId,
          goalId,
          attemptId,
          generation: 1,
          pid: containment.monitor.pid,
          containment,
          workspaceRoot: workspace,
        }),
    });
    const controller = new AbortController();
    const execution = runner({
      file: process.execPath,
      args: [script],
      cwd: workspace,
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    // The isolated command writes inside the disposable snapshot, never in the
    // live workspace.
    await waitFor(
      () =>
        existsSync(join(snapshot.workspacePath, "cancel-parent.pid")) &&
        existsSync(join(snapshot.workspacePath, "cancel-child.pid")),
      "the contained tree to start",
    );
    assert.equal(
      existsSync(parentMarker),
      false,
      "the isolated command must not write to the live workspace",
    );
    const [record] = readOwnershipRecords(home);
    assert.ok(record?.namespace, "the dispatch must record its PID namespace");
    pinNamespace(t, record.namespace);
    assert.ok(
      namespaceLiveMembers(record.namespace).length > 0,
      "the contained tree must be running before cancellation",
    );
    controller.abort();
    const result = await execution;
    assert.equal(result.aborted, true);
    assert.equal(result.ok, false);
    assert.deepEqual(
      namespaceLiveMembers(record.namespace),
      [],
      "cancellation must settle the exact namespace before the runner returns",
    );
    const reconciled = JSON.parse(
      readFileSync(join(home, "ownership", "reconciled", `${operationId}.json`), "utf8"),
    );
    assert.equal(
      statSync(join(home, "ownership", "reconciled", `${operationId}.json`)).mode & 0o777,
      0o600,
    );
    assert.equal(reconciled.containment.kind, "pid-namespace");
    assert.equal(reconciled.containment.namespace.inode, record.namespace.inode);
    assert.match(reconciled.mechanism, /pidfd|already-exited/);
  },
);

test(
  "normal completion settles a detached descendant left behind by the test",
  linux,
  async (t) => {
    const helper = await ensureHelper(t);
    const { home, workspace, goalId } = createFixture(t);
    const childMarker = join(workspace, "orphan-child.pid");
    const childCode = `const fs=require("node:fs");
const host=Number(fs.readFileSync("/proc/self/status","utf8").match(/NSpid:\\s*(.+)/)[1].trim().split(/\\s+/)[0]);
fs.writeFileSync(${JSON.stringify(childMarker)},String(host));
setInterval(()=>{},1000);`;
    const parentCode = `const {spawn}=require("node:child_process");
const fs=require("node:fs");
const child=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{detached:true,stdio:"ignore",env:process.env});
child.unref();
const timer=setInterval(()=>{
  if (fs.existsSync(${JSON.stringify(childMarker)})) { clearInterval(timer); process.exit(0); }
},25);
setTimeout(()=>process.exit(1),10000);`;
    const script = join(workspace, "orphan-parent.cjs");
    writeFileSync(script, parentCode);
    const ownership = createExecutionOwnership({ home, helperPath: helper });
    const operationId = newGoalId("operation");
    const attemptId = newGoalId("attempt");
    const { isolation: isolationFactory, snapshot } = goalIsolation(t, workspace);
    const runner = createContainmentProcessRunner({
      ownership,
      gateRoot: join(home, "containment"),
      isolation: isolationFactory,
      onPin: (containment) =>
        ownership.recordDispatch({
          operationId,
          goalId,
          attemptId,
          generation: 1,
          pid: containment.monitor.pid,
          containment,
          workspaceRoot: workspace,
        }),
    });
    const result = await runner({
      file: process.execPath,
      args: [script],
      cwd: workspace,
      timeoutMs: 30_000,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.code, 0);
    assert.ok(
      existsSync(join(snapshot.workspacePath, "orphan-child.pid")),
      "the detached child must have started inside the disposable snapshot",
    );
    assert.equal(
      existsSync(childMarker),
      false,
      "the isolated command must not write to the live workspace",
    );
    const [record] = readOwnershipRecords(home);
    assert.ok(record?.namespace, "the dispatch must record its PID namespace");
    // The run has finished, so this namespace cannot be pinned while alive.
    // The oracle discriminates a reused inode by the recorded init identity.
    assert.deepEqual(
      namespaceLiveMembers(record.namespace),
      [],
      "normal completion must settle the namespace even after the monitor exits",
    );
    const reconciled = JSON.parse(
      readFileSync(join(home, "ownership", "reconciled", `${operationId}.json`), "utf8"),
    );
    assert.equal(reconciled.containment.kind, "pid-namespace");
    assert.match(reconciled.mechanism, /pidfd|already-exited/);
  },
);

test("goal test dispatch refuses before starting an uncontained process", linux, async (t) => {
  const { home, workspace } = createFixture(t);
  const marker = join(workspace, "unexpected-execution");
  const runner = createGoalTestRunner({
    home,
    workspaceRoot: workspace,
    plan: {
      file: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
      cwd: workspace,
    },
    ownership: createExecutionOwnership({ home }),
  });
  const result = await runner({ planHash: hash("plan") });
  assert.equal(result.status, "denied");
  assert.match(result.summary, /containment/);
  assert.equal(existsSync(marker), false);
});

test("an old process-group reconciliation cannot release an ownership block", linux, (t) => {
  const { home, workspace, goalId } = createFixture(t);
  const operationId = newGoalId("operation");
  const attemptId = newGoalId("attempt");
  const ownership = createExecutionOwnership({ home });
  const record = ownership.recordDispatch({
    goalId,
    operationId,
    attemptId,
    generation: 1,
    pid: process.pid,
    workspaceRoot: workspace,
  });
  mkdirSync(ownership.reconciledDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(ownership.reconciledDir, `${operationId}.json`),
    JSON.stringify({
      schemaVersion: 1,
      operationId,
      goalId,
      attemptId,
      generation: 1,
      mechanism: "pidfd-teardown",
      verifiedAt: Date.now(),
      workspace: record.workspace,
    }),
    { mode: 0o600 },
  );
  assert.throws(
    () => withWorkspaceWriteLock(workspace, () => {}, { home }),
    /unverified execution/,
  );
});

test("a corrupt durable goal state refuses ordinary writers", linux, async (t) => {
  const home = makeTempDir("matrix-dur005-corrupt-home-");
  const workspace = makeTempDir("matrix-dur005-corrupt-ws-");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  mkdirSync(join(home, "goals"), { mode: 0o700 });
  mkdirSync(join(home, "goals", "goal_" + "a".repeat(32)), { mode: 0o700 });
  writeFileSync(join(home, "goals", "goal_" + "a".repeat(32), "checkpoint.json"), "{not json");
  chmodSync(join(home, "goals", "goal_" + "a".repeat(32)), 0o700);
  chmodSync(join(home, "goals", "goal_" + "a".repeat(32), "checkpoint.json"), 0o600);
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.env.MATRIX_HOME = ${JSON.stringify(home)};
       const { withWorkspaceWriteLock } = await import(${JSON.stringify(join(PACKAGE_ROOT, "lib", "workspace.mjs"))});
       try { withWorkspaceWriteLock(${JSON.stringify(workspace)}, () => {}); console.log("ALLOWED"); }
       catch (error) { console.log("REFUSED:" + error.message); process.exit(1); }`,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.match(child.stdout + child.stderr, /REFUSED:.*corrupt or unsafe/);
});

// --------------------------------------------------------------------------
// F. Disk failure before intent and after an effect
// --------------------------------------------------------------------------

test("a disk failure before the intent prevents the effect", linux, async (t) => {
  const { home, workspace, store, goalId } = createFixture(t, {
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const baseStore = store;
  const failingStore = new Proxy(baseStore, {
    get(target, prop) {
      if (prop === "append") {
        return (id, authority, kind, input, options) => {
          if (kind === "intent" && input?.kind === "edit") {
            throw new Error("injected ENOSPC: intent cannot be persisted");
          }
          return target.append(id, authority, kind, input, options);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const engine = scriptedEngine([
    editTurn("src/a.mjs", "export const a = 2;\n"),
    { content: "done", toolCalls: [] },
  ]);
  const runtime = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine,
    store: failingStore,
    headless: true,
    allowEdits: true,
  });
  const result = await runtime.resume();
  assert.notEqual(result.status, "completed");
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 1;\n");
  const editIntents = baseStore
    .readJournal(goalId)
    .filter((record) => record.kind === "intent" && record.payload.kind === "edit");
  assert.equal(editIntents.length, 0);
});

test("a disk failure after the effect leaves a blocked, non-successful goal", linux, async (t) => {
  const { home, workspace, store, goalId } = createFixture(t, {
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const baseStore = store;
  const failingStore = new Proxy(baseStore, {
    get(target, prop) {
      if (prop === "append") {
        return (id, authority, kind, input, options) => {
          if (kind === "receipt" && Array.isArray(input?.files) && input.files.length > 0) {
            throw new Error("injected ENOSPC: receipt cannot be persisted");
          }
          return target.append(id, authority, kind, input, options);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const engine = scriptedEngine([
    () => {
      runtime.authority.registerEditGrant({
        path: "src/a.mjs",
        content: "export const a = 2;\n",
        approved: true,
        goalId,
      });
      return editTurn("src/a.mjs", "export const a = 2;\n");
    },
    { content: "done", toolCalls: [] },
  ]);
  let runtime;
  runtime = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine,
    store: failingStore,
    headless: true,
  });
  const result = await runtime.resume();
  assert.notEqual(result.status, "completed");
  assert.equal(readFileSync(join(workspace, "src/a.mjs"), "utf8"), "export const a = 2;\n");
  const editReceipts = baseStore
    .readJournal(goalId)
    .filter(
      (record) =>
        record.kind === "receipt" &&
        Array.isArray(record.payload?.files) &&
        record.payload.files.length > 0,
    );
  assert.equal(editReceipts.length, 0);
  const editDispatches = baseStore
    .readJournal(goalId)
    .filter((record) => record.kind === "dispatch" && record.payload?.kind === "edit");
  assert.equal(editDispatches.length, 1);
  const fresh = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine: scriptedEngine([{ content: "done", toolCalls: [] }]),
    headless: true,
  });
  const blocked = await fresh.resume();
  assert.equal(blocked.status, "safe-stop");
  assert.equal(blocked.reason.code, "active-attempt");
  const { reconcileGoalOperations } = await import("../lib/goal-recovery.mjs");
  const reconciliation = reconcileGoalOperations(baseStore, goalId, { workspaceRoot: workspace });
  assert.equal(reconciliation.canResume, true);
  assert.ok(
    Object.values(reconciliation.fileReconciliations).some((entry) => entry.path === "src/a.mjs"),
  );
});

// --------------------------------------------------------------------------
// G. Reclaim of a verifiably dead attempt
// --------------------------------------------------------------------------

test("reclaim succeeds only after the owner is verifiably dead", linux, async (t) => {
  const home = makeTempDir("matrix-dur005-reclaim-home-");
  const workspace = makeTempDir("matrix-dur005-reclaim-ws-");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src/a.mjs"), "export const a = 1;\n");
  const identity = statSync(workspace, { bigint: true });
  const store = createGoalStore(home);
  const goalId = newGoalId();
  store.create({
    schemaVersion: 1,
    id: goalId,
    createdAt: Date.now(),
    objective: "reclaim",
    workspace: {
      path: workspace,
      device: String(identity.dev),
      inode: String(identity.ino),
      revision: null,
      manifest: hash("manifest"),
    },
    provider: { id: "scripted", modelId: "scripted", digest: hash("provider") },
    state: "ready",
    generation: 0,
    sequence: 0,
    budget: { ...GOAL_DEFAULT_BUDGET },
    operations: [],
    criteria: [
      {
        id: newGoalId("criterion"),
        revision: 1,
        kind: "artifact",
        path: "src/a.mjs",
        sha256: hash("x"),
      },
    ],
  });
  withGoalLock(workspace, (lock) => {
    const fence = { goalId, generation: 0, sequence: 1 };
    const begun = store.beginAttempt(goalId, { lock, fence });
    assert.ok(begun.lease);
  });
  const alive = reclaimStaleGoalAttempt({ home, goalId, workspace });
  assert.equal(alive.reclaimed, false);
  assert.equal(alive.reason, "lease-owner-alive");
  const unchanged = store.inspect(goalId);
  assert.ok(unchanged.lease, "the lease is untouched");
});

// --------------------------------------------------------------------------
// H. Ordinary-command behavior is unchanged outside the goal workflow
// --------------------------------------------------------------------------

test("ordinary standalone command behavior is unchanged", linux, async () => {
  const { createCommandPolicy } = await import("../lib/command-policy.mjs");
  const policy = createCommandPolicy({ enabled: true, headless: true });
  assert.ok(policy);
  const { GoalCommandUnsupportedError } = await import("../lib/goal-policy.mjs");
  const error = new GoalCommandUnsupportedError("x");
  assert.equal(error.code, "goal-command-unsupported");
});

// --------------------------------------------------------------------------
// I. SIGKILL recovery via the driver fixture
// --------------------------------------------------------------------------

test(
  "a SIGKILLed goal leaves a durable teardown block until pidfd verification",
  linux,
  async (t) => {
    const home = makeTempDir("matrix-dur005-sigkill-home-");
    const workspace = makeTempDir("matrix-dur005-sigkill-ws-");
    t.after(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    });
    // Install the reviewed helper at the default MATRIX_HOME/bin location:
    // the lease probe releases the teardown block only for reconciliation
    // records bound to the sha256 of that exact binary.
    const binDir = join(home, "bin");
    const build = spawnSync("node", ["scripts/build-pidfd-helper.mjs", "--out", binDir], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    });
    if (build.status !== 0) {
      throw new Error(`pidfd helper could not be built: ${build.stderr || build.stdout}`);
    }
    chmodSync(binDir, 0o700);
    const helper = join(binDir, "matrix-pidfd-helper");
    const childScript = join(workspace, "hang-child.mjs");
    const hangScript = join(workspace, "hang.mjs");
    const testScript = join(workspace, "hang-phase.mjs");
    writeFileSync(
      childScript,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.DUR005_RECORDS + ".grand", JSON.stringify({ pid: process.pid }) + "\\n", { flag: "a" });\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
    );
    writeFileSync(
      hangScript,
      `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst phase = process.env.DUR005_PHASE || "1";\nif (phase === "2") { console.log("ok 1 - resumed"); console.log("# pass 1"); console.log("# duration_ms 5"); process.exit(0); }\nconst child = spawn(process.execPath, [process.env.DUR005_CHILD], { stdio: "ignore", env: process.env });\nwriteFileSync(process.env.DUR005_RECORDS + ".root", JSON.stringify({ pid: process.pid }) + "\\n", { flag: "a" });\nwriteFileSync(process.env.DUR005_RECORDS + ".child", JSON.stringify({ pid: child.pid }) + "\\n", { flag: "a" });\nprocess.on("SIGTERM", () => {});\nchild.on("exit", () => process.exit(0));\nsetInterval(() => {}, 1000);\n`,
    );
    writeFileSync(
      testScript,
      `import { spawnSync } from "node:child_process";\nconst r = spawnSync(process.execPath, [process.env.DUR005_HANG], { stdio: "inherit", env: process.env });\nprocess.exit(r.status ?? 0);\n`,
    );
    const testPlan = {
      file: process.execPath,
      args: [testScript],
      cwd: workspace,
      framework: "node --test",
    };
    const inspected = inspectTestPlan(testPlan, { cwd: workspace });
    assert.equal(inspected.ok, true, inspected.error);
    const goalId = newGoalId();
    const identity = statSync(workspace, { bigint: true });
    const record = {
      schemaVersion: 1,
      id: goalId,
      createdAt: Date.now(),
      objective: "sigkill test",
      workspace: {
        path: workspace,
        device: String(identity.dev),
        inode: String(identity.ino),
        revision: null,
        manifest: hash("manifest"),
      },
      provider: { id: "scripted", modelId: "scripted", digest: hash("provider") },
      state: "ready",
      generation: 0,
      sequence: 0,
      budget: { ...GOAL_DEFAULT_BUDGET },
      operations: [],
      criteria: [
        {
          id: newGoalId("criterion"),
          revision: 1,
          kind: "test",
          planHash: inspected.plan.planHash,
        },
      ],
    };
    createGoalStore(home).create(record);
    const phaseFile = join(workspace, "phase.txt");
    writeFileSync(phaseFile, "1");
    const recordsBase = join(workspace, "records");
    const env = {
      ...process.env,
      DUR005_HOME: home,
      DUR005_WORKSPACE: workspace,
      DUR005_GOAL_ID: goalId,
      DUR005_PACKAGE_ROOT: PACKAGE_ROOT,
      DUR005_MODE: "run",
      DUR005_TEST_PLAN: JSON.stringify(testPlan),
      DUR005_TOOL_TIMEOUT_MS: "10000",
      DUR005_HELPER: helper,
      DUR005_RECORDS: recordsBase,
      DUR005_CHILD: childScript,
      DUR005_HANG: hangScript,
      DUR005_PHASE: "1",
      DUR005_PHASE_FILE: phaseFile,
      MATRIX_HOME: home,
    };
    const driverScript = join(workspace, "driver.mjs");
    writeFileSync(driverScript, DRIVER);
    const driver = spawn(process.execPath, [driverScript], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    driver.stdout.resume();
    // The owned test runs in a disposable snapshot, so the host cannot observe
    // its files. The namespace membership is the observable instead: the tree is
    // the namespace init, the guardian, the test command, its child and the
    // grandchild.
    const expectedTreeDepth = 5;
    const readyDeadline = Date.now() + 20_000;
    let members = [];
    while (Date.now() < readyDeadline) {
      const observed = readOwnershipRecords(home);
      if (observed.length >= 1 && observed[0].namespace) {
        members = namespaceLiveMembers(observed[0].namespace);
        if (members.length >= expectedTreeDepth) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(members.length >= expectedTreeDepth, "the owned test must reach its grandchild");
    assert.equal(
      existsSync(recordsBase + ".grand"),
      false,
      "the isolated test must not write to the live workspace",
    );
    const firstRecords = readOwnershipRecords(home);
    assert.equal(firstRecords.length, 1, "one dispatch record must exist before the crash");
    const firstRecord = firstRecords[0];
    assert.ok(firstRecord.namespace, "the dispatch must record its PID namespace");
    // Hold the crashed attempt's namespace for the rest of the test so its
    // inode number cannot be freed and given to an unrelated sandbox.
    pinNamespace(t, firstRecord.namespace);
    assert.ok(
      namespaceLiveMembers(firstRecord.namespace).length > 0,
      "the contained tree must be running before the driver is killed",
    );
    driver.kill("SIGKILL");
    const driverExit = await new Promise((resolve) =>
      driver.on("exit", (code, signal) => resolve({ code, signal })),
    );
    assert.equal(driverExit.signal, "SIGKILL");
    assert.ok(
      namespaceLiveMembers(firstRecord.namespace).length > 0,
      "the contained tree must survive the driver's death",
    );
    const writerSource = `const fs = await import("node:fs");
const { withWorkspaceWriteLock } = await import(${JSON.stringify(
      join(PACKAGE_ROOT, "lib", "workspace.mjs"),
    )});
try { withWorkspaceWriteLock(${JSON.stringify(workspace)}, () => { fs.writeFileSync(${JSON.stringify(
      join(workspace, "intruder.txt"),
    )}, "BYPASS\\n"); }); console.log("WROTE"); }
catch (error) { console.log("REFUSED:" + error.message); process.exit(1); }`;
    const runWriter = () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", writerSource], {
        env: { ...process.env, MATRIX_HOME: home },
        encoding: "utf8",
        timeout: 15_000,
      });
    const blockedWhileActive = runWriter();
    assert.match(
      blockedWhileActive.stdout + blockedWhileActive.stderr,
      /REFUSED/,
      "a second writer must be refused while the dead owner's lease is still active",
    );
    assert.equal(existsSync(join(workspace, "intruder.txt")), false);
    const fresh = spawnSync(process.execPath, [driverScript], {
      env: { ...env, DUR005_MODE: "run" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.match(fresh.stdout, /DUR005-RESULT/);
    const freshResult = JSON.parse(fresh.stdout.match(/DUR005-RESULT (.*)/)[1]);
    assert.equal(freshResult.status, "safe-stop");
    assert.equal(freshResult.reason.code, "active-attempt");
    assert.equal(freshResult.generation, 1, "no new generation is admitted");
    const reclaim = spawnSync(process.execPath, [driverScript], {
      env: { ...env, DUR005_MODE: "reclaim" },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.match(reclaim.stdout, /DUR005-RESULT/);
    const reclaimResult = JSON.parse(reclaim.stdout.match(/DUR005-RESULT (.*)/)[1]);
    assert.equal(reclaimResult.reclaimed, true);
    const blockedWhileUnverified = runWriter();
    assert.match(
      blockedWhileUnverified.stdout + blockedWhileUnverified.stderr,
      /REFUSED/,
      "a second writer must be refused while an owned process may survive",
    );
    assert.equal(existsSync(join(workspace, "intruder.txt")), false);
    writeFileSync(phaseFile, "2");
    const recoveredEnv = { ...env, DUR005_MODE: "run", DUR005_PHASE: "2" };
    const recovered = spawnSync(process.execPath, [driverScript], {
      env: recoveredEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(recovered.stdout, /DUR005-RESULT/);
    const recoveredResult = JSON.parse(recovered.stdout.match(/DUR005-RESULT (.*)/)[1]);
    assert.equal(recoveredResult.status, "completed");
    assert.equal(recoveredResult.generation, 2);
    assert.deepEqual(
      namespaceLiveMembers(firstRecord.namespace),
      [],
      "the recovered PID namespace must have no live members",
    );
    for (const ownershipRecord of readOwnershipRecords(home)) {
      if (!ownershipRecord.namespace) continue;
      // Records created inside the spawnSync runs above cannot be pinned while
      // alive; the oracle discriminates a reused inode by the recorded init.
      assert.deepEqual(
        namespaceLiveMembers(ownershipRecord.namespace),
        [],
        `operation ${ownershipRecord.operationId} must leave no live namespace members`,
      );
    }
    const allowed = runWriter();
    assert.match(allowed.stdout, /WROTE/, "a writer may proceed after verified teardown");
    assert.equal(readFileSync(join(workspace, "intruder.txt"), "utf8"), "BYPASS\n");
    const reconciledDir = join(home, "ownership", "reconciled");
    const reconciledNames = readdirSync(reconciledDir);
    assert.ok(
      reconciledNames.includes(`${firstRecord.operationId}.json`),
      "the crashed operation must be reconciled",
    );
    for (const name of reconciledNames) {
      assert.match(name, /^operation_[a-f0-9]{32}\.json$/);
      const reconciled = JSON.parse(readFileSync(join(reconciledDir, name), "utf8"));
      assert.equal(statSync(join(reconciledDir, name)).mode & 0o777, 0o600);
      assert.equal(reconciled.operationId, name.slice(0, -".json".length));
      assert.match(reconciled.mechanism, /pidfd|already-exited|host-reboot/);
    }
  },
);
