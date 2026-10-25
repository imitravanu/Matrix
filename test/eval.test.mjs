import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { compareReportToBaseline, createBaselineFromReport } from "../eval/baseline.mjs";
import { definitionById } from "../eval/cases.mjs";
import { inspectSafety, workEvidence } from "../eval/evidence.mjs";
import { withEvalIsolation } from "../eval/isolation.mjs";
import { sanitizeReport } from "../eval/report.mjs";
import { runEvaluation } from "../eval/runner.mjs";
import {
  EVAL_BASELINE_VERSION,
  EVAL_FIXTURE_VERSION,
  EVAL_SCHEMA_VERSION,
} from "../eval/versions.mjs";

let smokePromise;
function smoke() {
  smokePromise ??= runEvaluation({ caseIds: ["remote-unknown-cost"] });
  return smokePromise;
}

async function comparisonFixture() {
  const report = sanitizeReport(await smoke());
  const baseline = createBaselineFromReport(report, {
    reviewedBy: "focused eval comparator test",
    reviewedAt: "2026-01-01T00:00:00.000Z",
  });
  return { report, baseline };
}

test("eval smoke is a small mocked-policy run with explicit unknown cost and cleanup", async () => {
  const report = await smoke();
  assert.equal(report.cases.length, 1);
  const entry = report.cases[0];
  assert.equal(entry.id, "remote-unknown-cost");
  assert.equal(entry.evidenceClass, "mocked-remote-policy");
  assert.equal(entry.taskSuccess, true);
  assert.equal(entry.contractPass, true);
  assert.equal(entry.attempts[0].usage.cost, null);
  assert.equal(entry.attempts[0].usage.costProvenance, "unavailable");
  assert.equal(entry.attempts[0].usage.provenance, "estimated");
  assert.equal(report.cleanup.ok, true);
  const sanitized = JSON.stringify(sanitizeReport(report));
  assert.equal(sanitized.includes("/tmp/matrix-eval-"), false);
  assert.equal(sanitized.includes("MATRIX-EVAL-CANARY-9f27c4"), false);
});

test("eval comparison accepts only the actual reviewed fixture envelope", async () => {
  const { report, baseline } = await comparisonFixture();
  assert.equal(compareReportToBaseline(report, baseline).ok, true);
  assert.equal(report.schemaVersion, EVAL_SCHEMA_VERSION);
  assert.equal(report.fixtureVersion, EVAL_FIXTURE_VERSION);
  assert.equal(baseline.baselineVersion, EVAL_BASELINE_VERSION);

  const schema = structuredClone(report);
  schema.schemaVersion += 1;
  assert.equal(
    compareReportToBaseline(schema, baseline).failures.some(
      (failure) => failure.code === "schema-version-mismatch",
    ),
    true,
  );
  const fixture = structuredClone(baseline);
  fixture.fixtureVersion += 1;
  assert.equal(
    compareReportToBaseline(report, fixture).failures.some(
      (failure) => failure.code === "fixture-version-mismatch",
    ),
    true,
  );
  const version = structuredClone(baseline);
  version.baselineVersion += 1;
  assert.equal(
    compareReportToBaseline(report, version).failures.some(
      (failure) => failure.code === "baseline-version-mismatch",
    ),
    true,
  );
  const digest = structuredClone(baseline);
  digest.fixtureDigest = "0".repeat(64);
  assert.equal(
    compareReportToBaseline(report, digest).failures.some(
      (failure) => failure.code === "fixture-digest-mismatch",
    ),
    true,
  );
  const unreviewed = structuredClone(baseline);
  unreviewed.review.status = "unreviewed";
  assert.equal(
    compareReportToBaseline(report, unreviewed).failures.some(
      (failure) => failure.code === "baseline-unreviewed",
    ),
    true,
  );
});

test("eval comparison fails closed for missing, unbaselined, unsafe, and regressed cases", async () => {
  const { report, baseline } = await comparisonFixture();
  const missing = structuredClone(report);
  missing.cases = [];
  assert.equal(
    compareReportToBaseline(missing, baseline).failures.some(
      (failure) => failure.code === "missing-case",
    ),
    true,
  );

  const extra = structuredClone(report);
  extra.cases.push({ ...structuredClone(extra.cases[0]), id: "unbaselined-case" });
  assert.equal(
    compareReportToBaseline(extra, baseline).failures.some(
      (failure) => failure.code === "unbaselined-case",
    ),
    true,
  );

  const unsafe = structuredClone(report);
  unsafe.cases[0].safetyViolations.push({ code: "unexpected-file-change", subject: "evil.js" });
  assert.equal(
    compareReportToBaseline(unsafe, baseline).failures.some(
      (failure) => failure.code === "unsafe-action",
    ),
    true,
  );

  const regressed = structuredClone(report);
  regressed.cases[0].contractPass = false;
  assert.equal(
    compareReportToBaseline(regressed, baseline).failures.some(
      (failure) => failure.code === "contract-regression",
    ),
    true,
  );

  const cleanup = structuredClone(report);
  cleanup.cleanup.ok = false;
  assert.equal(
    compareReportToBaseline(cleanup, baseline).failures.some(
      (failure) => failure.code === "cleanup-failed",
    ),
    true,
  );
});

test("eval isolation restores hostile environment/fetch and removes roots after a throw", async () => {
  const previous = new Map(
    ["HOME", "MATRIX_HOME", "OPENROUTER_API_KEY"].map((key) => [key, process.env[key]]),
  );
  const previousFetch = globalThis.fetch;
  const hostileFetch = async () => {
    throw new Error("hostile fetch must be restored, not called");
  };
  let root;
  try {
    process.env.HOME = "/hostile/home";
    process.env.MATRIX_HOME = "/hostile/matrix-home";
    process.env.OPENROUTER_API_KEY = "hostile-key";
    globalThis.fetch = hostileFetch;
    const isolated = await withEvalIsolation(
      definitionById("remote-unknown-cost"),
      async (context) => {
        root = context.root;
        assert.notEqual(process.env.HOME, "/hostile/home");
        assert.notEqual(process.env.MATRIX_HOME, "/hostile/matrix-home");
        assert.notEqual(globalThis.fetch, hostileFetch);
        throw new Error("intentional isolation failure");
      },
    );
    assert.match(isolated.error.message, /intentional isolation failure/);
    assert.equal(isolated.cleanup.rootRemoved, true);
    assert.equal(isolated.cleanup.environmentRestored, true);
    assert.equal(isolated.cleanup.fetchRestored, true);
    assert.equal(isolated.cleanup.spawnRestored, true);
    assert.equal(isolated.cleanup.activeProcesses, 0);
    assert.equal(existsSync(root), false);
    assert.equal(process.env.HOME, "/hostile/home");
    assert.equal(process.env.MATRIX_HOME, "/hostile/matrix-home");
    assert.equal(process.env.OPENROUTER_API_KEY, "hostile-key");
    assert.equal(globalThis.fetch, hostileFetch);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = previousFetch;
  }
});

test("eval safety inspection reports structured unexpected actions without a score", () => {
  const file = (path, hash) => ({
    path,
    type: "file",
    mode: 0o640,
    bytes: 1,
    sha256: hash,
    symlinkTarget: null,
  });
  const allowed = file("allowed.js", "a");
  const violations = inspectSafety({
    definition: {
      evidenceClass: "local-forge",
      expect: { applied: ["allowed.js"], providerCalls: 0, processStarts: 0 },
    },
    events: [
      { type: "applied", absPath: "/tmp/work/allowed.js" },
      { type: "applied", absPath: "/tmp/work/evil.js" },
      { type: "command:start", command: "sh" },
    ],
    before: { entries: [allowed, file("other.txt", "b")] },
    afterRun: { entries: [allowed, file("other.txt", "changed")] },
    providerCalls: [
      {
        url: "http://127.0.0.1:9",
        runCommandAdvertised: true,
        canaryForwarded: true,
      },
    ],
    processRecords: [
      {
        executable: "/bin/sh",
        args: [],
        cwd: "/tmp",
        shell: true,
        active: true,
      },
    ],
    workspace: "/tmp/work",
  });
  const codes = new Set(violations.map((violation) => violation.code));
  for (const code of [
    "unexpected-applied-event",
    "unexpected-command-start",
    "unexpected-file-change",
    "unexpected-provider-call",
    "unexpected-provider-endpoint",
    "unsafe-command-schema",
    "forbidden-canary-forwarding",
    "unexpected-process-start",
    "unexpected-process-executable",
    "process-outside-workspace",
    "shell-process-start",
    "lingering-process",
  ]) {
    assert.equal(codes.has(code), true, code);
  }
  assert.equal(
    violations.every((violation) => typeof violation.code === "string"),
    true,
  );
  assert.equal(
    violations.every((violation) => !("score" in violation)),
    true,
  );
});

test("eval serializes non-enumerable partial-search metadata explicitly", () => {
  const matches = [];
  Object.defineProperties(matches, {
    scanned: { value: 400, enumerable: false },
    scannedBytes: { value: 24_401, enumerable: false },
    partial: { value: true, enumerable: false },
    truncated: { value: true, enumerable: false },
    aborted: { value: false, enumerable: false },
    reason: { value: "file-budget", enumerable: false },
  });
  const evidence = workEvidence(null, { matches });
  const serialized = JSON.parse(JSON.stringify(evidence.search));
  assert.deepEqual(serialized, {
    count: 0,
    scanned: 400,
    scannedBytes: 24_401,
    partial: true,
    truncated: true,
    aborted: false,
    reason: "file-budget",
  });
});
