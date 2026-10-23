import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { HELP_TEXT, parseArgv } from "../lib/cli.mjs";
import { formatDoctor, runDoctor } from "../lib/doctor.mjs";
import { copyDemo } from "./helpers.mjs";

const homeWith = (t) => {
  const previous = process.env.MATRIX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.MATRIX_HOME;
    else process.env.MATRIX_HOME = previous;
  });
  return previous;
};

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

  const vision = parseArgv(["vision", "telemetry", "--cols=80", "--rows", "20", "--png", "out.png"]);
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
  for (const required of ["node", "terminal", "truecolor", "workspace", "tests", "python3", "pytest", "demo", "matrix-home"]) {
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
