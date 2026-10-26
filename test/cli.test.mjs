import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { HELP_TEXT, parseArgv } from "../lib/cli.mjs";
import { formatDoctor, runDoctor, runDoctorAsync } from "../lib/doctor.mjs";
import { copyDemo } from "./helpers.mjs";

test("parseArgv accepts commands, tasks, flags and --", () => {
  const doctor = parseArgv(["doctor", "--json", "--demo"]);
  assert.equal(doctor.command, "doctor");
  assert.equal(doctor.json, true);
  assert.equal(doctor.demo, true);
  assert.equal(doctor.task, "");

  const task = parseArgv(["Fix the bounds bug", "--cwd", "/tmp/example"]);
  assert.equal(task.command, "interactive");
  assert.equal(task.task, "Fix the bounds bug");
  assert.equal(task.cwd, "/tmp/example");

  const vision = parseArgv([
    "vision",
    "telemetry",
    "--cols=80",
    "--rows",
    "20",
    "--png",
    "out.png",
  ]);
  assert.equal(vision.command, "vision");
  assert.equal(vision.graphMode, "telemetry");
  assert.equal(vision.cols, 80);
  assert.equal(vision.rows, 20);
  assert.equal(vision.exportPng, "out.png");

  const literal = parseArgv(["--", "--not-a-flag"]);
  assert.equal(literal.command, "interactive");
  assert.equal(literal.task, "--not-a-flag");

  assert.equal(parseArgv(["help"]).help, true);
  assert.equal(parseArgv(["version"]).version, true);
  assert.equal(parseArgv(["sessions"]).command, "sessions");
  assert.equal(parseArgv(["dump", "--screen", "swarm", "--mono"]).screen, "swarm");
  assert.equal(parseArgv(["bench", "--iterations", "2"]).benchIterations, 2);
  assert.equal(parseArgv(["bench", "--bench-iterations=3"]).benchIterations, 3);
  assert.match(HELP_TEXT, /matrix tour/);
  assert.match(HELP_TEXT, /y approve/);
});

test("parseArgv does not treat later task words as subcommands", () => {
  const smoke = parseArgv(["fix", "smoke", "output"]);
  assert.equal(smoke.command, "interactive");
  assert.equal(smoke.task, "fix smoke output");

  const doctor = parseArgv(["explain", "doctor", "behavior"]);
  assert.equal(doctor.command, "interactive");
  assert.equal(doctor.task, "explain doctor behavior");

  const sessions = parseArgv(["rename", "sessions", "to", "records"]);
  assert.equal(sessions.command, "interactive");
  assert.equal(sessions.task, "rename sessions to records");

  const commandAfterFlag = parseArgv(["--json", "doctor"]);
  assert.equal(commandAfterFlag.command, "doctor");

  const literalCommand = parseArgv(["--", "doctor"]);
  assert.equal(literalCommand.command, "interactive");
  assert.equal(literalCommand.task, "doctor");
});

test("parseArgv fails loudly on malformed input", () => {
  assert.throws(() => parseArgv(["--cwd"]), /--cwd expects a value/);
  assert.throws(() => parseArgv(["--unknown"]), /unknown option: --unknown/);
  assert.throws(() => parseArgv(["--mode", "bogus"]), /scope, workspace or telemetry/);
  assert.throws(() => parseArgv(["--json=1"]), /does not take a value/);
  assert.throws(() => parseArgv(["--cols", "0"]), /positive integer/);
  assert.throws(() => parseArgv(["--rows", "nope"]), /positive integer/);
  assert.throws(() => parseArgv(["--cols", "80junk"]), /positive integer/);
  assert.throws(() => parseArgv(["--rows", "1.5"]), /positive integer/);
  assert.throws(() => parseArgv(["--model", "--json"]), /--model expects a value/);
  assert.throws(() => parseArgv(["--cols", "--rows"]), /--cols expects a value/);
  assert.throws(() => parseArgv(["--model="]), /--model expects a value/);
  assert.throws(
    () => parseArgv(["vision", "bogus"]),
    /vision expects scope, workspace or telemetry/,
  );
  assert.throws(
    () => parseArgv(["vision", "scope", "extra"]),
    /does not accept positional arguments/,
  );
  assert.throws(() => parseArgv(["doctor", "unexpected"]), /does not accept positional arguments/);
  assert.throws(() => parseArgv(["smoke", "--cols", "80"]), /--cols is only valid with/);
  assert.throws(() => parseArgv(["dump", "--json"]), /--json is only valid with/);
  assert.throws(() => parseArgv(["bench", "--screen", "chat"]), /--screen is only valid with/);
});

test("command flags are exact, separate, and restricted to a headless task", () => {
  const hash = "a".repeat(64);
  const enabled = parseArgv(["inspect", "--enable-commands"]);
  assert.equal(enabled.enableCommands, true);
  assert.equal(enabled.approvedCommandPlanHash, null);
  assert.equal(enabled.autoApprove, false);
  const allowed = parseArgv(["inspect", `--allow-command=${hash}`, "--enable-commands"]);
  assert.equal(allowed.approvedCommandPlanHash, hash);
  assert.equal(
    parseArgv(["inspect", "--enable-commands", "--allow-command", hash]).approvedCommandPlanHash,
    hash,
  );
  for (const args of [
    ["inspect", `--allow-command=${hash}`],
    ["--enable-commands", `--allow-command=${hash}`],
    ["inspect", "--enable-commands", "--allow-command", "A".repeat(64)],
    ["inspect", "--enable-commands", "--allow-command", "a".repeat(63)],
    ["inspect", "--enable-commands", "--allow-command", `${hash}${hash}`],
    ["inspect", "--enable-commands", "--allow-command", hash, "--allow-command", hash],
    ["inspect", "--enable-commands", "--enable-commands"],
    ["doctor", "--enable-commands"],
    ["sessions", "--enable-commands", `--allow-command=${hash}`, "task"],
    ["dump", "--enable-commands"],
    ["inspect", "--enable-commands=true"],
  ]) {
    assert.throws(() => parseArgv(args), undefined, args.join(" "));
  }
  assert.equal(parseArgv(["inspect", "--yes", "--offline"]).enableCommands, false);
  assert.match(HELP_TEXT, /COMMAND TRUST/);
  assert.match(HELP_TEXT, /--allow-command <hash>/);
});

test("runDoctor reports real capabilities and formatDoctor stays readable", (t) => {
  const demo = copyDemo("matrix-doctor-");
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  process.env.MATRIX_HOME = home;
  assert.equal(existsSync(home), false);
  t.after(() => {
    delete process.env.MATRIX_HOME;
  });
  const stdout = { isTTY: true, columns: 120, rows: 40 };
  const report = runDoctor({
    cwd: demo.workspace,
    stdout,
    env: { COLORTERM: "truecolor", TERM: "xterm-256color" },
  });
  const names = report.checks.map((check) => check.name);
  assert.equal(new Set(names).size, names.length);
  for (const required of [
    "node",
    "terminal",
    "truecolor",
    "workspace",
    "tests",
    "python3",
    "pytest",
    "demo",
    "matrix-home",
  ]) {
    assert.ok(names.includes(required), `missing check ${required}`);
  }
  const workspace = report.checks.find((check) => check.name === "workspace");
  assert.equal(workspace.status, "ok");
  assert.match(workspace.detail, /demo-project/);
  const tests = report.checks.find((check) => check.name === "tests");
  assert.equal(tests.status, "ok");
  assert.match(tests.detail, /pytest/);
  assert.equal(report.checks.find((check) => check.name === "terminal").status, "ok");
  assert.equal(report.checks.find((check) => check.name === "truecolor").status, "ok");
  assert.equal(report.summary.fail, 0);
  assert.equal(report.checks.find((check) => check.name === "matrix-home").status, "ok");
  assert.equal(existsSync(home), true);
  const text = formatDoctor(report, { color: false });
  assert.match(text, /MATRIX DOCTOR/);
  assert.match(text, /Ready\. Local Forge works without a network key/);
  assert.equal(text.includes("\x1b["), false);
  assert.equal(text.includes("OPENROUTER_API_KEY="), false);
});

test("runDoctor reports a missing workspace as a failure, not a crash", (t) => {
  const demo = copyDemo("matrix-doctor-missing-");
  t.after(() => demo.cleanup());
  process.env.MATRIX_HOME = join(demo.root, "home");
  t.after(() => {
    delete process.env.MATRIX_HOME;
  });
  const report = runDoctor({
    cwd: join(demo.root, "does-not-exist"),
    stdout: { isTTY: false },
    env: {},
  });
  const workspace = report.checks.find((check) => check.name === "workspace");
  assert.equal(workspace.status, "fail");
  assert.ok(report.summary.fail >= 1);
  assert.match(formatDoctor(report, { color: false }), /workspace\s+fail|✗ workspace/);
});

test("async doctor awaits the real sandbox policy probe and reports its no-seccomp boundary", async (t) => {
  const demo = copyDemo("matrix-doctor-sandbox-");
  t.after(() => demo.cleanup());
  process.env.MATRIX_HOME = join(demo.root, "home");
  t.after(() => {
    delete process.env.MATRIX_HOME;
  });
  const sync = runDoctor({ cwd: demo.workspace, stdout: { isTTY: false }, env: {} });
  assert.equal(sync.sandbox.probed, false);
  assert.equal(sync.sandbox.available, false);
  assert.match(sync.checks.find((check) => check.name === "linux-sandbox").detail, /not probed/);

  const report = await runDoctorAsync({ cwd: demo.workspace, stdout: { isTTY: false }, env: {} });
  assert.equal(report.sandbox.probed, true);
  assert.equal(report.sandbox.available, true, report.sandbox.reason);
  assert.equal(report.sandbox.reason, null);
  assert.equal(
    report.sandbox.policy.seccomp,
    "none; namespace isolation is not a kernel-syscall filter",
  );
  const availability = report.checks.find((check) => check.name === "linux-sandbox");
  assert.equal(availability.status, "ok");
  assert.match(availability.detail, /real namespace\/snapshot probe passed/);
  assert.match(
    report.checks.find((check) => check.name === "sandbox-policy").detail,
    /seccomp=none/,
  );
});

test("failed sandbox probes remain unavailable instead of becoming synchronous success", async (t) => {
  const demo = copyDemo("matrix-doctor-sandbox-failed-");
  t.after(() => demo.cleanup());
  process.env.MATRIX_HOME = join(demo.root, "home");
  t.after(() => {
    delete process.env.MATRIX_HOME;
  });
  const report = await runDoctorAsync({
    cwd: demo.workspace,
    stdout: { isTTY: false },
    env: {},
    probeSandbox: async () => ({ available: false, reason: "namespaces unsupported" }),
  });
  assert.equal(report.sandbox.probed, true);
  assert.equal(report.sandbox.available, false);
  assert.equal(report.sandbox.reason, "namespaces unsupported");
  const availability = report.checks.find((check) => check.name === "linux-sandbox");
  assert.equal(availability.status, "warn");
  assert.match(availability.detail, /unavailable.*namespaces unsupported/);
  assert.match(availability.hint, /no unsandboxed fallback/);
});
