import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { PACKAGE_ROOT, copyDemo, makeTempDir } from "./helpers.mjs";

const BIN = join(PACKAGE_ROOT, "bin", "matrix.mjs");
const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

function runCli(args, { cwd = PACKAGE_ROOT, home = undefined, env = {} } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...(home ? { MATRIX_HOME: home } : {}),
      ...env,
    },
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
    JSON.stringify({ name: "node-fail", version: "1.0.0", type: "module", scripts: { test: "node --test" } })
  );
  writeFileSync(
    join(root, "src", "processor.js"),
    "export function tail(items) {\n  return items.slice(0, items.length - 1);\n}\n"
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
    ].join("\n")
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

  const doctor = runCli(["doctor", "--json", "--demo"], { home });
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.ok(report.summary.total > 10);
  assert.equal(report.summary.fail, 0);
  assert.ok(report.checks.some((check) => check.name === "workspace" && check.status === "ok"));
  assert.ok(report.checks.some((check) => check.name === "demo" && check.status === "ok"));

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

test("vision refuses --file paths outside the workspace", (t) => {
  const home = tempHome(t);
  const escaped = runCli(["vision", "scope", "--demo", "--file", "../README.md"], { home });
  assert.equal(escaped.status, 1);
  assert.match(escaped.stderr, /path escapes workspace/);
});

test("smoke, dump and PNG export run against the bundled demo", (t) => {
  const home = tempHome(t);
  const smoke = runCli(["smoke", "--demo", "--json"], { home });
  assert.equal(smoke.status, 0, smoke.stderr);
  const smokeReport = JSON.parse(smoke.stdout);
  assert.equal(smokeReport.ok, true);
  assert.equal(smokeReport.checks, 32);
  assert.ok(smokeReport.report.every((item) => item.ok));

  const dump = runCli(["dump", "--demo", "--screen", "chat", "--cols", "80", "--rows", "26", "--mono"], { home });
  assert.equal(dump.status, 0, dump.stderr);
  assert.match(dump.stdout, /SCREEN: CHAT/);
  assert.match(dump.stdout, /MATRIX\/FORGE/);
  assert.equal(dump.stdout.includes("\x1b["), false);
  assert.ok(dump.stdout.split("\n").every((line) => line.length <= 80));

  const png = join(home, "vision.png");
  const vision = runCli(["vision", "scope", "--demo", "--cols", "60", "--rows", "20", "--png", png], { home });
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

  const apply = runCli([TASK, "--yes", "--json"], { cwd: appliedDemo.workspace, home });
  assert.equal(apply.status, 0, apply.stderr);
  const applied = JSON.parse(apply.stdout);
  assert.equal(applied.result.ok, true);
  assert.equal(applied.result.editFile.status, "applied");
  assert.equal(applied.result.editFile.stats.adds, 1);
  assert.equal(applied.result.verifyTests.passed, 4);
  assert.equal(applied.result.verifyTests.failed, 0);
  assert.ok(readFileSync(join(appliedDemo.workspace, "src", "processor.py"), "utf8").includes(FIXED));

  const deny = runCli([TASK, "--json"], { cwd: deniedDemo.workspace, home });
  assert.equal(deny.status, 0, deny.stderr);
  const denied = JSON.parse(deny.stdout);
  assert.equal(denied.result.ok, true);
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
  const result = runCli([task, "--yes", "--json"], { cwd: root, home });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result.ok, false);
  assert.equal(report.result.editFile.status, "applied");
  assert.equal(report.result.verifyTests.ok, false);
  assert.equal(report.result.verifyTests.passed, 1);
  assert.equal(report.result.verifyTests.failed, 1);
  assert.match(report.result.summary, /tests failed/);
  assert.equal(result.stdout.includes("✓ complete"), false);

  const humanRoot = nodeFailureWorkspace(t);
  const human = runCli([task, "--yes"], { cwd: humanRoot, home });
  assert.equal(human.status, 1, `${human.stdout}\n${human.stderr}`);
  assert.match(human.stdout, /✗ failed/);
  assert.equal(human.stdout.includes("✓ complete"), false);
});

test("a remote model without a key fails honestly and never calls the network", (t) => {
  const home = tempHome(t);
  const noKeyHome = makeTempDir("matrix-cli-nokey-");
  t.after(() => spawnSync("rm", ["-rf", noKeyHome]));
  const result = runCli(["explain the workspace", "--model", "sonnet", "--json"], {
    cwd: join(PACKAGE_ROOT, "demo-project"),
    home,
    env: { OPENROUTER_API_KEY: "", HOME: noKeyHome },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs an OpenRouter key/);
  assert.equal(result.stdout.trim(), "");
});
