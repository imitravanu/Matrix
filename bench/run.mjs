// Matrix local benchmark runner. The default is a small smoke profile; the
// larger versioned fixtures require an explicit stress selection.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

import {
  BENCHMARK_FIXTURE_VERSION,
  BENCHMARK_SCHEMA_VERSION,
  BENCHMARK_SEED,
  BENCHMARK_SUITES,
  getBenchmarkProfile,
} from "./fixtures.mjs";
import { measureBenchmarkCase } from "./measure.mjs";
import { suiteDefinitions } from "./suites.mjs";

function selectedSuites(value) {
  const requested =
    value == null || value === "" || value === "all"
      ? [...BENCHMARK_SUITES]
      : (Array.isArray(value) ? value : String(value).split(","))
          .map((name) => String(name).trim().toLowerCase())
          .filter(Boolean);
  if (requested.includes("all")) return [...BENCHMARK_SUITES];
  if (requested.length === 0) throw new Error("--suite expects at least one suite name");
  const unknown = requested.filter((name) => !Object.hasOwn(suiteDefinitions, name));
  if (unknown.length > 0) {
    throw new Error(
      `unknown benchmark suite "${unknown[0]}"; choose from ${BENCHMARK_SUITES.join(", ")} or all`,
    );
  }
  const unique = new Set(requested);
  return BENCHMARK_SUITES.filter((name) => unique.has(name));
}

function normalizeSize(size = {}) {
  const columns = Math.max(40, Math.min(200, Math.floor(Number(size.columns) || 120)));
  const rows = Math.max(14, Math.min(80, Math.floor(Number(size.rows) || 36)));
  return { columns, rows };
}

function comparison(results, id, numeratorId, denominatorId, description) {
  const numerator = results.find((result) => result.id === numeratorId);
  const denominator = results.find((result) => result.id === denominatorId);
  if (!numerator || !denominator) return null;
  const ratio = (top, bottom) => (top > 0 && bottom > 0 ? top / bottom : null);
  return {
    id,
    description,
    numerator: numeratorId,
    denominator: denominatorId,
    p50Ratio: ratio(numerator.p50Ms, denominator.p50Ms),
    p95Ratio: ratio(numerator.p95Ms, denominator.p95Ms),
    policy: "reference-only ratio; no universal wall-clock pass/fail threshold",
  };
}

function runtimeMetadata() {
  const processors = cpus();
  return {
    node: {
      version: process.version,
      v8: process.versions.v8,
      uv: process.versions.uv,
      zlib: process.versions.zlib,
      modules: process.versions.modules,
    },
    platform: process.platform,
    platformRelease: release(),
    os: platform(),
    arch: process.arch,
    cpu: {
      model: processors[0]?.model ?? "unknown",
      logicalCount: processors.length,
    },
    totalMemoryBytes: totalmem(),
    pid: process.pid,
  };
}

/**
 * Run selected suites serially. A report is attached to thrown operational
 * errors as error.benchmarkReport after the same bounded cleanup has finished.
 */
export async function runBenchmarks({
  mode = "smoke",
  iterations = null,
  suites = null,
  size = null,
} = {}) {
  const profile = getBenchmarkProfile(mode, iterations);
  const selected = selectedSuites(suites);
  const geometry = normalizeSize(size ?? undefined);
  const root = mkdtempSync(join(tmpdir(), "matrix-bench-"));
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const context = {
    root,
    profile,
    size: geometry,
    cache: new Map(),
    resources: {
      inkActive: 0,
      inkMounts: 0,
      inkUnmounts: 0,
      processActive: 0,
      processRuns: 0,
    },
  };
  const results = [];
  const fixtures = [];
  let failure = null;
  let cleanupError = null;

  try {
    for (const suite of selected) {
      const prepared = await suiteDefinitions[suite](context);
      fixtures.push({ suite, ...prepared.fixture });
      for (const definition of prepared.cases) {
        const result = await measureBenchmarkCase({
          ...definition,
          suite,
          warmups: definition.warmups ?? profile.warmups,
          requestedIterations: profile.requestedIterations,
          iterations: definition.iterations ?? profile.iterations,
          iterationCap: definition.iterationCap ?? profile.maxIterations,
          fixture: definition.fixture ?? prepared.fixture,
        });
        if (suite === "render") {
          result.screen = definition.id.slice("render.".length);
          result.totalMs = result.samplesMs.reduce((sum, value) => sum + value, 0);
          result.perFrameMs = result.timingMs.mean;
          result.bytesPerFrame = Math.round(
            result.outputBytesBySample.reduce((sum, value) => sum + value, 0) /
              Math.max(1, result.outputBytesBySample.length),
          );
        }
        results.push(result);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
    }
  }

  const completedAt = new Date().toISOString();
  const cleanup = {
    strategy: "one mkdtemp root; recursive removal in finally; no caller workspace or demo writes",
    root,
    removed: !existsSync(root),
    error: cleanupError?.message ?? null,
    resources: { ...context.resources },
  };
  const comparisons = [
    comparison(
      results,
      "transcript.mount-vs-warm-update",
      "transcript.mount",
      "transcript.warm-update",
      "First Ink mount divided by a warm one-message rerender; mount and update are separate operations.",
    ),
    comparison(
      results,
      "event.sequential-vs-batched",
      "event.sequential-reduce",
      "event.batched-reduce",
      "Sequential reducer cost divided by one coalesced batch over the same deterministic event stream.",
    ),
  ].filter(Boolean);
  const functionalOk = results.every((result) => result.ok);
  const resourcesOk = cleanup.resources.inkActive === 0 && cleanup.resources.processActive === 0;
  const report = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    fixtureVersion: BENCHMARK_FIXTURE_VERSION,
    benchmark: "matrix-local-benchmarks",
    mode: profile.mode,
    stress: profile.stress,
    startedAt,
    completedAt,
    durationMs: Number(process.hrtime.bigint() - started) / 1e6,
    ...runtimeMetadata(),
    deterministicSeed: BENCHMARK_SEED,
    size: geometry,
    suites: selected,
    options: {
      mode: profile.mode,
      requestedIterations: profile.requestedIterations,
      profileIterations: profile.iterations,
      maxIterations: profile.maxIterations,
      warmups: profile.warmups,
      suites: selected,
      columns: geometry.columns,
      rows: geometry.rows,
    },
    reproduce: {
      command: `node bin/matrix.mjs bench${profile.stress ? " --stress" : ""} --json --iterations ${profile.requestedIterations} --suite ${selected.join(",")} --cols ${geometry.columns} --rows ${geometry.rows}`,
      workingDirectory: "Matrix package root",
      network: "none; local pure functions and process.execPath fixtures only",
      notes:
        "Fixture shapes, raw samples, effective per-case caps, and output-byte methods are recorded below. Wall-clock ratios are references, not portable SLAs.",
    },
    fixtures,
    results,
    comparisons,
    budgets: {
      timing:
        "none; CI should use functional work budgets and robust same-run ratios rather than universal timings",
      functional:
        "Each result's checks records expected and actual bounded-work/output invariants.",
    },
    cleanup,
    ok: !failure && !cleanupError && cleanup.removed && resourcesOk && functionalOk,
  };
  if (failure) {
    failure.benchmarkReport = report;
    throw failure;
  }
  return report;
}

function fixed(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

function bytes(value) {
  if (!Number.isFinite(value)) return "n/a";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MiB`;
}

export function formatBenchmarkText(report) {
  const lines = [];
  lines.push(
    `MATRIX BENCH · ${report.mode} · Node ${report.node.version} · ` +
      `${report.results.length} cases · fixture v${report.fixtureVersion}`,
  );
  lines.push(
    "  case                                      p50       p95       max      output    warmups/samples",
  );
  for (const result of report.results) {
    lines.push(
      `  ${result.id.padEnd(40)} ${fixed(result.p50Ms).padStart(8)}ms ` +
        `${fixed(result.p95Ms).padStart(8)}ms ${fixed(result.maxMs).padStart(8)}ms ` +
        `${bytes(result.outputBytes).padStart(9)}    ${result.warmups}/${result.iterations}`,
    );
  }
  const renderTotal = report.results
    .filter((result) => result.suite === "render")
    .reduce((sum, result) => sum + (result.p50Ms ?? 0), 0);
  if (renderTotal > 0)
    lines.push(
      `  render sweep p50 sum: ${renderTotal.toFixed(3)}ms (fresh mounts; not terminal write throughput)`,
    );
  for (const item of report.comparisons) {
    lines.push(
      `  ratio ${item.id}: p50 ${item.p50Ratio == null ? "n/a" : item.p50Ratio.toFixed(3)}× · ${item.policy}`,
    );
  }
  const failed = report.results.filter((result) => !result.ok);
  lines.push(
    `  functional checks: ${failed.length === 0 ? "passed" : `${failed.length} case(s) failed`} · ` +
      `temp cleanup: ${report.cleanup.removed ? "removed" : "FAILED"} · ` +
      `active Ink/process resources: ${report.cleanup.resources.inkActive}/${report.cleanup.resources.processActive}`,
  );
  if (!report.stress)
    lines.push("  larger bounded fixtures: node bin/matrix.mjs bench --stress --json");
  return `${lines.join("\n")}\n`;
}
