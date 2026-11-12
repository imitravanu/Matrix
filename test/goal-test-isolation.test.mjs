// DUR-001 contract repair — the durable-goal test containment boundary.
//
// The durable goal's approved test command must run in a disposable workspace
// snapshot with no network, cleared credentials and restricted filesystem
// access, while the PID-namespace ownership, the verified teardown and the
// crash-recovery protocol stay in force.
//
// These regressions drive the real goal runtime. The isolated test asserts, from
// inside the boundary, that it cannot read a host credential canary and cannot
// reach a host loopback server; the host asserts that the sentinels outside
// the disposable snapshot were never created and that the live workspace was
// not modified.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GOAL_DEFAULT_BUDGET, newGoalId } from "../lib/goal-contracts.mjs";
import { createGoalStore } from "../lib/goal-store.mjs";
import { collectOperationHistory } from "../lib/goal-context.mjs";
import {
  createGoalAuthority,
  createGoalRuntime,
  createExecutionOwnership,
} from "../lib/goal-policy.mjs";
import { inspectTestPlan } from "../lib/test-policy.mjs";

const linux = { skip: process.platform !== "linux", timeout: 60_000 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

function buildHelper(t, home) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const built = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "scripts", "build-pidfd-helper.mjs"), "--out", bin],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(built.status, 0, built.stderr || built.error?.message);
  return join(bin, "matrix-pidfd-helper");
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "matrix-goal-isolation-"));
  const workspace = join(base, "workspace");
  const home = join(base, "home");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, workspace, home };
}

/**
 * Drive one durable goal whose single criterion is the approved test plan, and
 * return the runtime result.
 */
async function runGoalWithTest(t, { workspace, home, plan, signal = null, cancelAfterMs = 0 }) {
  const helper = buildHelper(t, home);
  const inspected = inspectTestPlan(plan, { cwd: workspace });
  assert.equal(inspected.ok, true, inspected.error);
  const planHash = inspected.plan.planHash;
  const goalId = newGoalId();
  const identity = statSync(workspace, { bigint: true });
  const record = {
    schemaVersion: 1,
    id: goalId,
    createdAt: Date.now(),
    objective: "isolation regression",
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
    operations: [],
    criteria: [{ id: newGoalId("criterion"), revision: 1, kind: "test", planHash }],
    budget: { ...GOAL_DEFAULT_BUDGET },
  };
  createGoalStore(home).create(record);

  const authority = createGoalAuthority({
    home,
    workspace: { path: workspace, device: String(identity.dev), inode: String(identity.ino) },
  });
  const engine = {
    async turn() {
      authority.registerTestGrant({ planHash, approved: true, goalId });
      return {
        content: "",
        toolCalls: [{ name: "test", arguments: { planHash } }],
      };
    },
  };
  const runtime = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine,
    testPlan: plan,
    authority,
    headless: true,
    allowTests: true,
    helperPath: helper,
    executionOwnership: createExecutionOwnership({ home, helperPath: helper }),
    signal,
  });
  let timer = null;
  if (cancelAfterMs) {
    timer = setTimeout(() => runtime.pause(), cancelAfterMs);
    timer.unref?.();
  }
  let result;
  try {
    result = await runtime.resume();
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { result, goalId, planHash, runtime };
}

/**
 * The isolated probe. It asserts that the host credential canary is
 * unreadable and the host loopback server is unreachable, and it attempts the
 * writes the host checks afterwards.
 */
function probeSource({ canary, port, liveSentinel, outsideSentinel }) {
  return `import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { connect } from "node:net";

const canary = ${JSON.stringify(canary)};
const liveSentinel = ${JSON.stringify(liveSentinel)};
const outsideSentinel = ${JSON.stringify(outsideSentinel)};
const port = ${JSON.stringify(port)};

test("the isolated goal test cannot reach the host", async () => {
  assert.throws(
    () => readFileSync(canary, "utf8"),
    /ENOENT|EACCES/,
    "a host credential canary must not be readable inside the boundary",
  );
  const reachable = await new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    setTimeout(() => done(false), 3000);
  });
  assert.equal(reachable, false, "the host loopback server must not be reachable");
  writeFileSync(liveSentinel, "written");
  writeFileSync(outsideSentinel, "written");
});
`;
}

test(
  "an approved goal test runs in a disposable snapshot with no host access",
  linux,
  async (t) => {
    const { base, workspace, home } = fixture(t);
    const canary = join(base, "credential-canary.txt");
    writeFileSync(canary, "host-credential-secret", { mode: 0o600 });
    const liveSentinel = join(workspace, "live-sentinel.txt");
    const outsideSentinel = join(base, "outside-sentinel.txt");

    let served = 0;
    const server = createServer((request, response) => {
      served += 1;
      request.resume();
      response.end("host-secret");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());

    const probe = join(workspace, "probe.test.mjs");
    writeFileSync(
      probe,
      probeSource({
        canary,
        port: String(server.address().port),
        liveSentinel,
        outsideSentinel,
      }),
    );
    const plan = {
      file: process.execPath,
      args: ["--test", "probe.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const { result } = await runGoalWithTest(t, { workspace, home, plan });

    // The probe ran and every boundary it checked held.
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(served, 0, "the isolated test must not reach the host loopback server");
    // Nothing the isolated test wrote reached the host.
    assert.equal(
      existsSync(liveSentinel),
      false,
      "an isolated goal test must not modify the live workspace",
    );
    assert.equal(
      existsSync(outsideSentinel),
      false,
      "an isolated goal test must not modify a file outside the snapshot",
    );
  },
);

test(
  "an isolated goal test cannot modify the live workspace it was copied from",
  linux,
  async (t) => {
    const { workspace, home } = fixture(t);
    const target = join(workspace, "src", "target.mjs");
    mkdirSync(join(workspace, "src"), { recursive: true, mode: 0o700 });
    writeFileSync(target, "export const a = 1;\n");
    const before = readFileSync(target, "utf8");
    const script = join(workspace, "mutate.test.mjs");
    writeFileSync(
      script,
      `import test from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("mutate", () => { writeFileSync(${JSON.stringify(target)}, "export const a = 2;\\n"); });\n`,
    );
    const plan = {
      file: process.execPath,
      args: ["--test", "mutate.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const { result } = await runGoalWithTest(t, { workspace, home, plan });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(
      readFileSync(target, "utf8"),
      before,
      "the live workspace file must be unchanged after an isolated goal test",
    );
  },
);

test(
  "a goal test's child and grandchild processes are contained and torn down",
  linux,
  async (t) => {
    const { workspace, home } = fixture(t);
    const child = join(workspace, "child.mjs");
    const grandchild = join(workspace, "grandchild.mjs");
    writeFileSync(
      grandchild,
      "import { setInterval } from 'node:timers';\nsetInterval(() => {}, 1000);\n",
    );
    writeFileSync(
      child,
      `import { spawn } from "node:child_process";\nimport { setInterval } from "node:timers";\nspawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });\nsetInterval(() => {}, 1000);\n`,
    );
    const script = join(workspace, "spawner.test.mjs");
    writeFileSync(
      script,
      `import test from "node:test";\nimport { spawn } from "node:child_process";\nimport { setInterval } from "node:timers";\ntest("spawn", () => { spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "ignore" }); setInterval(() => {}, 1000); });\n`,
    );
    const plan = {
      file: process.execPath,
      args: ["--test", "spawner.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const { result } = await runGoalWithTest(t, { workspace, home, plan });
    assert.notEqual(result.status, "completed", "the hanging test must not complete");
    // The whole owned tree must be settled before the attempt ends.
    for (const record of readOwnershipRecords(home)) {
      if (!record.namespace) continue;
      assert.deepEqual(
        namespaceLiveMembers(record.namespace),
        [],
        "the owned namespace must have no live member after the attempt",
      );
    }
  },
);

test("cancelling an isolated goal test settles the owned namespace", linux, async (t) => {
  const { workspace, home } = fixture(t);
  const script = join(workspace, "hang.test.mjs");
  writeFileSync(
    script,
    "import test from 'node:test';\nimport { setInterval } from 'node:timers';\ntest('hang', () => { setInterval(() => {}, 1000); });\n",
  );
  const plan = {
    file: process.execPath,
    args: ["--test", "hang.test.mjs"],
    cwd: workspace,
    framework: "node --test",
  };
  const { result } = await runGoalWithTest(t, { workspace, home, plan, cancelAfterMs: 1500 });
  assert.notEqual(result.status, "completed", "a cancelled test must not complete the goal");
  for (const record of readOwnershipRecords(home)) {
    if (!record.namespace) continue;
    assert.deepEqual(
      namespaceLiveMembers(record.namespace),
      [],
      "cancellation must settle the owned namespace",
    );
  }
});

test(
  "a SIGKILLed goal test leaves a durable block and no stale test evidence",
  linux,
  async (t) => {
    const { workspace, home } = fixture(t);
    const script = join(workspace, "hang.test.mjs");
    writeFileSync(
      script,
      "import test from 'node:test';\nimport { setInterval } from 'node:timers';\ntest('hang', () => { setInterval(() => {}, 1000); });\n",
    );
    const plan = {
      file: process.execPath,
      args: ["--test", "hang.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const inspected = inspectTestPlan(plan, { cwd: workspace });
    assert.equal(inspected.ok, true, inspected.error);
    const planHash = inspected.plan.planHash;
    const helper = buildHelper(t, home);
    const goalId = newGoalId();
    const identity = statSync(workspace, { bigint: true });
    createGoalStore(home).create({
      schemaVersion: 1,
      id: goalId,
      createdAt: Date.now(),
      objective: "sigkill regression",
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
      operations: [],
      criteria: [{ id: newGoalId("criterion"), revision: 1, kind: "test", planHash }],
      budget: { ...GOAL_DEFAULT_BUDGET },
    });
    const driver = join(workspace, "driver.mjs");
    writeFileSync(
      driver,
      `import { createGoalAuthority, createGoalRuntime, createExecutionOwnership, reclaimStaleGoalAttempt } from ${JSON.stringify(
        join(PACKAGE_ROOT, "lib", "goal-policy.mjs"),
      )};
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const home = process.env.ISO_HOME;
const workspace = process.env.ISO_WORKSPACE;
const goalId = process.env.ISO_GOAL;
const planHash = process.env.ISO_PLAN;
const mode = process.env.ISO_MODE ?? "run";
const identity = statSync(workspace, { bigint: true });
if (mode === "recover") {
  // A fresh process releases the dead owner's lease and proves through the
  // trusted ownership boundary that the owned tree is gone.
  const reclaimed = reclaimStaleGoalAttempt({ home, goalId, workspace });
  const ownership = createExecutionOwnership({ home, helperPath: process.env.ISO_HELPER });
  const directory = join(home, "ownership");
  const record = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")))
    .filter((entry) => entry.goalId === goalId)[0];
  if (!record) {
    console.log("ISO-RECOVER " + JSON.stringify({ verified: false, reason: "no-ownership-record" }));
    process.exit(0);
  }
  const result = ownership.verifyTeardown({
    goalId,
    workspace: record.workspace,
    operations: [
      {
        goalId,
        operationId: record.operationId,
        attemptId: record.attemptId,
        generation: record.generation,
        workspace: record.workspace,
      },
    ],
  });
  console.log(
    "ISO-RECOVER " +
      JSON.stringify({
        reclaimed: reclaimed.reclaimed === true,
        verified: result.verified === true,
        reason: result.reason ?? null,
        mechanisms: (result.operations ?? []).map((entry) => entry.mechanism),
      }),
  );
  process.exit(0);
}
const authority = createGoalAuthority({
  home,
  workspace: { path: workspace, device: String(identity.dev), inode: String(identity.ino) },
});
const engine = {
  async turn() {
    authority.registerTestGrant({ planHash, approved: true, goalId });
    return { content: "", toolCalls: [{ name: "test", arguments: { planHash } }] };
  },
};
const runtime = createGoalRuntime({
  home,
  goalId,
  workspace,
  engine,
  testPlan: ${JSON.stringify(plan)},
  authority,
  headless: true,
  allowTests: true,
  helperPath: process.env.ISO_HELPER,
});
const result = await runtime.resume();
console.log("ISO-RESULT " + JSON.stringify({ status: result.status, reason: result.reason }));
`,
    );
    const env = {
      ...process.env,
      ISO_HOME: home,
      ISO_WORKSPACE: workspace,
      ISO_GOAL: goalId,
      ISO_PLAN: planHash,
      ISO_HELPER: helper,
    };
    const child = spawn(process.execPath, [driver], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();

    // The barrier: the owned process tree must actually have started before a
    // crash is injected. Without it the rest of this test would pass
    // vacuously.
    const deadline = Date.now() + 20_000;
    let members = [];
    let ownership = null;
    while (Date.now() < deadline) {
      const records = readOwnershipRecords(home);
      if (records.length >= 1 && records[0].namespace) {
        ownership = records[0];
        members = namespaceLiveMembers(ownership.namespace);
        if (members.length >= 3) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ownership?.namespace, "the dispatch must record its PID namespace");
    assert.ok(
      members.length >= 3,
      "the owned test tree must be running before the crash is injected",
    );
    const operationId = ownership.operationId;
    assert.match(operationId, /^operation_[a-f0-9]{32}$/);

    // The crash must actually be a SIGKILL of the goal's own process.
    assert.equal(child.kill("SIGKILL"), true, "the crashed attempt must be signalled");
    const [exitCode, exitSignal] = await once(child, "close");
    assert.equal(exitCode, null, "the crashed attempt must not exit normally");
    assert.equal(exitSignal, "SIGKILL", "the crashed attempt must die from SIGKILL");
    assert.ok(
      namespaceLiveMembers(ownership.namespace).length > 0,
      "the owned tree must survive the death of its owner",
    );

    // The crashed attempt must not have produced a succeeded test receipt.
    // A receipt carries no operation kind, so the operation history is the
    // authority: the crashed operation is matched by its operation id.
    const store = createGoalStore(home);
    const history = collectOperationHistory(store, goalId);
    const crashed = history.operations.find((entry) => entry.operationId === operationId);
    assert.ok(crashed?.intent, "the crashed attempt must have a committed intent");
    assert.equal(crashed.intent.kind, "test", "the crashed operation must be the test");
    assert.ok(!crashed.receipt, "the crashed operation must not carry a receipt");
    const succeededTests = history.summaries.filter(
      (entry) => entry.operationKind === "test" && entry.status === "succeeded",
    );
    assert.equal(
      succeededTests.length,
      0,
      "a crashed attempt must not record a succeeded test summary",
    );
    assert.ok(
      !history.summaries.some((entry) => entry.operationId === operationId),
      "the crashed operation must not carry an executor summary",
    );

    // A fresh process must not accept the crashed attempt's test evidence.
    const fresh = spawnSync(process.execPath, [driver], { env, encoding: "utf8", timeout: 60_000 });
    assert.match(fresh.stdout, /ISO-RESULT/);
    const freshResult = JSON.parse(fresh.stdout.match(/ISO-RESULT (.*)/)[1]);
    assert.notEqual(
      freshResult.status,
      "completed",
      "the crashed attempt must not complete the goal",
    );
    const inspectedGoal = store.inspect(goalId);
    assert.notEqual(
      inspectedGoal.goal.state,
      "completed",
      "a crashed attempt must not complete the goal",
    );

    // A fresh process must verify the teardown of the owned tree through the
    // trusted ownership boundary, and that proof must be durable.
    const recovered = spawnSync(process.execPath, [driver], {
      env: { ...env, ISO_MODE: "recover" },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.match(recovered.stdout, /ISO-RECOVER/, recovered.stderr);
    const recovery = JSON.parse(recovered.stdout.match(/ISO-RECOVER (.*)/)[1]);
    assert.equal(recovery.reclaimed, true, "the dead owner's lease must be reclaimed");
    assert.equal(
      recovery.verified,
      true,
      `a fresh process must verify the teardown of the crashed attempt (${recovery.reason ?? "unknown"})`,
    );
    assert.ok(
      recovery.mechanisms.some((mechanism) => /pidfd|already-exited|host-reboot/.test(mechanism)),
      "the verified teardown must use a reviewed mechanism",
    );
    assert.deepEqual(
      namespaceLiveMembers(ownership.namespace),
      [],
      "the verified teardown must leave no live member in the owned namespace",
    );
    const reconciledDir = join(home, "ownership", "reconciled");
    const reconciled = readdirSync(reconciledDir);
    assert.ok(
      reconciled.includes(`${operationId}.json`),
      "the verified teardown must persist a reconciliation record",
    );
    const reconciliation = JSON.parse(
      readFileSync(join(reconciledDir, `${operationId}.json`), "utf8"),
    );
    assert.equal(reconciliation.operationId, operationId);
    assert.match(reconciliation.mechanism, /pidfd|already-exited|host-reboot/);
  },
);

function readOwnershipRecords(home) {
  const directory = join(home, "ownership");
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      if (!statSync(path).isFile()) continue;
      records.push(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Ignore an unreadable record.
    }
  }
  return records;
}

/** The PID-namespace inode of one process, or null when it cannot be read. */
function namespaceInodeOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`).replace(/^pid:\[(\d+)\]$/, "$1");
  } catch {
    return null;
  }
}

/** The namespace-local PIDs of one process, or null when it cannot be read. */
function namespacePidsOf(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^NSpid:\s*(.+)$/m.exec(status);
    if (!match) return null;
    return match[1].trim().split(/\s+/).map(Number);
  } catch {
    return null;
  }
}

/** The start time and state of one process, read from `/proc`. */
function readProcIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rparen = stat.lastIndexOf(")");
  const fields = stat.slice(rparen + 2).split(" ");
  return { startTime: fields[19], state: fields[0] };
}

/**
 * The processes that live in the recorded PID namespace.
 *
 * A PID-namespace inode number is reused once the namespace is gone, so the
 * candidates are only the recorded namespace when the recorded namespace init
 * is still its init. Without that discrimination an unrelated sandbox that
 * inherited the inode number would be reported as the goal's own tree.
 */
function recordedNamespaceProcesses(namespace) {
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

/** The live (non-zombie) host processes of one recorded PID namespace. */
function namespaceLiveMembers(namespace) {
  const members = [];
  for (const { pid } of recordedNamespaceProcesses(namespace)) {
    let identity;
    try {
      identity = readProcIdentity(pid);
    } catch {
      continue;
    }
    if (identity.state !== "Z") members.push(pid);
  }
  return members;
}
