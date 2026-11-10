import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/matrix.mjs", import.meta.url));
const linux = { skip: process.platform !== "linux", timeout: 20_000 };
const original = "export const a = 1;\n";
const modified = "export const b = 1;\n";

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "matrix-goal-cli-"));
  const cwd = join(base, "work");
  const home = join(base, "state");
  mkdirSync(join(cwd, "src"), { recursive: true });
  const target = join(cwd, "src/a.mjs");
  writeFileSync(target, original);
  writeFileSync(
    join(cwd, "criteria.json"),
    JSON.stringify({
      schemaVersion: 1,
      criteria: [
        {
          kind: "artifact",
          path: "src/a.mjs",
          sha256: createHash("sha256").update(modified).digest("hex"),
        },
      ],
    }),
  );
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, MATRIX_HOME: home };
  const run = (...args) => {
    const child = spawn(process.execPath, [bin, "goal", ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const result = once(child, "close").then(([code, signal]) => {
      const out = Buffer.concat(stdout).toString("utf8");
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        /* errors may be printed to stderr */
      }
      return { code, signal, json, stdout: out, stderr: Buffer.concat(stderr).toString("utf8") };
    });
    t.after(() => child.kill("SIGKILL"));
    return { child, result };
  };
  return { cwd, home, target, env, run };
}

test(
  "read-only and invalid goal commands leave a fresh state directory absent",
  linux,
  async (t) => {
    const { home, run } = fixture(t);
    const listed = await run("list", "--json").result;
    assert.deepEqual(listed.json, { schemaVersion: 1, goals: [], omitted: 0 });
    for (const args of [
      ["inspect", "bogus"],
      ["pause", "goal_" + "a".repeat(32), "--allow-tests"],
      ["start", "edit", "--criteria", "missing.json"],
      ["start", "edit", "--criteria", "criteria.json", "--rounds", "99999"],
    ]) {
      const result = await run(...args, "--json").result;
      assert.equal(result.code, 2, JSON.stringify(result));
      assert.equal(existsSync(home), false);
    }
  },
);

test(
  "fresh-process goal resume needs fresh edit authority and keeps cumulative budget",
  linux,
  async (t) => {
    const { home, target, run } = fixture(t);
    const first = await run(
      "start",
      "rename a to b in src/a.mjs",
      "--criteria",
      "criteria.json",
      "--json",
    ).result;
    assert.equal(first.code, 1, JSON.stringify(first));
    assert.equal(first.json.reasonCode, "tool-denied");
    assert.equal(readFileSync(target, "utf8"), original);
    const id = first.json.goalId;
    const checkpoint = join(home, "goals", id, "checkpoint.json");
    const before = readFileSync(checkpoint);
    const inspected = await run("inspect", id, "--json").result;
    assert.equal(inspected.code, 0);
    assert.equal(inspected.json.criteria[0].accepted, false);
    assert.deepEqual(readFileSync(checkpoint), before);
    const resumed = await run("resume", id, "--yes", "--json").result;
    assert.equal(resumed.code, 0, JSON.stringify(resumed));
    assert.equal(resumed.json.result, "completed");
    assert.equal(resumed.json.generation, 2);
    assert.ok(resumed.json.remaining.requests < first.json.remaining.requests);
    assert.equal(readFileSync(target, "utf8"), modified);
  },
);

test(
  "a separate process can pause a live goal and a killed owner can be reclaimed",
  linux,
  async (t) => {
    const { home, env, run, target } = fixture(t);
    mkdirSync(home, { mode: 0o700 });
    env.DUR006_TEST_TOKEN = "dur006-fake-credential";
    let count = 0;
    let firstRequest;
    let secondRequest;
    let fourthRequest;
    const first = new Promise((resolve) => {
      firstRequest = resolve;
    });
    const second = new Promise((resolve) => {
      secondRequest = resolve;
    });
    const fourth = new Promise((resolve) => {
      fourthRequest = resolve;
    });
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        assert.equal(request.headers.authorization, "Bearer dur006-fake-credential");
        count++;
        if (count === 1) firstRequest();
        if (count === 2) secondRequest();
        if (count === 4) fourthRequest();
        if (count <= 2 || count === 4) return; // The live attempt must be stopped by another process.
        response.writeHead(200, { "content-type": "text/event-stream" });
        const call = {
          id: "call_1",
          type: "function",
          function: {
            name: "edit",
            arguments: JSON.stringify({ path: "src/a.mjs", content: modified }),
          },
        };
        const chunk = {
          choices: [
            { delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: "tool_calls" },
          ],
        };
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    writeFileSync(
      join(home, "providers.json"),
      JSON.stringify({
        schemaVersion: 1,
        providers: [
          {
            id: "local-test",
            name: "Local fixture",
            transport: "chat-completions",
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            auth: { type: "bearer", env: "DUR006_TEST_TOKEN" },
            request: { tokenLimitField: "max_tokens", includeUsage: false },
            models: [],
            defaultModel: null,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const running = run(
      "start",
      "change a to b",
      "--criteria",
      "criteria.json",
      "--provider",
      "local-test",
      "--model",
      "fixture-model",
      "--yes",
      "--json",
    );
    await Promise.race([
      first,
      running.result.then((early) => {
        throw new Error(JSON.stringify(early));
      }),
    ]);
    const listed = await run("list", "--json").result;
    const id = listed.json.goals[0].id;
    const paused = await run("pause", id, "--json").result;
    assert.equal(paused.code, 0, JSON.stringify(paused));
    assert.equal((await running.result).json.state, "paused");
    assert.equal(readFileSync(target, "utf8"), original);

    const retry = run("resume", id, "--yes", "--json");
    await Promise.race([
      second,
      retry.result.then((early) => {
        throw new Error(JSON.stringify(early));
      }),
    ]);
    retry.child.kill("SIGKILL");
    assert.equal((await retry.result).signal, "SIGKILL");
    const completed = await run("resume", id, "--yes", "--json").result;
    assert.equal(completed.code, 0, JSON.stringify(completed));
    assert.equal(completed.json.reconciled, true);
    assert.equal(completed.json.generation, 3);
    assert.equal(readFileSync(target, "utf8"), modified);
    assert.equal(count, 3);

    writeFileSync(target, original);
    const cancelledOwner = run(
      "start",
      "change a to b again",
      "--criteria",
      "criteria.json",
      "--provider",
      "local-test",
      "--model",
      "fixture-model",
      "--yes",
      "--json",
    );
    await Promise.race([
      fourth,
      cancelledOwner.result.then((early) => {
        throw new Error(JSON.stringify(early));
      }),
    ]);
    const active = (await run("list", "--json").result).json.goals.find(
      (goal) => goal.state === "running",
    );
    assert.ok(active);
    const cancelled = await run("cancel", active.id, "--json").result;
    assert.equal(cancelled.code, 0, JSON.stringify(cancelled));
    assert.equal((await cancelledOwner.result).json.state, "cancelled");
    assert.equal(readFileSync(target, "utf8"), original);
  },
);

test(
  "goal resume refuses a replacement directory without changing the checkpoint",
  linux,
  async (t) => {
    const { home, cwd, target, run } = fixture(t);
    const first = await run(
      "start",
      "rename a to b in src/a.mjs",
      "--criteria",
      "criteria.json",
      "--json",
    ).result;
    assert.equal(first.code, 1, JSON.stringify(first));
    const id = first.json.goalId;
    const checkpoint = join(home, "goals", id, "checkpoint.json");
    const before = readFileSync(checkpoint);
    renameSync(cwd, cwd + "-old");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(target, original);
    const refused = await run("resume", id, "--yes", "--json").result;
    assert.equal(refused.code, 2, JSON.stringify(refused));
    assert.match(refused.json.reason, /recorded goal/);
    assert.deepEqual(readFileSync(checkpoint), before);
    assert.equal(readFileSync(target, "utf8"), original);
  },
);

test("missing provider credentials refuse before creating a goal", linux, async (t) => {
  const { home, env, run } = fixture(t);
  mkdirSync(home, { mode: 0o700 });
  delete env.DUR006_MISSING_TOKEN;
  writeFileSync(
    join(home, "providers.json"),
    JSON.stringify({
      schemaVersion: 1,
      providers: [
        {
          id: "credential-fixture",
          name: "Credential fixture",
          transport: "chat-completions",
          baseUrl: "http://127.0.0.1:1/v1",
          auth: { type: "bearer", env: "DUR006_MISSING_TOKEN" },
          request: { tokenLimitField: "max_tokens", includeUsage: false },
          models: [],
          defaultModel: null,
        },
      ],
    }),
    { mode: 0o600 },
  );
  const result = await run(
    "start",
    "change a to b",
    "--criteria",
    "criteria.json",
    "--provider",
    "credential-fixture",
    "--model",
    "fixture-model",
    "--json",
  ).result;
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.match(result.json.reason, /DUR006_MISSING_TOKEN/);
  assert.equal(existsSync(join(home, "goals")), false);
});

test("goal --yes does not start tests and --allow-tests runs the bound plan", linux, async (t) => {
  const { home, cwd, run } = fixture(t);
  const script = fileURLToPath(new URL("../scripts/build-pidfd-helper.mjs", import.meta.url));
  mkdirSync(home, { mode: 0o700 });
  const built = spawnSync(process.execPath, [script, "--out", join(home, "bin")], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(built.status, 0, built.stderr || built.error?.message);
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: "node --test test.mjs" } }),
  );
  const marker = join(cwd, "test-ran");
  writeFileSync(
    join(cwd, "test.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync("test-ran", "yes");',
  );
  writeFileSync(
    join(cwd, "criteria.json"),
    JSON.stringify({ schemaVersion: 1, criteria: [{ kind: "test" }] }),
  );
  const first = await run(
    "start",
    "run the tests",
    "--criteria",
    "criteria.json",
    "--yes",
    "--json",
  ).result;
  assert.equal(first.code, 1, JSON.stringify(first));
  assert.equal(first.json.reasonCode, "tool-denied");
  assert.equal(existsSync(marker), false);
  const resumed = await run("resume", first.json.goalId, "--allow-tests", "--json").result;
  assert.equal(resumed.code, 0, JSON.stringify(resumed));
  assert.equal(resumed.json.result, "completed");
  assert.equal(readFileSync(marker, "utf8"), "yes");
});
