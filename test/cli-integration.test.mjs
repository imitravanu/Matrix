import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";

import { resolveProviderSelection, targetDigest } from "../lib/provider-contracts.mjs";
import { pickerModelFromTarget } from "../src/provider-picker.mjs";
import { addProviderProfile, loadProviderConfig } from "../lib/provider-config.mjs";
import { sessionProviderIdentity, validateSessionProvider } from "../lib/provider-session.mjs";
import { loadSession, saveSession } from "../lib/session.mjs";
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

test("headless --provider local runs Local Forge without a provider key", (t) => {
  const demo = copyDemo("matrix-cli-provider-local-");
  t.after(() => demo.cleanup());
  const result = runCli(["--provider", "local", "explain the workspace", "--json"], {
    cwd: demo.workspace,
    home: tempHome(t),
    env: {
      OPENROUTER_API_KEY: "",
      MATRIX_API_KEY: "",
      OPENAI_API_KEY: "",
      MATRIX_API_BASE: "",
      OPENAI_BASE_URL: "",
      OLLAMA_HOST: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.model, "local");
  assert.equal(report.result.status, "success");
  assert.equal(report.result.editFile, null);
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

function runCliAsync(args, { cwd = PACKAGE_ROOT, home = undefined, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...(home ? { MATRIX_HOME: home } : {}),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

test("headless tasks refuse session flags rather than ignoring saved state", (t) => {
  const home = tempHome(t);
  for (const selection of [["--resume"], ["--session", "missing"]]) {
    const result = runCli([...selection, "inspect the repository"], { home });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /headless tasks cannot resume a saved session/);
    assert.doesNotMatch(result.stdout, /TASK/);
  }
});

test("a provider-bound resume refuses a changed provider and --offline", async (t) => {
  const home = tempHome(t);
  const workspace = makeTempDir("matrix-resume-provider-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  await addProviderProfile(
    {
      id: "lab",
      name: "Lab",
      baseUrl: "https://lab.example/v1",
      auth: { type: "none" },
      models: [{ id: "vendor/manual", capabilities: { tools: "supported" } }],
    },
    { home },
  );
  const profile = loadProviderConfig({ home }).config.providers[0];
  const identity = {
    id: "lab",
    modelId: "vendor/manual",
    digest: targetDigest({ ...profile, baseUrl: "https://other.example/v1" }),
  };
  const saved = saveSession(
    { id: "bound", cwd: workspace, history: [], modelId: "vendor/manual", provider: identity },
    { home, now: Date.now() },
  );
  assert.equal(saved.ok, true);

  const runScript = (args) => {
    const command = [process.execPath, BIN, ...args].map(shQuote).join(" ");
    return spawnSync("script", ["-qec", command, "/dev/null"], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1", MATRIX_HOME: home },
    });
  };

  const result = runScript(["--resume"]);
  if (result.error?.code === "ENOENT") {
    const check = validateSessionProvider(identity, {
      config: loadProviderConfig({ home }).config,
    });
    assert.match(check.error, /changed since this session was saved/);
    return;
  }
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    /changed since this session was saved/,
  );

  const offline = runScript(["--resume", "--offline"]);
  assert.notEqual(offline.status, 0);
  assert.match(
    `${offline.stdout ?? ""}${offline.stderr ?? ""}`,
    /--offline cannot resume a provider-bound session/,
  );

  const repairCommand = [
    process.execPath,
    BIN,
    "--resume",
    "--provider",
    "lab",
    "--model",
    "vendor/manual",
  ]
    .map(shQuote)
    .join(" ");
  const repaired = spawnSync(
    "bash",
    ["-c", `( sleep 4; printf '\\003' ) | script -qec ${shQuote(repairCommand)} /dev/null`],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1", MATRIX_HOME: home, TERM: "xterm-256color" },
    },
  );
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(`${repaired.stdout ?? ""}${repaired.stderr ?? ""}`, /vendor\/manual/);
  assert.doesNotMatch(
    `${repaired.stdout ?? ""}${repaired.stderr ?? ""}`,
    /changed since this session was saved/,
  );
  const resumed = loadSession("bound", { home, cwd: workspace });
  assert.equal(resumed.provider.id, "lab");
  assert.equal(resumed.provider.modelId, "vendor/manual");
  assert.equal(resumed.provider.digest, targetDigest(profile));
});

test("a terminal provider invocation presets the exact named model", async (t) => {
  const home = tempHome(t);
  const workspace = makeTempDir("matrix-tty-preset-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  await addProviderProfile(
    {
      id: "lab",
      name: "Lab inference",
      baseUrl: "https://lab.example/v1",
      auth: { type: "none" },
      defaultModel: "vendor/manual",
      models: [{ id: "vendor/manual", name: "Lab Manual", capabilities: { tools: "supported" } }],
    },
    { home },
  );

  const command = [process.execPath, BIN, "--provider", "lab"].map(shQuote).join(" ");
  // Feed Ctrl+C after the first frame so the interactive app exits on its own.
  const wrapped = `( sleep 4; printf '\\003' ) | script -qec ${shQuote(command)} /dev/null`;
  const result = spawnSync("bash", ["-c", wrapped], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1", MATRIX_HOME: home, TERM: "xterm-256color" },
  });
  if (result.error?.code === "ENOENT") {
    // No PTY helper on this host: assert the preset the binary would render.
    const target = resolveProviderSelection({
      providerId: "lab",
      config: loadProviderConfig({ home }).config,
    }).target;
    assert.equal(target.modelId, "vendor/manual");
    const preset = pickerModelFromTarget(target, { source: "preset", available: true });
    assert.equal(preset.pickerKey, "provider:lab:vendor/manual");
    return;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(output, /Lab Manual/, output.slice(-3000));
  assert.doesNotMatch(output, /unknown model/, "the legacy resolver must not run");
  assert.doesNotMatch(output, /not supported in the interactive terminal/);
});

test("headless --provider ollama binds the built-in endpoint and placeholder key", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ollama cli ok" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const demo = copyDemo("matrix-cli-ollama-");
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    demo.cleanup();
  });

  const model = "llama3.2:8b";
  const result = await runCliAsync(
    ["--provider", "ollama", "--model", model, "Say that the provider works", "--json"],
    {
      cwd: demo.workspace,
      home: tempHome(t),
      env: {
        OLLAMA_HOST: `http://127.0.0.1:${server.address().port}`,
        OLLAMA_API_KEY: "",
        OPENROUTER_API_KEY: "",
        MATRIX_API_KEY: "",
        MATRIX_API_BASE: "http://127.0.0.1:1/must-not-be-used",
      },
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /ollama cli ok/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, "Bearer ollama");
  assert.equal(requests[0].body.model, model);
});

test("a terminal resume restores an arbitrary built-in model", async (t) => {
  const home = tempHome(t);
  const workspace = makeTempDir("matrix-tty-builtin-resume-");
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const target = resolveProviderSelection({
    providerId: "openrouter",
    modelQuery: "vendor/unlisted",
  }).target;
  const identity = sessionProviderIdentity(pickerModelFromTarget(target));
  const saved = saveSession(
    {
      id: "builtin-resume",
      cwd: workspace,
      history: [],
      modelId: "vendor/unlisted",
      provider: identity,
    },
    { home, now: Date.now() },
  );
  assert.equal(saved.ok, true);

  const command = [process.execPath, BIN, "--resume"].map(shQuote).join(" ");
  const wrapped = `( sleep 4; printf '\\003' ) | script -qec ${shQuote(command)} /dev/null`;
  const result = spawnSync("bash", ["-c", wrapped], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1", MATRIX_HOME: home, TERM: "xterm-256color" },
  });
  if (result.error?.code === "ENOENT") {
    assert.deepEqual(validateSessionProvider(identity), { ok: true, error: null });
    return;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(output, /vendor\/unlisted/, output.slice(-3000));
  assert.doesNotMatch(output, /Local Forge/, "the saved built-in identity must not fall back");
});

test("a headless CLI provider task reaches the exact endpoint with the exact model", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "provider cli ok" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const home = tempHome(t);
  const workspace = makeTempDir("matrix-cli-provider-workspace-");
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(workspace, { recursive: true, force: true });
  });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ name: "cli-provider", version: "1.0.0", private: true }),
  );
  writeFileSync(join(workspace, "README.md"), "# workspace\n");

  const model = "Vendor/Model-X:Free";
  const key = "sk-cli-canary-key";
  await addProviderProfile(
    {
      id: "lab",
      name: "Lab inference",
      baseUrl: `http://127.0.0.1:${server.address().port}/team/v1`,
      auth: { type: "bearer", env: "LAB_API_KEY" },
      defaultModel: model,
      models: [{ id: model, capabilities: { tools: "unknown" } }],
    },
    { home },
  );

  const result = await runCliAsync(
    ["--provider", "lab", "--model", model, "Say that the provider works"],
    { cwd: workspace, home, env: { LAB_API_KEY: key, NO_COLOR: "1" } },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /provider cli ok/);
  assert.match(result.stderr, /tool support is unverified/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/team/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, `Bearer ${key}`);
  assert.equal(requests[0].body.model, model);
  assert.equal(output.includes(key), false);
});

test("providers CLI manages profiles and never accepts a key value", (t) => {
  const home = tempHome(t);
  const key = "sk-provider-cli-canary";
  const add = runCli(
    [
      "providers",
      "add",
      "--id",
      "lab",
      "--base-url",
      "https://inference.example/v1",
      "--api-key-env",
      "LAB_API_KEY",
      "--model",
      "Vendor/Model-X:latest",
      "--name",
      "Lab",
    ],
    { home, env: { LAB_API_KEY: key } },
  );
  assert.equal(add.status, 0, add.stderr);
  assert.equal(`${add.stdout}${add.stderr}`.includes(key), false);
  assert.match(add.stdout, /provider "lab" added/);

  const raw = readFileSync(join(home, "providers.json"), "utf8");
  assert.equal(raw.includes(key), false);
  assert.match(raw, /LAB_API_KEY/);

  const listed = runCli(["providers", "list", "--json"], { home, env: { LAB_API_KEY: key } });
  assert.equal(listed.status, 0, listed.stderr);
  const report = JSON.parse(listed.stdout);
  const lab = report.providers.find((provider) => provider.id === "lab");
  assert.equal(lab.available, true);
  assert.deepEqual(
    lab.models.map((model) => model.id),
    ["Vendor/Model-X:latest"],
  );

  const models = runCli(["providers", "models", "lab"], { home, env: { LAB_API_KEY: key } });
  assert.equal(models.status, 0, models.stderr);
  assert.match(models.stdout, /configured \(1\)/);
  assert.match(models.stdout, /no snapshot yet/);

  const duplicate = runCli(
    [
      "providers",
      "add",
      "--id",
      "lab",
      "--base-url",
      "https://other.example/v1",
      "--api-key-env",
      "LAB_API_KEY",
    ],
    { home },
  );
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);

  const removed = runCli(["providers", "remove", "lab"], { home });
  assert.equal(removed.status, 0, removed.stderr);
  const after = JSON.parse(runCli(["providers", "list", "--json"], { home }).stdout);
  assert.equal(
    after.providers.some((provider) => provider.id === "lab"),
    false,
  );
});

test("providers replace works through the CLI and rejects stale expected digests", (t) => {
  const home = tempHome(t);
  const add = runCli(
    [
      "providers",
      "add",
      "--id",
      "lab",
      "--base-url",
      "https://old.example/v1",
      "--auth",
      "none",
      "--json",
    ],
    { home },
  );
  assert.equal(add.status, 0, add.stderr);
  const digest = JSON.parse(add.stdout).digest;
  const profile = join(home, "replacement.json");
  writeFileSync(
    profile,
    JSON.stringify({
      id: "lab",
      baseUrl: "https://new.example/v1",
      auth: { type: "none" },
      models: [{ id: "Vendor/Model" }],
    }),
  );
  const replace = runCli(
    ["providers", "replace", "lab", profile, "--expected-digest", digest, "--json"],
    { home },
  );
  assert.equal(replace.status, 0, replace.stderr);
  const show = runCli(["providers", "show", "lab", "--json"], { home });
  assert.equal(JSON.parse(show.stdout).baseUrl, "https://new.example/v1");
  assert.equal(JSON.parse(show.stdout).models[0].id, "Vendor/Model");
  const stale = runCli(["providers", "replace", "lab", profile, "--expected-digest", digest], {
    home,
  });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /changed since it was read/);
});

test("providers show and update inspect and edit one profile", (t) => {
  const home = tempHome(t);
  const key = "sk-provider-show-canary";
  const env = { LAB_API_KEY: key };
  const add = runCli(
    [
      "providers",
      "add",
      "--id",
      "lab",
      "--base-url",
      "https://inference.example/v1",
      "--api-key-env",
      "LAB_API_KEY",
      "--name",
      "Lab",
      "--model",
      "vendor/a",
    ],
    { home, env },
  );
  assert.equal(add.status, 0, add.stderr);

  const shown = runCli(["providers", "show", "lab"], { home, env });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /PROVIDER lab · Lab/);
  assert.match(shown.stdout, /auth bearer · LAB_API_KEY/);
  assert.match(shown.stdout, /default vendor\/a/);
  assert.match(shown.stdout, /key present/);
  assert.match(shown.stdout, /configured \(1\)/);
  assert.equal(shown.stdout.includes(key), false);

  const detail = JSON.parse(runCli(["providers", "show", "lab", "--json"], { home, env }).stdout);
  assert.deepEqual(detail.auth, { type: "bearer", env: "LAB_API_KEY" });
  assert.deepEqual(
    detail.models.map((model) => model.id),
    ["vendor/a"],
  );
  assert.equal(detail.available, true);
  assert.equal(detail.defaultModel, "vendor/a");
  assert.equal(detail.discovery, null);

  const updated = runCli(
    [
      "providers",
      "update",
      "lab",
      "--name",
      "Lab Two",
      "--model",
      "vendor/b",
      "--default-model",
      "vendor/b",
    ],
    { home, env },
  );
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /provider "lab" updated · name, model, defaultModel/);
  assert.equal(`${updated.stdout}${updated.stderr}`.includes(key), false);

  const after = JSON.parse(runCli(["providers", "show", "lab", "--json"], { home, env }).stdout);
  assert.equal(after.name, "Lab Two");
  assert.equal(after.defaultModel, "vendor/b");
  assert.deepEqual(
    after.models.map((model) => model.id),
    ["vendor/a", "vendor/b"],
  );
  assert.deepEqual(after.auth, { type: "bearer", env: "LAB_API_KEY" });

  const removed = runCli(["providers", "update", "lab", "--remove-model", "vendor/b"], {
    home,
    env,
  });
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /updated · model, defaultModel/);
  const cleaned = JSON.parse(runCli(["providers", "show", "lab", "--json"], { home }).stdout);
  assert.equal(cleaned.defaultModel, null);
  assert.deepEqual(
    cleaned.models.map((model) => model.id),
    ["vendor/a"],
  );

  const anonymous = runCli(["providers", "update", "lab", "--auth", "none"], { home, env });
  assert.equal(anonymous.status, 0, anonymous.stderr);
  const anonymousDetail = JSON.parse(
    runCli(["providers", "show", "lab", "--json"], { home, env }).stdout,
  );
  assert.deepEqual(anonymousDetail.auth, { type: "none", env: null });
  assert.equal(anonymousDetail.available, true);

  const unknown = runCli(["providers", "show", "missing"], { home, env });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown provider "missing"/);
  const unknownUpdate = runCli(["providers", "update", "missing", "--name", "X"], { home, env });
  assert.notEqual(unknownUpdate.status, 0);
  assert.match(unknownUpdate.stderr, /unknown provider/);
  const emptyUpdate = runCli(["providers", "update", "lab"], { home, env });
  assert.notEqual(emptyUpdate.status, 0);
  assert.match(emptyUpdate.stderr, /at least one change/);
  const duplicate = runCli(["providers", "update", "lab", "--model", "vendor/a"], {
    home,
    env,
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already lists model/);
});

test("providers update keeps an unlisted default model across unrelated edits", async (t) => {
  const home = tempHome(t);
  await addProviderProfile(
    {
      id: "lab",
      name: "Lab",
      baseUrl: "https://inference.example/v1",
      auth: { type: "none" },
      defaultModel: "Vendor/Manual:latest",
      models: [],
    },
    { home },
  );

  const renamed = runCli(["providers", "update", "lab", "--name", "Renamed", "--json"], {
    home,
  });
  assert.equal(renamed.status, 0, renamed.stderr);
  const receipt = JSON.parse(renamed.stdout);
  assert.deepEqual(receipt.changes, ["name"]);
  assert.equal(receipt.defaultModel, "Vendor/Manual:latest");

  const shown = JSON.parse(runCli(["providers", "show", "lab", "--json"], { home }).stdout);
  assert.equal(shown.name, "Renamed");
  assert.equal(shown.defaultModel, "Vendor/Manual:latest");
  assert.deepEqual(shown.models, []);
  assert.equal(shown.discovery, null);
});

test("providers models --refresh uses the profile endpoint and keeps failure visible", async (t) => {
  let fail = false;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    if (fail) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("unavailable");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ id: "vendor/discovered" }, { id: "Vendor/Model-X:latest" }],
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const home = tempHome(t);
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const key = "sk-provider-refresh-canary";
  const baseUrl = `http://127.0.0.1:${server.address().port}/team/v1`;
  const add = await runCliAsync(
    [
      "providers",
      "add",
      "--id",
      "lab",
      "--base-url",
      baseUrl,
      "--api-key-env",
      "LAB_API_KEY",
      "--model",
      "Vendor/Model-X:latest",
    ],
    { home },
  );
  assert.equal(add.status, 0, add.stderr);

  const refreshed = await runCliAsync(["providers", "models", "lab", "--refresh"], {
    home,
    env: { LAB_API_KEY: key },
  });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.match(refreshed.stdout, /refresh ok · 2 models/);
  assert.match(refreshed.stdout, /vendor\/discovered/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/team/v1/models");
  assert.equal(requests[0].headers.authorization, `Bearer ${key}`);

  let listed = JSON.parse(
    (await runCliAsync(["providers", "list", "--json"], { home, env: { LAB_API_KEY: key } }))
      .stdout,
  );
  assert.equal(listed.providers.find((provider) => provider.id === "lab").discovery.stale, false);

  fail = true;
  const failed = await runCliAsync(["providers", "models", "lab", "--refresh"], {
    home,
    env: { LAB_API_KEY: key },
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /refresh failed/);
  assert.match(failed.stdout, /prior snapshot preserved/);

  listed = JSON.parse(
    (await runCliAsync(["providers", "list", "--json"], { home, env: { LAB_API_KEY: key } }))
      .stdout,
  );
  const stale = listed.providers.find((provider) => provider.id === "lab");
  assert.equal(stale.discovery.outcome, "error");
  assert.equal(stale.discovery.stale, true);
  assert.match(stale.discovery.error, /HTTP 503/);
  assert.ok(stale.models.some((model) => model.id === "vendor/discovered"));

  // A fresh process reading the cache without --refresh must still warn.
  const cachedText = await runCliAsync(["providers", "models", "lab"], {
    home,
    env: { LAB_API_KEY: key },
  });
  assert.equal(cachedText.status, 0, cachedText.stderr);
  assert.match(cachedText.stdout, /stale: .*HTTP 503/);
  assert.match(cachedText.stdout, /configured \(1\)/);
  assert.match(cachedText.stdout, /Vendor\/Model-X:latest/);
  assert.match(cachedText.stdout, /vendor\/discovered/);
  assert.doesNotMatch(cachedText.stdout, /refresh failed/);

  const cachedJson = JSON.parse(
    (
      await runCliAsync(["providers", "models", "lab", "--json"], {
        home,
        env: { LAB_API_KEY: key },
      })
    ).stdout,
  );
  assert.equal(cachedJson.refresh, null);
  assert.equal(cachedJson.discovery.outcome, "error");
  assert.equal(cachedJson.discovery.stale, true);
  assert.match(cachedJson.discovery.error, /HTTP 503/);
  assert.deepEqual(cachedJson.configured, ["Vendor/Model-X:latest"]);
  assert.ok(cachedJson.discovered.includes("vendor/discovered"));
  assert.equal(requests.length, 2, "cache reads never call the provider");
});

test("providers test probes one exact model and records evidence without the key", async (t) => {
  const home = tempHome(t);
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = body.tools
        ? body.messages.some((message) => message.role === "tool")
          ? [
              { choices: [{ delta: { content: "observed" } }] },
              { choices: [{ delta: {}, finish_reason: "stop" }] },
            ]
          : [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_cli_1",
                          function: { name: "matrix_probe_noop", arguments: '{"note":"probe"}' },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              },
            ]
        : [{ choices: [{ delta: { content: "pong" } }] }];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const address = server.address();
  const key = "sk-probe-cli-canary";
  await addProviderProfile(
    {
      id: "lab",
      name: "Lab",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      auth: { type: "bearer", env: "LAB_API_KEY" },
      models: [{ id: "vendor/exact-model", capabilities: { tools: "unknown" } }],
    },
    { home },
  );

  const text = await runCliAsync(["providers", "test", "lab", "--model", "vendor/exact-model"], {
    home,
    env: { LAB_API_KEY: key },
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /PROVIDER PROBE lab · vendor\/exact-model/);
  assert.match(text.stdout, /text\s+✓ pass · 4 content chars/);
  assert.match(text.stdout, /tools\s+✓ pass/);
  assert.match(text.stdout, /3 requests/);
  assert.match(text.stdout, /record .*lab\.probes\.json/);
  assert.match(text.stdout, /Synthetic fixtures only/);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, `Bearer ${key}`);
  assert.equal(requests[0].body.max_tokens, 256);

  const recordPath = join(home, "provider-cache", "lab.probes.json");
  assert.equal(existsSync(recordPath), true);
  assert.equal(readFileSync(recordPath, "utf8").includes(key), false);

  const json = await runCliAsync(
    ["providers", "test", "lab", "--model", "vendor/exact-model", "--checks", "text", "--json"],
    { home, env: { LAB_API_KEY: key } },
  );
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.requestedChecks, ["text"]);
  assert.equal(report.checks.text.status, "pass");
  assert.equal(report.checks.tools.status, "not-evaluated");
  assert.equal(report.requests, 1);
  assert.equal(report.recorded, true);

  await addProviderProfile(
    {
      id: "down",
      name: "Down",
      baseUrl: "http://127.0.0.1:1/v1",
      auth: { type: "none" },
      models: [{ id: "vendor/down-model", capabilities: { tools: "unknown" } }],
    },
    { home },
  );
  const failed = await runCliAsync(["providers", "test", "down", "--model", "vendor/down-model"], {
    home,
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /text\s+✗ fail/);
  assert.match(failed.stdout, /record /);
});
