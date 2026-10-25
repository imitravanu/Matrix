import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runTests } from "../lib/process.mjs";
import { runsDir } from "../lib/session.mjs";
import {
  createTestPolicy,
  inspectTestPlan,
  TEST_ORIGIN,
  testTrustStorePath,
  withTestExecutionContext,
} from "../lib/test-policy.mjs";
import { makeTempDir, PACKAGE_ROOT } from "./helpers.mjs";

const NODE_SUMMARY = "console.log('# pass 1\\n# fail 0\\n# duration_ms 1')";

function temp(t, prefix = "matrix-trust-") {
  const root = makeTempDir(prefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function records(home, runId) {
  const path = join(runsDir(home), `${runId}.jsonl`);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function nodePlan(root, script = NODE_SUMMARY) {
  return {
    file: process.execPath,
    args: ["-e", script],
    cwd: root,
    framework: "node --test",
    script,
    display: "node -e <test script>",
  };
}

test("first-use approval shows real executable/argv/script and persists exact trust", async (t) => {
  const root = temp(t);
  const home = join(root, "home");
  const plan = nodePlan(root);
  const requests = [];
  const policy = createTestPolicy({
    home,
    requestApproval: async (request) => {
      requests.push(request);
      return "y";
    },
  });
  const first = await runTests(plan, { home, policy, runId: "first-use" });
  assert.equal(first.ok, true, first.summary);
  assert.deepEqual(
    requests.map((request) => request.kind),
    ["workspace", "test-plan"],
  );
  for (const request of requests) {
    assert.equal(request.origin, TEST_ORIGIN.USER);
    assert.equal(request.executable, process.execPath);
    assert.deepEqual(request.argv, plan.args);
    assert.equal(request.script, plan.script);
    assert.match(request.command, /-e/);
    assert.match(request.planHash, /^[a-f0-9]{64}$/);
  }
  assert.equal(requests[1].plan.planHash, first.testPlan.planHash);
  const storeText = readFileSync(testTrustStorePath(home), "utf8");
  assert.equal(
    storeText.includes(plan.script),
    false,
    "the trust store retains hashes, not script contents",
  );
  assert.equal(statSync(testTrustStorePath(home)).mode & 0o777, 0o600);

  const storedPolicy = createTestPolicy({
    home,
    requestApproval: async () => {
      throw new Error("stored exact trust should not prompt again");
    },
  });
  const second = await runTests(plan, { home, policy: storedPolicy, runId: "stored-use" });
  assert.equal(second.ok, true, second.summary);
  assert.equal(second.trustDecision, "stored");
  assert.equal(second.executionOrigin, TEST_ORIGIN.USER);
  const headless = await runTests(plan, {
    home,
    runId: "headless-stored-denied",
    policy: createTestPolicy({ home, headless: true }),
  });
  assert.equal(headless.ok, false);
  assert.equal(headless.trustStatus, "denied");
  assert.match(headless.trustReason, /--allow-tests/);
});

test("npm inspection includes current pretest/test scripts and changes their hash", (t) => {
  const root = temp(t);
  const manifest = join(root, "package.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      name: "trust-fixture",
      scripts: { pretest: "node setup.mjs", test: "node test.mjs" },
    }),
  );
  const plan = {
    file: "npm",
    args: ["test", "--silent"],
    cwd: root,
    script: "stale indexed value",
  };
  const first = inspectTestPlan(plan);
  assert.equal(first.ok, true, first.error);
  assert.equal(first.plan.script, "node test.mjs");
  assert.equal(first.plan.scripts.pretest, "node setup.mjs");
  assert.deepEqual(first.plan.args, ["test", "--silent"]);
  assert.notEqual(first.plan.command, "npm test");
  const initialHash = first.plan.scriptHash;
  writeFileSync(
    manifest,
    JSON.stringify({ name: "trust-fixture", scripts: { test: "node changed.mjs" } }),
  );
  const changed = inspectTestPlan(plan);
  assert.equal(changed.plan.script, "node changed.mjs");
  assert.notEqual(changed.plan.scriptHash, initialHash);
  assert.notEqual(changed.plan.planHash, first.plan.planHash);
});

test("untrusted and changed plans never spawn, including after an approval-window change", async (t) => {
  const root = temp(t);
  const home = join(root, "home");
  const marker = join(root, "spawned.sentinel");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned"); ${NODE_SUMMARY}`;
  const plan = nodePlan(root, script);
  const denied = await withTestExecutionContext(
    {
      home,
      runId: "model-denied",
      origin: TEST_ORIGIN.MODEL,
      policy: createTestPolicy({ home }),
    },
    () => runTests(plan),
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.processOk, false);
  assert.equal(denied.verified, false);
  assert.equal(denied.verificationStatus, "unverified");
  assert.equal(denied.executionOrigin, TEST_ORIGIN.MODEL);
  assert.equal(existsSync(marker), false);
  assert.equal(
    records(home, "model-denied").some((record) => record.type === "execution:start"),
    false,
  );

  const racedPlan = nodePlan(root, script);
  const policy = createTestPolicy({
    home,
    requestApproval: async (request) => {
      if (request.kind === "test-plan") racedPlan.script = "changed while the approval was open";
      return "once";
    },
  });
  const raced = await runTests(racedPlan, { home, policy, runId: "approval-race" });
  assert.equal(raced.ok, false);
  assert.match(raced.trustReason, /changed while approval/);
  assert.equal(existsSync(marker), false);
});

test("a required start-audit failure prevents an otherwise approved spawn", async (t) => {
  const root = temp(t);
  const home = join(root, "home-is-a-file");
  writeFileSync(home, "not a directory");
  const marker = join(root, "audit-bypass.sentinel");
  const plan = nodePlan(
    root,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "no"); ${NODE_SUMMARY}`,
  );
  const result = await runTests(plan, { home, allowTests: true, runId: "no-audit-no-spawn" });
  assert.equal(result.ok, false);
  assert.equal(result.processOk, false);
  assert.equal(result.verificationStatus, "unverified");
  assert.equal(result.trustStatus, "approved");
  assert.equal(result.auditStatus, "start-failed");
  assert.match(result.auditError, /start audit/);
  assert.equal(existsSync(marker), false);
});

test("an oversized start audit fails closed instead of running with a truncated audit", async (t) => {
  const root = temp(t);
  const home = join(root, "home");
  const marker = join(root, "oversized-audit.sentinel");
  const plan = nodePlan(
    root,
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "no"); ${NODE_SUMMARY}`,
  );
  plan.args.push(...Array.from({ length: 40 }, () => "x".repeat(2000)));
  const result = await runTests(plan, { home, allowTests: true, runId: "oversized-audit" });
  assert.equal(result.ok, false);
  assert.equal(result.auditStatus, "start-failed");
  assert.equal(existsSync(marker), false);
  const log = records(home, "oversized-audit");
  assert.equal(
    log.some((record) => record.type === "execution:start"),
    false,
  );
  assert.ok(
    Buffer.byteLength(readFileSync(join(runsDir(home), "oversized-audit.jsonl"), "utf8")) <=
      64 * 1024,
  );
});

test("a once approval authorizes one execution rather than becoming stored trust", async (t) => {
  const root = temp(t);
  const home = join(root, "home");
  let prompts = 0;
  const policy = createTestPolicy({
    home,
    requestApproval: async () => {
      prompts += 1;
      return "once";
    },
  });
  const plan = nodePlan(root);
  assert.equal((await runTests(plan, { home, policy, runId: "once-1" })).ok, true);
  assert.equal((await runTests(plan, { home, policy, runId: "once-2" })).ok, true);
  assert.equal(prompts, 4, "workspace and exact plan are approved again for the next execution");
  assert.equal(existsSync(testTrustStorePath(home)), false);
});

test("a dedicated allow decision covers one exact plan, not a different argv/script", async (t) => {
  const root = temp(t);
  const home = join(root, "home");
  const policy = createTestPolicy({ home, allowTests: true });
  const first = await runTests(nodePlan(root), { home, policy, runId: "allowed-plan" });
  assert.equal(first.ok, true);
  const otherMarker = join(root, "other.sentinel");
  const other = nodePlan(
    root,
    `require("node:fs").writeFileSync(${JSON.stringify(otherMarker)}, "no"); ${NODE_SUMMARY}`,
  );
  const denied = await runTests(other, { home, policy, runId: "different-plan" });
  assert.equal(denied.ok, false);
  assert.match(denied.trustReason, /only the first exact test plan/);
  assert.equal(existsSync(otherMarker), false);
});

test("start audit precedes spawn and fake secrets are redacted from output and logs", async (t) => {
  const root = temp(t);
  const home = join(root, "home");
  const runId = "audit-redaction";
  const auditPath = join(runsDir(home), `${runId}.jsonl`);
  const sentinel = "fake-secret-sentinel-SEC001";
  const script = `
    const fs = require("node:fs");
    const entries = fs.readFileSync(process.env.AUDIT_PATH, "utf8").trim().split("\\n").map(JSON.parse);
    if (!entries.some((entry) => entry.type === "execution:start")) process.exit(9);
    console.log(${JSON.stringify(sentinel)});
    ${NODE_SUMMARY}
  `;
  const result = await runTests(nodePlan(root, script), {
    home,
    allowTests: true,
    runId,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AUDIT_PATH: auditPath,
      MATRIX_TEST_SECRET: sentinel,
    },
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(
    result.lines.some((line) => line.includes(sentinel)),
    false,
  );
  assert.equal(result.command.includes(sentinel), false);
  assert.equal(result.testPlan.script.includes(sentinel), false);
  const logText = readFileSync(auditPath, "utf8");
  assert.equal(logText.includes(sentinel), false);
  assert.match(logText, /\[redacted\]/);
  assert.equal(statSync(auditPath).mode & 0o777, 0o600);
  const log = records(home, runId);
  const start = log.find((record) => record.type === "execution:start");
  const end = log.find((record) => record.type === "execution:end");
  assert.equal(start.origin, TEST_ORIGIN.USER);
  assert.equal(end.status, "verified");
  for (const field of ["stdout", "stderr", "lines", "env"]) assert.equal(field in end, false);
});

test("completion, timeout and abort all leave matching execution end audits", async (t) => {
  const root = temp(t);
  const home = join(root, "home");
  const waiting = nodePlan(root, "setInterval(() => {}, 1000)");
  const timed = await runTests(waiting, {
    home,
    allowTests: true,
    runId: "audit-timeout",
    timeoutMs: 60,
  });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.verificationStatus, "timedOut");
  assert.equal(records(home, "audit-timeout").at(-1).status, "timedOut");
  assert.equal(records(home, "audit-timeout").at(-1).type, "execution:end");

  const controller = new AbortController();
  const pending = runTests(waiting, {
    home,
    allowTests: true,
    runId: "audit-abort",
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 50);
  const aborted = await pending;
  clearTimeout(timer);
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.verificationStatus, "aborted");
  assert.equal(records(home, "audit-abort").at(-1).status, "aborted");
  assert.equal(records(home, "audit-abort").at(-1).type, "execution:end");
});

test(
  "a controller crash after spawn retains a start without a false completion",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = temp(t);
    const home = join(root, "home");
    const helper = join(root, "crash-helper.mjs");
    const processModule = pathToFileURL(join(PACKAGE_ROOT, "lib", "process.mjs")).href;
    writeFileSync(
      helper,
      `
    import { runTests } from ${JSON.stringify(processModule)};
    await runTests({
      file: process.execPath,
      args: ["-e", "process.kill(process.ppid, 'SIGKILL'); process.exit(0)"],
      cwd: ${JSON.stringify(root)},
      framework: "generic"
    }, { home: ${JSON.stringify(home)}, allowTests: true, runId: "audit-crash" });
  `,
    );
    const child = spawn(process.execPath, [helper], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    const outcome = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(outcome.error, undefined, stderr);
    assert.equal(outcome.signal, "SIGKILL", stderr);
    const log = records(home, "audit-crash");
    assert.equal(log.filter((record) => record.type === "execution:start").length, 1);
    assert.equal(
      log.some((record) => record.type === "execution:end"),
      false,
    );
  },
);
