import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { HELP_TEXT, parseArgv } from "../lib/cli.mjs";
import { formatDoctor, runDoctor, runDoctorAsync } from "../lib/doctor.mjs";
import { copyDemo } from "./helpers.mjs";

test("provider replace requires an exact profile file and expected digest", () => {
  const digest = "a".repeat(64);
  const options = parseArgv([
    "providers",
    "replace",
    "lab",
    "profile.json",
    "--expected-digest",
    digest,
  ]);
  assert.equal(options.providerArg, "lab");
  assert.equal(options.providerProfileFile, "profile.json");
  assert.equal(options.providerExpectedDigest, digest);
  assert.throws(
    () => parseArgv(["providers", "replace", "lab", "profile.json"]),
    /expected-digest/,
  );
  assert.throws(
    () => parseArgv(["providers", "replace", "lab", "--expected-digest", digest]),
    /profile JSON file/,
  );
  assert.throws(
    () => parseArgv(["providers", "show", "lab", "--expected-digest", digest]),
    /not valid/,
  );
});

test("recovery and publication retry require one explicit intent and reject broad approval", () => {
  for (const command of ["recover", "publish"]) {
    const parsed = parseArgv([command, "/tmp/intent.json"]);
    assert.equal(parsed.command, command);
    assert.equal(parsed.recoveryIntent, "/tmp/intent.json");
    assert.equal(parsed.task, "");
    assert.throws(() => parseArgv([command]), /requires one/);
    assert.throws(() => parseArgv([command, "one", "two"]), /requires one/);
    assert.throws(() => parseArgv([command, "one", "--yes"]), /only valid/);
  }
});

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

test("parallel CLI takes separately quoted tasks and rejects broad approval flags", () => {
  const parallel = parseArgv(["parallel", "fix one", "fix two", "--cwd", "/tmp/project"]);
  assert.deepEqual(parallel.parallelTasks, ["fix one", "fix two"]);
  assert.equal(parallel.command, "parallel");
  const layout = parseArgv(["parallel", "one", "two", "--cols", "40", "--rows", "20", "--no-alt"]);
  assert.equal(layout.cols, 40);
  assert.equal(layout.rows, 20);
  assert.equal(layout.noAltScreen, true);
  assert.throws(() => parseArgv(["parallel", "only one"]), /two through eight/);
  assert.throws(() => parseArgv(["parallel", "one", "two", "--yes"]), /only valid/);
  assert.throws(() => parseArgv(["parallel", "one", "two", "--demo"]), /not valid/);
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

test("an explicit provider presets the TUI for every task combination", () => {
  for (const args of [
    ["--provider", "lab", "--model", "Review/Arbitrary:tag", "Inspect this repository"],
    ["--provider", "lab", "--model", "sonnet", "Inspect this repository"],
    ["--provider", "lab", "Inspect this repository"],
    ["--provider", "lab"],
    ["--provider", "openrouter", "--model", "sonnet"],
    ["--provider", "ollama", "--model", "llama3.2"],
  ]) {
    const options = parseArgv(args);
    assert.equal(options.providerId, args[1], args.join(" "));
  }
  assert.match(HELP_TEXT, /named profile or built-in \(matrix, openrouter, ollama\)/);
  assert.match(HELP_TEXT, /preselects that exact provider\/model in the TUI/);
  assert.doesNotMatch(HELP_TEXT, /refused in the interactive terminal/);
});

test("providers commands parse actions, required flags and scope", () => {
  const list = parseArgv(["providers", "list", "--json"]);
  assert.equal(list.command, "providers");
  assert.equal(list.providersAction, "list");
  assert.equal(list.json, true);

  const add = parseArgv([
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
  ]);
  assert.equal(add.providersAction, "add");
  assert.equal(add.providerAddId, "lab");
  assert.equal(add.providerBaseUrl, "https://inference.example/v1");
  assert.equal(add.providerApiKeyEnv, "LAB_API_KEY");
  assert.equal(add.modelQuery, "Vendor/Model-X:latest");
  assert.equal(add.providerName, "Lab");
  assert.equal(add.providerAuth, "bearer");

  const none = parseArgv([
    "providers",
    "add",
    "--id",
    "lab",
    "--base-url",
    "https://inference.example/v1",
    "--auth",
    "none",
  ]);
  assert.equal(none.providerAuth, "none");

  const models = parseArgv(["providers", "models", "lab", "--refresh"]);
  assert.equal(models.providerArg, "lab");
  assert.equal(models.providerRefresh, true);
  assert.equal(parseArgv(["providers", "remove", "lab"]).providerArg, "lab");

  assert.throws(() => parseArgv(["providers"]), /expects one of/);
  assert.throws(() => parseArgv(["providers", "add"]), /requires --id/);
  assert.throws(() => parseArgv(["providers", "add", "--id", "lab"]), /requires --base-url/);
  assert.throws(
    () => parseArgv(["providers", "add", "--id", "lab", "--base-url", "https://example/v1"]),
    /requires --api-key-env/,
  );
  assert.throws(
    () =>
      parseArgv([
        "providers",
        "add",
        "--id",
        "lab",
        "--base-url",
        "https://example/v1",
        "--auth",
        "none",
        "--api-key-env",
        "X",
      ]),
    /not valid with --auth none/,
  );
  assert.throws(
    () =>
      parseArgv([
        "providers",
        "add",
        "--id",
        "Lab",
        "--base-url",
        "https://example/v1",
        "--api-key-env",
        "X",
      ]),
    /lowercase/,
  );
  assert.throws(() => parseArgv(["providers", "models"]), /exactly one provider id/);
  assert.throws(() => parseArgv(["providers", "models", "lab", "extra"]), /exactly one/);
  assert.throws(() => parseArgv(["providers", "list", "--refresh"]), /--refresh is only valid/);
  assert.throws(
    () => parseArgv(["providers", "models", "lab", "--model", "x"]),
    /--model is not valid/,
  );

  const show = parseArgv(["providers", "show", "lab", "--json"]);
  assert.equal(show.providersAction, "show");
  assert.equal(show.providerArg, "lab");
  assert.equal(show.json, true);

  const update = parseArgv([
    "providers",
    "update",
    "lab",
    "--name",
    "Lab Two",
    "--model",
    "vendor/new",
    "--remove-model",
    "vendor/old",
    "--default-model",
    "vendor/new",
  ]);
  assert.equal(update.providersAction, "update");
  assert.equal(update.providerArg, "lab");
  assert.equal(update.providerName, "Lab Two");
  assert.equal(update.modelQuery, "vendor/new");
  assert.equal(update.providerRemoveModel, "vendor/old");
  assert.equal(update.providerDefaultModel, "vendor/new");
  assert.equal(parseArgv(["providers", "update", "lab", "--auth", "none"]).providerAuth, "none");
  assert.equal(
    parseArgv(["providers", "update", "lab", "--api-key-env", "LAB_KEY"]).providerApiKeyEnv,
    "LAB_KEY",
  );

  assert.throws(() => parseArgv(["providers", "update", "lab"]), /at least one change/);
  assert.throws(() => parseArgv(["providers", "update"]), /exactly one provider id/);
  assert.throws(
    () => parseArgv(["providers", "update", "lab", "--id", "lab"]),
    /--id is not valid/,
  );
  assert.throws(
    () => parseArgv(["providers", "show", "lab", "--name", "x"]),
    /--name is not valid/,
  );
  assert.throws(() => parseArgv(["providers", "list", "--id", "lab"]), /--id is not valid/);
  assert.throws(
    () =>
      parseArgv([
        "providers",
        "add",
        "--id",
        "lab",
        "--base-url",
        "https://example/v1",
        "--auth",
        "none",
        "--remove-model",
        "vendor/x",
      ]),
    /--remove-model is not valid/,
  );
  assert.throws(
    () =>
      parseArgv([
        "providers",
        "update",
        "lab",
        "--model",
        "vendor/a",
        "--remove-model",
        "vendor/a",
      ]),
    /cannot name the same model/,
  );
  assert.throws(
    () => parseArgv(["providers", "update", "lab", "--auth", "none", "--api-key-env", "X"]),
    /not valid with --auth none/,
  );
  assert.throws(
    () => parseArgv(["providers", "update", "lab", "--auth", "magic"]),
    /--auth expects/,
  );
  assert.throws(
    () => parseArgv(["interactive", "--remove-model", "x"]),
    /--remove-model is only valid/,
  );
  assert.throws(
    () =>
      parseArgv([
        "providers",
        "add",
        "--id",
        "lab",
        "--base-url",
        "https://example/v1",
        "--api-key-env",
        "X",
        "--provider",
        "lab",
      ]),
    /--provider is only valid/,
  );
  const probe = parseArgv(["providers", "test", "lab", "--model", "vendor/exact"]);
  assert.equal(probe.providersAction, "test");
  assert.equal(probe.providerArg, "lab");
  assert.equal(probe.modelQuery, "vendor/exact");
  assert.deepEqual(probe.providerChecks, ["text", "tools"]);
  assert.deepEqual(
    parseArgv(["providers", "test", "lab", "--model", "x", "--checks", "tools,text,tools"])
      .providerChecks,
    ["tools", "text"],
  );
  assert.throws(() => parseArgv(["providers", "test", "lab"]), /requires --model/);
  assert.throws(
    () => parseArgv(["providers", "test", "lab", "--model", "x", "--checks", "vision"]),
    /--checks expects text/,
  );
  assert.throws(
    () => parseArgv(["providers", "test", "lab", "--model", "x", "--checks", ","]),
    /at least one of text, tools/,
  );
  assert.throws(
    () => parseArgv(["providers", "list", "--checks", "text"]),
    /--checks is not valid/,
  );
  assert.throws(
    () => parseArgv(["providers", "test", "lab", "--model", "x", "--refresh"]),
    /--refresh is only valid/,
  );

  assert.match(HELP_TEXT, /matrix providers add/);
  assert.match(HELP_TEXT, /matrix providers show/);
  assert.match(HELP_TEXT, /matrix providers update/);
  assert.match(HELP_TEXT, /matrix providers test/);
});
