import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { linuxBwrapArguments } from "../lib/linux-bwrap.mjs";
import {
  PROVIDER_ENVIRONMENT_KEYS,
  copyDemo,
  contentChunks,
  patchEnv,
  sseResponse,
  toolCallChunks,
  waitFor,
} from "./helpers.mjs";
import { runModelAgent } from "../lib/model-agent.mjs";
import { detectProject } from "../lib/project.mjs";
import { resolveModel } from "../lib/models.mjs";
import { TEST_ORIGIN, createTestPolicy, withTestExecutionContext } from "../lib/test-policy.mjs";
import { withWorkspaceWriteLock } from "../lib/workspace.mjs";

const GUARDIAN_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

const [configPath] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const evidencePath = path.join(config.evidenceDir, "run.json");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitUntil(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error("timeout waiting for " + label);
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function readIdentity(pid) {
  const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return {
    pid: Number(pid),
    startTime: Number(fields[19]),
    state: fields[0],
    command: fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim(),
  };
}
function writeJsonAtomic(file, value) {
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}
function nspid(pid) {
  const line = fs.readFileSync("/proc/" + pid + "/status", "utf8").split("\n").find((entry) => entry.startsWith("NSpid:"));
  return line ? line.split(/\s+/).slice(1).map(Number) : [];
}
function namespaceOf(pid) { return fs.readlinkSync("/proc/" + pid + "/ns/pid"); }
function firstChild(pid) {
  const names = fs.readFileSync("/proc/" + pid + "/task/" + pid + "/children", "utf8").trim();
  return names ? Number(names.split(/\s+/)[0]) : null;
}
function findWorker(marker, namespace, initPid) {
  for (const name of fs.readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid === initPid) continue;
    try {
      if (namespaceOf(pid) !== namespace) continue;
      if (!fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").includes(marker)) continue;
      return readIdentity(pid);
    } catch {}
  }
  return null;
}

(async () => {
  const emergency = setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); } catch {}
  }, 30000);
  emergency.unref();

  const workspace = fs.realpathSync(config.workspace);
  const workspaceStat = fs.statSync(workspace);
  const before = fs.readFileSync(path.join(workspace, config.pending.name));
  const after = Buffer.from(config.pending.after, "utf8");
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const evidence = {
    version: 1,
    goalId: config.goalId,
    runId: config.runId,
    bootId,
    workspace,
    workspaceStat: { dev: Number(workspaceStat.dev), ino: Number(workspaceStat.ino) },
    lockPath: config.lockPath,
    phase: "starting",
    guardian: readIdentity(process.pid),
    sandbox: null,
    worker: null,
    pendingWrite: {
      operationId: config.pending.operationId,
      path: config.pending.name,
      beforeSha256: digest(before),
      afterSha256: digest(after),
      state: "intent",
    },
  };
  writeJsonAtomic(evidencePath, evidence);

  const child = spawn("/usr/bin/bwrap", config.bwrapArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  await waitUntil(() => output.includes("COMMAND READY"), 5000, "sandbox command");

  if (config.mode === "unverified") {
    fs.writeFileSync(config.spawnedMarker, "spawned\n");
    setInterval(() => {}, 1000);
    return;
  }

  await waitUntil(() => output.includes("WORKER READY"), 5000, "detached worker");
  const initPid = await waitUntil(() => {
    const candidate = firstChild(child.pid);
    if (!candidate) return null;
    try {
      if (nspid(candidate).at(-1) !== 1) return null;
      return candidate;
    } catch { return null; }
  }, 5000, "sandbox init identity");
  const namespace = namespaceOf(initPid);
  const init = readIdentity(initPid);
  const marker = fs.readFileSync(path.join(config.snapshot, "worker-marker"), "utf8").trim();
  const worker = await waitUntil(() => findWorker(marker, namespace, initPid), 5000, "worker identity");

  const running = {
    ...evidence,
    phase: "running",
    sandbox: {
      monitor: readIdentity(child.pid),
      init,
      namespace,
    },
    worker,
    pendingWrite: { ...evidence.pendingWrite, state: "intent" },
  };
  writeJsonAtomic(evidencePath, running);
  fs.writeFileSync(path.join(workspace, config.pending.name), after, { mode: 0o600 });
  fs.writeFileSync(config.readyMarker, "ready\n");
  if (errors) fs.writeFileSync(config.stderrMarker, errors);
  setInterval(() => {}, 1000);
})().catch((error) => {
  fs.writeFileSync(config.errorMarker, String(error.stack || error) + "\n");
  console.error(error.stack || error);
  process.exit(1);
});
`;

const COMMAND_SOURCE = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.argv[1];
console.log("COMMAND READY");
if (mode === "worker") {
  const marker = fs.readFileSync("worker-marker", "utf8").trim();
  const worker = spawn(process.execPath, ["worker.js", marker], {
    detached: true,
    stdio: "ignore",
  });
  worker.unref();
  console.log("WORKER READY");
} else {
  console.log("COMMAND READY");
}
setInterval(() => {}, 1000);
`;

const WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const marker = process.argv[2] || "worker";
fs.appendFileSync("worker-start", marker + "\n");
setInterval(() => { fs.appendFileSync("worker-heartbeat", marker + "\n"); }, 25);
setInterval(() => {}, 1000);
`;

const RECOVERY_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const [evidenceDir] = process.argv.slice(1);
const runPath = path.join(evidenceDir, "run.json");
const recoveryPath = path.join(evidenceDir, "recovery.json");
const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const decisions = [];
const signals = [];
let run = null;

const SIGNAL_SCRIPT = [
  "import os, signal, sys",
  "pid = int(sys.argv[1])",
  "expected = int(sys.argv[2])",
  "signame = sys.argv[3]",
  "try:",
  "    fd = os.pidfd_open(pid)",
  "except ProcessLookupError:",
  "    print('GONE')",
  "    raise SystemExit(2)",
  "try:",
  "    with open('/proc/' + str(pid) + '/stat', 'rb') as handle:",
  "        stat = handle.read()",
  "    fields = stat.rsplit(b')', 1)[1].split()",
  "    actual = int(fields[19])",
  "    if actual != expected:",
  "        print('MISMATCH')",
  "        raise SystemExit(3)",
  "    signal.pidfd_send_signal(fd, getattr(signal, signame))",
  "    print('SIGNALED')",
  "finally:",
  "    os.close(fd)",
].join("\n");

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await sleep(20);
  }
  return false;
}
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function hashFile(file) { return digest(fs.readFileSync(file)); }
function writeJsonAtomic(file, value) {
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}
function writeRecovery(status, extra = {}) {
  writeJsonAtomic(recoveryPath, {
    version: 1,
    runId: run ? run.runId : null,
    status,
    at: new Date().toISOString(),
    decisions: [...decisions],
    signals: [...signals],
    ...extra,
  });
}
function fail(reason, extra = {}) {
  if (run) {
    writeJsonAtomic(runPath, {
      ...run,
      phase: "needs-attention",
      recoveryStatus: "needs-attention",
      recoveryReason: reason,
    });
  }
  writeRecovery("needs-attention", { reason, ...extra });
  process.exit(4);
}
function readIdentity(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid: Number(pid),
      startTime: Number(fields[19]),
      state: fields[0],
      command: fs.readFileSync("/proc/" + pid + "/comm", "utf8").trim(),
    };
  } catch {
    return null;
  }
}
function sameIdentity(current, persisted) {
  return Boolean(current && persisted && current.pid === persisted.pid && current.startTime === persisted.startTime);
}
function namespaceOf(pid) { return fs.readlinkSync("/proc/" + pid + "/ns/pid"); }
function nspid(pid) {
  const line = fs.readFileSync("/proc/" + pid + "/status", "utf8").split("\n").find((entry) => entry.startsWith("NSpid:"));
  return line ? line.split(/\s+/).slice(1).map(Number) : [];
}
async function waitGone(identity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sameIdentity(readIdentity(identity.pid), identity)) return true;
    await sleep(20);
  }
  return false;
}
function signalVerified(identity) {
  const result = spawnSync("python3", [
    "-c",
    SIGNAL_SCRIPT,
    String(identity.pid),
    String(identity.startTime),
    "SIGKILL",
  ], { encoding: "utf8", timeout: 3000 });
  const outcome = {
    target: identity.pid,
    startTime: identity.startTime,
    status: result.status,
    output: String(result.stdout || "").trim(),
    error: String(result.stderr || "").trim(),
  };
  signals.push(outcome);
  return outcome;
}

(async () => {
  const deadline = setTimeout(() => process.exit(5), 15000);
  run = JSON.parse(fs.readFileSync(runPath, "utf8"));
  writeRecovery("investigating", { phase: run.phase });
  if (!(await waitForFile(path.join(evidenceDir, "continue-investigation"), 10000))) {
    fail("test did not release the investigation gate");
  }
  if (run.version !== 1) fail("unsupported evidence version");
  if (run.bootId !== bootId) fail("boot identity mismatch");
  if (fs.realpathSync(run.workspace) !== run.workspace) fail("workspace path identity mismatch");
  const workspaceStat = fs.statSync(run.workspace);
  if (Number(workspaceStat.dev) !== run.workspaceStat.dev || Number(workspaceStat.ino) !== run.workspaceStat.ino) {
    fail("workspace root identity mismatch");
  }
  decisions.push("boot-and-workspace-identity-match");
  if (run.phase !== "running" || !run.sandbox || !run.worker) {
    fail("sandbox identity was not verified before guardian exit");
  }
  if (!sameIdentity(readIdentity(run.sandbox.monitor.pid), run.sandbox.monitor)) {
    fail("sandbox monitor identity mismatch");
  }
  if (!sameIdentity(readIdentity(run.sandbox.init.pid), run.sandbox.init)) {
    fail("sandbox init identity mismatch");
  }
  if (!sameIdentity(readIdentity(run.worker.pid), run.worker)) {
    fail("worker identity mismatch");
  }
  if (namespaceOf(run.sandbox.init.pid) !== run.sandbox.namespace) {
    fail("sandbox namespace mismatch");
  }
  if (namespaceOf(run.worker.pid) !== run.sandbox.namespace) {
    fail("worker namespace mismatch");
  }
  if (nspid(run.sandbox.init.pid).at(-1) !== 1) {
    fail("sandbox init is not namespace pid 1");
  }
  decisions.push("ownership-verified");

  const pendingPath = path.join(run.workspace, run.pendingWrite.path);
  let pendingHash;
  try {
    pendingHash = hashFile(pendingPath);
  } catch (error) {
    fail("pending write is missing", { error: String(error) });
  }
  let pendingState;
  if (pendingHash === run.pendingWrite.afterSha256) pendingState = "observed-applied";
  else if (pendingHash === run.pendingWrite.beforeSha256) pendingState = "not-applied";
  else fail("pending write matches neither image");
  decisions.push("pending-write:" + pendingState);
  const beforeStat = fs.statSync(pendingPath, { bigint: true });

  const initSignal = signalVerified(run.sandbox.init);
  if (initSignal.status === 3) fail("sandbox identity changed before signal", { signal: initSignal });
  if (!(await waitGone(run.sandbox.init, 3000))) {
    fail("sandbox teardown was not confirmed");
  }

  let monitorGone = await waitGone(run.sandbox.monitor, 2000);
  if (!monitorGone) {
    const monitorSignal = signalVerified(run.sandbox.monitor);
    if (monitorSignal.status === 3) fail("sandbox monitor identity changed before signal", { signal: monitorSignal });
    monitorGone = await waitGone(run.sandbox.monitor, 2000);
  }
  let workerGone = await waitGone(run.worker, 2000);
  if (!workerGone) {
    const workerSignal = signalVerified(run.worker);
    if (workerSignal.status === 3) fail("worker identity changed before signal", { signal: workerSignal });
    workerGone = await waitGone(run.worker, 2000);
  }
  if (!monitorGone || !workerGone) {
    fail("old run teardown was not confirmed", { monitorGone, workerGone });
  }
  decisions.push("teardown-confirmed");

  const afterStat = fs.statSync(pendingPath, { bigint: true });
  if (
    afterStat.ino !== beforeStat.ino ||
    afterStat.mtimeNs !== beforeStat.mtimeNs ||
    afterStat.ctimeNs !== beforeStat.ctimeNs
  ) {
    fail("workspace changed during teardown");
  }
  const finalHash = hashFile(pendingPath);
  if (finalHash !== pendingHash) fail("pending write changed during teardown");

  clearTimeout(deadline);
  writeJsonAtomic(runPath, {
    ...run,
    phase: "ready",
    recovery: { status: "ready", pendingWrite: pendingState },
  });
  writeRecovery("ready", {
    pendingWrite: { state: pendingState, sha256: finalHash },
    teardown: { sandbox: "gone", worker: "gone" },
    workspaceUnchanged: true,
  });
  process.exit(0);
})().catch((error) => {
  if (run) fail("recovery error: " + String(error.stack || error));
  console.error(error.stack || error);
  process.exit(1);
});
`;

const WRITER_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [evidenceDir, label] = process.argv.slice(1);
const run = JSON.parse(fs.readFileSync(path.join(evidenceDir, "run.json"), "utf8"));
let recovery = null;
try {
  recovery = JSON.parse(fs.readFileSync(path.join(evidenceDir, "recovery.json"), "utf8"));
} catch {}
const ready = run.phase === "ready" && recovery !== null && recovery.status === "ready";
const record = {
  label,
  pid: process.pid,
  lockAcquired: true,
  phase: run.phase,
  recoveryStatus: recovery ? recovery.status : null,
  decision: ready ? "execute" : "refuse",
  at: new Date().toISOString(),
};
const recordPath = path.join(evidenceDir, "writer-" + label + ".json");
const temp = recordPath + ".tmp-" + process.pid;
fs.writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
fs.renameSync(temp, recordPath);
if (!ready) {
  console.error("writer refused: goal is " + run.phase);
  process.exit(3);
}
fs.writeFileSync(
  path.join(run.workspace, "contender-" + label + ".txt"),
  "executed " + label + " pid=" + process.pid + "\n",
  { mode: 0o600 },
);
process.exit(0);
`;

const WITNESS_SOURCE = String.raw`
const fs = require("node:fs");
const [heartbeat] = process.argv.slice(1);
fs.writeFileSync(heartbeat, "started\n");
let count = 0;
setInterval(() => { fs.appendFileSync(heartbeat, String(++count) + "\n"); }, 20);
setInterval(() => {}, 1000);
`;

// This is a characterization of Linux flock, not a production goal lock.
test(
  "a live flock owner excludes another process and releases after death",
  { skip: process.platform !== "linux" },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-goal-lock-spike-"));
    const lock = join(dir, "workspace.lock");
    const worker = spawn(
      "flock",
      [
        "-n",
        "--no-fork",
        lock,
        process.execPath,
        "-e",
        'process.stdout.write("LOCKED\\n"); setInterval(() => {}, 1000)',
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => {
      worker.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    });
    const [chunk] = await Promise.race([
      once(worker.stdout, "data"),
      once(worker, "exit").then(([code]) => {
        throw new Error(`lock owner exited before ready: ${code}`);
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("lock owner readiness timeout")), 5000).unref(),
      ),
    ]);
    assert.equal(String(chunk), "LOCKED\n");
    const denied = spawnSync(
      "flock",
      ["-n", lock, process.execPath, "-e", 'process.stdout.write("EFFECT")'],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(denied.status, 1);
    assert.equal(denied.stdout, "");
    const exited = once(worker, "exit");
    worker.kill("SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
    const acquired = spawnSync(
      "flock",
      ["-n", lock, process.execPath, "-e", 'process.stdout.write("ACQUIRED")'],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(acquired.status, 0);
    assert.equal(acquired.stdout, "ACQUIRED");
  },
);

for (const descriptor of ["omitted", "forwarded", "closed"]) {
  const retainsLock = descriptor === "forwarded";
  test(
    retainsLock
      ? "a forwarded flock descriptor holds the lock until the detached worker exits"
      : `a detached worker can write after owner death and a second writer enters (${descriptor} descriptor)`,
    { skip: process.platform !== "linux", timeout: 15000 },
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "matrix-goal-lock-descendant-"));
      const lock = join(dir, "workspace.lock");
      const gate = join(dir, "release-child");
      const effect = join(dir, "child-effect");
      const descendantSource = `
        const { closeSync, existsSync, writeFileSync } = require('node:fs');
        const [gate, effect, descriptor] = process.argv.slice(1);
        if (descriptor === 'closed') closeSync(3);
        const poll = setInterval(() => {
          if (!existsSync(gate)) return;
          clearInterval(poll);
          clearTimeout(deadline);
          writeFileSync(effect, 'first run');
          console.log('EFFECT');
        }, 10);
        const deadline = setTimeout(() => process.exit(2), 8000);
        console.log('DESCENDANT READY');
      `;
      const ownerSource = `
        const { spawn } = require('node:child_process');
        const { readdirSync, readlinkSync } = require('node:fs');
        const [lock, gate, effect, source, descriptor] = process.argv.slice(1);
        const stdio = ['ignore', 'inherit', 'inherit'];
        if (descriptor !== 'omitted') {
          const fds = readdirSync('/proc/self/fd').filter((fd) => {
            try { return readlinkSync('/proc/self/fd/' + fd) === lock; }
            catch { return false; }
          });
          if (fds.length !== 1) throw new Error('missing flock descriptor');
          stdio.push(Number(fds[0]));
        }
        const worker = spawn(process.execPath, ['-e', source, gate, effect, descriptor], { detached: true, stdio });
        worker.unref();
        setInterval(() => {}, 1000);
      `;
      const owner = spawn(
        "flock",
        [
          "-n",
          "--no-fork",
          lock,
          process.execPath,
          "-e",
          ownerSource,
          lock,
          gate,
          effect,
          descendantSource,
          descriptor,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      let stderr = "";
      owner.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
      owner.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
      const exited = once(owner, "exit");
      const closed = once(owner, "close");
      t.after(async () => {
        if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
        writeFileSync(gate, "release");
        try {
          await closed;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
      assert.ok(
        await waitFor(() => output.includes("DESCENDANT READY"), { timeoutMs: 3000 }),
        stderr,
      );

      const contend = (wait = ["-n"]) =>
        spawnSync(
          "flock",
          [...wait, lock, process.execPath, "-e", 'process.stdout.write("SECOND WRITER")'],
          { encoding: "utf8", timeout: 3000 },
        );
      const before = contend();
      assert.equal(before.status, 1, before.stderr);
      assert.equal(before.stdout, "");
      owner.kill("SIGKILL");
      assert.deepEqual(await exited, [null, "SIGKILL"]);

      // The descendant is waiting for our signal and still able to write.
      const after = contend();
      assert.equal(after.status, retainsLock ? 1 : 0, after.stderr);
      assert.equal(after.stdout, retainsLock ? "" : "SECOND WRITER");
      writeFileSync(gate, "release");
      await closed;
      assert.match(output, /EFFECT/);
      assert.equal(readFileSync(effect, "utf8"), "first run");
      const released = contend(["-w", "2"]);
      assert.equal(released.status, 0, released.stderr);
      assert.equal(released.stdout, "SECOND WRITER");
    },
  );
}

test(
  "a Bubblewrap reaper keeps the lock after supervisor and command death without passing it to the command",
  { skip: process.platform !== "linux", timeout: 15000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-goal-lock-reaper-"));
    const lock = join(dir, "workspace.lock");
    const workspace = join(dir, "workspace");
    const snapshot = join(dir, "snapshot");
    mkdirSync(workspace);
    mkdirSync(snapshot);
    const node = realpathSync(process.execPath);
    const workerSource = `
      const { existsSync, writeFileSync } = require('node:fs');
      const command = process.argv[1];
      const deadline = setTimeout(() => process.exit(2), 8000);
      const reaped = setInterval(() => {
        if (existsSync('/proc/' + command)) return;
        clearInterval(reaped);
        console.log('COMMAND REAPED');
      }, 10);
      const poll = setInterval(() => {
        if (!existsSync('release-worker')) return;
        clearInterval(poll);
        clearInterval(reaped);
        clearTimeout(deadline);
        writeFileSync('worker-effect', 'snapshot only');
      }, 10);
      console.log('WORKER READY');
    `;
    const commandSource = `
      const { spawn } = require('node:child_process');
      const { existsSync, readdirSync, readlinkSync } = require('node:fs');
      const lock = process.argv[1];
      for (const fd of readdirSync('/proc/self/fd')) {
        let target;
        try { target = readlinkSync('/proc/self/fd/' + fd); } catch { continue; }
        if (target === lock) throw new Error('command inherited the lock');
      }
      const worker = spawn(process.execPath, ['-e', process.argv[2], String(process.pid)], { detached: true, stdio: 'inherit' });
      worker.unref();
      const deadline = setTimeout(() => process.exit(2), 8000);
      setInterval(() => {
        if (!existsSync('kill-command')) return;
        clearTimeout(deadline);
        process.kill(process.pid, 'SIGKILL');
      }, 10);
    `;
    const args = linuxBwrapArguments(
      {
        workspace,
        cwd: workspace,
        executable: node,
        argv: ["-e", commandSource, lock, workerSource],
      },
      { sourceRoot: workspace, workspacePath: snapshot },
    );
    // This experiment deliberately lets the namespace outlive the supervisor.
    // The reaper is the remaining lease holder while detached work is alive.
    args.splice(args.indexOf("--die-with-parent"), 1);
    const supervisorSource = `
      const { spawn } = require('node:child_process');
      const { readdirSync, readlinkSync } = require('node:fs');
      const [lock, args] = process.argv.slice(1);
      const fd = readdirSync('/proc/self/fd').find((name) => {
        try { return readlinkSync('/proc/self/fd/' + name) === lock; }
        catch { return false; }
      });
      if (fd === undefined) throw new Error('missing flock descriptor');
      spawn('/usr/bin/bwrap', ['--sync-fd', '3', ...JSON.parse(args)], { stdio: ['ignore', 'inherit', 'inherit', Number(fd)] });
    `;
    const supervisor = spawn(
      "flock",
      ["-n", "--no-fork", lock, node, "-e", supervisorSource, lock, JSON.stringify(args)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let stderr = "";
    supervisor.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    supervisor.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const exited = once(supervisor, "exit");
    const closed = once(supervisor, "close");
    t.after(async () => {
      if (supervisor.exitCode === null && supervisor.signalCode === null)
        supervisor.kill("SIGKILL");
      writeFileSync(join(snapshot, "kill-command"), "kill");
      writeFileSync(join(snapshot, "release-worker"), "release");
      try {
        await closed;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
    assert.ok(await waitFor(() => output.includes("WORKER READY"), { timeoutMs: 4000 }), stderr);
    supervisor.kill("SIGKILL");
    assert.deepEqual(await exited, [null, "SIGKILL"]);
    writeFileSync(join(snapshot, "kill-command"), "kill");
    assert.ok(await waitFor(() => output.includes("COMMAND REAPED"), { timeoutMs: 3000 }), stderr);
    const contender = spawnSync("flock", ["-n", lock, node, "-e", 'console.log("SECOND WRITER")'], {
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(contender.status, 1, contender.stderr);
    assert.equal(contender.stdout, "");
    writeFileSync(join(snapshot, "release-worker"), "release");
    await closed;
    assert.equal(readFileSync(join(snapshot, "worker-effect"), "utf8"), "snapshot only");
    assert.throws(() => readFileSync(join(workspace, "worker-effect")), { code: "ENOENT" });
    const released = spawnSync(
      "flock",
      ["-w", "2", lock, node, "-e", 'console.log("SECOND WRITER")'],
      {
        encoding: "utf8",
        timeout: 3000,
      },
    );
    assert.equal(released.status, 0, released.stderr);
    assert.equal(released.stdout.trim(), "SECOND WRITER");
  },
);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid: Number(pid),
      startTime: Number(fields[19]),
      state: fields[0],
    };
  } catch {
    return null;
  }
}

function identityMatches(identity) {
  const current = processIdentity(identity.pid);
  return Boolean(current && current.startTime === identity.startTime);
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(child, timeoutMs = 10000) {
  return Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`process ${child.pid} exit timeout`)), timeoutMs).unref();
    }),
  ]);
}

async function waitForGuardianMarker(marker, guardian, stderr) {
  const outcome = await waitFor(
    () => (existsSync(marker) ? "ready" : guardian.exitCode !== null ? "exit" : null),
    { timeoutMs: 8000 },
  );
  if (outcome !== "ready") throw new Error(`guardian exited before ${marker}: ${stderr()}`);
}

function spawnGuardian(lockPath, configPath) {
  return spawn(
    "flock",
    ["-n", "--no-fork", lockPath, process.execPath, "-e", GUARDIAN_SOURCE, configPath],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
}

function spawnRecovery(lockPath, evidenceDir) {
  return spawn(
    "flock",
    ["-n", "--no-fork", lockPath, process.execPath, "-e", RECOVERY_SOURCE, evidenceDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function runWriter(lockPath, evidenceDir, label, { wait = false } = {}) {
  const flock = wait ? ["-w", "5"] : ["-n"];
  return spawnSync(
    "flock",
    [...flock, "--no-fork", lockPath, process.execPath, "-e", WRITER_SOURCE, evidenceDir, label],
    { encoding: "utf8", timeout: 8000 },
  );
}

async function cleanupGuardianGroup(guardian) {
  if (!guardian || guardian.pid === undefined) return;
  if (guardian.exitCode === null && guardian.signalCode === null) {
    try {
      guardian.kill("SIGKILL");
    } catch {
      // The guardian may already have exited.
    }
  }
  try {
    process.kill(-guardian.pid, "SIGKILL");
  } catch {
    // The group may already be empty.
  }
  await waitFor(() => !groupAlive(guardian.pid), { timeoutMs: 3000 });
}

function recoveryState(evidenceDir) {
  const file = join(evidenceDir, "recovery.json");
  return existsSync(file) ? readJson(file) : null;
}

function writeGuardianConfig(dir, workspace, snapshot, lockPath, mode) {
  const evidenceDir = join(dir, "evidence");
  mkdirSync(evidenceDir);
  const before = mode === "running" ? "before running\n" : "before unverified\n";
  const after = mode === "running" ? "after running\n" : "after unverified\n";
  writeFileSync(join(workspace, "result.txt"), before);
  writeFileSync(join(snapshot, "worker-marker"), `DUR001_WORKER_${randomUUID()}\n`);
  writeFileSync(join(snapshot, "worker.js"), WORKER_SOURCE);
  const node = realpathSync(process.execPath);
  const bwrapArgs = linuxBwrapArguments(
    {
      workspace,
      cwd: workspace,
      executable: node,
      argv: ["-e", COMMAND_SOURCE, mode === "running" ? "worker" : "none"],
    },
    { sourceRoot: workspace, workspacePath: snapshot },
  );
  bwrapArgs.splice(bwrapArgs.indexOf("--die-with-parent"), 1);
  const config = {
    evidenceDir,
    workspace,
    snapshot,
    lockPath,
    mode,
    goalId: `dur001-recovery-${mode}`,
    runId: `run-${randomUUID()}`,
    pending: {
      operationId: `op-${mode}`,
      name: "result.txt",
      after,
    },
    bwrapArgs,
    spawnedMarker: join(dir, "guardian-spawned"),
    readyMarker: join(dir, "guardian-ready"),
    errorMarker: join(dir, "guardian-error"),
    stderrMarker: join(dir, "guardian-stderr"),
  };
  const configPath = join(dir, "guardian-config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { evidenceDir, configPath, before, after };
}

test(
  "fresh recovery refuses an unverified sandbox start and keeps the workspace closed",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-goal-recovery-unverified-"));
    const workspace = join(dir, "workspace");
    const snapshot = join(dir, "snapshot");
    mkdirSync(workspace);
    mkdirSync(snapshot);
    const lock = join(dir, "workspace.lock");
    const { evidenceDir, configPath, before } = writeGuardianConfig(
      dir,
      workspace,
      snapshot,
      lock,
      "unverified",
    );
    const guardian = spawnGuardian(lock, configPath);
    let stderr = "";
    guardian.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    let recovery = null;
    t.after(async () => {
      if (recovery && recovery.exitCode === null && recovery.signalCode === null) {
        recovery.kill("SIGKILL");
      }
      await cleanupGuardianGroup(guardian);
      rmSync(dir, { recursive: true, force: true });
    });

    await waitForGuardianMarker(join(dir, "guardian-spawned"), guardian, () => stderr);
    guardian.kill("SIGKILL");
    assert.deepEqual(await once(guardian, "exit"), [null, "SIGKILL"]);

    const starting = readJson(join(evidenceDir, "run.json"));
    assert.equal(starting.phase, "starting");
    assert.equal(starting.sandbox, null);
    assert.equal(groupAlive(guardian.pid), true, "old sandbox survived the guardian");

    const pre = runWriter(lock, evidenceDir, "pre-unverified");
    assert.equal(pre.status, 3, pre.stderr);
    assert.equal(readJson(join(evidenceDir, "writer-pre-unverified.json")).decision, "refuse");
    assert.equal(readJson(join(evidenceDir, "writer-pre-unverified.json")).lockAcquired, true);
    assert.equal(existsSync(join(workspace, "contender-pre-unverified.txt")), false);

    recovery = spawnRecovery(lock, evidenceDir);
    let recoveryError = "";
    recovery.stderr.setEncoding("utf8").on("data", (chunk) => (recoveryError += chunk));
    const recoveryExit = waitForExit(recovery);
    assert.ok(
      await waitFor(() => recoveryState(evidenceDir)?.status === "investigating", {
        timeoutMs: 5000,
      }),
      recoveryError,
    );
    assert.equal(identityMatches(starting.guardian), false);

    const during = runWriter(lock, evidenceDir, "during-unverified");
    assert.equal(during.status, 1, during.stderr);
    assert.equal(existsSync(join(evidenceDir, "writer-during-unverified.json")), false);
    assert.equal(existsSync(join(workspace, "contender-during-unverified.txt")), false);
    assert.equal(groupAlive(guardian.pid), true, "old sandbox was still alive");

    writeFileSync(join(evidenceDir, "continue-investigation"), "continue\n");
    const [recoveryCode] = await recoveryExit;
    assert.equal(recoveryCode, 4, recoveryError);
    const refused = recoveryState(evidenceDir);
    assert.equal(refused.status, "needs-attention");
    assert.match(refused.reason, /not verified/);
    assert.deepEqual(refused.signals, []);
    assert.equal(readJson(join(evidenceDir, "run.json")).phase, "needs-attention");
    assert.equal(groupAlive(guardian.pid), true, "unverified old run was left untouched");

    const post = runWriter(lock, evidenceDir, "post-unverified");
    assert.equal(post.status, 3, post.stderr);
    const postRecord = readJson(join(evidenceDir, "writer-post-unverified.json"));
    assert.equal(postRecord.lockAcquired, true);
    assert.equal(postRecord.decision, "refuse");
    assert.equal(postRecord.recoveryStatus, "needs-attention");
    assert.equal(existsSync(join(workspace, "contender-post-unverified.txt")), false);
    assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), before);
  },
);

test(
  "fresh recovery verifies and contains the old run, reconciles the pending write, then admits a writer",
  { skip: process.platform !== "linux", timeout: 25000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-goal-recovery-running-"));
    const workspace = join(dir, "workspace");
    const snapshot = join(dir, "snapshot");
    mkdirSync(workspace);
    mkdirSync(snapshot);
    const lock = join(dir, "workspace.lock");
    const { evidenceDir, configPath, after } = writeGuardianConfig(
      dir,
      workspace,
      snapshot,
      lock,
      "running",
    );
    const guardian = spawnGuardian(lock, configPath);
    let stderr = "";
    guardian.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    let recovery = null;
    t.after(async () => {
      if (recovery && recovery.exitCode === null && recovery.signalCode === null) {
        recovery.kill("SIGKILL");
      }
      await cleanupGuardianGroup(guardian);
      rmSync(dir, { recursive: true, force: true });
    });

    await waitForGuardianMarker(join(dir, "guardian-ready"), guardian, () => stderr);
    const running = readJson(join(evidenceDir, "run.json"));
    assert.equal(running.phase, "running");
    assert.equal(identityMatches(running.sandbox.init), true);
    assert.equal(identityMatches(running.worker), true);
    assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), after);
    assert.ok(
      await waitFor(() => existsSync(join(snapshot, "worker-heartbeat")), { timeoutMs: 2000 }),
      "detached worker never wrote its snapshot heartbeat",
    );
    const resultStat = statSync(join(workspace, "result.txt"), { bigint: true });

    guardian.kill("SIGKILL");
    assert.deepEqual(await once(guardian, "exit"), [null, "SIGKILL"]);
    assert.equal(identityMatches(running.sandbox.init), true, "old namespace survived");
    assert.equal(identityMatches(running.worker), true, "detached worker survived");

    const pre = runWriter(lock, evidenceDir, "pre-running");
    assert.equal(pre.status, 3, pre.stderr);
    assert.equal(readJson(join(evidenceDir, "writer-pre-running.json")).lockAcquired, true);
    assert.equal(readJson(join(evidenceDir, "writer-pre-running.json")).decision, "refuse");
    assert.equal(existsSync(join(workspace, "contender-pre-running.txt")), false);
    assert.equal(
      identityMatches(running.worker),
      true,
      "worker kept running after a refused writer",
    );

    recovery = spawnRecovery(lock, evidenceDir);
    let recoveryError = "";
    recovery.stderr.setEncoding("utf8").on("data", (chunk) => (recoveryError += chunk));
    const recoveryExit = waitForExit(recovery);
    assert.ok(
      await waitFor(() => recoveryState(evidenceDir)?.status === "investigating", {
        timeoutMs: 5000,
      }),
      recoveryError,
    );

    const during = runWriter(lock, evidenceDir, "during-running");
    assert.equal(during.status, 1, during.stderr);
    assert.equal(existsSync(join(evidenceDir, "writer-during-running.json")), false);
    assert.equal(existsSync(join(workspace, "contender-during-running.txt")), false);
    assert.equal(identityMatches(running.worker), true, "worker was contained behind recovery");

    writeFileSync(join(evidenceDir, "continue-investigation"), "continue\n");
    const [recoveryCode] = await recoveryExit;
    assert.equal(recoveryCode, 0, recoveryError);
    const recovered = recoveryState(evidenceDir);
    assert.equal(recovered.status, "ready");
    assert.equal(recovered.pendingWrite.state, "observed-applied");
    assert.equal(recovered.teardown.sandbox, "gone");
    assert.equal(recovered.teardown.worker, "gone");
    assert.ok(recovered.decisions.includes("ownership-verified"));
    assert.ok(recovered.decisions.includes("teardown-confirmed"));
    assert.equal(readJson(join(evidenceDir, "run.json")).phase, "ready");

    assert.equal(identityMatches(running.sandbox.init), false, "sandbox init was torn down");
    assert.equal(identityMatches(running.worker), false, "detached worker was torn down");
    assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), after);
    const postRecoveryStat = statSync(join(workspace, "result.txt"), { bigint: true });
    assert.equal(postRecoveryStat.ino, resultStat.ino);
    assert.equal(postRecoveryStat.mtimeNs, resultStat.mtimeNs);
    assert.equal(postRecoveryStat.ctimeNs, resultStat.ctimeNs);
    assert.equal(existsSync(join(workspace, "contender-during-running.txt")), false);

    const admitted = runWriter(lock, evidenceDir, "post-running");
    assert.equal(admitted.status, 0, admitted.stderr);
    assert.equal(readJson(join(evidenceDir, "writer-post-running.json")).decision, "execute");
    assert.match(
      readFileSync(join(workspace, "contender-post-running.txt"), "utf8"),
      /^executed post-running pid=\d+\n$/,
    );
    assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), after);
  },
);

test(
  "fresh recovery refuses a mismatched process identity without signaling it",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-goal-recovery-stale-"));
    const workspace = join(dir, "workspace");
    const evidenceDir = join(dir, "evidence");
    mkdirSync(workspace);
    mkdirSync(evidenceDir);
    const lock = join(dir, "workspace.lock");
    const before = "before stale\n";
    const after = "after stale\n";
    const result = join(workspace, "result.txt");
    writeFileSync(result, before);
    const heartbeat = join(dir, "witness-heartbeat");
    const witness = spawn(process.execPath, ["-e", WITNESS_SOURCE, heartbeat], {
      stdio: "ignore",
      detached: true,
    });
    t.after(() => {
      if (witness.exitCode === null && witness.signalCode === null) witness.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    });
    assert.ok(await waitFor(() => existsSync(heartbeat), { timeoutMs: 3000 }));
    const actual = processIdentity(witness.pid);
    assert.ok(actual);
    const mismatched = { ...actual, startTime: actual.startTime + 1 };
    const workspaceStat = statSync(workspace);
    const witnessNamespace = readlinkSync(`/proc/${witness.pid}/ns/pid`);
    const run = {
      version: 1,
      goalId: "dur001-recovery-stale",
      runId: `run-${randomUUID()}`,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      workspace,
      workspaceStat: { dev: Number(workspaceStat.dev), ino: Number(workspaceStat.ino) },
      lockPath: lock,
      phase: "running",
      guardian: mismatched,
      sandbox: { monitor: mismatched, init: mismatched, namespace: witnessNamespace },
      worker: mismatched,
      pendingWrite: {
        operationId: "op-stale",
        path: "result.txt",
        beforeSha256: digest(before),
        afterSha256: digest(after),
        state: "intent",
      },
    };
    writeFileSync(join(evidenceDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);

    const recovery = spawnRecovery(lock, evidenceDir);
    let recoveryError = "";
    recovery.stderr.setEncoding("utf8").on("data", (chunk) => (recoveryError += chunk));
    const recoveryExit = waitForExit(recovery);
    t.after(() => {
      if (recovery.exitCode === null && recovery.signalCode === null) recovery.kill("SIGKILL");
    });
    assert.ok(
      await waitFor(() => recoveryState(evidenceDir)?.status === "investigating", {
        timeoutMs: 5000,
      }),
      recoveryError,
    );

    const during = runWriter(lock, evidenceDir, "during-stale");
    assert.equal(during.status, 1, during.stderr);
    assert.equal(existsSync(join(evidenceDir, "writer-during-stale.json")), false);
    writeFileSync(join(evidenceDir, "continue-investigation"), "continue\n");
    const [recoveryCode] = await recoveryExit;
    assert.equal(recoveryCode, 4, recoveryError);
    const refused = recoveryState(evidenceDir);
    assert.equal(refused.status, "needs-attention");
    assert.match(refused.reason, /identity mismatch/);
    assert.deepEqual(refused.signals, []);
    assert.equal(readJson(join(evidenceDir, "run.json")).phase, "needs-attention");

    assert.equal(witness.exitCode, null, "unrelated process was signaled");
    assert.equal(identityMatches(actual), true, "unrelated process identity changed");
    const heartbeatLength = readFileSync(heartbeat).length;
    assert.ok(
      await waitFor(() => readFileSync(heartbeat).length > heartbeatLength, { timeoutMs: 1000 }),
    );

    const post = runWriter(lock, evidenceDir, "post-stale");
    assert.equal(post.status, 3, post.stderr);
    assert.equal(readJson(join(evidenceDir, "writer-post-stale.json")).decision, "refuse");
    assert.equal(existsSync(join(workspace, "contender-post-stale.txt")), false);
    assert.equal(readFileSync(result, "utf8"), before);
    assert.equal(identityMatches(actual), true, "unrelated process survived the refused writer");
  },
);

// ---------------------------------------------------------------------------
// DUR-001 continuation: crash consistency and generation fencing.
//
// The earlier cases study lock ownership and surviving sandbox processes. This
// extension isolates the *publication protocol*: how recovery publishes
// "ready"/writer state to disk, and how a fresh process (only the persisted
// evidence) decides whether a contender may write. It reuses the same run.json
// / recovery.json vocabulary and the same flock-guarded contender model, but
// drives it with deterministic barriers and SIGKILL so a process can be killed
// at an exact instruction boundary. SIGKILL is treated as process-crash
// evidence (no cleanup handlers, no final fsync); power-loss/filesystem
// guarantees are explicitly out of scope, per ARCHITECTURE.md section 4.
// ---------------------------------------------------------------------------

const CRASH_HELPERS = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function writeJsonAtomic(file, value) {
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeMarker(name) { fs.writeFileSync(name, "x\n"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForFile(file, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (fs.existsSync(file)) return true; await sleep(15); }
  return false;
}
`;

// Two-record publisher ("recovery"): writes run.json = ready ("writing ready"),
// waits on a deterministic barrier, then writes recovery.json = ready
// ("publishing writer state"). A barrier-gated SIGKILL between the two is the
// injected crash. writeInvestigating models the "investigating" prologue.
const PUBLISH_SOURCE =
  CRASH_HELPERS +
  String.raw`
const [configPath] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const ev = config.evidenceDir;
const runPath = path.join(ev, "run.json");
const recPath = path.join(ev, "recovery.json");
const allowWriterState = path.join(ev, "allow-writer-state");
const runReady = path.join(ev, "barrier-run-ready");
const writerReady = path.join(ev, "barrier-writer-ready");
const base = { version: 1, generation: config.generation, runId: config.runId };
(async () => {
  const emergency = setTimeout(() => process.exit(9), 15000); emergency.unref();
  if (config.writeInvestigating) {
    writeJsonAtomic(recPath, { ...base, status: "investigating", complete: false });
  }
  // "writing ready": publish the goal/attempt state first.
  writeJsonAtomic(runPath, { ...base, phase: "ready", workspace: config.workspace });
  writeMarker(runReady);
  // Deterministic barrier: do not publish writer state until released.
  const allowed = await waitForFile(allowWriterState, 12000);
  if (!allowed) process.exit(10);
  // "publishing writer state": the second independent record.
  writeJsonAtomic(recPath, { ...base, status: "ready", complete: true });
  writeMarker(writerReady);
  clearTimeout(emergency);
  process.exit(0);
})().catch((error) => { console.error(String(error.stack || error)); process.exit(1); });
`;

// Edit-intent writer: persists the intent (and the exact private images), then
// blocks on a barrier whose very next action is the live-file change. Killing it
// at the barrier leaves the intent persisted but the live file untouched.
const INTENT_SOURCE =
  CRASH_HELPERS +
  String.raw`
const [configPath] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const ev = config.evidenceDir;
(async () => {
  const emergency = setTimeout(() => process.exit(9), 15000); emergency.unref();
  writeJsonAtomic(path.join(ev, "edit-intent.json"), {
    version: 1,
    generation: config.generation,
    runId: config.runId,
    operationId: config.operationId,
    path: config.fileName,
    beforeSha256: digest(config.beforeText),
    afterSha256: digest(config.afterText),
    beforeBlob: config.beforeText,
    afterBlob: config.afterText,
    state: "intent",
  });
  writeMarker(path.join(ev, "intent-persisted"));
  // Deterministic barrier: the live-file change is the very next action.
  const allowed = await waitForFile(path.join(ev, "apply-edit"), 12000);
  if (!allowed) process.exit(10);
  fs.writeFileSync(path.join(config.workspace, config.fileName), config.afterText, { mode: 0o600 });
  writeMarker(path.join(ev, "edit-applied"));
  clearTimeout(emergency);
  process.exit(0);
})().catch((error) => { console.error(String(error.stack || error)); process.exit(1); });
`;

// Fresh recovery with only persisted evidence. Classifies the live file against
// the exact before/after images, then publishes ONE atomic, generation-fenced
// checkpoint. An unexpected image needs-attention and requires a hash-bound
// explicit resolution; the file is never overwritten or rolled back.
const RECONCILE_SOURCE =
  CRASH_HELPERS +
  String.raw`
const [configPath] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const ev = config.evidenceDir;
const intent = readJsonSafe(path.join(ev, "edit-intent.json"));
(async () => {
  const emergency = setTimeout(() => process.exit(9), 15000); emergency.unref();
  const gen = config.expectedGeneration;
  let checkpointValue;
  let needsAttention = false;
  const decisions = [];
  if (!intent || intent.version !== 1) {
    checkpointValue = { version: 1, generation: gen, runId: config.expectedRunId, status: "needs-attention", classification: "invalid-intent", admit: false };
  } else {
    const livePath = path.join(config.workspace, intent.path);
    let observed;
    try { observed = digest(fs.readFileSync(livePath)); } catch { observed = "missing"; }
    let classification;
    if (observed === intent.beforeSha256) classification = "not-applied";
    else if (observed === intent.afterSha256) classification = "observed-applied";
    else classification = "unexpected";
    decisions.push("classification:" + classification);
    // Honest provenance: the classification is derived only from the exact
    // private intent hashes and the observed live bytes. Matching after bytes
    // proves observable state, never that Matrix authored the change.
    const base = { version: 1, generation: gen, runId: config.expectedRunId, classification, observedSha256: observed, provenance: "observed-bytes-vs-intent-hashes; Matrix authorship not claimed", checkpoint: "single-atomic-rename" };
    if (classification === "unexpected") {
      const resolution = readJsonSafe(path.join(ev, "resolution.json"));
      const valid = resolution && resolution.decision === "accept" && resolution.observedSha256 === observed && resolution.generation === gen && resolution.runId === config.expectedRunId;
      if (valid) {
        checkpointValue = { ...base, status: "ready", admit: true, preserved: true, resolution: { decision: "accept", observedSha256: observed } };
        decisions.push("explicit-resolution-accepted");
      } else {
        checkpointValue = { ...base, status: "needs-attention", admit: false, preserved: true, resolutionRequired: true };
        needsAttention = true;
        decisions.push("explicit-resolution-required");
      }
    } else {
      checkpointValue = { ...base, status: "ready", admit: true, reapply: false, rewrite: false };
      decisions.push(classification === "not-applied" ? "no-reapply" : "record-observed-after");
    }
  }
  if (config.holdBeforeCheckpoint) {
    writeMarker(path.join(ev, "barrier-holding"));
    const allowed = await waitForFile(path.join(ev, "allow-checkpoint"), 12000);
    if (!allowed) process.exit(10);
  }
  // Single atomic checkpoint: one rename, generation-fenced, never a torn pair.
  writeJsonAtomic(path.join(ev, "checkpoint.json"), checkpointValue);
  const needsAttentionPath = path.join(ev, "needs-attention.json");
  if (needsAttention) {
    writeJsonAtomic(needsAttentionPath, { ...checkpointValue, reason: "unexpected image requires explicit resolution" });
  } else if (fs.existsSync(needsAttentionPath)) {
    fs.rmSync(needsAttentionPath); // a resolved/ready checkpoint must not leave stale attention evidence
  }
  writeJsonAtomic(path.join(ev, "reconcile.json"), { version: 1, decisions, classification: checkpointValue.classification, observedSha256: checkpointValue.observedSha256 || null, wroteResult: false });
  clearTimeout(emergency);
  process.exit(0);
})().catch((error) => { console.error(String(error.stack || error)); process.exit(1); });
`;

// Contender policy. "naive-two-record" reproduces the current two-record policy
// (both records say ready, no generation fence). "fenced-checkpoint" reads one
// atomic checkpoint and requires the current generation/runId. "fenced-two-record"
// keeps two records but fences them by generation, runId and completion.
const CONTENDER_SOURCE =
  CRASH_HELPERS +
  String.raw`
const [evidenceDir, label, mode, expectedGeneration, expectedRunId, workspace] = process.argv.slice(1);
const run = readJsonSafe(path.join(evidenceDir, "run.json"));
const recovery = readJsonSafe(path.join(evidenceDir, "recovery.json"));
const checkpoint = readJsonSafe(path.join(evidenceDir, "checkpoint.json"));
const gen = Number(expectedGeneration);
let ready = false;
let detail = "";
if (mode === "naive-two-record") {
  ready = Boolean(run && run.phase === "ready" && recovery && recovery.status === "ready");
  detail = "run=" + (run ? run.phase : "none") + " recovery=" + (recovery ? recovery.status : "none");
} else if (mode === "fenced-checkpoint") {
  ready = Boolean(checkpoint && checkpoint.version === 1 && checkpoint.status === "ready" && checkpoint.admit === true && checkpoint.generation === gen && checkpoint.runId === expectedRunId);
  detail = "checkpoint=" + (checkpoint ? checkpoint.status + "@" + checkpoint.generation : "none");
} else if (mode === "fenced-two-record") {
  ready = Boolean(run && run.phase === "ready" && recovery && recovery.status === "ready" && run.generation === recovery.generation && run.runId === recovery.runId && recovery.complete === true && run.generation === gen && run.runId === expectedRunId);
  detail = "run=" + (run ? run.phase + "@" + run.generation : "none") + " recovery=" + (recovery ? recovery.status + "@" + recovery.generation : "none");
}
const record = { label, mode, pid: process.pid, lockAcquired: true, decision: ready ? "execute" : "refuse", detail, expectedGeneration: gen, expectedRunId, at: new Date().toISOString() };
writeJsonAtomic(path.join(evidenceDir, "writer-" + label + ".json"), record);
if (!ready) { console.error("contender refused: " + detail); process.exit(3); }
fs.writeFileSync(path.join(workspace, "contender-" + label + ".txt"), "executed " + label + " mode=" + mode + " pid=" + process.pid + "\n", { mode: 0o600 });
process.exit(0);
`;

function putJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonIfExists(file) {
  return existsSync(file) ? readJson(file) : null;
}

function makeCrashFixture(label) {
  const dir = mkdtempSync(join(tmpdir(), `matrix-goal-dur001-${label}-`));
  const workspace = join(dir, "workspace");
  const evidenceDir = join(dir, "evidence");
  mkdirSync(workspace);
  mkdirSync(evidenceDir);
  return { dir, workspace, evidenceDir, lock: join(dir, "workspace.lock") };
}

function writeChildConfig(evidenceDir, values) {
  const configPath = join(evidenceDir, `config-${randomUUID()}.json`);
  putJson(configPath, values);
  return configPath;
}

function spawnFlockChild(lock, source, args) {
  const child = spawn("flock", ["-n", "--no-fork", lock, process.execPath, "-e", source, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.resume();
  return child;
}

function captureStderr(child) {
  let text = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (text += chunk));
  return () => text;
}

function killChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function killGroup(child) {
  if (!child) return;
  killChild(child);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group may already be empty.
  }
}

async function crashGroupCleanup(children, dir) {
  for (const child of children) killGroup(child);
  await new Promise((resolve) => setTimeout(resolve, 40));
  rmSync(dir, { recursive: true, force: true });
}

// Kill a barrier-gated child at an exact point. SIGKILL is the process-crash
// evidence; the assertion makes the crash point explicit.
async function killAtBarrier(child, marker, stderr) {
  assert.ok(await waitFor(() => existsSync(marker), { timeoutMs: 6000 }), stderr());
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL", "barrier process must be killed as a crash");
}

function runContenderSync(lock, evidenceDir, label, mode, gen, runId, workspace) {
  return spawnSync(
    "flock",
    [
      "-n",
      "--no-fork",
      lock,
      process.execPath,
      "-e",
      CONTENDER_SOURCE,
      evidenceDir,
      label,
      mode,
      String(gen),
      runId,
      workspace,
    ],
    { encoding: "utf8", timeout: 8000 },
  );
}

function contenderRecord(evidenceDir, label) {
  return readJson(join(evidenceDir, `writer-${label}.json`));
}

function writeEditIntent(evidenceDir, opts) {
  putJson(join(evidenceDir, "edit-intent.json"), {
    version: 1,
    generation: opts.generation,
    runId: opts.runId,
    operationId: opts.operationId,
    path: opts.fileName,
    beforeSha256: digest(opts.beforeText),
    afterSha256: digest(opts.afterText),
    beforeBlob: opts.beforeText,
    afterBlob: opts.afterText,
    state: "intent",
  });
}

// A1: kill recovery between "writing ready" and "publishing writer state".
// The two records disagree; a fresh contender with only persisted evidence
// must not write. Both the naive two-record policy and the single-checkpoint
// policy refuse (no checkpoint exists).
test(
  "DUR-001 crash consistency: recovery killed between ready and writer-state publication leaves disagreeing records and a fresh contender refuses",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const { dir, workspace, evidenceDir, lock } = makeCrashFixture("disagree");
    const children = [];
    t.after(() => crashGroupCleanup(children, dir));
    const before = "before crash\n";
    writeFileSync(join(workspace, "result.txt"), before);
    const gen = 1;
    const runId = "run-disagree-1";
    const configPath = writeChildConfig(evidenceDir, {
      evidenceDir,
      workspace,
      generation: gen,
      runId,
      writeInvestigating: true,
    });
    const publisher = spawnFlockChild(lock, PUBLISH_SOURCE, [configPath]);
    children.push(publisher);
    const stderr = captureStderr(publisher);

    // SIGKILL at the deterministic barrier: run.json is published, writer state is not.
    await killAtBarrier(publisher, join(evidenceDir, "barrier-run-ready"), stderr);

    const run = readJson(join(evidenceDir, "run.json"));
    const recovery = readJsonIfExists(join(evidenceDir, "recovery.json"));
    assert.equal(run.phase, "ready");
    assert.equal(run.generation, gen);
    assert.equal(recovery.status, "investigating", "writer state was never published");
    assert.equal(
      run.phase === "ready" && recovery.status === "ready",
      false,
      "the two records disagree",
    );
    assert.equal(existsSync(join(evidenceDir, "barrier-writer-ready")), false);

    // Fresh process with only persisted evidence: disagreeing records -> refuse.
    const naive = runContenderSync(
      lock,
      evidenceDir,
      "naive-disagree",
      "naive-two-record",
      gen,
      runId,
      workspace,
    );
    assert.equal(naive.status, 3, naive.stderr);
    assert.equal(contenderRecord(evidenceDir, "naive-disagree").decision, "refuse");
    assert.equal(existsSync(join(workspace, "contender-naive-disagree.txt")), false);

    // No single checkpoint exists, so the fenced policy also refuses.
    const fenced = runContenderSync(
      lock,
      evidenceDir,
      "fenced-disagree",
      "fenced-checkpoint",
      gen,
      runId,
      workspace,
    );
    assert.equal(fenced.status, 3, fenced.stderr);
    assert.equal(existsSync(join(workspace, "contender-fenced-disagree.txt")), false);
    assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), before);
  },
);

// A2: reproduce the defect in the current two-record protocol. Generation 1
// completes fully (both records ready). A generation-2 recovery is then killed
// after publishing run.json=ready(gen2) but before republishing writer state.
// The two-record protocol does not invalidate generation 1's writer-state
// record, so persisted evidence is torn: run.json is gen2, recovery.json is the
// OLD gen1. A naive contender (the current policy, no generation fence) executes
// on this partial/old-generation state. This characterizes the failure first.
test(
  "DUR-001 reproduced defect: the two-record protocol admits a contender after a partial cross-generation update",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const { dir, workspace, evidenceDir, lock } = makeCrashFixture("torn");
    const children = [];
    t.after(() => crashGroupCleanup(children, dir));
    const before = "before torn\n";
    writeFileSync(join(workspace, "result.txt"), before);

    // Generation 1: let recovery publish both records completely.
    const cfg1 = writeChildConfig(evidenceDir, {
      evidenceDir,
      workspace,
      generation: 1,
      runId: "run-1",
      writeInvestigating: false,
    });
    const pub1 = spawnFlockChild(lock, PUBLISH_SOURCE, [cfg1]);
    children.push(pub1);
    const e1 = captureStderr(pub1);
    assert.ok(
      await waitFor(() => existsSync(join(evidenceDir, "barrier-run-ready")), { timeoutMs: 6000 }),
      e1(),
    );
    writeFileSync(join(evidenceDir, "allow-writer-state"), "go\n");
    const [code1] = await waitForExit(pub1);
    assert.equal(code1, 0, e1());
    const gen1run = readJson(join(evidenceDir, "run.json"));
    const gen1rec = readJson(join(evidenceDir, "recovery.json"));
    assert.equal(gen1run.generation, 1);
    assert.equal(gen1rec.generation, 1);
    assert.equal(gen1run.phase, "ready");
    assert.equal(gen1rec.status, "ready");

    // Clear the gen1 markers so the gen2 barrier is unambiguous.
    for (const marker of ["barrier-run-ready", "allow-writer-state", "barrier-writer-ready"]) {
      rmSync(join(evidenceDir, marker), { force: true });
    }

    // Generation 2: a fresh attempt. Kill it at the barrier (run state
    // published; writer-state record NOT republished, so gen1's stays).
    const cfg2 = writeChildConfig(evidenceDir, {
      evidenceDir,
      workspace,
      generation: 2,
      runId: "run-2",
      writeInvestigating: false,
    });
    const pub2 = spawnFlockChild(lock, PUBLISH_SOURCE, [cfg2]);
    children.push(pub2);
    const e2 = captureStderr(pub2);
    await killAtBarrier(pub2, join(evidenceDir, "barrier-run-ready"), e2);

    const run = readJson(join(evidenceDir, "run.json"));
    const recovery = readJson(join(evidenceDir, "recovery.json"));
    assert.equal(run.phase, "ready");
    assert.equal(run.generation, 2);
    assert.equal(recovery.status, "ready");
    assert.equal(recovery.generation, 1, "writer-state record is from the OLD generation");
    assert.notEqual(
      run.generation,
      recovery.generation,
      "persisted evidence is torn across generations",
    );

    // The current, unfenced policy admits the write after the partial update.
    const naive = runContenderSync(
      lock,
      evidenceDir,
      "naive-torn",
      "naive-two-record",
      2,
      "run-2",
      workspace,
    );
    assert.equal(naive.status, 0, naive.stderr);
    assert.equal(contenderRecord(evidenceDir, "naive-torn").decision, "execute");
    assert.equal(existsSync(join(workspace, "contender-naive-torn.txt")), true);
  },
);

// A3: demonstrate the fix - a single atomic, generation-fenced checkpoint.
// A recovery killed before its single checkpoint write leaves NO half-ready
// state; an OLD-generation checkpoint cannot admit a gen2 contender; a corrupt
// or needs-attention checkpoint refuses; a valid current checkpoint admits.
test(
  "DUR-001 fix: a single atomic checkpoint refuses after a crash and rejects old-generation or corrupt evidence",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const { dir, workspace, evidenceDir, lock } = makeCrashFixture("checkpoint");
    const children = [];
    t.after(() => crashGroupCleanup(children, dir));
    const before = "before checkpoint\n";
    const after = "after checkpoint\n";
    const fileName = "result.txt";
    const gen = 2;
    const runId = "run-checkpoint-2";
    writeFileSync(join(workspace, fileName), before);
    writeEditIntent(evidenceDir, {
      generation: gen,
      runId,
      operationId: "op-checkpoint",
      fileName,
      beforeText: before,
      afterText: after,
    });

    // (a) Crash recovery before the single checkpoint write -> no ready state.
    const holdCfg = writeChildConfig(evidenceDir, {
      evidenceDir,
      workspace,
      expectedGeneration: gen,
      expectedRunId: runId,
      holdBeforeCheckpoint: true,
    });
    const held = spawnFlockChild(lock, RECONCILE_SOURCE, [holdCfg]);
    children.push(held);
    const eHeld = captureStderr(held);
    await killAtBarrier(held, join(evidenceDir, "barrier-holding"), eHeld);
    assert.equal(
      existsSync(join(evidenceDir, "checkpoint.json")),
      false,
      "no torn/half-ready checkpoint after a crash",
    );
    const killed = runContenderSync(
      lock,
      evidenceDir,
      "cp-killed",
      "fenced-checkpoint",
      gen,
      runId,
      workspace,
    );
    assert.equal(killed.status, 3, killed.stderr);
    assert.equal(existsSync(join(workspace, "contender-cp-killed.txt")), false);

    // Positive control: a completed recovery publishes a valid checkpoint and admits.
    const okCfg = writeChildConfig(evidenceDir, {
      evidenceDir,
      workspace,
      expectedGeneration: gen,
      expectedRunId: runId,
      holdBeforeCheckpoint: false,
    });
    const ok = spawnFlockChild(lock, RECONCILE_SOURCE, [okCfg]);
    children.push(ok);
    const eOk = captureStderr(ok);
    const [okCode] = await waitForExit(ok);
    assert.equal(okCode, 0, eOk());
    const good = runContenderSync(
      lock,
      evidenceDir,
      "cp-ok",
      "fenced-checkpoint",
      gen,
      runId,
      workspace,
    );
    assert.equal(good.status, 0, good.stderr);
    assert.equal(existsSync(join(workspace, "contender-cp-ok.txt")), true);

    // (b) OLD-generation checkpoint cannot fence a gen2 contender.
    putJson(join(evidenceDir, "checkpoint.json"), {
      version: 1,
      generation: gen - 1,
      runId,
      status: "ready",
      admit: true,
      classification: "not-applied",
    });
    const old = runContenderSync(
      lock,
      evidenceDir,
      "cp-old",
      "fenced-checkpoint",
      gen,
      runId,
      workspace,
    );
    assert.equal(old.status, 3, old.stderr);
    assert.equal(contenderRecord(evidenceDir, "cp-old").decision, "refuse");
    assert.equal(existsSync(join(workspace, "contender-cp-old.txt")), false);

    // (c) needs-attention and corrupt checkpoints refuse; never infer a write.
    putJson(join(evidenceDir, "checkpoint.json"), {
      version: 1,
      generation: gen,
      runId,
      status: "needs-attention",
      admit: false,
    });
    const attention = runContenderSync(
      lock,
      evidenceDir,
      "cp-attention",
      "fenced-checkpoint",
      gen,
      runId,
      workspace,
    );
    assert.equal(attention.status, 3, attention.stderr);
    assert.equal(existsSync(join(workspace, "contender-cp-attention.txt")), false);

    writeFileSync(join(evidenceDir, "checkpoint.json"), '{"version":1,"status":"rea');
    const corrupt = runContenderSync(
      lock,
      evidenceDir,
      "cp-corrupt",
      "fenced-checkpoint",
      gen,
      runId,
      workspace,
    );
    assert.equal(corrupt.status, 3, corrupt.stderr);
    assert.equal(existsSync(join(workspace, "contender-cp-corrupt.txt")), false);
    assert.equal(readFileSync(join(workspace, fileName), "utf8"), before);
  },
);

// A4: demonstrate the alternative fix - keep two records but add safe ordering
// (a new generation invalidates writer state as its first durable action) plus
// a generation/runId/completion fence. The torn state from A2 is refused, and
// an entirely old-generation pair is refused; a consistent current pair admits.
test(
  "DUR-001 fix: generation-fenced safe ordering refuses torn and old-generation two-record state",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const { dir, workspace, evidenceDir, lock } = makeCrashFixture("fenced-order");
    t.after(() => crashGroupCleanup([], dir));
    const gen = 2;
    const runId = "run-2";
    writeFileSync(join(workspace, "result.txt"), "before fenced\n");

    // Torn / old-generation state (the A2 failure family): run.json gen2,
    // recovery.json still the OLD gen1. The fence refuses it.
    putJson(join(evidenceDir, "run.json"), { version: 1, generation: 2, runId, phase: "ready" });
    putJson(join(evidenceDir, "recovery.json"), {
      version: 1,
      generation: 1,
      runId: "run-1",
      status: "ready",
      complete: true,
    });
    const torn = runContenderSync(
      lock,
      evidenceDir,
      "fo-torn",
      "fenced-two-record",
      gen,
      runId,
      workspace,
    );
    assert.equal(torn.status, 3, torn.stderr);
    assert.equal(contenderRecord(evidenceDir, "fo-torn").decision, "refuse");
    assert.equal(existsSync(join(workspace, "contender-fo-torn.txt")), false);

    // Safe ordering: the new generation's first durable action is to invalidate
    // writer state (investigating@gen2). Neither policy admits a contender.
    putJson(join(evidenceDir, "recovery.json"), {
      version: 1,
      generation: 2,
      runId,
      status: "investigating",
      complete: false,
    });
    const ordered = runContenderSync(
      lock,
      evidenceDir,
      "fo-ordered",
      "fenced-two-record",
      gen,
      runId,
      workspace,
    );
    assert.equal(ordered.status, 3, ordered.stderr);
    const orderedNaive = runContenderSync(
      lock,
      evidenceDir,
      "fo-ordered-naive",
      "naive-two-record",
      gen,
      runId,
      workspace,
    );
    assert.equal(orderedNaive.status, 3, orderedNaive.stderr);
    assert.equal(existsSync(join(workspace, "contender-fo-ordered.txt")), false);

    // Positive control: consistent, complete, current-generation pair admits.
    putJson(join(evidenceDir, "run.json"), { version: 1, generation: 2, runId, phase: "ready" });
    putJson(join(evidenceDir, "recovery.json"), {
      version: 1,
      generation: 2,
      runId,
      status: "ready",
      complete: true,
    });
    const admitted = runContenderSync(
      lock,
      evidenceDir,
      "fo-ok",
      "fenced-two-record",
      gen,
      runId,
      workspace,
    );
    assert.equal(admitted.status, 0, admitted.stderr);
    assert.equal(existsSync(join(workspace, "contender-fo-ok.txt")), true);

    // Entirely old-generation pair refuses a gen2 contender (generation fence).
    putJson(join(evidenceDir, "run.json"), {
      version: 1,
      generation: 1,
      runId: "run-1",
      phase: "ready",
    });
    putJson(join(evidenceDir, "recovery.json"), {
      version: 1,
      generation: 1,
      runId: "run-1",
      status: "ready",
      complete: true,
    });
    const stale = runContenderSync(
      lock,
      evidenceDir,
      "fo-stale",
      "fenced-two-record",
      gen,
      runId,
      workspace,
    );
    assert.equal(stale.status, 3, stale.stderr);
    assert.equal(existsSync(join(workspace, "contender-fo-stale.txt")), false);
    assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), "before fenced\n");
  },
);

// Run the writer (persist intent, killed before live change), arrange the
// observable live-file image, then reconcile and admit a contender. Shared by B1/B2/B3.
async function runEditIntentScenario(t, { label, liveImage }) {
  const { dir, workspace, evidenceDir, lock } = makeCrashFixture(label);
  const children = [];
  t.after(() => crashGroupCleanup(children, dir));
  const before = `before ${label}\n`;
  const after = `after ${label}\n`;
  const unexpected = `unexpected ${label} bytes\n`;
  const fileName = "result.txt";
  const gen = 2;
  const runId = `run-${label}`;
  const livePath = join(workspace, fileName);
  writeFileSync(livePath, before);

  // Writer persists the edit intent, then is SIGKILLed before changing the live file.
  const intentCfg = writeChildConfig(evidenceDir, {
    evidenceDir,
    workspace,
    generation: gen,
    runId,
    operationId: `op-${label}`,
    fileName,
    beforeText: before,
    afterText: after,
  });
  const writer = spawnFlockChild(lock, INTENT_SOURCE, [intentCfg]);
  children.push(writer);
  const eWriter = captureStderr(writer);
  await killAtBarrier(writer, join(evidenceDir, "intent-persisted"), eWriter);
  assert.equal(
    existsSync(join(evidenceDir, "edit-applied")),
    false,
    "writer died before the live change",
  );
  assert.equal(readFileSync(livePath, "utf8"), before, "writer did not touch the live file");

  // Arrange the actual observable bytes. Recovery trusts only these bytes and
  // the persisted intent hashes, never a claim from the (dead) writer.
  let liveBytes = before;
  if (liveImage === "after") {
    liveBytes = after;
    writeFileSync(livePath, after);
  } else if (liveImage === "unexpected") {
    liveBytes = unexpected;
    writeFileSync(livePath, unexpected);
  }

  const reconcileCfg = writeChildConfig(evidenceDir, {
    evidenceDir,
    workspace,
    expectedGeneration: gen,
    expectedRunId: runId,
    holdBeforeCheckpoint: false,
  });
  const reconcile = () => {
    const child = spawnFlockChild(lock, RECONCILE_SOURCE, [reconcileCfg]);
    children.push(child);
    return { child, stderr: captureStderr(child) };
  };
  return {
    dir,
    workspace,
    evidenceDir,
    lock,
    before,
    after,
    unexpected,
    fileName,
    gen,
    runId,
    livePath,
    liveBytes,
    reconcile,
  };
}

// B1: exact before image -> not-applied. The edit is never re-applied; the
// contender executes, and the actual bytes remain the exact before image.
test(
  "DUR-001 edit intent: exact before image is not-applied, contender executes, bytes preserved",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const f = await runEditIntentScenario(t, { label: "before-image", liveImage: "before" });
    const { child, stderr } = f.reconcile();
    const [code] = await waitForExit(child);
    assert.equal(code, 0, stderr());
    const cp = readJson(join(f.evidenceDir, "checkpoint.json"));
    assert.equal(cp.classification, "not-applied");
    assert.equal(cp.status, "ready");
    assert.equal(cp.admit, true);
    assert.equal(readJson(join(f.evidenceDir, "reconcile.json")).wroteResult, false);

    const contender = runContenderSync(
      f.lock,
      f.evidenceDir,
      "before-ok",
      "fenced-checkpoint",
      f.gen,
      f.runId,
      f.workspace,
    );
    assert.equal(contender.status, 0, contender.stderr);
    assert.equal(
      existsSync(join(f.workspace, "contender-before-ok.txt")),
      true,
      "contender executed",
    );
    assert.equal(
      readFileSync(f.livePath, "utf8"),
      f.before,
      "exact before bytes preserved, no re-apply",
    );
  },
);

// B2: exact after image -> observed-applied. Recovery records the after image
// as observed and never rewrites it; the contender executes; bytes stay exact.
test(
  "DUR-001 edit intent: exact after image is observed-applied, never rewritten, contender executes",
  { skip: process.platform !== "linux", timeout: 20000 },
  async (t) => {
    const f = await runEditIntentScenario(t, { label: "after-image", liveImage: "after" });
    const { child, stderr } = f.reconcile();
    const [code] = await waitForExit(child);
    assert.equal(code, 0, stderr());
    const cp = readJson(join(f.evidenceDir, "checkpoint.json"));
    assert.equal(cp.classification, "observed-applied");
    assert.equal(cp.rewrite, false);
    assert.equal(cp.status, "ready");
    assert.equal(readJson(join(f.evidenceDir, "reconcile.json")).wroteResult, false);

    const contender = runContenderSync(
      f.lock,
      f.evidenceDir,
      "after-ok",
      "fenced-checkpoint",
      f.gen,
      f.runId,
      f.workspace,
    );
    assert.equal(contender.status, 0, contender.stderr);
    assert.equal(
      existsSync(join(f.workspace, "contender-after-ok.txt")),
      true,
      "contender executed",
    );
    assert.equal(
      readFileSync(f.livePath, "utf8"),
      f.after,
      "exact after bytes preserved, never rewritten",
    );
  },
);

// B3: unexpected image -> needs-attention. The file is preserved (no
// overwrite/rollback), the contender refuses, and progress requires an
// explicit resolution bound to the exact observed bytes. A mismatched
// resolution is refused too; a matching resolution admits without touching
// the file. Check actual bytes and contender execution throughout.
test(
  "DUR-001 edit intent: unexpected image preserves the file and requires an explicit hash-bound resolution",
  { skip: process.platform !== "linux", timeout: 25000 },
  async (t) => {
    const f = await runEditIntentScenario(t, {
      label: "unexpected-image",
      liveImage: "unexpected",
    });

    const runOnce = async (label) => {
      const { child, stderr } = f.reconcile();
      const [code] = await waitForExit(child);
      assert.equal(code, 0, stderr());
      const contender = runContenderSync(
        f.lock,
        f.evidenceDir,
        label,
        "fenced-checkpoint",
        f.gen,
        f.runId,
        f.workspace,
      );
      return { contender, cp: readJson(join(f.evidenceDir, "checkpoint.json")) };
    };

    // No resolution: needs-attention, contender refuses, bytes preserved.
    const none = await runOnce("unexpected-none");
    assert.equal(none.cp.classification, "unexpected");
    assert.equal(none.cp.status, "needs-attention");
    assert.equal(none.cp.admit, false);
    assert.equal(none.cp.resolutionRequired, true);
    assert.equal(
      readJson(join(f.evidenceDir, "needs-attention.json")).reason,
      "unexpected image requires explicit resolution",
    );
    assert.equal(none.contender.status, 3, none.contender.stderr);
    assert.equal(
      existsSync(join(f.workspace, "contender-unexpected-none.txt")),
      false,
      "contender did not execute",
    );
    assert.equal(
      readFileSync(f.livePath, "utf8"),
      f.unexpected,
      "unexpected bytes preserved, no rollback",
    );

    // Mismatched (stale/wrong-hash) resolution is still refused.
    putJson(join(f.evidenceDir, "resolution.json"), {
      decision: "accept",
      observedSha256: digest(f.before), // deliberately wrong image
      generation: f.gen,
      runId: f.runId,
    });
    const bad = await runOnce("unexpected-bad");
    assert.equal(bad.cp.status, "needs-attention");
    assert.equal(bad.contender.status, 3, bad.contender.stderr);
    assert.equal(existsSync(join(f.workspace, "contender-unexpected-bad.txt")), false);
    assert.equal(readFileSync(f.livePath, "utf8"), f.unexpected);

    // Matching, hash-bound resolution admits, but the file is still preserved.
    putJson(join(f.evidenceDir, "resolution.json"), {
      decision: "accept",
      observedSha256: digest(f.unexpected),
      generation: f.gen,
      runId: f.runId,
    });
    const ok = await runOnce("unexpected-ok");
    assert.equal(ok.cp.status, "ready");
    assert.equal(ok.cp.admit, true);
    assert.equal(ok.cp.preserved, true);
    assert.equal(ok.contender.status, 0, ok.contender.stderr);
    assert.equal(
      existsSync(join(f.workspace, "contender-unexpected-ok.txt")),
      true,
      "contender executed after explicit resolution",
    );
    assert.equal(
      readFileSync(f.livePath, "utf8"),
      f.unexpected,
      "file preserved: no overwrite and no rollback",
    );
    assert.equal(readJson(join(f.evidenceDir, "reconcile.json")).wroteResult, false);
  },
);

test(
  "DUR-001 symlink aliasing: canonical workspace root prevents alias from acquiring a separate lock",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "matrix-goal-lock-alias-"));
    const realWs = join(root, "real-workspace");
    const aliasWs = join(root, "alias-workspace");
    mkdirSync(realWs);
    symlinkSync(realWs, aliasWs);

    const readyBarrier = join(root, "primary.ready");
    const releaseBarrier = join(root, "primary.release");
    const primaryTouched = join(realWs, "primary.txt");
    const aliasTouched = join(aliasWs, "alias.txt");

    // Primary holder locks realpath(realWs) + ".lock"
    const canonicalLockPath = realpathSync(realWs) + ".lock";
    // Alias lock path when resolved via realpathSync(aliasWs) + ".lock"
    const aliasLockPath = realpathSync(aliasWs) + ".lock";
    assert.equal(
      aliasLockPath,
      canonicalLockPath,
      "alias resolves to identical canonical lock file",
    );

    const primaryScript = `
      const fs = require("node:fs");
      const [readyPath, releasePath, touchPath] = process.argv.slice(1);
      fs.writeFileSync(touchPath, "primary-running\\n");
      fs.writeFileSync(readyPath, "ready\\n");
      const start = Date.now();
      while (!fs.existsSync(releasePath) && Date.now() - start < 15000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      process.exit(0);
    `;

    const primaryProc = spawn(
      "flock",
      [
        "-n",
        "--no-fork",
        canonicalLockPath,
        process.execPath,
        "-e",
        primaryScript,
        readyBarrier,
        releaseBarrier,
        primaryTouched,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    t.after(() => {
      try {
        writeFileSync(releaseBarrier, "done\n");
      } catch {
        // Ignored if barrier is already gone.
      }
      try {
        primaryProc.kill("SIGKILL");
      } catch {
        // Ignored if process already exited.
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Ignored if root is already removed.
      }
    });

    await waitFor(() => existsSync(readyBarrier), 5000, "primary barrier ready");
    assert.equal(existsSync(primaryTouched), true, "primary holds lock and touched file");

    // Contender attempts to acquire lock via alias
    const contenderProc = spawnSync(
      "flock",
      [
        "-n",
        "--no-fork",
        aliasLockPath,
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(process.argv[1], "alias-ran\\n");`,
        aliasTouched,
      ],
      { encoding: "utf8" },
    );

    assert.notEqual(contenderProc.status, 0, "alias contender was rejected by flock");
    assert.equal(existsSync(aliasTouched), false, "rejected alias contender wrote zero bytes");

    // Release primary
    writeFileSync(releaseBarrier, "done\n");
    await once(primaryProc, "exit");
    assert.equal(primaryProc.exitCode, 0, "primary exited cleanly");

    // Valid positive control: contender can acquire lock once primary is gone
    const controlProc = spawnSync(
      "flock",
      [
        "-n",
        "--no-fork",
        aliasLockPath,
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(process.argv[1], "alias-ran\\n");`,
        aliasTouched,
      ],
      { encoding: "utf8" },
    );
    assert.equal(controlProc.status, 0, "alias writer successfully acquired after release");
    assert.equal(existsSync(aliasTouched), true, "control writer successfully wrote file");
  },
);

test(
  "DUR-001 root replacement: replacing the workspace directory prevents reuse of stale authority and rejects execution",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "matrix-goal-lock-replace-"));
    const ws = join(root, "workspace");
    const wsOld = join(root, "workspace.old");
    const lockPath = join(root, "workspace.lock");
    const pausedBarrier = join(root, "primary.paused");
    const mutateBarrier = join(root, "primary.mutate");
    const primaryApprovedFile = "approved-write.txt";
    const contenderTouched = join(ws, "contender.txt");
    const controlTouched = join(ws, "control-success.txt");

    mkdirSync(ws);
    const initialStat = statSync(ws);
    const approvedAuthority = {
      workspace: ws,
      dev: Number(initialStat.dev),
      ino: Number(initialStat.ino),
    };

    const primaryScript = `
      const fs = require("node:fs");
      const path = require("node:path");
      const [pausedPath, mutatePath, authJson, filename] = process.argv.slice(1);
      const auth = JSON.parse(authJson);
      fs.writeFileSync(pausedPath, "paused\\n");
      const start = Date.now();
      while (!fs.existsSync(mutatePath) && Date.now() - start < 15000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      if (!fs.existsSync(mutatePath)) {
        console.error("timeout waiting for mutate barrier");
        process.exit(1);
      }
      const currentStat = fs.statSync(auth.workspace);
      if (Number(currentStat.dev) !== auth.dev || Number(currentStat.ino) !== auth.ino) {
        console.error("refusing write: workspace root directory changed (inode mismatch)");
        process.exit(3);
      }
      fs.writeFileSync(path.join(auth.workspace, filename), "approved-content\\n");
      process.exit(0);
    `;

    const primaryProc = spawn(
      "flock",
      [
        "-n",
        "--no-fork",
        lockPath,
        process.execPath,
        "-e",
        primaryScript,
        pausedBarrier,
        mutateBarrier,
        JSON.stringify(approvedAuthority),
        primaryApprovedFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    t.after(() => {
      try {
        writeFileSync(mutateBarrier, "done\n");
      } catch {
        // Ignored if barrier is already gone.
      }
      try {
        primaryProc.kill("SIGKILL");
      } catch {
        // Ignored if process already exited.
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Ignored if root is already removed.
      }
    });

    // 1. Wait for primary holder to pause before mutation
    await waitFor(() => existsSync(pausedBarrier), 5000, "primary barrier paused before mutation");

    // 2. Replace workspace directory while primary holds lock
    renameSync(ws, wsOld);
    mkdirSync(ws);
    const replacedStat = statSync(ws);
    assert.notEqual(
      Number(replacedStat.ino),
      approvedAuthority.ino,
      "replaced workspace directory has a distinct inode",
    );

    // 3. Let original holder resume and attempt approved write
    writeFileSync(mutateBarrier, "mutate\n");
    await once(primaryProc, "exit");
    assert.equal(primaryProc.exitCode, 3, "original holder refused write on root replacement");

    // Assert both roots remain completely unchanged
    assert.equal(
      existsSync(join(wsOld, primaryApprovedFile)),
      false,
      "original renamed root has no approved file",
    );
    assert.deepEqual(readdirSync(wsOld), [], "original renamed root left completely unchanged");
    assert.equal(
      existsSync(join(ws, primaryApprovedFile)),
      false,
      "replacement root has no approved file",
    );
    assert.deepEqual(readdirSync(ws), [], "replacement root left completely unchanged");

    // 4. Stale contender attempts execution with stale authority
    const contenderScript = `
      const fs = require("node:fs");
      const [authJson, touchPath] = process.argv.slice(1);
      const auth = JSON.parse(authJson);
      const currentStat = fs.statSync(auth.workspace);
      if (Number(currentStat.dev) !== auth.dev || Number(currentStat.ino) !== auth.ino) {
        console.error("authority mismatch: directory inode changed");
        process.exit(3);
      }
      fs.writeFileSync(touchPath, "contender-ran\\n");
      process.exit(0);
    `;

    const rejectedContender = spawnSync(
      process.execPath,
      ["-e", contenderScript, JSON.stringify(approvedAuthority), contenderTouched],
      { encoding: "utf8" },
    );
    assert.equal(rejectedContender.status, 3, "stale contender rejected on stale inode");
    assert.equal(existsSync(contenderTouched), false, "rejected contender wrote zero bytes");
    assert.deepEqual(readdirSync(ws), [], "replacement root unchanged by rejected contender");
    assert.deepEqual(
      readdirSync(wsOld),
      [],
      "original renamed root unchanged by rejected contender",
    );

    // 5. Valid positive control: contender with updated authority executes successfully
    const updatedAuthority = {
      workspace: ws,
      dev: Number(replacedStat.dev),
      ino: Number(replacedStat.ino),
    };
    const validContender = spawnSync(
      "flock",
      [
        "-n",
        "--no-fork",
        lockPath,
        process.execPath,
        "-e",
        contenderScript,
        JSON.stringify(updatedAuthority),
        controlTouched,
      ],
      { encoding: "utf8" },
    );
    assert.equal(validContender.status, 0, "contender with valid authority succeeded");
    assert.equal(existsSync(controlTouched), true, "valid control contender wrote file");
    assert.equal(readFileSync(controlTouched, "utf8"), "contender-ran\n");
    assert.deepEqual(readdirSync(wsOld), [], "original renamed root remains untouched");
  },
);

test(
  "DUR-001 legacy writer participation: active goal lock excludes legacy writers, and free workspace admits them",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "matrix-goal-lock-legacy-"));
    const ws = join(root, "workspace");
    const lockPath = join(root, "workspace.lock");
    const leasePath = join(root, "workspace.lease.json");
    const readyBarrier = join(root, "goal.ready");
    const releaseBarrier = join(root, "goal.release");
    const legacyTouched = join(ws, "legacy-write.txt");

    mkdirSync(ws);

    // Goal process holds lock and writes active lease
    const goalScript = `
      const fs = require("node:fs");
      const [readyPath, releasePath, leaseFile] = process.argv.slice(1);
      fs.writeFileSync(leaseFile, JSON.stringify({
        goalId: "goal-test-legacy",
        generation: 1,
        owner: { pid: process.pid },
        expiresAt: Date.now() + 30000,
      }, null, 2) + "\\n");
      fs.writeFileSync(readyPath, "ready\\n");
      const start = Date.now();
      while (!fs.existsSync(releasePath) && Date.now() - start < 15000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      fs.rmSync(leaseFile, { force: true });
      process.exit(0);
    `;

    const goalProc = spawn(
      "flock",
      [
        "-n",
        "--no-fork",
        lockPath,
        process.execPath,
        "-e",
        goalScript,
        readyBarrier,
        releaseBarrier,
        leasePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    t.after(() => {
      try {
        writeFileSync(releaseBarrier, "done\n");
      } catch {
        // Ignored if barrier is already gone.
      }
      try {
        goalProc.kill("SIGKILL");
      } catch {
        // Ignored if process already exited.
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Ignored if root is already removed.
      }
    });

    await waitFor(() => existsSync(readyBarrier), 5000, "goal barrier ready");

    // Legacy writer checks lock + lease before writing
    const legacyWriterScript = `
      const fs = require("node:fs");
      const [lockFile, leaseFile, targetPath] = process.argv.slice(1);
      if (fs.existsSync(leaseFile)) {
        try {
          const lease = JSON.parse(fs.readFileSync(leaseFile, "utf8"));
          if (lease && lease.expiresAt && Date.now() < lease.expiresAt && lease.owner && lease.owner.pid !== process.pid) {
            console.error("rejected: workspace locked by active goal lease");
            process.exit(5);
          }
        } catch {}
      }
      fs.writeFileSync(targetPath, "legacy-content\\n");
      process.exit(0);
    `;

    // 1. Legacy writer attempting to flock fails immediately
    const flockAttempt = spawnSync(
      "flock",
      [
        "-n",
        "--no-fork",
        lockPath,
        process.execPath,
        "-e",
        legacyWriterScript,
        lockPath,
        leasePath,
        legacyTouched,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(flockAttempt.status, 0, "flock rejected legacy writer during active goal");
    assert.equal(existsSync(legacyTouched), false, "rejected legacy writer wrote zero bytes");

    // 2. Legacy writer attempting without flock is rejected by lease check
    const leaseAttempt = spawnSync(
      process.execPath,
      ["-e", legacyWriterScript, lockPath, leasePath, legacyTouched],
      { encoding: "utf8" },
    );
    assert.equal(leaseAttempt.status, 5, "lease check rejected legacy writer during active goal");
    assert.equal(existsSync(legacyTouched), false, "rejected legacy writer wrote zero bytes");

    // Release goal
    writeFileSync(releaseBarrier, "done\n");
    await once(goalProc, "exit");
    assert.equal(goalProc.exitCode, 0, "goal exited cleanly");

    // Valid positive control: legacy writer can acquire lock and write when goal is inactive
    const controlAttempt = spawnSync(
      "flock",
      [
        "-n",
        "--no-fork",
        lockPath,
        process.execPath,
        "-e",
        legacyWriterScript,
        lockPath,
        leasePath,
        legacyTouched,
      ],
      { encoding: "utf8" },
    );
    assert.equal(controlAttempt.status, 0, "legacy writer succeeded once goal released");
    assert.equal(existsSync(legacyTouched), true, "legacy writer executed and touched file");
  },
);

test(
  "DUR-001 live writer participation: model agent write path refuses when goal lock is held and succeeds when released",
  { skip: process.platform !== "linux" },
  async (t) => {
    const demo = copyDemo("matrix-goal-lock-live-writer-");
    t.after(() => demo.cleanup());
    const project = detectProject(demo.workspace);
    const canonicalWorkspace = realpathSync(demo.workspace);
    const lockPath = canonicalWorkspace + ".lock";
    const readyBarrier = join(demo.root, "goal.ready");
    const releaseBarrier = join(demo.root, "goal.release");
    const leaseFile = join(canonicalWorkspace, "workspace.lease.json");
    const model = resolveModel("sonnet");
    const targetRel = "src/processor.py";
    const targetAbs = join(demo.workspace, targetRel);
    const initialContent = readFileSync(targetAbs, "utf8");

    // Hold goal lock in a separate process
    const goalScript = `
      const fs = require("node:fs");
      const [readyPath, releasePath, leasePath] = process.argv.slice(1);
      fs.writeFileSync(leasePath, JSON.stringify({
        goalId: "goal-test-live-writer",
        generation: 1,
        owner: { pid: process.pid },
        expiresAt: Date.now() + 30000,
      }, null, 2) + "\\n");
      fs.writeFileSync(readyPath, "ready\\n");
      const start = Date.now();
      while (!fs.existsSync(releasePath) && Date.now() - start < 15000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      try { fs.rmSync(leasePath, { force: true }); } catch {}
      process.exit(0);
    `;

    const goalProc = spawn(
      "flock",
      [
        "-n",
        "--no-fork",
        lockPath,
        process.execPath,
        "-e",
        goalScript,
        readyBarrier,
        releaseBarrier,
        leaseFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    t.after(() => {
      try {
        writeFileSync(releaseBarrier, "done\n");
      } catch {
        // Ignored.
      }
      try {
        goalProc.kill("SIGKILL");
      } catch {
        // Ignored.
      }
    });

    await waitFor(() => existsSync(readyBarrier), 5000, "goal lock holder ready barrier");

    const previousFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = previousFetch;
    });

    let round = 0;
    const fetchMock = async (_url, _init) => {
      round += 1;
      if (round === 1) {
        return sseResponse([
          { choices: [{ delta: { reasoning: "Inspecting target file" } }] },
          ...toolCallChunks("call_read", "read_file", {
            path: targetRel,
            start_line: 17,
            end_line: 23,
          }),
        ]);
      }
      if (round === 2) {
        return sseResponse(
          toolCallChunks("call_edit", "propose_edit", {
            path: targetRel,
            start_line: 20,
            end_line: 21,
            replacement: "        context = bounds[0:len(bounds)]\n",
            rationale: "fix bounds slice",
          }),
        );
      }
      return sseResponse(contentChunks("Finished attempt."));
    };
    globalThis.fetch = fetchMock;

    const testHome = mkdtempSync(join(tmpdir(), "matrix-live-writer-home-"));
    t.after(() => rmSync(testHome, { recursive: true, force: true }));
    const policy = createTestPolicy({ home: testHome, headless: true, allowTests: true });

    // The model agent refuses to start without a provider credential. Give it
    // a fake one and an isolated home so this test is hermetic on a host with
    // no stored credentials; the mocked fetch never sends it anywhere.
    const restoreProviderEnv = patchEnv({
      HOME: testHome,
      ...Object.fromEntries(PROVIDER_ENVIRONMENT_KEYS.map((key) => [key, undefined])),
      OPENROUTER_API_KEY: "test-key",
    });
    t.after(restoreProviderEnv);

    // 1. Invoke real write path with normal approval flow while lock is held
    let approvalRequested = false;
    let approvalProposal = null;
    const lockedEvents = [];

    await withTestExecutionContext({ home: testHome, origin: TEST_ORIGIN.MODEL, policy }, () =>
      runModelAgent({
        task: "Fix off-by-one in src/processor.py",
        project,
        model,
        backupHome: join(demo.root, "backup"),
        requestApproval: async (proposal) => {
          approvalRequested = true;
          approvalProposal = proposal;
          return "y";
        },
        onEvent: (event) => lockedEvents.push(event),
      }),
    );

    assert.equal(approvalRequested, true, "normal approval flow was invoked while locked");
    assert.ok(approvalProposal, "approval proposal was presented");
    assert.equal(approvalProposal.file, targetRel);

    const editToolEvents = lockedEvents.filter(
      (e) => e.type === "tool:end" && e.name === "propose_edit",
    );
    assert.equal(editToolEvents.length, 1, "propose_edit tool was dispatched");
    assert.equal(editToolEvents[0].ok, false, "tool failed due to lock refusal");
    assert.match(editToolEvents[0].summary, /workspace is locked/, "summary reports lock refusal");

    const unchangedContent = readFileSync(targetAbs, "utf8");
    assert.equal(
      unchangedContent,
      initialContent,
      "workspace file was not modified while lock held",
    );

    // 2. Release the lock and verify the same approved operation succeeds
    writeFileSync(releaseBarrier, "done\n");
    await once(goalProc, "exit");
    assert.equal(goalProc.exitCode, 0, "goal holder process exited cleanly");

    round = 0;
    approvalRequested = false;
    approvalProposal = null;
    const unlockedEvents = [];
    let contenderAtCommit;
    const renameSyncOriginal = fs.renameSync;
    const rename = t.mock.method(fs, "renameSync", (from, to) => {
      if (to === targetAbs) {
        contenderAtCommit = spawnSync("flock", ["-n", lockPath, "true"], { timeout: 2000 });
      }
      return renameSyncOriginal(from, to);
    });
    syncBuiltinESMExports();
    t.after(() => {
      rename.mock.restore();
      syncBuiltinESMExports();
    });

    await withTestExecutionContext({ home: testHome, origin: TEST_ORIGIN.MODEL, policy }, () =>
      runModelAgent({
        task: "Fix off-by-one in src/processor.py",
        project,
        model,
        backupHome: join(demo.root, "backup"),
        requestApproval: async (proposal) => {
          approvalRequested = true;
          approvalProposal = proposal;
          return "y";
        },
        onEvent: (event) => unlockedEvents.push(event),
      }),
    );

    assert.equal(approvalRequested, true, "normal approval flow was invoked after release");
    assert.ok(approvalProposal, "approval proposal was presented on second invocation");
    assert.equal(approvalProposal.file, targetRel);
    const unlockedToolEvents = unlockedEvents.filter(
      (e) => e.type === "tool:end" && e.name === "propose_edit",
    );
    assert.equal(unlockedToolEvents.length, 1, "propose_edit tool dispatched again");
    assert.equal(unlockedToolEvents[0].ok, true, "propose_edit succeeded after lock released");
    assert.equal(contenderAtCommit?.status, 1, "a second writer was excluded at the atomic rename");
    assert.equal(spawnSync("flock", ["-n", lockPath, "true"]).status, 0, "edit released its lock");
    assert.match(unlockedToolEvents[0].summary, /applied/, "edit was applied");

    const modifiedContent = readFileSync(targetAbs, "utf8");
    assert.notEqual(
      modifiedContent,
      initialContent,
      "workspace file was modified after lock release",
    );
    assert.ok(
      modifiedContent.includes("context = bounds[0:len(bounds)]"),
      "file contains applied change",
    );
  },
);

test(
  "DUR-001 workspace write gate: holds a new lock and releases it on failure",
  { skip: process.platform !== "linux" },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "matrix-workspace-gate-"));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, "workspace");
    mkdirSync(dir);
    const lockPath = realpathSync(dir) + ".lock";
    const attempt = () => spawnSync("flock", ["-n", lockPath, "true"], { timeout: 2000 });
    const write = () => withWorkspaceWriteLock(dir, () => "ran");
    const failure = new Error("synthetic write failure");
    assert.equal(existsSync(lockPath), false);
    assert.throws(
      () =>
        withWorkspaceWriteLock(dir, () => {
          assert.equal(attempt().status, 1, "a competing process cannot enter on the first write");
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(attempt().status, 0, "a failed write releases its lock");

    // 3. Foreign active lease
    const leaseFile = join(dir, "workspace.lease.json");
    writeFileSync(
      leaseFile,
      JSON.stringify({ expiresAt: Date.now() + 30000, owner: { pid: 9999999 } }),
    );
    assert.throws(write, /refusing to write: workspace is locked by an active goal lease/);

    // 4. Expired lease
    writeFileSync(
      leaseFile,
      JSON.stringify({ expiresAt: Date.now() - 1000, owner: { pid: 9999999 } }),
    );
    assert.equal(write(), "ran");

    // 5. Own lease
    writeFileSync(
      leaseFile,
      JSON.stringify({ expiresAt: Date.now() + 30000, owner: { pid: process.pid } }),
    );
    assert.equal(write(), "ran");

    for (const contents of [
      "corrupted-json",
      "{}",
      JSON.stringify({ expiresAt: Date.now() + 30000, owner: { pid: "invalid" } }),
      "x".repeat(4097),
    ]) {
      writeFileSync(leaseFile, contents);
      assert.throws(write, /workspace lease is invalid/);
    }
    rmSync(leaseFile, { force: true });
    symlinkSync(lockPath, leaseFile);
    assert.throws(write, /workspace lease is unavailable/);
    rmSync(leaseFile);
    mkdirSync(leaseFile);
    assert.throws(write, /workspace lease is invalid/);
    rmSync(leaseFile, { recursive: true });

    const unavailable = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import assert from "node:assert/strict";
         const { withWorkspaceWriteLock } = await import(process.argv[1]);
         assert.throws(
           () => withWorkspaceWriteLock(process.argv[2], () => assert.fail("write was admitted")),
           /workspace lock is unavailable/,
         );`,
        new URL("../lib/workspace.mjs", import.meta.url).href,
        dir,
      ],
      { env: { PATH: parent }, encoding: "utf8", timeout: 3000 },
    );
    assert.equal(unavailable.status, 0, unavailable.stderr || String(unavailable.error));
    assert.equal(attempt().status, 0, "unavailable flock leaves no held lock");

    // 7. Lock held by flock without lease
    const readyBarrier = join(dir, "lock.ready");
    const releaseBarrier = join(dir, "lock.release");

    const lockProc = spawn(
      "flock",
      [
        "-n",
        "--no-fork",
        lockPath,
        process.execPath,
        "-e",
        `
        const fs = require("node:fs");
        const [readyPath, releasePath] = process.argv.slice(1);
        fs.writeFileSync(readyPath, "ready\\n");
        const start = Date.now();
        while (!fs.existsSync(releasePath) && Date.now() - start < 15000) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        process.exit(0);
        `,
        readyBarrier,
        releaseBarrier,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    t.after(() => {
      try {
        writeFileSync(releaseBarrier, "done\n");
      } catch {
        // Ignored.
      }
      try {
        lockProc.kill("SIGKILL");
      } catch {
        // Ignored.
      }
    });

    await waitFor(() => existsSync(readyBarrier), 5000, "flock barrier ready");
    assert.throws(write, /refusing to write: workspace is locked by an active goal/);

    // 8. Released flock
    writeFileSync(releaseBarrier, "done\n");
    await once(lockProc, "exit");
    assert.equal(write(), "ran");
  },
);
