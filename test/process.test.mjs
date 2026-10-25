import test, { after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { parseTestOutput, runProcess, runTests, testPlanCommand } from "../lib/process.mjs";
import { detectProject } from "../lib/project.mjs";
import { copyDemo, makeTempDir } from "./helpers.mjs";

const TEST_HOME = makeTempDir("matrix-process-home-");
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

function runTrustedTests(plan, options = {}) {
  return runTests(plan, { ...options, home: TEST_HOME, allowTests: true });
}

test("runProcess streams stdout/stderr and reports the exit code", async () => {
  const lines = [];
  const result = await runProcess({
    file: process.execPath,
    args: ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
    onLine: (line, stream) => lines.push(`${stream}:${line}`),
  });
  assert.equal(result.code, 3);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.ok(result.stdout.includes("out"));
  assert.ok(result.stderr.includes("err"));
  assert.deepEqual(lines, ["stdout:out", "stderr:err"]);
  assert.equal(typeof result.durationMs, "number");
});

test("runProcess keeps partial stdout and stderr lines separate", async () => {
  const lines = [];
  const result = await runProcess({
    file: process.execPath,
    args: [
      "-e",
      `
      process.stdout.write("out");
      process.stderr.write("err");
      setTimeout(() => {
        process.stdout.write("1\\n");
        process.stderr.write("2\\n");
      }, 50);
    `,
    ],
    onLine: (line, stream) => lines.push(`${stream}:${line}`),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(lines.sort(), ["stderr:err2", "stdout:out1"].sort());
});

test("runProcess decodes UTF-8 characters split across byte chunks", async () => {
  const lines = [];
  const result = await runProcess({
    file: process.execPath,
    args: [
      "-e",
      `
      (async () => {
        for (const byte of Buffer.from("リンゴ\\n")) {
          process.stdout.write(Buffer.from([byte]));
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
      })();
    `,
    ],
    onLine: (line, stream) => lines.push(`${stream}:${line}`),
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "リンゴ\n");
  assert.deepEqual(lines, ["stdout:リンゴ"]);
});

test("runProcess retains the tail of noisy output and caps long lines", async () => {
  const lines = [];
  const result = await runProcess({
    file: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(600 * 1024) + 'TAIL')"],
    onLine: (line) => lines.push(line),
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout.length, 512 * 1024);
  assert.ok(result.stdout.endsWith("TAIL"));
  assert.equal(result.stdoutTruncated, true);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("…"));
  assert.ok(lines[0].endsWith("TAIL"));
  assert.ok(lines[0].length <= 512 * 1024 + 1);
});

test("runProcess reports spawn errors without throwing", async () => {
  const result = await runProcess({ file: "/definitely/not/a/binary", args: [] });
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(result.code, null);
});

test("runProcess aborts the whole child process", async () => {
  const controller = new AbortController();
  const promise = runProcess({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 80);
  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.ok, false);
});

test("runProcess enforces a timeout", async () => {
  const result = await runProcess({
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 120,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

test("parseTestOutput understands pytest summaries and failures", () => {
  const output = `==================== test session starts ====================\nFAILED tests/test_x.py::test_a - AssertionError\n2 failed, 2 passed in 0.04s\n==================== short test summary =====================\n`;
  const parsed = parseTestOutput(output, "pytest");
  assert.equal(parsed.passed, 2);
  assert.equal(parsed.failed, 2);
  assert.equal(parsed.durationMs, 40);
  assert.match(parsed.summary, /2 failed, 2 passed/);
  assert.equal(parsed.parseConfident, true);
});

test("parseTestOutput understands node:test output", () => {
  const parsed = parseTestOutput(
    "# tests 3\n# pass 2\n# fail 1\n# duration_ms 12.5\n",
    "node --test",
  );
  assert.equal(parsed.passed, 2);
  assert.equal(parsed.failed, 1);
  assert.equal(parsed.durationMs, 12.5);
  assert.equal(parsed.summary, "2 passed · 1 failed");
});

test("parseTestOutput understands the Node 24 spec reporter", () => {
  const output = `▶ src/app.test.mjs
  ✔ adds numbers (1.204ms)
  ✖ keeps the last element (0.812ms)
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10.25
`;
  const parsed = parseTestOutput(output, "node --test");
  assert.equal(parsed.passed, 1);
  assert.equal(parsed.failed, 1);
  assert.equal(parsed.durationMs, 10.25);
  assert.equal(parsed.summary, "1 passed · 1 failed");
  assert.equal(parsed.parseConfident, true);
  assert.deepEqual(
    parsed.cases.map((item) => [item.pass, item.name]),
    [
      [true, "adds numbers (1.204ms)"],
      [false, "keeps the last element (0.812ms)"],
    ],
  );
});

test("parseTestOutput understands Cargo and Go summaries", () => {
  const cargo = parseTestOutput("test result: ok. 3 passed; 0 failed; finished in 0.02s", "cargo");
  assert.equal(cargo.passed, 3);
  assert.equal(cargo.failed, 0);
  assert.equal(cargo.parseConfident, true);
  const go = parseTestOutput("ok  \texample.com/project/pkg\t0.20s", "go");
  assert.equal(go.failed, 0);
  assert.equal(go.summary, "ok");
  assert.equal(go.parseConfident, true);
});

test("parseTestOutput does not invent confidence for unknown output", () => {
  const parsed = parseTestOutput("something happened\n", "generic");
  assert.equal(parsed.parseConfident, false);
  assert.equal(parsed.passed, 0);
  assert.equal(parsed.failed, 0);
  assert.equal(parsed.summary, null);
});

test("runTests distinguishes verified, unverified, and failed execution", async () => {
  const execute = (script, framework = "generic") =>
    runTrustedTests({
      file: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      framework,
      display: "verification status check",
    });

  const empty = await execute("");
  assert.equal(empty.processOk, true);
  assert.equal(empty.ok, false);
  assert.equal(empty.verified, false);
  assert.equal(empty.verificationStatus, "unverified");
  assert.match(empty.summary, /unrecognized test output/);

  const zero = await execute("console.log('# pass 0\\n# fail 0\\n# duration_ms 1')", "node --test");
  assert.equal(zero.ok, true);
  assert.equal(zero.verified, true);
  assert.equal(zero.verificationStatus, "verified");
  assert.equal(zero.passed, 0);
  assert.equal(zero.failed, 0);

  const failed = await execute("process.exit(7)");
  assert.equal(failed.processOk, false);
  assert.equal(failed.ok, false);
  assert.equal(failed.verificationStatus, "failed");
});

test("runTests strips credentials and loader hooks from the child environment", async () => {
  const result = await runTrustedTests({
    file: process.execPath,
    args: [
      "-e",
      `
      console.log(JSON.stringify({
        secret: process.env.MATRIX_TEST_SECRET ?? null,
        key: process.env.OPENROUTER_API_KEY ?? null,
        loader: process.env.NODE_OPTIONS ?? null,
        path: Boolean(process.env.PATH),
      }));
      console.log("# pass 1\\n# fail 0\\n# duration_ms 1");
    `,
    ],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MATRIX_TEST_SECRET: "canary-secret",
      OPENROUTER_API_KEY: "canary-key",
      NODE_OPTIONS: "--require /definitely/not-present",
    },
    framework: "node --test",
    display: "environment check",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.lines[0]), {
    secret: null,
    key: null,
    loader: null,
    path: true,
  });
  assert.equal(result.stdout.includes("canary"), false);
});

test("runTests preserves a valid summary after more than 512 KiB of noise", async () => {
  const result = await runTrustedTests({
    file: process.execPath,
    args: [
      "-e",
      "process.stdout.write('x'.repeat(600 * 1024) + '\\n# pass 1\\n# fail 0\\n# duration_ms 1\\n')",
    ],
    cwd: process.cwd(),
    framework: "node --test",
    display: "noisy node tests",
  });
  assert.equal(result.ok, true);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.summary, "1 passed · 0 failed");
  assert.equal(result.parseConfident, true);
  assert.ok(result.lines.at(-1).includes("duration_ms"));
});

test("runTests keeps the latest 400 output lines and reports truncation", async () => {
  const result = await runTrustedTests({
    file: process.execPath,
    args: ["-e", "for (let i = 0; i < 450; i++) console.log(`line ${i}`)"],
    cwd: process.cwd(),
    framework: "generic",
    display: "noisy tests",
  });
  assert.equal(result.processOk, true);
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(result.verificationStatus, "unverified");
  assert.equal(result.lines.length, 400);
  assert.equal(result.lines[0], "line 50");
  assert.equal(result.lines.at(-1), "line 449");
  assert.equal(result.outputLineCount, 450);
  assert.equal(result.outputTruncated, true);
  assert.equal(typeof result.durationMs, "number");
});

test("runTests executes the real pytest runner on a temp demo", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  assert.equal(testPlanCommand(project.test), "python3 -m pytest -q");
  const baseline = await runTrustedTests(project.test, { cwd: project.test.cwd });
  assert.equal(baseline.ok, false);
  assert.equal(baseline.failed, 2);
  assert.equal(baseline.passed, 2);
  assert.ok(baseline.lines.length > 0);
  assert.ok(baseline.command.includes("pytest"));
});
