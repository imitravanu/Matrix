// DUR-006 — CLI grammar and real subprocess goal-command tests.
//
// Every filesystem case runs on a temporary MATRIX_HOME and a temporary
// workspace; the provider is a mock HTTP server in a separate child process
// reached through a fake credential (a bearer env var holding a dummy value).
// No network and no real credentials are used. Covered: start/resume to
// completion, denied edits, SIGKILL/SIGINT interruption and fresh-process
// resume, pause/cancel through the verified owner channel, read-only
// list/inspect, invalid flags and goal ids, unknown goals, missing keys,
// criteria-file validation, workspace replacement/rename, budget limits,
// a real PTY run and PTY kill/restart.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { parseArgv } from "../lib/cli.mjs";
import { canonicalJson } from "../lib/goal-contracts.mjs";
import { addProviderProfile } from "../lib/provider-config.mjs";
import { createGoalStore } from "../lib/goal-store.mjs";
import { stripAnsi } from "../lib/text.mjs";
import { PACKAGE_ROOT, makeTempDir } from "./helpers.mjs";

const BIN = join(PACKAGE_ROOT, "bin", "matrix.mjs");
const linux = { skip: process.platform !== "linux" };
const hash = (value) => createHash("sha256").update(value).digest("hex");

const INITIAL = "export const a = 1;\n";
const TARGET = "export const a = 2;\n";
const FAKE_KEY = "fake-goal-key-0123456789abcdef";

// ---------------------------------------------------------------------------
// CLI parsing units
// ---------------------------------------------------------------------------

test("goal grammar parses the six frozen actions and start flags", () => {
  const start = parseArgv([
    "goal",
    "start",
    "fix",
    "the",
    "bug",
    "--criteria",
    "c.json",
    "--model",
    "sonnet",
    "--provider",
    "lab",
    "--yes",
    "--json",
    "--rounds",
    "16",
    "--tools",
    "48",
    "--requests",
    "64",
    "--active-ms",
    "120000",
  ]);
  assert.equal(start.command, "goal");
  assert.equal(start.goalAction, "start");
  assert.equal(start.goalObjective, "fix the bug");
  assert.equal(start.goalCriteriaFile, "c.json");
  assert.equal(start.modelQuery, "sonnet");
  assert.equal(start.providerId, "lab");
  assert.equal(start.autoApprove, true);
  assert.equal(start.json, true);
  assert.equal(start.goalRounds, 16);
  assert.equal(start.goalTools, 48);
  assert.equal(start.goalRequests, 64);
  assert.equal(start.goalActiveMs, 120000);
  assert.equal(start.task, "");

  for (const action of ["resume", "pause", "cancel", "inspect"]) {
    const parsed = parseArgv(["goal", action, "goal_" + "a".repeat(32), "--json"]);
    assert.equal(parsed.goalAction, action);
    assert.equal(parsed.goalId, "goal_" + "a".repeat(32));
    assert.equal(parsed.json, true);
  }
  const list = parseArgv(["goal", "list", "--json"]);
  assert.equal(list.goalAction, "list");
  assert.equal(list.goalId, null);
  assert.equal(list.json, true);
});

test("malformed goal input is rejected with exit code 2 before any state exists", () => {
  const cases = [
    ["goal"],
    ["goal", "frobnicate"],
    ["goal", "start"],
    ["goal", "start", "objective"],
    ["goal", "list", "extra"],
    ["goal", "resume"],
    ["goal", "resume", "not-an-id"],
    ["goal", "inspect", "goal_" + "a".repeat(32), "extra"],
    ["goal", "list", "--bogus"],
    ["goal", "start", "obj", "--criteria", "c.json", "--rounds", "0"],
    ["goal", "start", "obj", "--criteria", "c.json", "--rounds", "abc"],
    ["goal", "pause", "goal_" + "a".repeat(32), "--criteria", "c.json"],
    ["goal", "list", "--yes"],
    ["goal", "resume", "goal_" + "a".repeat(32), "--rounds", "4"],
  ];
  for (const args of cases) {
    let error = null;
    try {
      parseArgv(args);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `expected ${JSON.stringify(args)} to throw`);
    assert.equal(
      error.exitCode,
      2,
      `expected exitCode 2 for ${JSON.stringify(args)}: ${error.message}`,
    );
  }
});

test("ordinary session resume and existing flag behavior are unchanged", () => {
  const resumed = parseArgv(["--resume", "some task"]);
  assert.equal(resumed.command, "interactive");
  assert.equal(resumed.resume, true);
  assert.equal(resumed.task, "some task");
  assert.equal(resumed.goalAction, null);
  const session = parseArgv(["--session", "abc", "task"]);
  assert.equal(session.sessionId, "abc");
  assert.throws(() => parseArgv(["goal", "list", "--resume"]), /only valid/);
  assert.throws(() => parseArgv(["doctor", "--criteria", "c.json"]), /only valid/);
});

// ---------------------------------------------------------------------------
// Mock provider in its own process (the test process stays responsive)
// ---------------------------------------------------------------------------

const MOCK_SOURCE = `
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
const dir = process.argv[1];
const sse = (o) => "data: " + JSON.stringify(o) + "\\n\\n";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let mode = "text:hi";
    try {
      mode = readFileSync(dir + "/mode", "utf8").trim();
      if (mode.startsWith("seq:")) {
        const steps = JSON.parse(mode.slice(4));
        const step = steps.length > 1 ? steps.shift() : steps[0];
        writeFileSync(dir + "/mode", steps.length > 1 ? "seq:" + JSON.stringify(steps) : step);
        mode = step;
      }
    } catch {}
    if (mode === "hang") return;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode.startsWith("edit")) {
      const edit = JSON.parse(readFileSync(dir + "/edit.json", "utf8"));
      res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "edit", arguments: JSON.stringify(edit) } }] } }] }));
      res.write(sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    } else {
      res.write(sse({ choices: [{ delta: { content: mode.slice(5) }, finish_reason: "stop" }] }));
    }
    res.write("data: [DONE]\\n\\n");
    res.end();
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
`;

/** Start the mock provider child; mode("hang"|"edit"|"text:<s>") drives it. */
function startMockProvider(t) {
  const dir = makeTempDir("matrix-dur006-mock-");
  writeFileSync(join(dir, "mode"), "text:hi");
  const child = spawn(process.execPath, ["--input-type=module", "-e", MOCK_SOURCE, dir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  const port = new Promise((resolve, reject) => {
    let settled = false;
    let line = "";
    child.stdout.on("data", (chunk) => {
      line += chunk;
      const index = line.indexOf("\n");
      if (index >= 0 && !settled) {
        settled = true;
        resolve(Number(line.slice(0, index).trim()));
      }
    });
    child.stderr.on("data", (chunk) => (line += chunk));
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`mock provider exited early (${code}): ${line}`));
    });
    const timer = setTimeout(() => {
      if (!settled) reject(new Error("mock provider did not start"));
    }, 10_000);
    timer.unref();
  });
  return {
    dir,
    port,
    async setMode(mode) {
      writeFileSync(join(dir, "mode"), mode);
    },
    setEdit(path, content) {
      writeFileSync(join(dir, "edit.json"), JSON.stringify({ path, content }));
      writeFileSync(join(dir, "mode"), "edit");
    },
  };
}

function makeFixture(t) {
  const home = makeTempDir("matrix-dur006-home-");
  const workspace = makeTempDir("matrix-dur006-ws-");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.mjs"), INITIAL);
  writeFileSync(
    join(workspace, "criteria.json"),
    JSON.stringify({
      schemaVersion: 1,
      criteria: [{ kind: "artifact", path: "src/a.mjs", sha256: hash(TARGET) }],
    }),
  );
  return { home, workspace };
}

async function addFakeProvider(home, port, { id = "fake", env = "FAKE_GOAL_KEY" } = {}) {
  await addProviderProfile(
    {
      id,
      name: "Fake",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      auth: { type: "bearer", env },
      models: [{ id: `${id}/model-1`, capabilities: { tools: "supported" } }],
    },
    { home },
  );
}

function runCli(args, { cwd = PACKAGE_ROOT, home = undefined, env = {} } = {}) {
  const childEnv = {
    ...process.env,
    NO_COLOR: "1",
    ...(home ? { MATRIX_HOME: home } : {}),
    FAKE_GOAL_KEY: FAKE_KEY,
    ...env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: childEnv,
  });
}

function spawnCli(args, { cwd = PACKAGE_ROOT, home } = {}) {
  return spawn(process.execPath, [BIN, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", MATRIX_HOME: home, FAKE_GOAL_KEY: FAKE_KEY },
  });
}

function collect(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const GOAL_ARGS = [
  "goal",
  "start",
  "Set a to 2",
  "--criteria",
  "criteria.json",
  "--provider",
  "fake",
  "--model",
  "fake/model-1",
];

function listGoals(home, cwd) {
  const result = runCli(["goal", "list", "--json", "-C", cwd], { home });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).goals;
}

function waitForGoal(home, cwd, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const goals = listGoals(home, cwd);
    if (goals.length) return goals[0].id;
    if (Date.now() > deadline) throw new Error("goal was not created in time");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

function waitForLease(home, goalId, timeoutMs = 10_000) {
  const store = createGoalStore(home);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const status = store.inspect(goalId);
      if (status.lease) return status.lease;
    } catch {
      // not yet visible
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the goal lease");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

// ---------------------------------------------------------------------------
// Subprocess behavior
// ---------------------------------------------------------------------------

test(
  "goal start runs the accepted runtime to completion against the mock provider",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    mock.setEdit("src/a.mjs", TARGET);
    // First provider round proposes the edit; later rounds answer with text so
    // the executor re-evaluates the artifact criterion and completes.
    writeFileSync(join(mock.dir, "mode"), `seq:["edit","text:done"]`);

    const first = runCli([...GOAL_ARGS, "--yes", "-C", workspace], { home });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Goal completed/);
    assert.match(first.stdout, /State completed · generation 1/);
    assert.match(first.stdout, /Remaining criteria 0 of 1/);
    assert.match(first.stdout, /Remaining budget \d+ rounds · \d+ tools · \d+ requests · \d+ ms/);
    assert.match(first.stdout, /Last operation edit · succeeded/);
    assert.match(first.stdout, /Next command: matrix goal inspect goal_[a-f0-9]{32}/);
    assert.equal(readFileSync(join(workspace, "src", "a.mjs"), "utf8"), TARGET);
    assert.doesNotMatch(first.stdout + first.stderr, /fake-goal-key/);
  },
);

test(
  "headless start without --yes denies the edit and stops honestly at needs-attention",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    mock.setEdit("src/a.mjs", TARGET);

    const result = runCli([...GOAL_ARGS, "-C", workspace], { home });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /State needs-attention/);
    assert.match(result.stdout, /Remaining criteria 1 of 1/);
    assert.match(result.stdout, /Next command: matrix goal resume goal_[a-f0-9]{32}/);
    assert.equal(
      readFileSync(join(workspace, "src", "a.mjs"), "utf8"),
      INITIAL,
      "denied edit wrote nothing",
    );
    const goals = listGoals(home, workspace);
    assert.equal(goals.length, 1);
    assert.equal(goals[0].state, "needs-attention");
  },
);

test("list and inspect are read-only and never print credentials", linux, async (t) => {
  const { home, workspace } = makeFixture(t);
  const mock = startMockProvider(t);
  const port = await mock.port;
  await addFakeProvider(home, port);
  mock.setEdit("src/a.mjs", TARGET);
  const started = runCli([...GOAL_ARGS, "--yes", "-C", workspace], { home });
  assert.equal(started.status, 0, started.stderr);
  const goalId = listGoals(home, workspace)[0].id;

  const snapshot = (root) => {
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(`${full}:${hash(readFileSync(full))}`);
      }
    };
    walk(root);
    return out;
  };
  const beforeStore = snapshot(join(home, "goals"));
  const beforeWorkspace = readFileSync(join(workspace, "src", "a.mjs"), "utf8");

  const list = runCli(["goal", "list", "-C", workspace], { home });
  const listJson = runCli(["goal", "list", "--json", "-C", workspace], { home });
  const inspect = runCli(["goal", "inspect", goalId, "-C", workspace], { home });
  const inspectJson = runCli(["goal", "inspect", goalId, "--json", "-C", workspace], { home });
  for (const result of [list, listJson, inspect, inspectJson]) {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /fake-goal-key/);
  }
  assert.match(inspect.stdout, /State completed/);
  assert.match(inspect.stdout, /Next command: matrix goal inspect/);
  const parsed = JSON.parse(inspectJson.stdout);
  assert.equal(parsed.goalId, goalId);
  assert.equal(parsed.state, "completed");
  assert.ok(Array.isArray(parsed.criteria));
  assert.ok(parsed.remaining && typeof parsed.remaining.rounds === "number");
  assert.ok(parsed.lastOperation && parsed.lastOperation.status === "succeeded");
  assert.ok(parsed.nextCommand.includes("matrix goal inspect"));

  assert.deepEqual(snapshot(join(home, "goals")), beforeStore, "list/inspect mutated the store");
  assert.equal(readFileSync(join(workspace, "src", "a.mjs"), "utf8"), beforeWorkspace);
});

test(
  "invalid flags, ids, unknown goals, bad criteria and missing keys all exit 2 without creating state",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);

    const bad = [
      ["goal", "list", "--bogus", "-C", workspace],
      ["goal", "inspect", "bogus", "-C", workspace],
      ["goal", "inspect", "goal_" + "a".repeat(32), "-C", workspace], // unknown
      ["goal", "pause", "goal_" + "b".repeat(32), "-C", workspace], // unknown
      ["goal", "start", "obj", "-C", workspace], // missing --criteria
      [
        "goal",
        "start",
        "obj",
        "--criteria",
        "missing.json",
        "--provider",
        "fake",
        "--model",
        "fake/model-1",
        "-C",
        workspace,
      ],
      [
        "goal",
        "start",
        "obj",
        "--criteria",
        "criteria.json",
        "--model",
        "nosuchmodel",
        "-C",
        workspace,
      ],
      [
        "goal",
        "start",
        "obj",
        "--criteria",
        "criteria.json",
        "--provider",
        "fake",
        "--model",
        "fake/model-1",
        "--rounds",
        "999",
        "-C",
        workspace,
      ],
    ];
    for (const args of bad) {
      const result = runCli(args, { home });
      assert.equal(
        result.status,
        2,
        `${JSON.stringify(args)} -> ${result.status}: ${result.stderr}`,
      );
    }
    assert.equal(listGoals(home, workspace).length, 0, "refusals must not create goals");

    const malformed = [
      "not json",
      JSON.stringify({ schemaVersion: 2, criteria: [] }),
      JSON.stringify({ schemaVersion: 1, criteria: [] }),
      JSON.stringify({
        schemaVersion: 1,
        criteria: [{ kind: "artifact", path: "src/a.mjs", sha256: "xyz" }],
      }),
      JSON.stringify({ schemaVersion: 1, criteria: [{ kind: "wat" }] }),
      JSON.stringify({
        schemaVersion: 1,
        criteria: [{ kind: "artifact", path: "../escape", sha256: hash(TARGET) }],
      }),
    ];
    for (const [index, content] of malformed.entries()) {
      const file = join(workspace, `bad-${index}.json`);
      writeFileSync(file, content);
      const result = runCli(
        [
          "goal",
          "start",
          "obj",
          "--criteria",
          `bad-${index}.json`,
          "--provider",
          "fake",
          "--model",
          "fake/model-1",
          "-C",
          workspace,
        ],
        { home },
      );
      assert.equal(result.status, 2, `malformed criteria ${index}: ${result.stderr}`);
    }
    assert.equal(listGoals(home, workspace).length, 0);

    // Missing provider key fails honestly before any goal exists, no network.
    const noKey = runCli([...GOAL_ARGS, "--yes", "-C", workspace], {
      home,
      env: { FAKE_GOAL_KEY: undefined },
    });
    assert.equal(noKey.status, 2, noKey.stderr);
    assert.match(noKey.stderr + noKey.stdout, /key|credential|requires/i);
    assert.doesNotMatch(noKey.stdout + noKey.stderr, /fake-goal-key/);
    assert.equal(listGoals(home, workspace).length, 0);
  },
);

test("explicit budget limits are validated against the frozen maximum", linux, async (t) => {
  const { home, workspace } = makeFixture(t);
  const mock = startMockProvider(t);
  const port = await mock.port;
  await addFakeProvider(home, port);
  const ok = runCli([...GOAL_ARGS, "--yes", "--rounds", "16", "--tools", "48", "-C", workspace], {
    home,
  });
  assert.equal(ok.status, 1, ok.stderr); // no tools proposed -> needs-attention
  const goalId = listGoals(home, workspace)[0].id;
  const store = createGoalStore(home);
  const budget = store.inspect(goalId).goal.budget;
  assert.equal(budget.rounds, 16);
  assert.equal(budget.tools, 48);
  assert.equal(budget.requests, 32, "unspecified dimensions keep the frozen default");
  const over = runCli([...GOAL_ARGS, "--active-ms", String(86_400_000 + 1), "-C", workspace], {
    home,
  });
  assert.equal(over.status, 2, over.stderr);
});

// ---------------------------------------------------------------------------
// Interruption, restart, pause/cancel and workspace changes
// ---------------------------------------------------------------------------

test(
  "SIGKILL mid-run leaves durable state; a fresh process resumes and completes without resetting budget",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    mock.setEdit("src/a.mjs", TARGET);
    await mock.setMode("hang");

    const first = spawnCli([...GOAL_ARGS, "--yes", "-C", workspace], { home, cwd: workspace });
    const firstOut = collect(first);
    const goalId = waitForGoal(home, workspace);
    waitForLease(home, goalId);
    const store = createGoalStore(home);
    const beforeKill = store.inspect(goalId);
    assert.ok(beforeKill.lease, "an attempt owns the lease while running");
    first.kill("SIGKILL");
    const killed = await firstOut;
    assert.equal(killed.signal, "SIGKILL");

    await mock.setMode(`seq:["edit","text:done"]`);
    const resumed = runCli(["goal", "resume", goalId, "--yes", "-C", workspace], { home });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /State completed/);
    assert.equal(readFileSync(join(workspace, "src", "a.mjs"), "utf8"), TARGET);
    const after = store.inspect(goalId);
    assert.ok(
      after.goal.generation > beforeKill.goal.generation,
      "a new attempt advanced the generation",
    );
    assert.ok(
      after.counters.used.requests >= beforeKill.counters.used.requests,
      "the persisted ledger is monotonic across restart",
    );
    assert.ok(after.counters.used.tools >= 1);
    const view = JSON.parse(
      runCli(["goal", "inspect", goalId, "--json", "-C", workspace], { home }).stdout,
    );
    assert.equal(view.state, "completed");
    assert.equal(
      view.nextCommand.includes("matrix goal inspect"),
      true,
      "inspect points at the read-only command",
    );
  },
);

test("SIGINT interrupts with exit 130 and leaves the goal resumable", linux, async (t) => {
  const { home, workspace } = makeFixture(t);
  const mock = startMockProvider(t);
  const port = await mock.port;
  await addFakeProvider(home, port);
  mock.setEdit("src/a.mjs", TARGET);
  await mock.setMode("hang");

  const child = spawnCli([...GOAL_ARGS, "--yes", "-C", workspace], { home, cwd: workspace });
  const out = collect(child);
  const goalId = waitForGoal(home, workspace);
  waitForLease(home, goalId);
  child.kill("SIGINT");
  const result = await out;
  assert.equal(
    result.code,
    130,
    `expected 130, got ${result.code} ${result.signal}: ${result.stderr}`,
  );
  const state = createGoalStore(home).inspect(goalId).goal.state;
  assert.ok(
    ["paused", "running", "interrupted", "awaiting-approval"].includes(state),
    `state ${state}`,
  );

  // A fresh resume finishes the goal once the provider answers.
  await mock.setMode(`seq:["edit","text:done"]`);
  const resumed = runCli(["goal", "resume", goalId, "--yes", "-C", workspace], { home });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /State completed/);
});

test(
  "pause and cancel travel through the verified owner channel while an attempt runs",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);

    // Create a stopped goal first (text only -> needs-attention).
    await mock.setMode("text:thinking");
    const created = runCli([...GOAL_ARGS, "-C", workspace], { home });
    assert.equal(created.status, 1, created.stderr);
    const goalId = listGoals(home, workspace)[0].id;

    // Resume with a hanging provider so an attempt is live, then pause it from
    // a separate process through the verified owner channel.
    await mock.setMode("hang");
    const runner = spawnCli(["goal", "resume", goalId, "--yes", "-C", workspace], {
      home,
      cwd: workspace,
    });
    const runnerOut = collect(runner);
    waitForLease(home, goalId);
    const paused = runCli(["goal", "pause", goalId, "-C", workspace], { home });
    assert.equal(paused.status, 0, paused.stderr);
    assert.match(paused.stdout, /pause requested/);
    const stopped = await runnerOut;
    assert.notEqual(stopped.code, 0);
    const afterPause = createGoalStore(home).inspect(goalId).goal.state;
    assert.equal(afterPause, "paused", `state after pause: ${afterPause}`);

    // Pause on a stopped goal refuses with exit 2.
    const again = runCli(["goal", "pause", goalId, "-C", workspace], { home });
    assert.equal(again.status, 2, again.stderr);

    // Resume again with a hanging provider, then cancel from another process.
    const runner2 = spawnCli(["goal", "resume", goalId, "--yes", "-C", workspace], {
      home,
      cwd: workspace,
    });
    const runner2Out = collect(runner2);
    waitForLease(home, goalId);
    const cancelled = runCli(["goal", "cancel", goalId, "--json", "-C", workspace], { home });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /cancel requested|"accepted"/);
    await runner2Out;
    const afterCancel = createGoalStore(home).inspect(goalId).goal.state;
    assert.equal(afterCancel, "cancelled", `state after cancel: ${afterCancel}`);
    const refused = runCli(["goal", "resume", goalId, "--yes", "-C", workspace], { home });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr + refused.stdout, /cancelled/);
  },
);

test(
  "a replaced workspace directory refuses resume; a rename of the same directory resumes",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    await mock.setMode("text:thinking");
    const created = runCli([...GOAL_ARGS, "-C", workspace], { home });
    assert.equal(created.status, 1, created.stderr);
    const goalId = listGoals(home, workspace)[0].id;

    // Replace the workspace with a fresh directory at the same path.
    const old = `${workspace}-old`;
    renameSync(workspace, old);
    t.after(() => rmSync(old, { recursive: true, force: true }));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.mjs"), INITIAL);
    const replaced = runCli(["goal", "resume", goalId, "--yes", "-C", workspace], { home });
    assert.equal(replaced.status, 2, replaced.stderr);
    assert.match(replaced.stderr + replaced.stdout, /workspace/i);
    assert.equal(listGoals(home, workspace).length, 0, "the replacement workspace has no goals");
    const inspect = runCli(["goal", "inspect", goalId, "-C", old], { home });
    assert.equal(inspect.status, 0, inspect.stderr);

    // A pure rename keeps the device/inode identity, so resume works there.
    const renamed = `${workspace}-renamed`;
    renameSync(old, renamed);
    t.after(() => rmSync(renamed, { recursive: true, force: true }));
    mock.setEdit("src/a.mjs", TARGET);
    await mock.setMode(`seq:["edit","text:done"]`);
    const resumed = runCli(["goal", "resume", goalId, "--yes", "-C", renamed], { home });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /State completed/);
    assert.equal(readFileSync(join(renamed, "src", "a.mjs"), "utf8"), TARGET);
  },
);

test(
  "resume of a live attempt refuses with exit 2 and names the control commands",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    await mock.setMode("hang");
    const runner = spawnCli([...GOAL_ARGS, "--yes", "-C", workspace], { home, cwd: workspace });
    const out = collect(runner);
    const goalId = waitForGoal(home, workspace);
    waitForLease(home, goalId);
    const second = runCli(["goal", "resume", goalId, "--yes", "-C", workspace], { home });
    assert.equal(second.status, 2, second.stderr);
    assert.match(second.stderr + second.stdout, /resume refused|lease/i);
    assert.match(second.stderr + second.stdout, /matrix goal (pause|cancel)/);
    runner.kill("SIGKILL");
    await out;
  },
);

// ---------------------------------------------------------------------------
// Workspace mismatch guidance, quoting and redaction
// ---------------------------------------------------------------------------

function seedWorkspace(workspace) {
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "a.mjs"), INITIAL);
  writeFileSync(
    join(workspace, "criteria.json"),
    JSON.stringify({
      schemaVersion: 1,
      criteria: [{ kind: "artifact", path: "src/a.mjs", sha256: hash(TARGET) }],
    }),
  );
}

test(
  "a foreign directory names the recorded workspace and never targets a replacement",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    await mock.setMode("text:thinking");
    const created = runCli([...GOAL_ARGS, "-C", workspace], { home });
    assert.equal(created.status, 1, created.stderr);
    const goalId = listGoals(home, workspace)[0].id;
    const other = makeTempDir("matrix-dur006-other-");
    t.after(() => rmSync(other, { recursive: true, force: true }));
    const checkpoint = join(home, "goals", goalId, "checkpoint.json");
    const quoted = "'" + workspace.replaceAll("'", "'\"'\"'") + "'";
    const before = readFileSync(checkpoint);

    // While the recorded directory is intact, the continuation uses that path.
    const viewed = runCli(["goal", "inspect", goalId, "--json", "-C", other], { home });
    assert.equal(viewed.status, 0, viewed.stderr);
    const view = JSON.parse(viewed.stdout);
    assert.ok(view.reason.includes(workspace), view.reason);
    assert.equal(view.nextCommand, `matrix goal resume ${goalId} --cwd ${quoted}`);

    const terminal = runCli(["goal", "inspect", goalId, "-C", other], { home });
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.match(stripAnsi(terminal.stdout), /Next command: matrix goal resume .* --cwd/);

    const refused = runCli(["goal", "resume", goalId, "--yes", "-C", other], { home });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /recorded workspace/);
    assert.ok(refused.stderr.includes(`--cwd ${quoted}`), refused.stderr);
    assert.deepEqual(readFileSync(checkpoint), before, "refusal changed the checkpoint");

    // The recorded directory moved: the old path no longer resolves.
    const moved = `${workspace}-moved`;
    renameSync(workspace, moved);
    t.after(() => rmSync(moved, { recursive: true, force: true }));
    const missing = JSON.parse(
      runCli(["goal", "inspect", goalId, "--json", "-C", other], { home }).stdout,
    );
    assert.match(missing.reason, /missing or has been replaced/);
    assert.ok(missing.reason.includes(workspace), missing.reason);
    assert.equal(missing.nextCommand, `matrix goal inspect ${goalId}`);
    assert.ok(!missing.nextCommand.includes("resume"), missing.nextCommand);

    // A replacement directory at the recorded path must never be resumed.
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "a.mjs"), INITIAL);
    const replacement = JSON.parse(
      runCli(["goal", "inspect", goalId, "--json", "-C", workspace], { home }).stdout,
    );
    assert.match(replacement.reason, /missing or has been replaced/);
    assert.equal(replacement.nextCommand, `matrix goal inspect ${goalId}`);
    const replacementResume = runCli(["goal", "resume", goalId, "--yes", "-C", workspace], {
      home,
    });
    assert.equal(replacementResume.status, 2, replacementResume.stderr);
    assert.match(replacementResume.stderr, /matrix goal list --cwd/);
    assert.ok(
      !replacementResume.stderr.includes(`matrix goal resume ${goalId} --cwd`),
      replacementResume.stderr,
    );

    // The moved directory is still the recorded workspace and recovers.
    mock.setEdit("src/a.mjs", TARGET);
    await mock.setMode(`seq:["edit","text:done"]`);
    const resumed = runCli(["goal", "resume", goalId, "--yes", "-C", moved], { home });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(readFileSync(join(moved, "src", "a.mjs"), "utf8"), TARGET);
  },
);

test("recorded workspace continuations are shell-quoted and redacted", linux, async (t) => {
  const mock = startMockProvider(t);
  const port = await mock.port;
  await mock.setMode("text:thinking");
  const other = makeTempDir("matrix-dur006-quote-other-");
  t.after(() => rmSync(other, { recursive: true, force: true }));

  // A workspace path containing a single quote must arrive as one shell argument.
  const quoteBase = makeTempDir("matrix-dur006-quote-");
  t.after(() => rmSync(quoteBase, { recursive: true, force: true }));
  const quotedWorkspace = join(quoteBase, "work's");
  const quoteHome = makeTempDir("matrix-dur006-quote-home-");
  t.after(() => rmSync(quoteHome, { recursive: true, force: true }));
  await addFakeProvider(quoteHome, port);
  seedWorkspace(quotedWorkspace);
  const created = runCli([...GOAL_ARGS, "-C", quotedWorkspace], { home: quoteHome });
  assert.equal(created.status, 1, created.stderr);
  const goalId = listGoals(quoteHome, quotedWorkspace)[0].id;
  const view = JSON.parse(
    runCli(["goal", "inspect", goalId, "--json", "-C", other], { home: quoteHome }).stdout,
  );
  const expectedPath = "'" + quotedWorkspace.replaceAll("'", "'\"'\"'") + "'";
  assert.equal(view.nextCommand, `matrix goal resume ${goalId} --cwd ${expectedPath}`);

  const binDir = join(quoteBase, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "matrix");
  writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n');
  chmodSync(stub, 0o755);
  const executed = spawnSync("bash", ["-c", view.nextCommand], {
    cwd: other,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.ok(
    executed.stdout.split("\n").includes(quotedWorkspace),
    `quoted path was split: ${executed.stdout}`,
  );

  // A workspace path containing the credential is never printed or quoted.
  const secretBase = makeTempDir("matrix-dur006-secret-");
  t.after(() => rmSync(secretBase, { recursive: true, force: true }));
  const secretWorkspace = join(secretBase, `ws-${FAKE_KEY}`);
  const secretHome = makeTempDir("matrix-dur006-secret-home-");
  t.after(() => rmSync(secretHome, { recursive: true, force: true }));
  await addFakeProvider(secretHome, port);
  seedWorkspace(secretWorkspace);
  const secretCreated = runCli([...GOAL_ARGS, "-C", secretWorkspace], { home: secretHome });
  assert.equal(secretCreated.status, 1, secretCreated.stderr);
  const secretGoal = listGoals(secretHome, secretWorkspace)[0].id;
  const secretView = JSON.parse(
    runCli(["goal", "inspect", secretGoal, "--json", "-C", other], { home: secretHome }).stdout,
  );
  assert.equal(secretView.nextCommand, `matrix goal resume ${secretGoal}`);
  assert.ok(!JSON.stringify(secretView).includes(FAKE_KEY));
  assert.ok(!(secretCreated.stdout + secretCreated.stderr).includes(FAKE_KEY));
});

test(
  "finding R1: workspace path credential redaction and custom auth.env resolution",
  linux,
  async (t) => {
    const mock = startMockProvider(t);
    const port = await mock.port;
    await mock.setMode("text:thinking");
    const other = makeTempDir("matrix-dur006-r1-other-");
    t.after(() => rmSync(other, { recursive: true, force: true }));

    const shellEscape = (val) => val.replaceAll("'", "'\"'\"'");

    // Control: safe path containing an apostrophe without credentials preserves copyable commands
    const controlBase = makeTempDir("matrix-dur006-r1-control-");
    t.after(() => rmSync(controlBase, { recursive: true, force: true }));
    const controlWorkspace = join(controlBase, "safe'work'space");
    const controlHome = makeTempDir("matrix-dur006-r1-control-home-");
    t.after(() => rmSync(controlHome, { recursive: true, force: true }));
    await addFakeProvider(controlHome, port);
    seedWorkspace(controlWorkspace);
    const controlStart = runCli([...GOAL_ARGS, "-C", controlWorkspace], { home: controlHome });
    assert.equal(controlStart.status, 1, controlStart.stderr);
    const controlGoalId = listGoals(controlHome, controlWorkspace)[0].id;
    const controlExpected = `'${shellEscape(controlWorkspace)}'`;

    // Control inspect (JSON)
    const controlInspectJson = runCli(["goal", "inspect", controlGoalId, "--json", "-C", other], {
      home: controlHome,
    });
    assert.equal(controlInspectJson.status, 0, controlInspectJson.stderr);
    const controlView = JSON.parse(controlInspectJson.stdout);
    assert.ok(controlView.reason.includes(controlExpected), controlView.reason);
    assert.equal(
      controlView.nextCommand,
      `matrix goal resume ${controlGoalId} --cwd ${controlExpected}`,
    );

    // Control inspect (terminal)
    const controlInspectTerm = runCli(["goal", "inspect", controlGoalId, "-C", other], {
      home: controlHome,
    });
    assert.equal(controlInspectTerm.status, 0, controlInspectTerm.stderr);
    assert.ok(
      stripAnsi(controlInspectTerm.stdout)
        .replace(/\s+/g, " ")
        .includes(`--cwd ${controlExpected}`),
      controlInspectTerm.stdout,
    );

    // Control resume refusal (JSON)
    const controlResumeJson = runCli(
      ["goal", "resume", controlGoalId, "--yes", "--json", "-C", other],
      { home: controlHome },
    );
    assert.equal(controlResumeJson.status, 2, controlResumeJson.stderr);
    const controlRefusal = JSON.parse(controlResumeJson.stdout);
    assert.equal(controlRefusal.result, "refused");
    assert.ok(controlRefusal.reason.includes(`--cwd ${controlExpected}`), controlRefusal.reason);

    // Control resume refusal (terminal)
    const controlResumeTerm = runCli(["goal", "resume", controlGoalId, "--yes", "-C", other], {
      home: controlHome,
    });
    assert.equal(controlResumeTerm.status, 2);
    assert.ok(
      stripAnsi(controlResumeTerm.stderr).includes(`--cwd ${controlExpected}`),
      controlResumeTerm.stderr,
    );

    // Case 1: Custom auth.env name (e.g. FOO) with ordinary fake credential
    const customEnvName = "FOO";
    const customCred = "n4m3l3ssV4lu3";
    const customEscaped = shellEscape(customCred);
    const customBase = makeTempDir("matrix-dur006-r1-custom-");
    t.after(() => rmSync(customBase, { recursive: true, force: true }));
    const customWorkspace = join(customBase, `ws-${customCred}`);
    const customHome = makeTempDir("matrix-dur006-r1-custom-home-");
    t.after(() => rmSync(customHome, { recursive: true, force: true }));
    await addFakeProvider(customHome, port, { id: "customprov", env: customEnvName });
    seedWorkspace(customWorkspace);
    const customEnv = { [customEnvName]: customCred };
    const customStart = runCli(
      [
        "goal",
        "start",
        "Set a to 2",
        "--criteria",
        "criteria.json",
        "--provider",
        "customprov",
        "--model",
        "customprov/model-1",
        "-C",
        customWorkspace,
      ],
      { home: customHome, env: customEnv },
    );
    assert.equal(customStart.status, 1, customStart.stderr);
    const customGoalId = listGoals(customHome, customWorkspace)[0].id;

    // Case 1: inspect (JSON)
    const customInspectJson = runCli(["goal", "inspect", customGoalId, "--json", "-C", other], {
      home: customHome,
      env: customEnv,
    });
    assert.equal(customInspectJson.status, 0, customInspectJson.stderr);
    assert.ok(!customInspectJson.stdout.includes(customCred), "raw credential in inspect JSON");
    assert.ok(
      !customInspectJson.stdout.includes(customEscaped),
      "escaped credential in inspect JSON",
    );
    assert.ok(!customInspectJson.stderr.includes(customCred));
    assert.ok(!customInspectJson.stderr.includes(customEscaped));
    const customView = JSON.parse(customInspectJson.stdout);
    assert.equal(customView.nextCommand, `matrix goal resume ${customGoalId}`);
    assert.ok(customView.reason.includes("[redacted]"));
    assert.ok(customView.reason.includes("recorded workspace"));

    // Case 1: inspect (terminal)
    const customInspectTerm = runCli(["goal", "inspect", customGoalId, "-C", other], {
      home: customHome,
      env: customEnv,
    });
    assert.equal(customInspectTerm.status, 0, customInspectTerm.stderr);
    assert.ok(
      !customInspectTerm.stdout.includes(customCred),
      "raw credential in inspect terminal stdout",
    );
    assert.ok(
      !customInspectTerm.stdout.includes(customEscaped),
      "escaped credential in inspect terminal stdout",
    );
    assert.ok(!customInspectTerm.stderr.includes(customCred));
    assert.ok(!customInspectTerm.stderr.includes(customEscaped));
    assert.ok(stripAnsi(customInspectTerm.stdout).includes("[redacted]"));
    assert.ok(stripAnsi(customInspectTerm.stdout).includes(`matrix goal resume ${customGoalId}`));
    assert.ok(!stripAnsi(customInspectTerm.stdout).includes("--cwd"));

    // Case 1: resume refusal (JSON)
    const customResumeJson = runCli(
      ["goal", "resume", customGoalId, "--yes", "--json", "-C", other],
      { home: customHome, env: customEnv },
    );
    assert.equal(customResumeJson.status, 2, customResumeJson.stderr);
    assert.ok(
      !customResumeJson.stdout.includes(customCred),
      "raw credential in resume refusal JSON",
    );
    assert.ok(
      !customResumeJson.stdout.includes(customEscaped),
      "escaped credential in resume refusal JSON",
    );
    assert.ok(!customResumeJson.stderr.includes(customCred));
    assert.ok(!customResumeJson.stderr.includes(customEscaped));
    const customRefusal = JSON.parse(customResumeJson.stdout);
    assert.equal(customRefusal.result, "refused");
    assert.ok(customRefusal.reason.includes("recorded workspace"));
    assert.ok(customRefusal.reason.includes(`matrix goal resume ${customGoalId}`));
    assert.ok(!customRefusal.reason.includes("--cwd"));

    // Case 1: resume refusal (terminal)
    const customResumeTerm = runCli(["goal", "resume", customGoalId, "--yes", "-C", other], {
      home: customHome,
      env: customEnv,
    });
    assert.equal(customResumeTerm.status, 2);
    assert.ok(!customResumeTerm.stdout.includes(customCred));
    assert.ok(!customResumeTerm.stdout.includes(customEscaped));
    assert.ok(
      !customResumeTerm.stderr.includes(customCred),
      "raw credential in resume refusal stderr",
    );
    assert.ok(
      !customResumeTerm.stderr.includes(customEscaped),
      "escaped credential in resume refusal stderr",
    );
    assert.ok(stripAnsi(customResumeTerm.stderr).includes("recorded workspace"));
    assert.ok(stripAnsi(customResumeTerm.stderr).includes(`matrix goal resume ${customGoalId}`));
    assert.ok(!stripAnsi(customResumeTerm.stderr).includes("--cwd"));

    // Case 2: Credential containing an apostrophe
    const quoteCred = "q7z'k3x9pw2mf4t";
    const quoteEscaped = shellEscape(quoteCred);
    const quoteBase2 = makeTempDir("matrix-dur006-r1-quotecred-");
    t.after(() => rmSync(quoteBase2, { recursive: true, force: true }));
    const quoteWorkspace2 = join(quoteBase2, `ws-${quoteCred}`);
    const quoteHome2 = makeTempDir("matrix-dur006-r1-quotecred-home-");
    t.after(() => rmSync(quoteHome2, { recursive: true, force: true }));
    await addFakeProvider(quoteHome2, port, { id: "quoteprov", env: "STUB_KEY" });
    seedWorkspace(quoteWorkspace2);
    const quoteEnv = { STUB_KEY: quoteCred };
    const quoteStart = runCli(
      [
        "goal",
        "start",
        "Set a to 2",
        "--criteria",
        "criteria.json",
        "--provider",
        "quoteprov",
        "--model",
        "quoteprov/model-1",
        "-C",
        quoteWorkspace2,
      ],
      { home: quoteHome2, env: quoteEnv },
    );
    assert.equal(quoteStart.status, 1, quoteStart.stderr);
    const quoteGoalId = listGoals(quoteHome2, quoteWorkspace2)[0].id;

    // Case 2: inspect (JSON)
    const quoteInspectJson = runCli(["goal", "inspect", quoteGoalId, "--json", "-C", other], {
      home: quoteHome2,
      env: quoteEnv,
    });
    assert.equal(quoteInspectJson.status, 0, quoteInspectJson.stderr);
    assert.ok(!quoteInspectJson.stdout.includes(quoteCred), "raw quote credential in inspect JSON");
    assert.ok(
      !quoteInspectJson.stdout.includes(quoteEscaped),
      "escaped quote credential in inspect JSON",
    );
    assert.ok(!quoteInspectJson.stderr.includes(quoteCred));
    assert.ok(!quoteInspectJson.stderr.includes(quoteEscaped));
    const quoteView = JSON.parse(quoteInspectJson.stdout);
    assert.equal(quoteView.nextCommand, `matrix goal resume ${quoteGoalId}`);
    assert.ok(quoteView.reason.includes("[redacted]"));
    assert.ok(quoteView.reason.includes("recorded workspace"));

    // Case 2: inspect (terminal)
    const quoteInspectTerm = runCli(["goal", "inspect", quoteGoalId, "-C", other], {
      home: quoteHome2,
      env: quoteEnv,
    });
    assert.equal(quoteInspectTerm.status, 0, quoteInspectTerm.stderr);
    assert.ok(
      !quoteInspectTerm.stdout.includes(quoteCred),
      "raw quote credential in inspect terminal stdout",
    );
    assert.ok(
      !quoteInspectTerm.stdout.includes(quoteEscaped),
      "escaped quote credential in inspect terminal stdout",
    );
    assert.ok(!quoteInspectTerm.stderr.includes(quoteCred));
    assert.ok(!quoteInspectTerm.stderr.includes(quoteEscaped));
    assert.ok(stripAnsi(quoteInspectTerm.stdout).includes("[redacted]"));
    assert.ok(stripAnsi(quoteInspectTerm.stdout).includes(`matrix goal resume ${quoteGoalId}`));
    assert.ok(!stripAnsi(quoteInspectTerm.stdout).includes("--cwd"));

    // Case 2: resume refusal (JSON)
    const quoteResumeJson = runCli(
      ["goal", "resume", quoteGoalId, "--yes", "--json", "-C", other],
      { home: quoteHome2, env: quoteEnv },
    );
    assert.equal(quoteResumeJson.status, 2, quoteResumeJson.stderr);
    assert.ok(
      !quoteResumeJson.stdout.includes(quoteCred),
      "raw quote credential in resume refusal JSON",
    );
    assert.ok(
      !quoteResumeJson.stdout.includes(quoteEscaped),
      "escaped quote credential in resume refusal JSON",
    );
    assert.ok(!quoteResumeJson.stderr.includes(quoteCred));
    assert.ok(!quoteResumeJson.stderr.includes(quoteEscaped));
    const quoteRefusal = JSON.parse(quoteResumeJson.stdout);
    assert.equal(quoteRefusal.result, "refused");
    assert.ok(quoteRefusal.reason.includes("recorded workspace"));
    assert.ok(quoteRefusal.reason.includes(`matrix goal resume ${quoteGoalId}`));
    assert.ok(!quoteRefusal.reason.includes("--cwd"));

    // Case 2: resume refusal (terminal)
    const quoteResumeTerm = runCli(["goal", "resume", quoteGoalId, "--yes", "-C", other], {
      home: quoteHome2,
      env: quoteEnv,
    });
    assert.equal(quoteResumeTerm.status, 2);
    assert.ok(!quoteResumeTerm.stdout.includes(quoteCred));
    assert.ok(!quoteResumeTerm.stdout.includes(quoteEscaped));
    assert.ok(
      !quoteResumeTerm.stderr.includes(quoteCred),
      "raw quote credential in resume refusal stderr",
    );
    assert.ok(
      !quoteResumeTerm.stderr.includes(quoteEscaped),
      "escaped quote credential in resume refusal stderr",
    );
    assert.ok(stripAnsi(quoteResumeTerm.stderr).includes("recorded workspace"));
    assert.ok(stripAnsi(quoteResumeTerm.stderr).includes(`matrix goal resume ${quoteGoalId}`));
    assert.ok(!stripAnsi(quoteResumeTerm.stderr).includes("--cwd"));
  },
);

// ---------------------------------------------------------------------------
// Refused control against a stale owner
// ---------------------------------------------------------------------------

test(
  "pause and cancel against a dead owner exit 2 with recovery guidance and no state change",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    await mock.setMode("hang");
    const runner = spawnCli([...GOAL_ARGS, "--yes", "-C", workspace], { home, cwd: workspace });
    const out = collect(runner);
    const goalId = waitForGoal(home, workspace);
    const lease = waitForLease(home, goalId);
    process.kill(lease.owner.pid, "SIGKILL");
    runner.kill("SIGKILL");
    await out;

    const checkpoint = join(home, "goals", goalId, "checkpoint.json");
    const journal = join(home, "goals", goalId, "journal.jsonl");
    const before = { checkpoint: readFileSync(checkpoint), journal: readFileSync(journal) };

    const pause = runCli(["goal", "pause", goalId, "--json", "-C", workspace], { home });
    assert.equal(pause.status, 2, pause.stderr);
    const pauseView = JSON.parse(pause.stdout);
    assert.equal(pauseView.result, "refused");
    assert.match(pauseView.reason, /no verified live owner/);
    assert.ok(pauseView.reason.includes(`matrix goal resume ${goalId}`), pauseView.reason);

    const cancel = runCli(["goal", "cancel", goalId, "--json", "-C", workspace], { home });
    assert.equal(cancel.status, 2, cancel.stderr);
    const cancelView = JSON.parse(cancel.stdout);
    assert.equal(cancelView.result, "refused");
    assert.ok(cancelView.reason.includes(`matrix goal resume ${goalId}`), cancelView.reason);

    assert.deepEqual(readFileSync(checkpoint), before.checkpoint, "refusal changed the checkpoint");
    assert.deepEqual(readFileSync(journal), before.journal, "refusal changed the journal");
    const state = JSON.parse(
      runCli(["goal", "inspect", goalId, "--json", "-C", workspace], { home }).stdout,
    );
    assert.equal(state.state, "running", "the refused control changed the goal state");

    // The suggested recovery reclaims the dead owner and completes.
    mock.setEdit("src/a.mjs", TARGET);
    await mock.setMode(`seq:["edit","text:done"]`);
    const resumed = runCli(["goal", "resume", goalId, "--yes", "-C", workspace], { home });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(readFileSync(join(workspace, "src", "a.mjs"), "utf8"), TARGET);
  },
);

/** Rewrite the checkpoint with a forged lease owner, keeping the byte contract intact. */
function forgeLeaseOwner(checkpointPath, owner) {
  const { checksum, ...body } = JSON.parse(readFileSync(checkpointPath, "utf8"));
  const forged = { ...body, lease: { ...body.lease, owner } };
  writeFileSync(
    checkpointPath,
    canonicalJson({ ...forged, checksum: hash(canonicalJson(forged)) }),
  );
}

/**
 * Wait until the live owner has dispatched the provider and has stopped
 * rewriting the checkpoint.
 *
 * The owner writes the checkpoint when it acquires the lease and again when it
 * dispatches the provider. A lease forged before those writes finish can be
 * replaced by a legitimate write between the forge and the control request,
 * and the control request is then answered by the real, live owner instead of
 * being refused. The dispatch record is the owner's own signal that it is
 * blocked on the provider, and the checkpoint counts as settled only once it
 * has stopped changing.
 */
function waitForOwnerSettled(home, goalId, checkpointPath, timeoutMs = 10_000) {
  const store = createGoalStore(home);
  const deadline = Date.now() + timeoutMs;
  let dispatched = false;
  let last = null;
  let settledSince = Date.now();
  for (;;) {
    try {
      if (!dispatched) {
        dispatched = store
          .readJournal(goalId)
          .some((record) => record.kind === "dispatch" && record.payload?.kind === "provider");
      }
      const current = hash(readFileSync(checkpointPath));
      if (current !== last) {
        last = current;
        settledSince = Date.now();
      } else if (dispatched && Date.now() - settledSince >= 50) {
        return;
      }
    } catch {
      // not yet visible
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the owner to settle");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

test(
  "a lease naming a live but unrelated process still refuses control with exit 2",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    await mock.setMode("hang");
    const runner = spawnCli([...GOAL_ARGS, "--yes", "-C", workspace], { home, cwd: workspace });
    const out = collect(runner);
    const goalId = waitForGoal(home, workspace);
    const lease = waitForLease(home, goalId);

    // A live pid with the wrong start time is not the recorded owner, so the
    // same stale-authority path must apply (the alternate failure family).
    assert.equal(lease.owner.pid !== process.pid, true, "fixture owner pid is the test process");
    const checkpoint = join(home, "goals", goalId, "checkpoint.json");
    // The owner is still live and rewrites the checkpoint when it dispatches
    // the provider. Forge only once it has settled, so the forged lease is
    // the one the control command below actually reads.
    waitForOwnerSettled(home, goalId, checkpoint);
    forgeLeaseOwner(checkpoint, {
      pid: process.pid,
      startTime: "1",
      bootId: lease.owner.bootId,
    });
    const before = readFileSync(checkpoint);

    for (const action of ["pause", "cancel"]) {
      const refused = runCli(["goal", action, goalId, "--json", "-C", workspace], { home });
      assert.equal(refused.status, 2, refused.stderr);
      const view = JSON.parse(refused.stdout);
      assert.equal(view.result, "refused");
      assert.match(view.reason, /no verified live owner/);
      assert.ok(view.reason.includes(`matrix goal resume ${goalId}`), view.reason);
    }
    assert.deepEqual(readFileSync(checkpoint), before, "refusal changed the checkpoint");
    assert.equal(createGoalStore(home).inspect(goalId).goal.state, "running");

    process.kill(lease.owner.pid, "SIGKILL");
    await out;
  },
);

// ---------------------------------------------------------------------------
// PTY
// ---------------------------------------------------------------------------

test("a real PTY run shows the interactive start event and completes", linux, async (t) => {
  const { home, workspace } = makeFixture(t);
  const mock = startMockProvider(t);
  const port = await mock.port;
  await addFakeProvider(home, port);
  mock.setEdit("src/a.mjs", TARGET);
  writeFileSync(join(mock.dir, "mode"), `seq:["edit","text:done"]`);

  const command = `node ${BIN} goal start "Set a to 2" --criteria criteria.json --provider fake --model fake/model-1 --yes -C ${workspace}`;
  const result = spawnSync("script", ["-qec", command, "/dev/null"], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      MATRIX_HOME: home,
      FAKE_GOAL_KEY: FAKE_KEY,
      NO_COLOR: "1",
      TERM: "xterm-256color",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const plain = stripAnsi(result.stdout);
  assert.match(plain, /Goal created\. Starting an attempt\./);
  assert.match(plain, /Goal completed/);
  assert.match(plain, /Next command: matrix goal inspect goal_[a-f0-9]{32}/);
  assert.equal(readFileSync(join(workspace, "src", "a.mjs"), "utf8"), TARGET);
});

test(
  "PTY kill/restart: SIGKILL the recorded owner mid-run, then a fresh process resumes to completion",
  linux,
  async (t) => {
    const { home, workspace } = makeFixture(t);
    const mock = startMockProvider(t);
    const port = await mock.port;
    await addFakeProvider(home, port);
    await mock.setMode("text:thinking");
    const created = runCli([...GOAL_ARGS, "-C", workspace], { home });
    assert.equal(created.status, 1, created.stderr);
    const goalId = listGoals(home, workspace)[0].id;

    await mock.setMode("hang");
    const pty = spawn(
      "script",
      ["-qec", `node ${BIN} goal resume ${goalId} --yes -C ${workspace}`, "/dev/null"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          MATRIX_HOME: home,
          FAKE_GOAL_KEY: FAKE_KEY,
          NO_COLOR: "1",
          TERM: "xterm-256color",
        },
      },
    );
    const ptyOut = collect(pty);
    const lease = waitForLease(home, goalId);
    process.kill(lease.owner.pid, "SIGKILL");
    await ptyOut;

    mock.setEdit("src/a.mjs", TARGET);
    await mock.setMode(`seq:["edit","text:done"]`);
    const resumed = runCli(["goal", "resume", goalId, "--yes", "--json", "-C", workspace], {
      home,
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const view = JSON.parse(resumed.stdout);
    assert.equal(view.state, "completed");
    assert.match(view.event, /Goal completed/);
    assert.equal(view.reconciled, true, "the fresh process reconciled the killed attempt");
    assert.equal(readFileSync(join(workspace, "src", "a.mjs"), "utf8"), TARGET);
  },
);
