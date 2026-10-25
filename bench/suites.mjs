// Benchmark suite definitions. All operations are synchronous local code or an
// awaited child running process.execPath; no provider implementation is called.

import React from "react";
import { render as renderInk } from "ink";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { diffStatsFromText, makeUnifiedDiff, parseUnifiedDiff } from "../lib/diff.mjs";
import { buildScopeGraph } from "../lib/graph.mjs";
import { MODELS } from "../lib/models.mjs";
import { runTests } from "../lib/process.mjs";
import { detectProject, walkFiles } from "../lib/project.mjs";
import { encodePNG, halfBlockAnsi, toAscii } from "../lib/raster.mjs";
import { parseScopes } from "../lib/scope.mjs";
import { listSessions, loadSession, saveSession, sessionsDir } from "../lib/session.mjs";
import { applySwarmEvent, applySwarmEvents, createSwarmState } from "../lib/swarm.mjs";
import { renderEditFileCard } from "../src/cards.mjs";
import { Frame } from "../src/frame.mjs";
import { ALL_VIEWS } from "../src/views.mjs";
import { renderScreen } from "../src/render.mjs";
import { buildChatLines, createChatLayout } from "../src/screens/chat.mjs";
import {
  createEventFixture,
  createIndexFixture,
  createProcessFixture,
  createSessionFixture,
  javascriptAdversarialSource,
  javascriptFlatSource,
  javascriptNestedSource,
  makeLongLineFixture,
  makeTranscript,
  pythonFlatSource,
  pythonNestedSource,
} from "./fixtures.mjs";

const h = React.createElement;

function cached(context, key, create) {
  if (!context.cache.has(key)) context.cache.set(key, create());
  return context.cache.get(key);
}

function check(name, ok, expected, actual) {
  return { name, ok: Boolean(ok), expected, actual };
}

function renderFixture(context) {
  return cached(context, "render", () => {
    const source = javascriptFlatSource(8);
    const parsed = parseScopes(source, "src/fixture.js");
    const transcript = makeTranscript({
      messages: 6,
      contentBytes: 128,
      collapsedReasoningBytes: 256,
    });
    const project = {
      root: "/benchmark/workspace",
      name: "matrix-bench-render",
      branch: "benchmark",
      fileCount: 8,
      files: [
        {
          rel: "src/fixture.js",
          path: "/benchmark/workspace/src/fixture.js",
          name: "fixture.js",
          ext: ".js",
        },
      ],
      languages: [{ name: "javascript", files: 8, bytes: Buffer.byteLength(source) * 8 }],
      test: { display: "node --test" },
      truncated: false,
    };
    let swarmState = createSwarmState({ task: "deterministic render fixture", project });
    swarmState = applySwarmEvent(swarmState, {
      type: "run:start",
      task: "deterministic render fixture",
      plan: [
        { title: "Inspect fixture", status: "done" },
        { title: "Render result", status: "active" },
      ],
    });
    swarmState = applySwarmEvent(swarmState, { type: "thought", text: "local benchmark state" });
    const longLine = makeLongLineFixture(512);
    const patch = makeUnifiedDiff(longLine.original, longLine.updated, { file: "src/fixture.js" });
    const permission = {
      file: "src/fixture.js",
      scope: "flat_0()",
      patch,
      hunks: parseUnifiedDiff(patch).hunks,
      stats: diffStatsFromText(patch),
      rationale: "deterministic long-line render fixture",
      status: "pending",
    };
    const props = {
      project,
      model: MODELS[0],
      modelName: MODELS[0].name,
      tokenStats: { inputTokens: 1234, outputTokens: 456, cachedTokens: 8, cost: 0.0012 },
      usage: { prompt_tokens: 1234, completion_tokens: 456, cached_tokens: 8, cost: 0.0012 },
      metrics: { elapsedMs: 42, rounds: 1, toolCalls: 1 },
      testResult: { passed: 4, failed: 0, summary: "4 passed · 0 failed" },
      chatHistory: transcript.history,
      permission,
      proposal: permission,
      swarmState,
      scopeFile: "src/fixture.js",
      scopeSource: source,
      scopeParsed: parsed,
      scopeFiles: ["src/fixture.js"],
      scopeSelection: 0,
      visionMode: "scope",
      activeLine: 2,
      hasKey: false,
      animTime: 2000,
    };
    return {
      props,
      shape: {
        screens: [...ALL_VIEWS],
        sourceBytes: Buffer.byteLength(source),
        scopes: parsed.flat.length,
        transcriptMessages: transcript.history.length,
        transcriptBytes: transcript.shape.transcriptBytes,
        permissionPatchBytes: Buffer.byteLength(patch),
        syntheticWorkspace: "/benchmark/workspace",
        providerCredentials: "not read (hasKey=false)",
      },
    };
  });
}

function transcriptFixture(context) {
  return cached(context, "large-transcript", () => {
    const transcript = makeTranscript(context.profile.transcript);
    const render = renderFixture(context);
    return {
      ...transcript,
      props: {
        ...render.props,
        screen: "chat",
        chatHistory: transcript.history,
        permission: null,
        proposal: null,
        live: null,
        hasKey: false,
      },
    };
  });
}

function longLineFixture(context) {
  return cached(context, "long-line-diff", () => {
    const fixture = makeLongLineFixture(context.profile.transcript.longLineBytes);
    const patch = makeUnifiedDiff(fixture.original, fixture.updated, { file: "src/long-line.js" });
    return {
      ...fixture,
      patch,
      shape: {
        ...fixture.shape,
        patchBytes: Buffer.byteLength(patch),
        expanded: true,
        cardWidth: context.size.columns,
      },
    };
  });
}

function graphFixture(context) {
  return cached(context, "scope-graph", () => {
    const source = javascriptNestedSource(context.profile.graph.scopes);
    const parsed = parseScopes(source, "stress.js");
    const options = {
      file: "stress.js",
      width: context.profile.graph.width,
      height: context.profile.graph.height,
      activeLine: context.profile.graph.scopes + 1,
    };
    return {
      parsed,
      options,
      canvas: buildScopeGraph(parsed, options).canvas,
      shape: {
        ...context.profile.graph,
        activeLine: options.activeLine,
        sourceBytes: Buffer.byteLength(source),
        parsedScopes: parsed.flat.length - 1,
        rgbaBytes: options.width * options.height * 4,
        parserExcludedFromRasterCases: true,
      },
    };
  });
}

function setLayout(prepared, size) {
  prepared.previousEnvironment = {
    columns: process.env.MATRIX_COLS,
    rows: process.env.MATRIX_ROWS,
    reducedMotion: process.env.MATRIX_REDUCED_MOTION,
  };
  process.env.MATRIX_COLS = String(size.columns);
  process.env.MATRIX_ROWS = String(size.rows);
  // The transcript benchmark measures updates, not decorative animation timers.
  process.env.MATRIX_REDUCED_MOTION = "1";
}

function restoreLayout(prepared) {
  const previous = prepared?.previousEnvironment;
  if (!previous) return;
  if (previous.columns === undefined) delete process.env.MATRIX_COLS;
  else process.env.MATRIX_COLS = previous.columns;
  if (previous.rows === undefined) delete process.env.MATRIX_ROWS;
  else process.env.MATRIX_ROWS = previous.rows;
  if (previous.reducedMotion === undefined) delete process.env.MATRIX_REDUCED_MOTION;
  else process.env.MATRIX_REDUCED_MOTION = previous.reducedMotion;
}

class BenchmarkOutput extends EventEmitter {
  constructor(columns, rows) {
    super();
    this.columns = columns;
    this.rows = rows;
    this.isTTY = false;
    this.last = "";
    this.writes = 0;
  }

  write = (chunk) => {
    this.last = String(chunk);
    this.writes++;
    return true;
  };

  lastFrame = () => this.last;
}

class BenchmarkInput extends EventEmitter {
  isTTY = false;
  setEncoding() {}
  setRawMode() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  read() {
    return null;
  }
}

function mountFrame(context, props) {
  const stdout = new BenchmarkOutput(context.size.columns, context.size.rows);
  const stderr = new BenchmarkOutput(context.size.columns, context.size.rows);
  const stdin = new BenchmarkInput();
  const app = renderInk(h(Frame, props), {
    stdout,
    stderr,
    stdin,
    debug: true,
    interactive: false,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  app.lastFrame = stdout.lastFrame;
  context.resources.inkActive++;
  context.resources.inkMounts++;
  return app;
}

function unmountFrame(context, app) {
  if (!app) return;
  try {
    app.unmount();
  } finally {
    context.resources.inkActive--;
    context.resources.inkUnmounts++;
  }
}

function prepareMount(context, props) {
  return () => {
    const prepared = {};
    setLayout(prepared, context.size);
    prepared.props = props;
    return prepared;
  };
}

function cleanupMount(context, prepared) {
  try {
    unmountFrame(context, prepared?.app);
  } finally {
    restoreLayout(prepared);
  }
}

export const suiteDefinitions = {
  render(context) {
    const fixture = renderFixture(context);
    const cases = ALL_VIEWS.map((screen) => ({
      id: `render.${screen}`,
      operationName: "fresh renderToString mount",
      fixture: {
        screen,
        ...context.size,
        inputBytes: fixture.shape.transcriptBytes + fixture.shape.sourceBytes,
      },
      operation() {
        const output = renderScreen(screen, { ...fixture.props, hasKey: false }, context.size);
        return {
          output,
          details: { screen, codeUnits: output.length },
          checks: [check("non-empty-frame", output.length > 0, true, output.length > 0)],
        };
      },
    }));
    return { fixture: { ...fixture.shape, ...context.size }, cases };
  },

  index(context) {
    const fixture = createIndexFixture(context.root, context.profile.index);
    const budgetChecks = (result) => [
      check(
        "file-work-budget",
        result.files.length <= fixture.scanBudgets.maxFiles,
        `<= ${fixture.scanBudgets.maxFiles}`,
        result.files.length,
      ),
      check(
        "entry-work-budget",
        result.entriesSeen <= fixture.scanBudgets.maxEntries,
        `<= ${fixture.scanBudgets.maxEntries}`,
        result.entriesSeen,
      ),
      check(
        "directory-work-budget",
        result.dirsSeen <= fixture.scanBudgets.maxDirectories,
        `<= ${fixture.scanBudgets.maxDirectories}`,
        result.dirsSeen,
      ),
    ];
    return {
      fixture: fixture.shape,
      cases: [
        {
          id: "index.scan-bounded",
          operationName: "walkFiles only (warm OS cache; parser excluded)",
          fixture: {
            inputBytes: fixture.shape.logicalSourceBytes,
            logicalFiles: fixture.shape.sourceFilesCreated,
          },
          operation() {
            const result = walkFiles(fixture.workspace, fixture.scanBudgets);
            return {
              output: {
                files: result.files.length,
                entriesSeen: result.entriesSeen,
                dirsSeen: result.dirsSeen,
                truncated: result.truncated,
                scanIncomplete: result.scanIncomplete,
              },
              details: {
                files: result.files.length,
                entriesSeen: result.entriesSeen,
                dirsSeen: result.dirsSeen,
                truncated: result.truncated,
                scanIncomplete: result.scanIncomplete,
              },
              checks: budgetChecks(result),
            };
          },
        },
        {
          id: "index.detect-project",
          operationName: "detectProject scan + manifests (git and parser excluded)",
          fixture: {
            inputBytes: fixture.shape.logicalSourceBytes,
            logicalFiles: fixture.shape.sourceFilesCreated,
          },
          operation() {
            const result = detectProject(fixture.workspace, fixture.detectOptions);
            const bounded = {
              files: result.files,
              entriesSeen: result.entriesSeen,
              dirsSeen: result.dirsSeen,
            };
            return {
              output: {
                name: result.name,
                fileCount: result.fileCount,
                entriesSeen: result.entriesSeen,
                dirsSeen: result.dirsSeen,
                gitStatus: result.gitStatus,
              },
              details: {
                fileCount: result.fileCount,
                entriesSeen: result.entriesSeen,
                dirsSeen: result.dirsSeen,
                gitStatus: result.gitStatus,
                internalScanMs: result.scanMs,
              },
              checks: [
                ...budgetChecks(bounded),
                check("git-disabled", result.isGit === false, false, result.isGit),
              ],
            };
          },
        },
      ],
    };
  },

  parser(context) {
    const shape = context.profile.parser;
    const definitions = [
      ["python-flat", pythonFlatSource(shape.flat), "flat.py", shape.flat],
      ["python-nested", pythonNestedSource(shape.pythonNested), "nested.py", shape.pythonNested],
      ["javascript-flat", javascriptFlatSource(shape.flat), "flat.js", shape.flat],
      [
        "javascript-nested",
        javascriptNestedSource(shape.javascriptNested),
        "nested.js",
        shape.javascriptNested,
      ],
      [
        "javascript-adversarial",
        javascriptAdversarialSource(shape.adversarial),
        "adversarial.js",
        shape.adversarial,
      ],
    ];
    const cases = definitions.map(([name, source, file, expectedScopes]) => ({
      id: `parser.${name}`,
      operationName: "parseScopes only (filesystem scan excluded)",
      fixture: {
        file,
        expectedScopes,
        sourceBytes: Buffer.byteLength(source),
        sourceCodeUnits: source.length,
        inputBytes: Buffer.byteLength(source),
      },
      operation() {
        const parsed = parseScopes(source, file);
        const realScopes = parsed.flat.length - 1;
        const noFakeScopes = parsed.flat.every((node) => !node.name.startsWith("fake"));
        return {
          output: { language: parsed.language, lineCount: parsed.lineCount, scopes: realScopes },
          details: { language: parsed.language, lineCount: parsed.lineCount, scopes: realScopes },
          checks: [
            check("scope-count", realScopes === expectedScopes, expectedScopes, realScopes),
            check(
              "no-fake-adversarial-scopes",
              name !== "javascript-adversarial" || noFakeScopes,
              true,
              noFakeScopes,
            ),
          ],
        };
      },
    }));
    return {
      fixture: {
        ...shape,
        corpora: definitions.map(([name, source, file]) => ({
          name,
          file,
          bytes: Buffer.byteLength(source),
        })),
        deterministic: true,
      },
      cases,
    };
  },

  transcript(context) {
    const fixture = transcriptFixture(context);
    const baseProps = fixture.props;
    const viewportWidth = context.size.columns - 4;
    const viewportHeight = Math.max(3, context.size.rows - 8);
    const referenceLines = buildChatLines({ history: fixture.history, width: viewportWidth });
    const sameDescriptors = (left, right) =>
      left.length === right.length &&
      left.every((line, index) => {
        const other = right[index];
        return (
          line.text === other?.text &&
          line.color === other?.color &&
          line.bg === other?.bg &&
          line.bold === other?.bold &&
          line.dim === other?.dim &&
          line.italic === other?.italic
        );
      });
    const updateProps = (iteration) => ({
      ...baseProps,
      live: {
        plan: [],
        reasoning: "",
        toolCards: [],
        content: `warm local update ${iteration} λ🙂`,
        modelName: "Local Forge",
        phase: "thinking",
      },
    });
    return {
      fixture: {
        ...fixture.shape,
        mountGeometry: context.size,
        warmUpdate: "one changed live assistant message; initial mount excluded",
        reducedMotion: true,
      },
      cases: [
        {
          id: "transcript.large-layout",
          operationName: "buildChatLines full transcript + collapsed reasoning",
          fixture: { inputBytes: fixture.shape.transcriptBytes, messages: fixture.shape.messages },
          operation() {
            const lines = buildChatLines({
              history: fixture.history,
              width: context.size.columns - 4,
            });
            return {
              output: lines.map((line) => line.text).join("\n"),
              details: { lineCount: lines.length, messages: fixture.history.length },
              checks: [
                check(
                  "transcript-lines",
                  lines.length > fixture.history.length,
                  `> ${fixture.history.length}`,
                  lines.length,
                ),
              ],
            };
          },
        },
        {
          id: "transcript.cached-viewport-mount",
          operationName: "cold cached ChatScreen viewport (full Ink mount excluded)",
          fixture: { inputBytes: fixture.shape.transcriptBytes, messages: fixture.shape.messages },
          prepare: () => ({ layout: createChatLayout() }),
          operation(prepared) {
            const view = prepared.layout.viewport({
              history: fixture.history,
              width: viewportWidth,
              height: viewportHeight,
            });
            const expected = referenceLines.slice(
              Math.max(0, referenceLines.length - viewportHeight),
            );
            const descriptorsMatch = sameDescriptors(view.lines, expected);
            return {
              output: view.lines.map((line) => line.text).join("\n"),
              details: {
                totalLines: view.total,
                visibleLines: view.lines.length,
                messageBuilds: view.stats.messageBuilds,
                cacheHits: view.stats.cacheHits,
                cacheEntries: view.stats.cacheEntries,
              },
              checks: [
                check(
                  "cached-mount-total",
                  view.total === referenceLines.length,
                  referenceLines.length,
                  view.total,
                ),
                check("cached-mount-descriptors", descriptorsMatch, true, descriptorsMatch),
                check(
                  "cached-cold-builds",
                  view.stats.messageBuilds === fixture.history.length,
                  fixture.history.length,
                  view.stats.messageBuilds,
                ),
                check(
                  "cached-visible-bound",
                  view.lines.length <= viewportHeight,
                  `<= ${viewportHeight}`,
                  view.lines.length,
                ),
              ],
            };
          },
          cleanup: (prepared) => prepared?.layout.clear(),
        },
        {
          id: "transcript.cached-viewport-warm-update",
          operationName: "one live update against cached transcript metadata (Ink excluded)",
          fixture: { inputBytes: fixture.shape.transcriptBytes, messages: fixture.shape.messages },
          prepare({ iteration }) {
            const layout = createChatLayout();
            layout.viewport({
              history: fixture.history,
              width: viewportWidth,
              height: viewportHeight,
            });
            const live = updateProps(iteration).live;
            const reference = buildChatLines({
              history: fixture.history,
              live,
              width: viewportWidth,
            });
            return { layout, live, reference };
          },
          operation(prepared) {
            const view = prepared.layout.viewport({
              history: fixture.history,
              live: prepared.live,
              width: viewportWidth,
              height: viewportHeight,
            });
            const expected = prepared.reference.slice(
              Math.max(0, prepared.reference.length - viewportHeight),
            );
            const descriptorsMatch = sameDescriptors(view.lines, expected);
            return {
              output: view.lines.map((line) => line.text).join("\n"),
              details: {
                totalLines: view.total,
                visibleLines: view.lines.length,
                messageBuilds: view.stats.messageBuilds,
                cacheHits: view.stats.cacheHits,
                cacheEntries: view.stats.cacheEntries,
              },
              checks: [
                check(
                  "cached-warm-total",
                  view.total === prepared.reference.length,
                  prepared.reference.length,
                  view.total,
                ),
                check("cached-warm-descriptors", descriptorsMatch, true, descriptorsMatch),
                check(
                  "stable-history-cache-hits",
                  view.stats.cacheHits === fixture.history.length,
                  fixture.history.length,
                  view.stats.cacheHits,
                ),
                check(
                  "changed-live-builds",
                  view.stats.messageBuilds === 1,
                  1,
                  view.stats.messageBuilds,
                ),
              ],
            };
          },
          cleanup: (prepared) => prepared?.layout.clear(),
        },
        {
          id: "transcript.mount",
          operationName: "Ink mount + first cached ChatScreen viewport (unmount excluded)",
          fixture: { inputBytes: fixture.shape.transcriptBytes, messages: fixture.shape.messages },
          prepare: prepareMount(context, baseProps),
          operation(prepared) {
            prepared.app = mountFrame(context, { ...prepared.props, live: null });
            const output = prepared.app.lastFrame() ?? "";
            return {
              output,
              details: { frameCodeUnits: output.length },
              checks: [check("mounted-frame", output.length > 0, true, output.length > 0)],
            };
          },
          cleanup: (prepared) => cleanupMount(context, prepared),
        },
        {
          id: "transcript.warm-update",
          operationName: "Ink rerender of one live update on mounted cached transcript",
          fixture: { inputBytes: fixture.shape.transcriptBytes, messages: fixture.shape.messages },
          prepare() {
            const prepared = {};
            setLayout(prepared, context.size);
            try {
              prepared.app = mountFrame(context, { ...baseProps, live: null });
              return prepared;
            } catch (error) {
              restoreLayout(prepared);
              throw error;
            }
          },
          operation(prepared, { iteration }) {
            prepared.app.rerender(h(Frame, updateProps(iteration)));
            const output = prepared.app.lastFrame() ?? "";
            return {
              output,
              details: { frameCodeUnits: output.length, update: iteration },
              checks: [check("warm-frame", output.length > 0, true, output.length > 0)],
            };
          },
          cleanup: (prepared) => cleanupMount(context, prepared),
        },
      ],
    };
  },

  diff(context) {
    const fixture = longLineFixture(context);
    return {
      fixture: fixture.shape,
      cases: [
        {
          id: "diff.long-line-generation",
          operationName: "makeUnifiedDiff on one changed UTF-8 long line",
          fixture: {
            inputBytes: fixture.shape.originalBytes + fixture.shape.updatedBytes,
            ...fixture.shape,
          },
          operation() {
            const patch = makeUnifiedDiff(fixture.original, fixture.updated, {
              file: "src/long-line.js",
            });
            return {
              output: patch,
              details: { patchCodeUnits: patch.length, patchBytes: Buffer.byteLength(patch) },
              checks: [
                check(
                  "long-line-patch",
                  patch.includes("@@") && patch.includes("λ🙂"),
                  true,
                  patch.includes("@@"),
                ),
              ],
            };
          },
        },
        {
          id: "diff.long-line-layout",
          operationName: "expanded renderEditFileCard with exact code wrapping",
          fixture: { inputBytes: fixture.shape.patchBytes, ...fixture.shape },
          operation() {
            const rows = renderEditFileCard(
              "src/long-line.js",
              "render()",
              fixture.patch.split("\n").filter(Boolean),
              "pending",
              context.size.columns,
              { expanded: true },
            );
            return {
              output: rows.map((row) => row.text).join("\n"),
              details: { wrappedRows: rows.length },
              checks: [check("long-line-wrapped", rows.length > 10, "> 10", rows.length)],
            };
          },
        },
      ],
    };
  },

  process(context) {
    const fixture = createProcessFixture(context.profile.process);
    const home = join(context.root, "process-home");
    const plan = {
      file: process.execPath,
      args: ["-e", fixture.script],
      cwd: context.root,
      framework: "node --test",
      display: "benchmark noisy node tests",
    };
    return {
      fixture: fixture.shape,
      cases: [
        {
          id: "process.noisy-output",
          operationName: "trusted runTests + bounded UTF-8 streams + summary parsing",
          iterationCap: context.profile.process.maxIterations,
          fixture: {
            inputBytes: fixture.shape.plannedStdoutBytes + fixture.shape.plannedStderrBytes,
            ...fixture.shape,
          },
          async operation() {
            context.resources.processActive++;
            context.resources.processRuns++;
            try {
              const result = await runTests(plan, {
                home,
                runId: "benchmark-noisy-process",
                allowTests: true,
                headless: true,
                timeoutMs: 30_000,
                env: { PATH: process.env.PATH ?? "" },
              });
              const stdoutBytes = Buffer.byteLength(result.stdout);
              const stderrBytes = Buffer.byteLength(result.stderr);
              return {
                output: {
                  verified: result.verified,
                  passed: result.passed,
                  failed: result.failed,
                  retainedLines: result.lines.length,
                  outputLineCount: result.outputLineCount,
                },
                outputBytes: stdoutBytes + stderrBytes,
                outputByteMethod:
                  "Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)",
                details: {
                  stdoutBytes,
                  stderrBytes,
                  stdoutCodeUnits: result.stdout.length,
                  stderrCodeUnits: result.stderr.length,
                  stdoutTruncated: result.stdoutTruncated,
                  stderrTruncated: result.stderrTruncated,
                  retainedLines: result.lines.length,
                  outputLineCount: result.outputLineCount,
                  outputTruncated: result.outputTruncated,
                  verificationStatus: result.verificationStatus,
                  auditStatus: result.auditStatus,
                },
                checks: [
                  check(
                    "verified-late-summary",
                    result.verified && result.passed === 1 && result.failed === 0,
                    "1 passed, 0 failed",
                    result.summary,
                  ),
                  check(
                    "retained-line-budget",
                    result.lines.length <= 400,
                    "<= 400",
                    result.lines.length,
                  ),
                  check(
                    "latest-lines-retained",
                    result.outputLineCount <= 400 || result.outputTruncated,
                    true,
                    result.outputTruncated,
                  ),
                  check(
                    "long-line-capture-truncated",
                    result.stdoutTruncated && result.stdout.endsWith("# duration_ms 1\n"),
                    true,
                    result.stdoutTruncated,
                  ),
                  check(
                    "private-audit-complete",
                    result.auditStatus === "complete",
                    "complete",
                    result.auditStatus,
                  ),
                ],
              };
            } finally {
              context.resources.processActive--;
            }
          },
        },
      ],
    };
  },

  session(context) {
    const fixture = createSessionFixture(context.root, context.profile.session);
    return {
      fixture: fixture.shape,
      cases: [
        {
          id: "session.list-many",
          operationName: "listSessions over deterministic large session files",
          fixture: {
            inputBytes: fixture.shape.storedBytes,
            sessions: fixture.shape.storedSessionFiles,
          },
          operation() {
            const listed = listSessions({ home: fixture.home });
            const sorted = listed.every(
              (entry, index) => index === 0 || listed[index - 1].savedAt >= entry.savedAt,
            );
            return {
              output: listed,
              details: { listed: listed.length, storedBytes: fixture.shape.storedBytes },
              checks: [
                check(
                  "all-sessions-listed",
                  listed.length === fixture.shape.storedSessionFiles,
                  fixture.shape.storedSessionFiles,
                  listed.length,
                ),
                check("newest-first-sort", sorted, true, sorted),
              ],
            };
          },
        },
        {
          id: "session.large-transcript-roundtrip",
          operationName: "saveSession + loadSession + exact serialized file bytes",
          fixture: {
            inputBytes: fixture.shape.largeTranscriptInputBytes,
            messages: context.profile.session.transcriptMessages,
          },
          operation() {
            const saved = saveSession(
              {
                id: "benchmark-large-transcript",
                cwd: "/benchmark/workspace",
                project: { name: "matrix-bench-large", fileCount: 1 },
                modelId: "local",
                history: fixture.largeHistory,
                tokenStats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
                metrics: {},
              },
              { home: fixture.home, now: 1_700_000_100_000 },
            );
            const raw = readFileSync(saved.path, "utf8");
            const loaded = loadSession(saved.id, { home: fixture.home });
            const temporaryFiles = readdirSync(sessionsDir(fixture.home)).filter((name) =>
              name.includes(".tmp"),
            ).length;
            return {
              output: {
                id: loaded?.id,
                retainedMessages: loaded?.history?.length,
                firstRetainedId: loaded?.history?.[0]?.id,
                lastRetainedId: loaded?.history?.at(-1)?.id,
              },
              outputBytes: Buffer.byteLength(raw),
              outputByteMethod: "Buffer.byteLength(readFileSync(sessionPath, 'utf8'))",
              details: {
                retainedMessages: loaded?.history?.length ?? 0,
                firstRetainedId: loaded?.history?.[0]?.id ?? null,
                lastRetainedId: loaded?.history?.at(-1)?.id ?? null,
                serializedSessionBytes: Buffer.byteLength(raw),
                temporaryFiles,
              },
              checks: [
                check("large-session-loaded", loaded?.id === saved.id, saved.id, loaded?.id),
                check(
                  "history-retention-budget",
                  loaded?.history?.length === fixture.shape.expectedRetainedMessages,
                  fixture.shape.expectedRetainedMessages,
                  loaded?.history?.length,
                ),
                check("atomic-write-cleanup", temporaryFiles === 0, 0, temporaryFiles),
              ],
            };
          },
        },
      ],
    };
  },

  event(context) {
    const fixture = createEventFixture(context.profile.event);
    let base = createSwarmState({ task: "benchmark high-rate events" });
    base = applySwarmEvent(base, {
      type: "run:start",
      task: "benchmark high-rate events",
      plan: [{ title: "reduce events", status: "active" }],
    });
    const reduceSequential = () => {
      let state = base;
      let transitions = 0;
      for (const event of fixture.mixed) {
        const next = applySwarmEvent(state, event);
        if (next !== state) transitions++;
        state = next;
      }
      return { state, transitions };
    };
    const reductionEnvelope = ({ state, transitions, publications }, reducerCalls) => {
      const lastLog = state.lanes.planner.logs.at(-1)?.text ?? null;
      const expectedLastLog = `reasoning ${fixture.shape.thoughtEvents - 1} λ🙂`;
      return {
        output: {
          transitions,
          publications,
          reducerCalls,
          plannerLogs: state.lanes.planner.logs.length,
          lastLog,
        },
        details: {
          transitions,
          publications,
          reducerCalls,
          relevantEvents: fixture.shape.thoughtEvents,
          plannerLogs: state.lanes.planner.logs.length,
          forgeLogs: state.lanes.forge.logs.length,
          radarLogs: state.lanes.radar.logs.length,
        },
        checks: [
          check(
            "planner-log-budget",
            state.lanes.planner.logs.length <= 80,
            "<= 80",
            state.lanes.planner.logs.length,
          ),
          check(
            "complete-mixed-stream-reduced",
            lastLog === expectedLastLog,
            expectedLastLog,
            lastLog,
          ),
        ],
      };
    };
    return {
      fixture: fixture.shape,
      cases: [
        {
          id: "event.content-noop",
          operationName: "high-rate content events with structural-sharing no-op",
          fixture: { inputBytes: fixture.shape.contentInputBytes, events: fixture.content.length },
          operation() {
            let state = base;
            let transitions = 0;
            for (const event of fixture.content) {
              const next = applySwarmEvent(state, event);
              if (next !== state) transitions++;
              state = next;
            }
            return {
              output: { transitions, sameReference: state === base },
              details: { transitions, sameReference: state === base },
              checks: [
                check("zero-irrelevant-transitions", transitions === 0, 0, transitions),
                check("state-reference-shared", state === base, true, state === base),
              ],
            };
          },
        },
        {
          id: "event.sequential-reduce",
          operationName: "sequential applySwarmEvent high-rate mixed stream",
          fixture: { inputBytes: fixture.shape.mixedInputBytes, events: fixture.mixed.length },
          operation() {
            const reduced = reduceSequential();
            const envelope = reductionEnvelope(
              { ...reduced, publications: reduced.transitions },
              fixture.mixed.length,
            );
            envelope.checks.push(
              check(
                "relevant-state-transitions",
                reduced.transitions === fixture.shape.thoughtEvents,
                fixture.shape.thoughtEvents,
                reduced.transitions,
              ),
            );
            return envelope;
          },
        },
        {
          id: "event.batched-reduce",
          operationName: "applySwarmEvents coalesced high-rate mixed stream",
          fixture: { inputBytes: fixture.shape.mixedInputBytes, events: fixture.mixed.length },
          operation() {
            const state = applySwarmEvents(base, fixture.mixed);
            const transitions = state === base ? 0 : 1;
            return reductionEnvelope({ state, transitions, publications: transitions }, 1);
          },
        },
      ],
    };
  },

  graph(context) {
    const fixture = graphFixture(context);
    return {
      fixture: fixture.shape,
      cases: [
        {
          id: "graph.scope-large",
          operationName: "buildScopeGraph (parser and ANSI/PNG encoding excluded)",
          fixture: { inputBytes: fixture.shape.sourceBytes, scopes: fixture.shape.parsedScopes },
          operation() {
            const graph = buildScopeGraph(fixture.parsed, fixture.options);
            return {
              output: graph.meta,
              outputBytes: Buffer.byteLength(graph.canvas.data),
              outputByteMethod: "Buffer.byteLength(graph.canvas.data) (RGBA bytes)",
              details: { ...graph.meta, width: graph.canvas.width, height: graph.canvas.height },
              checks: [
                check(
                  "all-scopes-considered",
                  graph.meta.scopes === fixture.shape.parsedScopes,
                  fixture.shape.parsedScopes,
                  graph.meta.scopes,
                ),
                check(
                  "rgba-byte-size",
                  graph.canvas.data.byteLength === fixture.shape.rgbaBytes,
                  fixture.shape.rgbaBytes,
                  graph.canvas.data.byteLength,
                ),
              ],
            };
          },
        },
      ],
    };
  },

  raster(context) {
    const fixture = graphFixture(context);
    return {
      fixture: fixture.shape,
      cases: [
        {
          id: "raster.ansi",
          operationName: "halfBlockAnsi over prebuilt scope graph",
          fixture: { inputBytes: fixture.shape.rgbaBytes, ...fixture.shape },
          operation() {
            const output = halfBlockAnsi(fixture.canvas);
            return {
              output,
              details: { codeUnits: output.length, utf8Bytes: Buffer.byteLength(output) },
              checks: [check("ansi-output", output.length > 0, true, output.length > 0)],
            };
          },
        },
        {
          id: "raster.ascii",
          operationName: "toAscii over prebuilt scope graph",
          fixture: { inputBytes: fixture.shape.rgbaBytes, ...fixture.shape },
          operation() {
            const output = toAscii(fixture.canvas, { width: fixture.canvas.width });
            return {
              output,
              details: { codeUnits: output.length, utf8Bytes: Buffer.byteLength(output) },
              checks: [check("ascii-output", output.length > 0, true, output.length > 0)],
            };
          },
        },
        {
          id: "raster.png",
          operationName: "encodePNG over prebuilt scope graph",
          fixture: { inputBytes: fixture.shape.rgbaBytes, ...fixture.shape },
          operation() {
            const output = encodePNG(fixture.canvas);
            return {
              output,
              details: { pngBytes: Buffer.byteLength(output) },
              checks: [
                check(
                  "png-signature",
                  output.subarray(1, 4).toString("ascii") === "PNG",
                  "PNG",
                  output.subarray(1, 4).toString("ascii"),
                ),
              ],
            };
          },
        },
      ],
    };
  },
};
