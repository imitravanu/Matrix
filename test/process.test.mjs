import test from "node:test";
import assert from "node:assert/strict";

import { parseTestOutput, runProcess, runTests, testPlanCommand } from "../lib/process.mjs";
import { detectProject } from "../lib/project.mjs";
import { copyDemo } from "./helpers.mjs";

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
  const parsed = parseTestOutput("# tests 3\n# pass 2\n# fail 1\n# duration_ms 12.5\n", "node --test");
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
    [[true, "adds numbers (1.204ms)"], [false, "keeps the last element (0.812ms)"]]
  );
});

test("parseTestOutput does not invent confidence for unknown output", () => {
  const parsed = parseTestOutput("something happened\n", "generic");
  assert.equal(parsed.parseConfident, false);
  assert.equal(parsed.passed, 0);
  assert.equal(parsed.failed, 0);
  assert.equal(parsed.summary, null);
});

test("runTests executes the real pytest runner on a temp demo", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  assert.equal(testPlanCommand(project.test), "python3 -m pytest -q");
  const baseline = await runTests(project.test, { cwd: project.test.cwd });
  assert.equal(baseline.ok, false);
  assert.equal(baseline.failed, 2);
  assert.equal(baseline.passed, 2);
  assert.ok(baseline.lines.length > 0);
  assert.ok(baseline.command.includes("pytest"));
});
