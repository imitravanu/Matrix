// Deterministic, local-only fixtures for Matrix benchmarks. Nothing in this
// module reads a provider, the checked-in demo, or the caller's workspace.

import { linkSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { saveSession } from "../lib/session.mjs";

export const BENCHMARK_SCHEMA_VERSION = 1;
export const BENCHMARK_FIXTURE_VERSION = 1;
export const BENCHMARK_SEED = 0x4d415452;
export const BENCHMARK_SUITES = Object.freeze([
  "render",
  "index",
  "parser",
  "transcript",
  "diff",
  "process",
  "session",
  "event",
  "graph",
  "raster",
]);

// Shapes are deliberately versioned and reported with every result. Stress is
// bounded by construction: no caller-provided path, fixture size, or unbounded
// iteration count is accepted. Iteration overrides only repeat these fixtures.
const PROFILES = {
  smoke: {
    warmups: 1,
    iterations: 5,
    maxIterations: 100,
    index: {
      files: 384,
      directories: 12,
      maxFiles: 128,
      maxEntries: 512,
      maxDirectories: 32,
    },
    parser: {
      flat: 120,
      pythonNested: 160,
      javascriptNested: 320,
      adversarial: 120,
    },
    transcript: {
      messages: 80,
      contentBytes: 160,
      collapsedReasoningBytes: 4096,
      longLineBytes: 4096,
    },
    process: {
      noiseLines: 450,
      longLineBytes: 600 * 1024,
      maxIterations: 3,
    },
    session: {
      sessions: 40,
      messagesPerSession: 8,
      messageBytes: 128,
      transcriptMessages: 120,
      transcriptMessageBytes: 128,
    },
    event: {
      contentEvents: 2000,
      thoughtEvents: 240,
    },
    graph: {
      scopes: 512,
      width: 120,
      height: 68,
    },
  },
  stress: {
    warmups: 2,
    iterations: 11,
    maxIterations: 20,
    index: {
      // The scan itself uses a small work budget against this 100,000-file
      // tree. Hard links avoid duplicating source data during fixture setup.
      files: 100_000,
      directories: 100,
      maxFiles: 250,
      maxEntries: 2000,
      maxDirectories: 100,
    },
    parser: {
      flat: 1000,
      pythonNested: 1000,
      javascriptNested: 6000,
      adversarial: 1000,
    },
    transcript: {
      messages: 600,
      contentBytes: 240,
      collapsedReasoningBytes: 1024 * 1024,
      longLineBytes: 40 * 1024,
    },
    process: {
      noiseLines: 5000,
      longLineBytes: 600 * 1024,
      maxIterations: 5,
    },
    session: {
      sessions: 1000,
      messagesPerSession: 24,
      messageBytes: 512,
      transcriptMessages: 600,
      transcriptMessageBytes: 512,
    },
    event: {
      contentEvents: 10_000,
      thoughtEvents: 2000,
    },
    graph: {
      scopes: 8000,
      width: 160,
      height: 96,
    },
  },
};

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(`${label} expects a positive integer`);
  return number;
}

export function getBenchmarkProfile(mode = "smoke", requestedIterations = null) {
  if (!Object.hasOwn(PROFILES, mode)) throw new Error(`unknown benchmark mode: ${mode}`);
  const base = PROFILES[mode];
  const requested =
    requestedIterations == null
      ? base.iterations
      : positiveInteger(requestedIterations, "--iterations");
  return {
    mode,
    stress: mode === "stress",
    warmups: base.warmups,
    requestedIterations: requested,
    iterations: Math.min(base.maxIterations, requested),
    maxIterations: base.maxIterations,
    index: { ...base.index },
    parser: { ...base.parser },
    transcript: { ...base.transcript },
    process: { ...base.process },
    session: { ...base.session },
    event: { ...base.event },
    graph: { ...base.graph },
  };
}

/** Repeat complete Unicode text until at least the requested UTF-8 byte size. */
export function repeatToBytes(unit, targetBytes) {
  const text = String(unit);
  const unitBytes = Buffer.byteLength(text);
  if (unitBytes === 0) throw new Error("fixture unit must contain at least one byte");
  const target = Math.max(1, Math.floor(Number(targetBytes) || 1));
  return text.repeat(Math.ceil(target / unitBytes));
}

export function pythonFlatSource(count) {
  const lines = [];
  for (let index = 0; index < count; index++) {
    lines.push(`def flat_${index}(value):`, `    return value + ${index}`, "");
  }
  return lines.join("\n");
}

export function pythonNestedSource(count) {
  const lines = [];
  for (let index = 0; index < count; index++) {
    lines.push(`${" ".repeat(index * 4)}def nested_${index}():`);
  }
  lines.push(`${" ".repeat(count * 4)}return ${count}`);
  return lines.join("\n");
}

export function javascriptFlatSource(count) {
  const lines = [];
  for (let index = 0; index < count; index++) {
    lines.push(`function flat_${index}(value) {`, `  return value + ${index};`, "}", "");
  }
  return lines.join("\n");
}

export function javascriptNestedSource(count) {
  const lines = [];
  for (let index = 0; index < count; index++) lines.push(`function nested_${index}() {`);
  lines.push(`return ${count};`);
  for (let index = 0; index < count; index++) lines.push("}");
  return lines.join("\n");
}

export function javascriptAdversarialSource(count) {
  const lines = [];
  for (let index = 0; index < count; index++) {
    lines.push(
      `// function fake_${index}() { ( [ ] )`,
      `const text_${index} = "function fake() { ( [ ] ) }";`,
      `const pattern_${index} = /[{}()]+/g;`,
      `function real_${index}(value = /[{}()]/) {`,
      "  return value;",
      "}",
      "",
    );
  }
  return lines.join("\n");
}

export function makeLongLineFixture(targetBytes) {
  const token = repeatToBytes("λ🙂", targetBytes);
  const original = `export function render() {\n  return "${token}-old";\n}\n`;
  const updated = `export function render() {\n  return "${token}-new";\n}\n`;
  return {
    original,
    updated,
    shape: {
      targetBytes,
      tokenBytes: Buffer.byteLength(token),
      originalBytes: Buffer.byteLength(original),
      updatedBytes: Buffer.byteLength(updated),
      encoding: "utf8",
      tokenUnit: "λ🙂",
    },
  };
}

export function makeTranscript({ messages, contentBytes, collapsedReasoningBytes }) {
  const history = [];
  const contentUnit = "grounded local result λ🙂 · ";
  const reasoningUnit = "collapsed reasoning with spaces λ🙂 · ";
  for (let index = 0; index < messages; index++) {
    const common = { id: `bench-message-${index}`, timestamp: 1_700_000_000_000 + index };
    if (index % 2 === 0) {
      history.push({
        ...common,
        role: "user",
        content: `Inspect deterministic fixture ${index / 2}: ${repeatToBytes("request λ🙂 ", Math.max(32, contentBytes / 2))}`,
      });
    } else {
      history.push({
        ...common,
        role: "assistant",
        modelName: "Local Forge",
        summary: `Grounded result ${(index - 1) / 2}`,
        content: `${repeatToBytes(contentUnit, contentBytes)}\n\n\`\`\`js\nconst fixture = ${index};\nconsole.log("λ🙂", fixture);\n\`\`\``,
        reasoning: index % 10 === 9 ? repeatToBytes("short reasoning λ🙂 ", 256) : "",
        elapsedTime: 1,
      });
    }
  }
  const lastAssistant = [...history].reverse().find((message) => message.role === "assistant");
  if (lastAssistant)
    lastAssistant.reasoning = repeatToBytes(reasoningUnit, collapsedReasoningBytes);
  return {
    history,
    shape: {
      messages: history.length,
      requestedContentBytes: contentBytes,
      requestedCollapsedReasoningBytes: collapsedReasoningBytes,
      collapsedReasoningBytes: lastAssistant ? Buffer.byteLength(lastAssistant.reasoning) : 0,
      transcriptBytes: Buffer.byteLength(JSON.stringify(history)),
      encoding: "utf8",
      includesCollapsedReasoning: true,
    },
  };
}

function linkOrWrite(seed, target, content) {
  try {
    linkSync(seed, target);
    return "hard-link";
  } catch {
    // Some filesystems do not support links. The fixture remains deterministic
    // and bounded; only setup strategy changes, and that strategy is reported.
    writeFileSync(target, content);
    return "copy";
  }
}

export function createIndexFixture(root, shape) {
  const fixtureRoot = join(root, "index-fixture");
  const workspace = join(fixtureRoot, "workspace");
  const seed = join(fixtureRoot, "seed.source");
  mkdirSync(workspace, { recursive: true });
  const source = "export function benchmarkFixture(value) { return value + 1; }\n";
  writeFileSync(seed, source);
  writeFileSync(join(workspace, "package.json"), '{"name":"matrix-bench-index","private":true}\n');

  const extensions = ["mjs", "py", "rs", "go"];
  let strategy = "hard-link";
  let created = 0;
  for (let directory = 0; directory < shape.directories && created < shape.files; directory++) {
    const dir = join(workspace, `tree-${String(directory).padStart(3, "0")}`);
    mkdirSync(dir, { recursive: true });
    const remainingDirectories = shape.directories - directory;
    const here = Math.ceil((shape.files - created) / remainingDirectories);
    for (let index = 0; index < here && created < shape.files; index++, created++) {
      const name = `file-${String(created).padStart(6, "0")}.${extensions[created % extensions.length]}`;
      const actual = linkOrWrite(seed, join(dir, name), source);
      if (actual === "copy") strategy = "copy-fallback";
    }
  }

  const scanBudgets = {
    maxFiles: shape.maxFiles,
    maxEntries: shape.maxEntries,
    maxDirectories: shape.maxDirectories,
    maxDepth: 4,
    maxBytes: 2 * 1024 * 1024,
  };
  return {
    workspace,
    scanBudgets,
    detectOptions: {
      ...scanBudgets,
      // detectProject accepts an exec injection for git. Make the local-only
      // boundary explicit instead of relying on the temp directory not being a repo.
      exec: () => {
        throw new Error("benchmark git execution disabled");
      },
    },
    shape: {
      ...shape,
      sourceFilesCreated: created,
      manifestFiles: 1,
      directoriesCreated: shape.directories,
      sourceBytesPerFile: Buffer.byteLength(source),
      logicalSourceBytes: created * Buffer.byteLength(source),
      setupStrategy: strategy,
      scanBudgets,
    },
  };
}

function sessionHistory(messages, messageBytes, prefix) {
  const payload = repeatToBytes("session payload λ🙂 · ", messageBytes);
  return Array.from({ length: messages }, (_, index) => ({
    id: `${prefix}-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index} · ${payload}`,
    timestamp: 1_700_000_000_000 + index,
  }));
}

export function createSessionFixture(root, shape) {
  const home = join(root, "session-home");
  const storedPaths = [];
  let storedBytes = 0;
  for (let index = 0; index < shape.sessions; index++) {
    const saved = saveSession(
      {
        id: `many-${String(index).padStart(4, "0")}`,
        cwd: "/benchmark/workspace",
        project: { name: "matrix-bench-session", fileCount: 8 },
        modelId: "local",
        history: sessionHistory(shape.messagesPerSession, shape.messageBytes, `many-${index}`),
        tokenStats: { inputTokens: index, outputTokens: 1, cachedTokens: 0 },
        metrics: { elapsedMs: index },
      },
      { home, now: 1_700_000_000_000 + index },
    );
    storedPaths.push(saved.path);
    storedBytes += statSync(saved.path).size;
  }
  const largeHistory = sessionHistory(
    shape.transcriptMessages,
    shape.transcriptMessageBytes,
    "large",
  );
  return {
    home,
    largeHistory,
    shape: {
      ...shape,
      storedSessionFiles: storedPaths.length,
      storedBytes,
      largeTranscriptInputBytes: Buffer.byteLength(JSON.stringify(largeHistory)),
      expectedRetainedMessages: Math.min(500, shape.transcriptMessages),
      encoding: "utf8",
    },
  };
}

function eventBytes(events) {
  return events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)) + 1, 0);
}

export function createEventFixture(shape) {
  const content = Array.from({ length: shape.contentEvents }, (_, index) => ({
    type: "content",
    text: `answer delta ${index} λ🙂\n`,
  }));
  const mixed = [];
  for (let index = 0; index < shape.thoughtEvents; index++) {
    mixed.push({ type: "thought", text: `## reasoning ${index} λ🙂\ncontinuation ${index}` });
    mixed.push(content[index % content.length]);
  }
  // Include the remaining high-rate answer deltas in the reduction fixtures.
  for (let index = shape.thoughtEvents; index < content.length; index++) mixed.push(content[index]);
  return {
    content,
    mixed,
    shape: {
      ...shape,
      mixedEvents: mixed.length,
      contentInputBytes: eventBytes(content),
      mixedInputBytes: eventBytes(mixed),
      encoding: "utf8",
    },
  };
}

function noiseLine(index) {
  return `noise ${String(index).padStart(6, "0")} λ🙂 λ🙂 diagnostic output\n`;
}

export function createProcessFixture(shape) {
  // Reproduce the 600-KiB single-byte long-line boundary from PROC-001;
  // surrounding noise still contains multibyte UTF-8 on both streams.
  const unit = "x";
  const longLineRepeats = Math.ceil(shape.longLineBytes / Buffer.byteLength(unit));
  const longLineBytes = longLineRepeats * Buffer.byteLength(unit);
  const summary = "# tests 1\n# pass 1\n# fail 0\n# duration_ms 1\n";
  let plannedStdoutBytes = 0;
  for (let index = 0; index < shape.noiseLines; index++)
    plannedStdoutBytes += Buffer.byteLength(noiseLine(index));
  plannedStdoutBytes += longLineBytes + Buffer.byteLength("TAIL\n") + Buffer.byteLength(summary);
  const stderr = "benchmark stderr λ🙂\n";
  const script = `
const lines = ${shape.noiseLines};
const repeats = ${longLineRepeats};
const unit = ${JSON.stringify(unit)};
for (let index = 0; index < lines; index++) {
  process.stdout.write(\`noise \${String(index).padStart(6, "0")} λ🙂 λ🙂 diagnostic output\\n\`);
}
process.stderr.write(${JSON.stringify(stderr)});
process.stdout.write(unit.repeat(repeats) + "TAIL\\n");
process.stdout.write(${JSON.stringify(summary)});
`;
  return {
    script,
    shape: {
      ...shape,
      longLineRepeats,
      longLineBytes,
      plannedStdoutBytes,
      plannedStderrBytes: Buffer.byteLength(stderr),
      summaryBytes: Buffer.byteLength(summary),
      retainedDisplayLineBudget: 400,
      capturedStreamCodeUnitBudget: 512 * 1024,
      longLineUnit: "x (single-byte); noise contains λ🙂",
      encoding: "utf8",
      executable: "process.execPath",
      network: "none",
    },
  };
}
