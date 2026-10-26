import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import net from "node:net";

import { COMMAND_STATUS, runSandboxedCommand } from "../lib/command-execution.mjs";
import { createCommandPolicy, inspectCommandPlan } from "../lib/command-policy.mjs";
import { createLinuxBwrapBackend } from "../lib/linux-bwrap.mjs";
import { cleanupWorkspaceSnapshot } from "../lib/linux-snapshot.mjs";
import { runsDir } from "../lib/session.mjs";
import { makeTempDir } from "./helpers.mjs";

let sequence = 0;

function fixture(t) {
  const root = makeTempDir("matrix-command-execution-");
  const workspace = join(root, "workspace");
  const home = join(root, "matrix-home");
  const scratch = join(root, "scratch");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "sentinel.txt"), "live-original");
  writeFileSync(join(root, "outside.txt"), "outside-original");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, home, scratch };
}

function nodePlan(f, source, cwd = f.workspace) {
  return { executable: process.execPath, argv: ["-e", source], cwd, script: source };
}

function approval(requestApproval = () => true) {
  return createCommandPolicy({ enabled: true, requestApproval });
}

function headlessApproval(workspace, plan) {
  const inspected = inspectCommandPlan(plan, { workspace });
  assert.equal(inspected.ok, true, inspected.error);
  return createCommandPolicy({
    enabled: true,
    headless: true,
    approvedPlanHash: inspected.plan.planHash,
  });
}

async function execute(f, plan, options = {}) {
  const runId = options.runId ?? `command-${++sequence}`;
  const result = await runSandboxedCommand(plan, {
    workspace: f.workspace,
    policy: options.policy ?? approval(),
    home: options.home ?? f.home,
    scratchDir: f.scratch,
    runId,
    executionId: `execution-${runId}`,
    ...options,
  });
  return { result, runId };
}

function records(f, runId, home = f.home) {
  const path = join(runsDir(home), `${runId}.jsonl`);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function assertLiveAndClean(f) {
  assert.equal(readFileSync(join(f.workspace, "sentinel.txt"), "utf8"), "live-original");
  assert.equal(readFileSync(join(f.root, "outside.txt"), "utf8"), "outside-original");
  if (existsSync(f.scratch)) assert.deepEqual(readdirSync(f.scratch), []);
}

function assertNoEditEvents(log) {
  assert.equal(
    log.some((record) => ["applied", "undo", "undo:run"].includes(record.type)),
    false,
  );
}

function assertSuccess(result) {
  assert.equal(result.commandStatus, COMMAND_STATUS.SUCCEEDED, result.failure ?? result.reason);
  assert.equal(result.status, "success");
  assert.equal(result.processOk, true);
  assert.equal(result.auditStatus, "complete");
  assert.equal(result.cleanupStatus, "complete");
  assert.equal(result.liveWorkspaceChanged, false);
  assert.equal(result.writes, "discarded");
  assert.equal(result.undo, "not-applicable");
}

test("real bubblewrap probe enforces the required policy on this Linux host", async () => {
  const backend = createLinuxBwrapBackend();
  const probe = await backend.probe();
  assert.equal(probe.available, true, probe.reason);
});

test("current Node runs as one read-only runtime file while an outside lookalike stays rejected and unmounted", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "lookalike-bin"));
  const lookalike = join(f.root, "lookalike-bin", "node");
  const canary = "OUTSIDE-EXECUTABLE-CANARY-ADV002";
  writeFileSync(lookalike, `#!/bin/sh\nprintf ${canary}\n`, { mode: 0o755 });
  chmodSync(lookalike, 0o755);

  const rejected = await execute(f, { executable: lookalike, argv: [], cwd: f.workspace });
  assert.equal(rejected.result.commandStatus, COMMAND_STATUS.DENIED);
  assert.equal(rejected.result.reason, "executable-outside-runtime");
  assert.equal(rejected.result.audit.start, false);

  const source = `
    const fs = require("node:fs");
    console.log("runtime:" + fs.realpathSync(process.execPath));
    try { console.log("lookalike:" + fs.readFileSync(${JSON.stringify(lookalike)}, "utf8")); }
    catch (error) { console.log("lookalike:" + error.code); }
  `;
  const { result } = await execute(f, nodePlan(f, source));
  assertSuccess(result);
  assert.equal(result.stdout.includes(`runtime:${realpathSync(process.execPath)}`), true);
  assert.equal(result.stdout.includes("lookalike:ENOENT"), true);
  assert.equal(result.stdout.includes(canary), false);
  assertLiveAndClean(f);
});

test("execution discards snapshot writes and keeps inline script bytes out of every audit projection", async (t) => {
  const f = fixture(t);
  const marker = "INLINE-SCRIPT-ONLY-CANARY-ADV002";
  const source = `/* ${marker} */ const fs = require("node:fs"); fs.writeFileSync("sentinel.txt", "snapshot"); fs.writeFileSync("created.txt", "snapshot"); console.log("sandbox-ok");`;
  const plan = nodePlan(f, source);
  let request;
  const { result, runId } = await execute(f, plan, {
    policy: approval((value) => {
      request = value;
      return true;
    }),
  });
  assertSuccess(result);
  assert.equal(result.stdout, "sandbox-ok\n");
  assert.equal(existsSync(join(f.workspace, "created.txt")), false);
  assertLiveAndClean(f);
  assert.equal(request.script, source, "approval UI still receives exact script bytes");
  assert.equal(request.command.includes(marker), true);

  const log = records(f, runId);
  assert.deepEqual(
    log.map((record) => record.type),
    ["command:decision", "command:start", "command:end"],
  );
  assertNoEditEvents(log);
  const serialized = JSON.stringify(log);
  assert.equal(serialized.includes(source), false);
  assert.equal(serialized.includes(marker), false);
  assert.equal(JSON.stringify(result.commandPlan).includes(marker), false);
  assert.equal(result.command.includes(marker), false);
  assert.match(result.commandPlan.argv[1], /^\[inline-script sha256:[a-f0-9]{64}\]$/);
  for (const record of log) {
    assert.equal("env" in record, false);
    assert.equal("stdout" in record, false);
    assert.equal("stderr" in record, false);
    assert.equal("lines" in record, false);
  }
  assert.equal(statSync(result.audit.path).mode & 0o777, 0o600);
});

test("explicit shell redirection/substitution, sed -i and workspace executables cannot apply live edits", async (t) => {
  const f = fixture(t);
  const shell = `printf shell-changed > sentinel.txt; target=$(printf substitution); printf substituted > "$target.txt"; printf five > "$((2 + 3)).txt"`;
  const shellRun = await execute(f, {
    executable: "/bin/sh",
    argv: ["-c", shell],
    cwd: f.workspace,
    script: shell,
  });
  assertSuccess(shellRun.result);
  assert.equal(existsSync(join(f.workspace, "substitution.txt")), false);
  assert.equal(existsSync(join(f.workspace, "5.txt")), false);

  const sedRun = await execute(f, {
    executable: "/usr/bin/sed",
    argv: ["-i", "s/live-original/sed-changed/g", "sentinel.txt"],
    cwd: f.workspace,
  });
  assertSuccess(sedRun.result);

  const executable = join(f.workspace, "tool.sh");
  writeFileSync(executable, "#!/bin/sh\nprintf workspace-tool > sentinel.txt\n", { mode: 0o755 });
  chmodSync(executable, 0o755);
  const toolRun = await execute(f, { executable, argv: [], cwd: f.workspace });
  assertSuccess(toolRun.result);
  assertLiveAndClean(f);
});

test("interpreter, traversal and denied-edit replacement affect only the disposable snapshot", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, "denied.txt"), "denied-replacement");
  const source = `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(join(f.workspace, "sentinel.txt"))}, "interpreter");
    fs.renameSync("denied.txt", "sentinel.txt");
    let traversal = "allowed";
    try { fs.writeFileSync("../outside.txt", "escaped"); } catch (error) { traversal = error.code; }
    console.log("traversal:" + traversal);
  `;
  const { result } = await execute(f, nodePlan(f, source));
  assertSuccess(result);
  assert.match(result.stdout, /traversal:(?:allowed|EROFS|ENOENT|EACCES)/);
  assert.equal(
    existsSync(join(f.workspace, "denied.txt")),
    true,
    "live denied source was not renamed",
  );
  assertLiveAndClean(f);

  writeFileSync(
    join(f.workspace, "script.mjs"),
    'import fs from "node:fs"; fs.writeFileSync("sentinel.txt", "file-script");\n',
  );
  const fileRun = await execute(f, {
    executable: process.execPath,
    argv: ["script.mjs"],
    cwd: f.workspace,
    scriptFile: "script.mjs",
  });
  assertSuccess(fileRun.result);
  assertLiveAndClean(f);
});

test("escape symlinks, directory symlinks and hardlink aliases never modify live canaries", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, "subdir"));
  writeFileSync(join(f.workspace, "subdir", "file.txt"), "directory-original");
  linkSync(join(f.workspace, "sentinel.txt"), join(f.workspace, "hardlink.txt"));
  symlinkSync("../outside.txt", join(f.workspace, "escape.txt"));
  symlinkSync("subdir", join(f.workspace, "directory-link"));
  const source = `
    const fs = require("node:fs");
    let escape = "allowed";
    try { fs.writeFileSync("escape.txt", "escaped"); } catch (error) { escape = error.code; }
    fs.writeFileSync("hardlink.txt", "snapshot-hardlink");
    fs.writeFileSync("directory-link/file.txt", "snapshot-directory");
    fs.linkSync("hardlink.txt", "new-hardlink.txt");
    console.log("escape:" + escape);
  `;
  const { result } = await execute(f, nodePlan(f, source));
  assertSuccess(result);
  assert.match(result.stdout, /escape:(?:allowed|EROFS|ENOENT|EACCES)/);
  assert.equal(readFileSync(join(f.workspace, "hardlink.txt"), "utf8"), "live-original");
  assert.equal(readFileSync(join(f.workspace, "subdir", "file.txt"), "utf8"), "directory-original");
  assert.equal(existsSync(join(f.workspace, "new-hardlink.txt")), false);
  assertLiveAndClean(f);
});

test("approval-window symlink/cwd swaps deny without a start audit or spawn", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, "a"));
  mkdirSync(join(f.workspace, "b"));
  symlinkSync("a", join(f.workspace, "current"));
  const plan = nodePlan(f, 'console.log("must-not-run")', join(f.workspace, "current"));
  const { result, runId } = await execute(f, plan, {
    policy: approval(() => {
      unlinkSync(join(f.workspace, "current"));
      symlinkSync("b", join(f.workspace, "current"));
      return true;
    }),
  });
  assert.equal(result.commandStatus, COMMAND_STATUS.DENIED);
  assert.equal(result.reason, "approval-window-changed");
  assert.equal(result.stdout, "");
  assert.equal(result.audit.start, false);
  assert.equal(
    records(f, runId).some((record) => record.type === "command:start"),
    false,
  );
  assertLiveAndClean(f);
});

test("secret files, host paths and ambient credentials are unavailable; literal output is redacted", async (t) => {
  const f = fixture(t);
  const canary = "FAKE-CANARY-ADV002-NOT-A-REAL-SECRET";
  writeFileSync(join(f.root, "host-canary.txt"), canary);
  writeFileSync(join(f.workspace, ".env"), `TOKEN=${canary}`);
  writeFileSync(join(f.workspace, "credentials.json"), JSON.stringify({ canary }));
  mkdirSync(join(f.workspace, ".ssh"));
  writeFileSync(join(f.workspace, ".ssh", "id_rsa"), canary);
  const attempts = [
    join(f.root, "host-canary.txt"),
    ".env",
    "credentials.json",
    ".ssh/id_rsa",
    "/etc/passwd",
    "/root/.ssh/id_rsa",
  ];
  const source = `
    const fs = require("node:fs");
    for (const path of ${JSON.stringify(attempts)}) {
      try { console.log(path + ":ACQUIRED:" + fs.readFileSync(path, "utf8")); }
      catch (error) { console.log(path + ":" + error.code); }
    }
    console.log("credential-env:" + String(process.env.OPENROUTER_API_KEY));
    console.log("literal:" + ${JSON.stringify(canary)});
  `;
  const { result, runId } = await execute(f, nodePlan(f, source), { secretValues: [canary] });
  assertSuccess(result);
  assert.equal(result.stdout.includes(canary), false);
  assert.equal(result.stdout.includes("ACQUIRED"), false);
  assert.equal(result.stdout.includes("credential-env:undefined"), true);
  assert.equal(result.stdout.includes("literal:[redacted]"), true);
  for (const path of attempts) assert.equal(result.stdout.includes(`${path}:ENOENT`), true, path);
  assert.equal(readFileSync(join(f.root, "host-canary.txt"), "utf8"), canary);
  assert.equal(readFileSync(result.audit.path, "utf8").includes(canary), false);
  assertNoEditEvents(records(f, runId));
  assertLiveAndClean(f);
});

test("network and host socket attempts cannot connect or send a payload", async (t) => {
  const f = fixture(t);
  const socketPath = join(f.root, "host-canary.sock");
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const source = `
    const net = require("node:net");
    function probe(options, label) {
      return new Promise((resolve) => {
        const socket = net.connect(options);
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          socket.destroy();
          console.log(label + ":" + value);
          resolve();
        };
        socket.once("connect", () => finish("CONNECTED"));
        socket.once("error", (error) => finish(error.code));
        socket.setTimeout(400, () => finish("TIMEOUT"));
      });
    }
    Promise.all([
      probe({ host: "127.0.0.1", port: 9 }, "tcp"),
      probe(${JSON.stringify(socketPath)}, "unix")
    ]);
  `;
  const { result } = await execute(f, nodePlan(f, source));
  assertSuccess(result);
  assert.equal(result.stdout.includes("CONNECTED"), false);
  assert.match(result.stdout, /tcp:(?:EACCES|EPERM|ECONNREFUSED|ENETUNREACH|ETIMEOUT|TIMEOUT)/);
  assert.match(result.stdout, /unix:ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(connections, 0);
  assertLiveAndClean(f);
});

test("provider-like stdout/stderr remain bounded, redacted, tailed and visibly truncated", async (t) => {
  const f = fixture(t);
  const canary = "FAKE-OUTPUT-CANARY-ADV002";
  const source = `
    for (let index = 0; index < 450; index++) console.log("line " + index);
    process.stdout.write("x".repeat(600 * 1024) + ${JSON.stringify(canary)} + "TAIL\\n");
    process.stderr.write("e".repeat(600 * 1024) + "ERRTAIL\\n");
  `;
  const { result, runId } = await execute(f, nodePlan(f, source), {
    secretValues: [canary],
    resourceLimits: { outputChars: 4096 },
  });
  assertSuccess(result);
  assert.ok(result.stdout.length <= 4096 && result.stdout.length > 4000);
  assert.equal(result.stderr.length, 4096);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
  assert.equal(result.stdout.endsWith("TAIL\n"), true);
  assert.equal(result.stderr.endsWith("ERRTAIL\n"), true);
  assert.equal(result.stdout.includes(canary), false);
  assert.equal(result.outputLineCount, 452);
  assert.equal(result.lines.length, 400);
  assert.equal(result.lines[0], "line 52");
  assert.equal(result.outputTruncated, true);
  assert.ok(result.lines.at(-1).length <= 16 * 1024 + 1);
  const log = records(f, runId);
  assert.equal(log.at(-1).outputTruncated, true);
  assert.equal(JSON.stringify(log).includes(canary), false);
  assertLiveAndClean(f);
});

test("denial and exact-hash replay never spawn, and no fallback authority is inferred", async (t) => {
  const f = fixture(t);
  const plan = nodePlan(f, 'console.log("not-authorized")');
  const denied = await execute(f, plan, { policy: createCommandPolicy({ enabled: false }) });
  assert.equal(denied.result.commandStatus, COMMAND_STATUS.DENIED);
  assert.equal(denied.result.status, "denied");
  assert.equal(denied.result.processOk, false);
  assert.equal(denied.result.stdout, "");
  assert.equal(denied.result.audit.start, false);

  const policy = headlessApproval(f.workspace, plan);
  const first = await execute(f, plan, { policy });
  assertSuccess(first.result);
  const replay = await execute(f, plan, { policy });
  assert.equal(replay.result.commandStatus, COMMAND_STATUS.DENIED);
  assert.equal(replay.result.reason, "approval-replayed");
  assert.equal(replay.result.stdout, "");
  assert.equal(replay.result.audit.start, false);
  assertLiveAndClean(f);
});

test("missing start audit blocks spawn and oversized decision audit fails closed", async (t) => {
  const f = fixture(t);
  const plan = nodePlan(f, 'console.log("must-not-run")');
  const missing = await execute(f, plan, {
    hooks: {
      afterDecision: () => {
        rmSync(f.home, { recursive: true, force: true });
        writeFileSync(f.home, "audit-home-is-a-file");
      },
    },
  });
  assert.equal(missing.result.commandStatus, COMMAND_STATUS.AUDIT_FAILED);
  assert.equal(missing.result.reason, "start-audit-failed");
  assert.equal(missing.result.auditStatus, "start-failed");
  assert.equal(missing.result.stdout, "");
  assert.equal(missing.result.processStatus, "not-started");
  assert.equal(missing.result.audit.start, false);
  assertLiveAndClean(f);

  const g = fixture(t);
  const oversizedPlan = nodePlan(g, 'console.log("also-must-not-run")');
  oversizedPlan.argv.push("x".repeat(2048));
  const oversized = await execute(g, oversizedPlan, { retention: { maxEventBytes: 1024 } });
  assert.equal(oversized.result.commandStatus, COMMAND_STATUS.AUDIT_FAILED);
  assert.equal(oversized.result.reason, "decision-audit-failed");
  assert.equal(oversized.result.stdout, "");
  assert.equal(oversized.result.audit.start, false);
  assert.equal(oversized.result.audit.end, false);
  assertLiveAndClean(g);
});

test("end-audit failure is visible and cannot turn exit zero into audited success", async (t) => {
  const f = fixture(t);
  let sabotaged = false;
  const source = 'console.log("begin"); setTimeout(() => console.log("end"), 100);';
  const { result } = await execute(f, nodePlan(f, source), {
    onLine: (line) => {
      if (line === "begin" && !sabotaged) {
        sabotaged = true;
        rmSync(f.home, { recursive: true, force: true });
        writeFileSync(f.home, "end-audit-blocked");
      }
    },
  });
  assert.equal(sabotaged, true);
  assert.equal(result.processOk, true);
  assert.equal(result.code, 0);
  assert.equal(result.commandStatus, COMMAND_STATUS.AUDIT_FAILED);
  assert.equal(result.auditStatus, "end-failed");
  assert.equal(result.ok, false);
  assert.match(result.failure, /end audit/);
  assert.equal(result.cleanupStatus, "complete");
  assertLiveAndClean(f);
});

test("cleanup failure is distinct, audited and never hides process evidence", async (t) => {
  const f = fixture(t);
  const { result, runId } = await execute(f, nodePlan(f, 'console.log("done")'), {
    hooks: {
      cleanupSnapshot: (snapshot) => {
        const cleaned = cleanupWorkspaceSnapshot(snapshot);
        assert.equal(cleaned.ok, true);
        return { ok: false, error: "injected cleanup failure" };
      },
    },
  });
  assert.equal(result.processOk, true);
  assert.equal(result.commandStatus, COMMAND_STATUS.CLEANUP_FAILED);
  assert.equal(result.cleanupStatus, "failed");
  assert.equal(result.ok, false);
  assert.match(result.failure, /injected cleanup failure/);
  assert.equal(result.auditStatus, "complete");
  assert.equal(records(f, runId).at(-1).cleanupStatus, "failed");
  assertLiveAndClean(f);
});

test("cleanup failure does not replace an existing nonzero process failure", async (t) => {
  const f = fixture(t);
  const { result, runId } = await execute(f, nodePlan(f, "process.exit(9)"), {
    hooks: {
      cleanupSnapshot: (snapshot) => {
        assert.equal(cleanupWorkspaceSnapshot(snapshot).ok, true);
        return { ok: false, error: "secondary cleanup failure" };
      },
    },
  });
  assert.equal(result.code, 9);
  assert.equal(result.commandStatus, COMMAND_STATUS.FAILED);
  assert.equal(result.processStatus, COMMAND_STATUS.FAILED);
  assert.equal(result.cleanupStatus, "failed");
  assert.equal(result.auditStatus, "complete");
  assert.equal(records(f, runId).at(-1).status, COMMAND_STATUS.FAILED);
  assert.equal(records(f, runId).at(-1).cleanupStatus, "failed");
  assertLiveAndClean(f);
});

test("cancellation works before approval, while approval waits, and after snapshot before spawn", async (t) => {
  const f = fixture(t);
  const plan = nodePlan(f, 'console.log("must-not-run")');
  const pre = new AbortController();
  pre.abort();
  const before = await execute(f, plan, { signal: pre.signal });
  assert.equal(before.result.commandStatus, COMMAND_STATUS.ABORTED);
  assert.equal(before.result.audit.start, false);

  const during = new AbortController();
  const timer = setTimeout(() => during.abort(), 30);
  const waiting = await execute(f, plan, {
    signal: during.signal,
    policy: approval(() => new Promise(() => {})),
  });
  clearTimeout(timer);
  assert.equal(waiting.result.commandStatus, COMMAND_STATUS.ABORTED);
  assert.equal(waiting.result.audit.start, false);

  const beforeSpawn = new AbortController();
  const stopped = await execute(f, plan, {
    signal: beforeSpawn.signal,
    hooks: { beforeStartAudit: () => beforeSpawn.abort() },
  });
  assert.equal(stopped.result.commandStatus, COMMAND_STATUS.ABORTED);
  assert.equal(stopped.result.audit.start, false);
  assert.equal(stopped.result.stdout, "");
  assertLiveAndClean(f);
});

test("timeout cleans the process tree, scratch and audit without becoming success", async (t) => {
  const f = fixture(t);
  const source = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>process.stdout.write('child\\\\n'),40)"], { stdio: ["ignore", "inherit", "inherit"] });
    process.on("SIGTERM", () => {});
    console.log("ready");
    setInterval(() => process.stdout.write("parent\\n"), 40);
  `;
  const { result, runId } = await execute(f, nodePlan(f, source), { timeoutMs: 180 });
  assert.equal(result.commandStatus, COMMAND_STATUS.TIMED_OUT);
  assert.equal(result.status, "timedOut");
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.cleanupStatus, "complete");
  assert.equal(records(f, runId).at(-1).status, COMMAND_STATUS.TIMED_OUT);
  assertLiveAndClean(f);
});

test("abort during execution kills descendants and retains aborted primary status", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const source = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", "setInterval(()=>process.stdout.write('child\\\\n'),40)"], { stdio: ["ignore", "inherit", "inherit"] });
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  const { result, runId } = await execute(f, nodePlan(f, source), {
    signal: controller.signal,
    onLine: (line) => {
      if (line === "ready") controller.abort();
    },
  });
  assert.equal(result.commandStatus, COMMAND_STATUS.ABORTED);
  assert.equal(result.status, "aborted");
  assert.equal(result.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.cleanupStatus, "complete");
  assert.equal(records(f, runId).at(-1).status, COMMAND_STATUS.ABORTED);
  assertLiveAndClean(f);
});

test("unsupported backend and failed real probes are unavailable with no unsandboxed fallback", async (t) => {
  const f = fixture(t);
  const plan = nodePlan(f, 'console.log("must-not-run")');
  const unsupported = await execute(f, plan, { backend: "unsandboxed-host" });
  assert.equal(unsupported.result.commandStatus, COMMAND_STATUS.UNAVAILABLE);
  assert.equal(unsupported.result.reason, "backend-unsupported");
  assert.equal(unsupported.result.stdout, "");
  assert.equal(unsupported.result.audit.start, false);

  const failed = await execute(f, plan, {
    backendOptions: { bwrapPath: "/definitely/not/bwrap" },
  });
  assert.equal(failed.result.commandStatus, COMMAND_STATUS.UNAVAILABLE);
  assert.equal(failed.result.reason, "backend-unavailable");
  assert.equal(failed.result.stdout, "");
  assert.equal(failed.result.audit.start, false);
  assertLiveAndClean(f);
});

test("an unbounded wall timeout is rejected before the user process spawns", async (t) => {
  const f = fixture(t);
  const { result, runId } = await execute(f, nodePlan(f, 'console.log("must-not-run")'), {
    timeoutMs: 0,
  });
  assert.equal(result.commandStatus, COMMAND_STATUS.FAILED);
  assert.match(result.failure, /wall timeout/);
  assert.equal(result.stdout, "");
  assert.equal(result.code, null);
  assert.equal(result.cleanupStatus, "complete");
  assert.equal(records(f, runId).at(-1).spawned, false);
  assertLiveAndClean(f);
});

test("nonzero exit remains a process failure with complete audits and discarded writes", async (t) => {
  const f = fixture(t);
  const source =
    'require("node:fs").writeFileSync("sentinel.txt", "failed-snapshot"); console.error("failure-output"); process.exit(7);';
  const { result, runId } = await execute(f, nodePlan(f, source));
  assert.equal(result.commandStatus, COMMAND_STATUS.FAILED);
  assert.equal(result.status, "failed");
  assert.equal(result.processStatus, COMMAND_STATUS.FAILED);
  assert.equal(result.processOk, false);
  assert.equal(result.code, 7);
  assert.equal(result.ok, false);
  assert.equal(result.auditStatus, "complete");
  assert.equal(result.cleanupStatus, "complete");
  assertNoEditEvents(records(f, runId));
  assertLiveAndClean(f);
});

test("workspace executable replacement after approval blocks its new bytes", async (t) => {
  const f = fixture(t);
  const executable = join(f.workspace, "replace-me.sh");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(executable, 0o755);
  const plan = { executable, argv: [], cwd: f.workspace };
  const { result, runId } = await execute(f, plan, {
    policy: approval(() => {
      const replacement = join(f.workspace, "replacement.sh");
      writeFileSync(replacement, "#!/bin/sh\nprintf replaced > ../outside.txt\n", { mode: 0o755 });
      chmodSync(replacement, 0o755);
      renameSync(replacement, executable);
      return true;
    }),
  });
  assert.equal(result.commandStatus, COMMAND_STATUS.DENIED);
  assert.equal(result.reason, "approval-window-changed");
  assert.equal(result.audit.start, false);
  assert.equal(
    records(f, runId).some((record) => record.type === "command:start"),
    false,
  );
  assertLiveAndClean(f);
});
