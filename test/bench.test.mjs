import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { BENCHMARK_SUITES, getBenchmarkProfile } from "../bench/fixtures.mjs";
import { measureBenchmarkCase, utf8ByteLength } from "../bench/measure.mjs";
import { runBenchmarks } from "../bench/run.mjs";
import { suiteDefinitions } from "../bench/suites.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(PACKAGE_ROOT, "bin", "matrix.mjs");
const DEMO = join(PACKAGE_ROOT, "demo-project");

function isolatedEnvironment(t) {
  const root = mkdtempSync(join(tmpdir(), "matrix-bench-test-home-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    ...process.env,
    HOME: root,
    MATRIX_HOME: join(root, "matrix-home"),
    NO_COLOR: "1",
    OPENROUTER_API_KEY: "benchmark-fake-key-never-used",
    OPENROUTER_BASE_URL: "http://127.0.0.1:9",
    MATRIX_API_BASE: "http://127.0.0.1:9",
    OPENAI_BASE_URL: "http://127.0.0.1:9",
    OLLAMA_HOST: "http://127.0.0.1:9",
  };
}

function runCli(args, env) {
  const stdout = execFileSync(process.execPath, [CLI, ...args], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function digestTree(root) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        visit(path);
      } else if (entry.isFile()) {
        hash.update(`file:${rel}:`);
        hash.update(readFileSync(path));
        hash.update("\n");
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

test("benchmark measurements count UTF-8 bytes, report percentiles, and clean failed iterations", async () => {
  const sample = "λ🙂";
  assert.equal(sample.length, 3, "fixture must distinguish UTF-16 code units from bytes");
  assert.equal(utf8ByteLength(sample), Buffer.byteLength(sample));
  assert.equal(utf8ByteLength(sample), 6);

  const result = await measureBenchmarkCase({
    id: "test.utf8",
    suite: "test",
    warmups: 1,
    iterations: 3,
    iterationCap: 3,
    operation: () => sample,
  });
  assert.deepEqual(result.outputBytesBySample, [6, 6, 6]);
  assert.equal(result.samplesMs.length, 3);
  assert.equal(result.warmups, 1);
  assert.ok(result.timingMs.p50 <= result.timingMs.p95);
  assert.ok(result.timingMs.p95 <= result.timingMs.max);
  assert.match(result.outputByteMethod, /Buffer\.byteLength/);
  assert.equal(result.memory.unit, "bytes");
  assert.ok(Number.isSafeInteger(result.memory.peak.rss));

  let cleanups = 0;
  await assert.rejects(
    measureBenchmarkCase({
      id: "test.failure-cleanup",
      suite: "test",
      warmups: 0,
      iterations: 1,
      iterationCap: 1,
      prepare: () => ({ temporary: true }),
      operation: () => {
        throw new Error("intentional benchmark failure");
      },
      cleanup: (prepared) => {
        assert.equal(prepared.temporary, true);
        cleanups++;
      },
    }),
    /intentional benchmark failure/,
  );
  assert.equal(cleanups, 1, "cleanup runs exactly once after an operational failure");
});

test("benchmark runner removes its temporary root when suite setup fails", async () => {
  const original = suiteDefinitions.event;
  suiteDefinitions.event = () => {
    throw new Error("intentional suite setup failure");
  };
  try {
    await assert.rejects(runBenchmarks({ suites: ["event"], iterations: 1 }), (error) => {
      assert.match(error.message, /intentional suite setup failure/);
      assert.ok(error.benchmarkReport);
      assert.equal(error.benchmarkReport.ok, false);
      assert.equal(error.benchmarkReport.cleanup.removed, true);
      assert.equal(existsSync(error.benchmarkReport.cleanup.root), false);
      assert.equal(error.benchmarkReport.cleanup.resources.processActive, 0);
      return true;
    });
  } finally {
    suiteDefinitions.event = original;
  }
});

test("bench JSON has reproduction metadata and byte counts, bounded cleanup, and no demo writes", (t) => {
  const env = isolatedEnvironment(t);
  const demoBefore = digestTree(DEMO);
  const report = runCli(["bench", "--demo", "--iterations", "1", "--json"], env);

  assert.equal(report.ok, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.fixtureVersion, 1);
  assert.equal(report.mode, "smoke");
  assert.equal(report.stress, false);
  assert.equal(report.node.version, process.version);
  assert.deepEqual(report.suites, BENCHMARK_SUITES);
  assert.match(report.reproduce.command, /node bin\/matrix\.mjs bench/);
  assert.match(report.reproduce.command, /--iterations 1/);
  assert.match(report.reproduce.network, /none/);
  assert.equal(report.options.requestedIterations, 1);
  assert.ok(
    report.fixtures.some((fixture) => fixture.suite === "transcript" && fixture.messages > 0),
  );
  assert.ok(
    report.fixtures.some((fixture) => fixture.suite === "index" && fixture.sourceFilesCreated > 0),
  );

  for (const result of report.results) {
    assert.equal(result.samplesMs.length, result.iterations, result.id);
    assert.equal(result.outputBytesBySample.length, result.iterations, result.id);
    assert.equal(result.warmups, 1, result.id);
    assert.ok(Number.isFinite(result.timingMs.p50), result.id);
    assert.ok(Number.isFinite(result.timingMs.p95), result.id);
    assert.ok(Number.isFinite(result.timingMs.max), result.id);
    assert.ok(result.timingMs.p50 <= result.timingMs.p95, result.id);
    assert.ok(result.timingMs.p95 <= result.timingMs.max, result.id);
    assert.ok(Number.isSafeInteger(result.outputBytes) && result.outputBytes >= 0, result.id);
    assert.match(result.outputByteMethod, /Buffer\.byteLength/, result.id);
    assert.equal(result.memory.unit, "bytes", result.id);
    assert.ok(Number.isSafeInteger(result.memory.peak.rss), result.id);
    assert.ok(
      result.checks.every((check) => check.ok),
      result.id,
    );
  }

  const ansi = report.results.find((result) => result.id === "raster.ansi");
  assert.ok(
    ansi.outputBytes > ansi.details.codeUnits,
    "half-block Unicode is measured as bytes, not code units",
  );
  assert.equal(ansi.outputBytes, ansi.details.utf8Bytes);
  const diff = report.results.find((result) => result.id === "diff.long-line-generation");
  assert.ok(diff.outputBytes > diff.details.patchCodeUnits);
  assert.equal(diff.outputBytes, diff.details.patchBytes);
  const processResult = report.results.find((result) => result.id === "process.noisy-output");
  assert.equal(
    processResult.outputBytes,
    processResult.details.stdoutBytes + processResult.details.stderrBytes,
  );
  assert.ok(processResult.details.retainedLines <= 400);
  assert.equal(processResult.details.stdoutTruncated, true);
  const index = report.results.find((result) => result.id === "index.scan-bounded");
  const indexFixture = report.fixtures.find((fixture) => fixture.suite === "index");
  assert.ok(index.details.entriesSeen <= indexFixture.scanBudgets.maxEntries);
  assert.ok(index.details.files <= indexFixture.scanBudgets.maxFiles);
  assert.ok(report.comparisons.some((item) => item.id === "transcript.mount-vs-warm-update"));
  assert.ok(report.comparisons.some((item) => item.id === "event.sequential-vs-batched"));

  assert.equal(report.cleanup.removed, true);
  assert.equal(existsSync(report.cleanup.root), false);
  assert.equal(report.cleanup.resources.inkActive, 0);
  assert.equal(report.cleanup.resources.processActive, 0);
  assert.equal(report.cleanup.resources.inkMounts, report.cleanup.resources.inkUnmounts);
  assert.equal(
    report.cleanup.resources.processRuns,
    2,
    "one warmup and one measured child, with none left active",
  );
  assert.equal(digestTree(DEMO), demoBefore, "the checked-in demo remains byte-for-byte unchanged");
});

test("stress is explicit, suite-selectable, versioned, and bounded", (t) => {
  const env = isolatedEnvironment(t);
  const profile = getBenchmarkProfile("stress", 1_000_000);
  assert.equal(profile.stress, true);
  assert.equal(profile.iterations, 20);
  assert.equal(profile.index.files, 100_000);
  assert.equal(profile.parser.pythonNested, 1000);
  assert.equal(profile.transcript.messages, 600);
  assert.equal(profile.transcript.collapsedReasoningBytes, 1024 * 1024);
  assert.equal(profile.transcript.longLineBytes, 40 * 1024);
  assert.equal(profile.session.sessions, 1000);
  assert.equal(profile.session.transcriptMessages, 600);
  assert.equal(profile.event.contentEvents, 10_000);
  assert.equal(profile.graph.scopes, 8000);

  // Select the inexpensive render suite so this CLI contract test does not
  // materialize the 100,000-file/index or 1,000-session stress fixtures.
  const report = runCli(
    ["bench", "--stress", "--suite", "render", "--iterations", "1", "--json"],
    env,
  );
  assert.equal(report.ok, true);
  assert.equal(report.mode, "stress");
  assert.equal(report.stress, true);
  assert.deepEqual(report.suites, ["render"]);
  assert.equal(report.results.length, 8);
  assert.ok(report.results.every((result) => result.suite === "render" && result.warmups === 2));
  assert.equal(report.cleanup.removed, true);
  assert.equal(existsSync(report.cleanup.root), false);

  const wrongCommand = spawnSync(process.execPath, [CLI, "sessions", "--stress"], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(wrongCommand.status, 1);
  assert.match(wrongCommand.stderr, /--stress and --suite are only valid with matrix bench/);

  const emptySuite = spawnSync(process.execPath, [CLI, "bench", "--suite", ","], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(emptySuite.status, 1);
  assert.match(emptySuite.stderr, /at least one suite name/);
});
