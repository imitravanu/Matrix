import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  COVERAGE_THRESHOLDS,
  evaluateCoverage,
  parseCoverageReport,
  runCoverage,
} from "../scripts/check-coverage.mjs";

function coverageFixture(prefix = "ℹ", { end = true } = {}) {
  return [
    `${prefix} tests 2`,
    `${prefix} pass 2`,
    `${prefix} start of coverage report`,
    `${prefix} ----------------------------------------`,
    `${prefix} file                 | line % | branch % | funcs % | uncovered lines`,
    `${prefix} ----------------------------------------`,
    `${prefix} lib                  |        |          |         |`,
    `${prefix}  controller.mjs      |  93.94 |    74.58 |   90.63 | 42`,
    `${prefix} src                  |        |          |         |`,
    `${prefix}  screens             |        |          |         |`,
    `${prefix}   chat.mjs           |  98.25 |    95.26 |   96.97 |`,
    `${prefix}  result-projection.mjs | 100.00 |    60.71 |  100.00 |`,
    `${prefix} ----------------------------------------`,
    `${prefix} all files            |  94.62 |    82.99 |   93.63 |`,
    `${prefix} ----------------------------------------`,
    ...(end ? [`${prefix} end of coverage report`] : []),
  ].join("\n");
}

test("coverage parsing handles Node 24 output and reconstructs nested paths", () => {
  const report = parseCoverageReport(coverageFixture());
  assert.deepEqual(report.files.get("lib/controller.mjs"), {
    line: 93.94,
    branch: 74.58,
    functions: 90.63,
  });
  assert.deepEqual(report.files.get("src/screens/chat.mjs"), {
    line: 98.25,
    branch: 95.26,
    functions: 96.97,
  });
  assert.deepEqual(report.summary, { line: 94.62, branch: 82.99, functions: 93.63 });
  const result = evaluateCoverage(report, {
    "lib/controller.mjs": { line: 90, branch: 70, functions: 90 },
    "src/result-projection.mjs": { line: 100, branch: 60, functions: 100 },
  });
  assert.deepEqual(result.failures, []);
});

test("coverage parsing handles TAP-prefixed Node 22 output", () => {
  const report = parseCoverageReport(coverageFixture("#"));
  assert.equal(report.files.get("src/result-projection.mjs").line, 100);
  assert.equal(report.files.get("src/screens/chat.mjs").functions, 96.97);
});

test("coverage parsing fails closed on missing, incomplete, and malformed reports", () => {
  assert.throws(() => parseCoverageReport(""), /missing or empty/);
  assert.throws(() => parseCoverageReport("ℹ tests 1\nℹ pass 1"), /incomplete/);
  assert.throws(() => parseCoverageReport(coverageFixture("ℹ", { end: false })), /incomplete/);
  assert.throws(
    () => parseCoverageReport(coverageFixture().replace("74.58", "not-a-number")),
    /Malformed branch coverage/,
  );
  assert.throws(
    () => parseCoverageReport(coverageFixture().replace("line %", "lines")),
    /Unsupported coverage headings/,
  );
});

test("coverage evaluation rejects low values and missing critical modules", () => {
  const report = parseCoverageReport(coverageFixture());
  const { failures } = evaluateCoverage(report, {
    "lib/controller.mjs": { line: 95, branch: 70, functions: 90 },
    "lib/workspace.mjs": { line: 95, branch: 90, functions: 100 },
  });
  assert.ok(failures.some((failure) => failure.includes("line 93.94% is below 95.00%")));
  assert.ok(
    failures.some((failure) => failure === "lib/workspace.mjs: missing from coverage report"),
  );
});

test("critical ratchets retain the reviewed safety floors and public contracts", () => {
  const reviewed = {
    "lib/controller.mjs": [90, 70, 90],
    "lib/diff.mjs": [95, 85, 90],
    "lib/local-agent.mjs": [95, 80, 95],
    "lib/model-agent.mjs": [90, 75, 95],
    "lib/openrouter.mjs": [90, 82, 95],
    "lib/outcome.mjs": [95, 90, 100],
    "lib/process.mjs": [90, 85, 90],
    "lib/project.mjs": [90, 75, 95],
    "lib/session.mjs": [90, 78, 95],
    "lib/workspace.mjs": [95, 90, 100],
  };
  for (const [path, [line, branch, functions]] of Object.entries(reviewed)) {
    assert.ok(COVERAGE_THRESHOLDS[path].line >= line, `${path} line floor`);
    assert.ok(COVERAGE_THRESHOLDS[path].branch >= branch, `${path} branch floor`);
    assert.ok(COVERAGE_THRESHOLDS[path].functions >= functions, `${path} function floor`);
  }
  assert.ok(COVERAGE_THRESHOLDS["src/event-reducer.mjs"]);
  assert.ok(COVERAGE_THRESHOLDS["src/result-projection.mjs"]);
});

test("coverage runner preserves ordinary test failure exit codes", async () => {
  const failingSpawn = (command, _args, options) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawn(command, ["-e", "process.exit(7)"], { ...options, env });
  };
  const sink = { write() {} };
  assert.equal(await runCoverage({ spawnImpl: failingSpawn, stdout: sink, stderr: sink }), 7);
});

test("coverage runner rejects a successful test run without a parseable report", async () => {
  const reportlessSpawn = (command, _args, options) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawn(command, ["-e", "console.log('tests passed')"], { ...options, env });
  };
  const sink = { write() {} };
  let errors = "";
  const stderr = { write: (chunk) => (errors += chunk) };
  assert.equal(await runCoverage({ spawnImpl: reportlessSpawn, stdout: sink, stderr }), 1);
  assert.match(errors, /Coverage report rejected: Coverage report is incomplete/);
});
