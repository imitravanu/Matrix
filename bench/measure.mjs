// Measurement primitives shared by every benchmark suite. Timings use a
// monotonic clock; textual output sizes always use Buffer.byteLength, never
// JavaScript's UTF-16 code-unit length.

export function utf8ByteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return Buffer.byteLength(value);
  if (value instanceof ArrayBuffer) return Buffer.byteLength(value);
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized === undefined ? String(value) : serialized, "utf8");
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function memorySnapshot() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

function memoryDelta(after, before) {
  return Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
}

function peakMemory(current, sample) {
  return Object.fromEntries(
    Object.keys(current).map((key) => [key, Math.max(current[key], sample[key])]),
  );
}

function measurementEnvelope(value) {
  if (
    value &&
    typeof value === "object" &&
    (Object.hasOwn(value, "output") ||
      Object.hasOwn(value, "outputBytes") ||
      value.details ||
      value.checks)
  ) {
    return {
      output: value.output,
      outputBytes: value.outputBytes,
      outputByteMethod: value.outputByteMethod,
      details: value.details ?? {},
      checks: value.checks ?? [],
    };
  }
  return { output: value, details: {}, checks: [] };
}

function mergeChecks(target, checks, sampleIndex) {
  for (const check of checks) {
    const normalized =
      typeof check === "boolean" ? { name: `check-${target.length}`, ok: check } : check;
    const name = normalized.name ?? `check-${target.length}`;
    let aggregate = target.find((entry) => entry.name === name);
    if (!aggregate) {
      aggregate = {
        name,
        ok: true,
        failures: 0,
        samples: 0,
        expected: normalized.expected,
        actual: normalized.actual,
      };
      target.push(aggregate);
    }
    aggregate.samples++;
    aggregate.actual = normalized.actual;
    if (aggregate.expected === undefined) aggregate.expected = normalized.expected;
    if (!normalized.ok) {
      aggregate.ok = false;
      aggregate.failures++;
      aggregate.lastFailureSample = sampleIndex;
    }
  }
}

/**
 * Measure one case serially. prepare/cleanup surround every warmup and sample,
 * but only operation is timed. Cleanup always runs, including thrown operations.
 */
export async function measureBenchmarkCase(definition) {
  const iterations = Math.max(
    1,
    Math.min(positiveCap(definition.iterationCap), positiveCap(definition.iterations)),
  );
  const warmups = Math.max(0, Math.floor(Number(definition.warmups) || 0));
  const samplesMs = [];
  const outputBytesBySample = [];
  const checks = [];
  const before = memorySnapshot();
  let peak = before;
  let details = {};
  let outputBytes = 0;
  let outputByteMethod =
    definition.outputByteMethod ??
    "Buffer.byteLength(text, 'utf8'), Buffer.byteLength(JSON.stringify(object)), or Buffer.byteLength(binaryView)";

  for (let sequence = 0; sequence < warmups + iterations; sequence++) {
    const warmup = sequence < warmups;
    const sampleIndex = sequence - warmups;
    let prepared;
    try {
      prepared = await definition.prepare?.({ iteration: sampleIndex, sequence, warmup });
      const started = process.hrtime.bigint();
      const raw = await definition.operation(prepared, {
        iteration: sampleIndex,
        sequence,
        warmup,
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      peak = peakMemory(peak, memorySnapshot());
      if (warmup) continue;
      const measured = measurementEnvelope(raw);
      samplesMs.push(elapsedMs);
      outputBytes =
        measured.outputBytes === undefined ? utf8ByteLength(measured.output) : measured.outputBytes;
      if (!Number.isSafeInteger(outputBytes) || outputBytes < 0) {
        throw new Error(`invalid output byte count for ${definition.id}`);
      }
      outputBytesBySample.push(outputBytes);
      outputByteMethod = measured.outputByteMethod ?? outputByteMethod;
      details = measured.details ?? {};
      mergeChecks(checks, measured.checks ?? [], sampleIndex);
    } catch (error) {
      if (!error.benchmarkCase) error.benchmarkCase = definition.id;
      throw error;
    } finally {
      await definition.cleanup?.(prepared, { iteration: sampleIndex, sequence, warmup });
    }
  }

  mergeChecks(
    checks,
    [
      {
        name: "output-byte-count",
        ok: outputBytesBySample.every((value) => Number.isSafeInteger(value) && value >= 0),
        expected: "non-negative safe integer Buffer.byteLength values",
        actual: outputBytes,
      },
    ],
    Math.max(0, samplesMs.length - 1),
  );
  const after = memorySnapshot();
  const totalMs = samplesMs.reduce((sum, value) => sum + value, 0);
  const timingMs = {
    min: samplesMs.length ? Math.min(...samplesMs) : null,
    p50: percentile(samplesMs, 0.5),
    p95: percentile(samplesMs, 0.95),
    max: samplesMs.length ? Math.max(...samplesMs) : null,
    mean: samplesMs.length ? totalMs / samplesMs.length : null,
  };
  return {
    id: definition.id,
    suite: definition.suite,
    operation: definition.operationName ?? "operation",
    fixture: definition.fixture ?? {},
    warmups,
    requestedIterations: definition.requestedIterations ?? definition.iterations,
    profileIterations: definition.iterations,
    iterationCap: positiveCap(definition.iterationCap),
    iterations,
    samplesMs,
    timingMs,
    p50Ms: timingMs.p50,
    p95Ms: timingMs.p95,
    maxMs: timingMs.max,
    inputBytes: definition.inputBytes ?? definition.fixture?.inputBytes ?? null,
    outputBytes,
    outputBytesBySample,
    outputByteMethod,
    memory: {
      unit: "bytes",
      method: "process.memoryUsage() before/after the case and after every operation; no forced GC",
      before,
      after,
      delta: memoryDelta(after, before),
      peak,
      gcExposed: typeof globalThis.gc === "function",
    },
    details,
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function positiveCap(value) {
  const number = Math.max(1, Math.floor(Number(value) || 1));
  if (!Number.isSafeInteger(number))
    throw new Error("benchmark iteration cap is not a safe integer");
  return number;
}
