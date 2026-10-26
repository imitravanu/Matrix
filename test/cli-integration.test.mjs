import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { PACKAGE_ROOT, copyDemo, makeTempDir } from "./helpers.mjs";

const BIN = join(PACKAGE_ROOT, "bin", "matrix.mjs");
const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

function runCli(args, { cwd = PACKAGE_ROOT, home = undefined, env = {} } = {}) {
  const childEnv = {
    ...process.env,
    NO_COLOR: "1",
    ...(home ? { MATRIX_HOME: home } : {}),
    ...env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: childEnv,
  });
}

function tempHome(t) {
  const home = makeTempDir("matrix-cli-home-");
  t.after(() => {
    try {
      spawnSync("rm", ["-rf", home]);
    } catch {
      // best effort
    }
  });
  return home;
}

function nodeFailureWorkspace(t) {
  const root = makeTempDir("matrix-cli-node-fail-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "node-fail",
      version: "1.0.0",
      type: "module",
      scripts: { test: "node --test" },
    }),
  );
  writeFileSync(
    join(root, "src", "processor.js"),
    "export function tail(items) {\n  return items.slice(0, items.length - 1);\n}\n",
  );
  writeFileSync(
    join(root, "test", "processor.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { tail } from "../src/processor.js";',
      "",
      'test("keeps the last element", () => {',
      "  assert.deepEqual(tail([1, 2]), [1, 2]);",
      "});",
      "",
      'test("intentional failure", () => {',
      "  assert.equal(1, 2);",
      "});",
      "",
    ].join("\n"),
  );
  return root;
}

function nodeTrustWorkspace(t) {
  const root = makeTempDir("matrix-cli-trust-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "node-trust",
      version: "1.0.0",
      type: "module",
      scripts: { test: "node test/run.mjs" },
    }),
  );
  writeFileSync(
    join(root, "test", "run.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("test-ran.sentinel", "fake test execution");',
      'console.log("# pass 1\\n# fail 0\\n# duration_ms 1");',
      "",
    ].join("\n"),
  );
  return { root, marker: join(root, "test-ran.sentinel"), script: "node test/run.mjs" };
}

function nodeUnrecognizedWorkspace(t) {
  const root = makeTempDir("matrix-cli-unverified-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "node-unverified",
      version: "1.0.0",
      type: "module",
      scripts: { test: "node test/run.mjs" },
    }),
  );
  writeFileSync(
    join(root, "src", "processor.js"),
    "export function tail(items) {\n  return items.slice(0, items.length - 1);\n}\n",
  );
  writeFileSync(
    join(root, "test", "run.mjs"),
    'console.log("zero exit without a recognized test summary");\n',
  );
  return root;
}

test("version, help, doctor and sessions are real CLI paths", (t) => {
  const home = tempHome(t);
  const version = runCli(["--version"], { home });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /matrix v1\.0\.0/);

  const help = runCli(["--help"], { home });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /USAGE/);
  assert.match(help.stdout, /matrix doctor/);
  assert.match(help.stdout, /--allow-tests/);
  assert.match(help.stdout, /--enable-commands/);
  assert.match(help.stdout, /--allow-command/);
  assert.match(help.stdout, /COMMAND TRUST/);

  const doctor = runCli(["doctor", "--json", "--demo"], { home });
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.ok(report.summary.total > 10);
  assert.equal(report.summary.fail, 0);
  assert.ok(report.checks.some((check) => check.name === "workspace" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "demo" && check.status === "ok"));
  assert.equal(report.sandbox.probed, true);
  assert.equal(report.sandbox.available, true, report.sandbox.reason);
  assert.match(report.sandbox.policy.seccomp, /^none;/);

  const sessions = runCli(["sessions", "--json"], { home });
  assert.equal(sessions.status, 0);
  assert.deepEqual(JSON.parse(sessions.stdout), []);

  const noTty = runCli([], { home });
  assert.equal(noTty.status, 1);
  assert.match(noTty.stderr, /needs a TTY|pass a task/);

  const badScreen = runCli(["dump", "--screen", "bogus"], { home });
  assert.equal(badScreen.status, 1);
  assert.match(badScreen.stderr, /--screen expects one of/);

  const badPng = runCli(["dump", "--png", "nope.png"], { home });
  assert.equal(badPng.status, 1);
  assert.match(badPng.stderr, /--png is only valid with matrix vision/);

  const demoYes = runCli(["fix the bounds bug", "--demo", "--yes"], { home });
  assert.equal(demoYes.status, 1);
  assert.match(demoYes.stderr, /refusing --yes on the bundled demo/);
});

test("invalid command input fails before work with a help hint", (t) => {
  const demo = copyDemo("matrix-cli-invalid-input-");
  t.after(() => demo.cleanup());
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  for (const args of [
    ["vision", "bogus"],
    ["smoke", "--cols", "80"],
    ["--model", "--json"],
    ["--model", "--allow-tests"],
    ["doctor", "--allow-tests"],
    ["doctor", "--enable-commands"],
    ["doctor", "--enable-commands", `--allow-command=${"a".repeat(64)}`],
    ["--enable-commands", `--allow-command=${"a".repeat(64)}`],
    ["explain", "--enable-commands", "--allow-command", "ABC"],
    ["doctor", "extra"],
  ]) {
    const result = runCli(args, { cwd: demo.workspace, home: tempHome(t) });
    assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /matrix --help/);
    assert.equal(result.stdout.trim(), "");
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

test("vision refuses --file paths outside the workspace", (t) => {
  const home = tempHome(t);
  const escaped = runCli(["vision", "scope", "--demo", "--file", "../README.md"], { home });
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /path escapes workspace/);
});

test("direct Vision and dump output honor NO_COLOR and monochrome flags", (t) => {
  const home = tempHome(t);
  const modes = [
    { suffix: [], env: { NO_COLOR: "1" } },
    { suffix: ["--mono"], env: { NO_COLOR: undefined } },
    { suffix: ["--no-color"], env: { NO_COLOR: undefined } },
  ];
  for (const base of [
    ["vision", "scope", "--demo"],
    ["dump", "--demo", "--screen", "chat"],
  ]) {
    for (const mode of modes) {
      const args = [...base, ...mode.suffix];
      const result = runCli(args, { home, env: mode.env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes("\x1b["), false, `${args.join(" ")} emitted ANSI`);
    }
  }
});

test("smoke, dump and PNG export run against the bundled demo", (t) => {
  const home = tempHome(t);
  const smoke = runCli(["smoke", "--demo", "--json"], { home });
  assert.equal(smoke.status, 0, smoke.stderr);
  const smokeReport = JSON.parse(smoke.stdout);
  assert.equal(smokeReport.ok, true);
  assert.equal(smokeReport.checks, 32);
  assert.ok(smokeReport.report.every((item) => item.ok));

  const dump = runCli(
    ["dump", "--demo", "--screen", "chat", "--cols", "80", "--rows", "26", "--mono"],
    { home },
  );
  assert.equal(dump.status, 0, dump.stderr);
  assert.match(dump.stdout, /SCREEN: CHAT/);
  assert.match(dump.stdout, /MATRIX\/FORGE/);
  assert.equal(dump.stdout.includes("\x1b["), false);
  assert.ok(dump.stdout.split("\n").every((line) => line.length <= 80));

  const png = join(home, "vision.png");
  const vision = runCli(
    ["vision", "scope", "--demo", "--cols", "60", "--rows", "20", "--png", png],
    { home },
  );
  assert.equal(vision.status, 0, vision.stderr);
  const written = JSON.parse(vision.stdout);
  assert.equal(written.width, 60);
  assert.equal(written.height, 38);
  const bytes = readFileSync(png);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(bytes.readUInt32BE(16), 60);
  assert.equal(bytes.readUInt32BE(20), 38);
  assert.ok(readdirSync(home).includes("vision.png"));
});

test("headless apply and deny use the real gate on a temp workspace", (t) => {
  const home = tempHome(t);
  const appliedDemo = copyDemo("matrix-cli-apply-");
  const deniedDemo = copyDemo("matrix-cli-deny-");
  t.after(() => {
    appliedDemo.cleanup();
    deniedDemo.cleanup();
  });

  const apply = runCli([TASK, "--yes", "--allow-tests", "--json"], {
    cwd: appliedDemo.workspace,
    home,
  });
  assert.equal(apply.status, 0, apply.stderr);
  const applied = JSON.parse(apply.stdout);
  assert.equal(applied.result.ok, true);
  assert.equal(applied.result.status, "success");
  assert.equal(applied.result.outcome, "success");
  assert.equal(applied.result.elapsedMs, applied.result.metrics.elapsedMs);
  assert.equal(applied.result.editFile.status, "applied");
  assert.equal(applied.result.editFile.stats.adds, 1);
  assert.equal(applied.result.verifyTests.passed, 4);
  assert.equal(applied.result.verifyTests.failed, 0);
  assert.ok(
    readFileSync(join(appliedDemo.workspace, "src", "processor.py"), "utf8").includes(FIXED),
  );

  const deny = runCli([TASK, "--allow-tests", "--json"], { cwd: deniedDemo.workspace, home });
  assert.equal(deny.status, 0, deny.stderr);
  const denied = JSON.parse(deny.stdout);
  assert.equal(denied.result.ok, true);
  assert.equal(denied.result.status, "denied");
  assert.equal(denied.result.outcome, "denied");
  assert.equal(denied.result.error, false);
  assert.equal(denied.result.failure, null);
  assert.equal(denied.result.elapsedMs, denied.result.metrics.elapsedMs);
  assert.equal(denied.result.editFile.status, "denied");
  assert.equal(denied.result.verifyTests, null);
  const deniedBytes = readFileSync(join(deniedDemo.workspace, "src", "processor.py"), "utf8");
  assert.ok(deniedBytes.includes(BUGGY));
  assert.equal(deniedBytes.includes(FIXED), false);
});

test("headless failure is honest for a Node test suite that still fails", (t) => {
  const home = tempHome(t);
  const root = nodeFailureWorkspace(t);
  const task = "Fix the off-by-one in src/processor.js";
  const result = runCli([task, "--yes", "--allow-tests", "--json"], { cwd: root, home });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result.ok, false);
  assert.equal(report.result.status, "failed");
  assert.equal(report.result.outcome, "failed");
  assert.equal(report.result.elapsedMs, report.result.metrics.elapsedMs);
  assert.equal(report.result.editFile.status, "applied");
  assert.equal(report.result.verifyTests.ok, false);
  assert.equal(report.result.verifyTests.passed, 1);
  assert.equal(report.result.verifyTests.failed, 1);
  assert.match(report.result.summary, /tests failed/);
  assert.equal(result.stdout.includes("✓ complete"), false);

  const humanRoot = nodeFailureWorkspace(t);
  const human = runCli([task, "--yes", "--allow-tests"], { cwd: humanRoot, home });
  assert.equal(human.status, 1, `${human.stdout}\n${human.stderr}`);
  assert.match(human.stdout, /✗ failed/);
  assert.equal(human.stdout.includes("✓ complete"), false);
});

test("headless unrecognized zero-exit verification is unverified, nonzero, and recoverable", (t) => {
  const root = nodeUnrecognizedWorkspace(t);
  const result = runCli(
    ["Fix the off-by-one in src/processor.js", "--yes", "--allow-tests", "--json"],
    {
      cwd: root,
      home: tempHome(t),
    },
  );
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result.ok, false);
  assert.equal(report.result.status, "unverified");
  assert.equal(report.result.outcome, "unverified");
  assert.equal(report.result.error, false);
  assert.match(report.result.failure, /unrecognized test output/);
  assert.equal(report.result.verifyTests.processOk, true);
  assert.equal(report.result.verifyTests.verified, false);
  assert.equal(report.result.verifyTests.verificationStatus, "unverified");
  assert.equal(report.result.editFile.status, "applied");
  assert.ok(report.result.editFile.backupPath);
  assert.equal(report.result.elapsedMs, report.result.metrics.elapsedMs);
  const source = readFileSync(join(root, "src", "processor.js"), "utf8");
  assert.match(source, /items\.slice\(0, items\.length\)/);
});

test("headless test trust is separate from --yes and writes equivalent execution audits", (t) => {
  const home = tempHome(t);
  const fixture = nodeTrustWorkspace(t);
  const denied = runCli(["run tests", "--yes", "--json"], { cwd: fixture.root, home });
  assert.equal(denied.status, 1, `${denied.stdout}\n${denied.stderr}`);
  const deniedReport = JSON.parse(denied.stdout);
  assert.equal(deniedReport.result.status, "unverified");
  assert.equal(deniedReport.result.verifyTests.trustStatus, "denied");
  assert.match(deniedReport.result.verifyTests.trustReason, /--allow-tests/);
  assert.equal(deniedReport.result.verifyTests.executionOrigin, "model-or-automatic");
  assert.equal(deniedReport.result.verifyTests.testPlan.script, fixture.script);
  assert.deepEqual(deniedReport.result.verifyTests.testPlan.argv, ["test", "--silent"]);
  assert.equal(
    existsSync(fixture.marker),
    false,
    "--yes must never implicitly approve repository tests",
  );
  const deniedLogs = readdirSync(join(home, "runs")).map((name) =>
    readFileSync(join(home, "runs", name), "utf8"),
  );
  assert.equal(
    deniedLogs.some((text) => text.includes('"type":"execution:start"')),
    false,
  );

  const allowed = runCli(["run tests", "--yes", "--allow-tests", "--json"], {
    cwd: fixture.root,
    home,
  });
  assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
  const allowedReport = JSON.parse(allowed.stdout);
  assert.equal(allowedReport.result.status, "success");
  assert.equal(allowedReport.result.verifyTests.trustStatus, "approved");
  assert.equal(allowedReport.result.verifyTests.auditStatus, "complete");
  assert.equal(existsSync(fixture.marker), true);
  const records = readdirSync(join(home, "runs")).flatMap((name) =>
    readFileSync(join(home, "runs", name), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  );
  const start = records.find((record) => record.type === "execution:start");
  assert.ok(start, "allowed headless execution has a durable start record");
  const end = records.find(
    (record) => record.type === "execution:end" && record.executionId === start.executionId,
  );
  assert.ok(end, "allowed headless execution has a durable end record");
  assert.equal(start.origin, "model-or-automatic");
  assert.equal(start.testPlan.script, fixture.script);
  assert.equal(start.testPlan.argv[0], "test");
  assert.equal(end.status, "verified");
  assert.equal(end.processOk, true);
  assert.equal("stdout" in end, false, "execution audits never persist process output");
});

test("allow-command refuses a silent Local Forge fallback", (t) => {
  const demo = copyDemo("matrix-cli-command-local-");
  t.after(() => demo.cleanup());
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  const result = runCli(
    ["inspect", "--offline", "--enable-commands", `--allow-command=${"a".repeat(64)}`, "--json"],
    { cwd: demo.workspace, home: tempHome(t) },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a remote tool-calling model/);
  assert.equal(result.stdout.trim(), "");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("an unknown explicit model fails before an auto-approved run", (t) => {
  const demo = copyDemo("matrix-cli-unknown-model-");
  t.after(() => demo.cleanup());
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  const result = runCli([TASK, "--model", "sonett", "--yes", "--json"], {
    cwd: demo.workspace,
    home: tempHome(t),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown model "sonett"/);
  assert.equal(result.stdout.trim(), "");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a remote model without a key fails honestly and never calls the network", (t) => {
  const home = tempHome(t);
  const noKeyHome = makeTempDir("matrix-cli-nokey-");
  t.after(() => spawnSync("rm", ["-rf", noKeyHome]));
  const result = runCli(["explain the workspace", "--model", "sonnet", "--json"], {
    cwd: join(PACKAGE_ROOT, "demo-project"),
    home,
    env: {
      OPENROUTER_API_KEY: "",
      MATRIX_API_KEY: "",
      OPENAI_API_KEY: "",
      MATRIX_API_BASE: "",
      OPENAI_BASE_URL: "",
      OLLAMA_HOST: "",
      HOME: noKeyHome,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs an OpenRouter key/);
  assert.equal(result.stdout.trim(), "");
});
