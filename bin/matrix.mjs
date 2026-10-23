#!/usr/bin/env node
// ============================================================================
// Matrix CLI.
//
// Interactive workbench, headless task runner, doctor, real demo tour, pixel
// canvas export, render dumps, smoke checks and a benchmark.
// ============================================================================

import React from "react";
import { render } from "ink";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgv, HELP_TEXT } from "../lib/cli.mjs";
import { detectProject, readFileSafe } from "../lib/project.mjs";
import { parseScopes } from "../lib/scope.mjs";
import { runLocalAgent } from "../lib/local-agent.mjs";
import { runModelAgent } from "../lib/model-agent.mjs";
import { isOpenRouterAvailable } from "../lib/openrouter.mjs";
import { MODELS, formatCost, resolveModel } from "../lib/models.mjs";
import { createSwarmState, applySwarmEvent } from "../lib/swarm.mjs";
import { loadLatestSession, loadSession, listSessions, matrixHome } from "../lib/session.mjs";
import { runDoctor, formatDoctor } from "../lib/doctor.mjs";
import { halfBlockAnsi, toAscii, writePng } from "../lib/raster.mjs";
import { buildVision } from "../lib/graph.mjs";
import { stripAnsi } from "../lib/text.mjs";
import { enterAltScreen, exitAltScreen, isAltScreenSupported } from "../lib/alt-screen.mjs";
import { createSynchronizedStdout, isSyncSupported } from "../lib/sync-stream.mjs";
import { MatrixApp, SCREENS } from "../src/matrix.mjs";
import { checkFrame, maxLineWidth, renderAt, renderScreen, renderAllScreens, visible } from "../src/render.mjs";

const h = React.createElement;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_ROOT = join(PACKAGE_ROOT, "demo-project");
const SOURCE_EXTENSIONS = new Set([
  ".py", ".pyi", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".rs", ".go", ".rb",
]);

function pkg() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
}

function resolveCwd(options) {
  const raw = options.demo ? DEMO_ROOT : options.cwd ?? process.cwd();
  const cwd = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(cwd)) throw new Error(`workspace not found: ${cwd}`);
  if (options.demo && !existsSync(DEMO_ROOT)) throw new Error("demo-project is missing from the package");
  return cwd;
}

function firstSource(project, preferred = null) {
  if (preferred) return preferred;
  const file = project.files.find((entry) => SOURCE_EXTENSIONS.has(entry.ext));
  return file?.rel ?? null;
}

function sourceData(project, file) {
  if (!file) return { file: null, source: "", parsed: null };
  const readable = readFileSafe(join(project.root, file));
  if (!readable.ok) return { file, source: "", parsed: null, error: readable.error };
  return { file, source: readable.content, parsed: parseScopes(readable.content, file) };
}

function sizeFrom(options, fallback = { columns: 100, rows: 30 }) {
  return {
    columns: options.cols ?? fallback.columns,
    rows: options.rows ?? fallback.rows,
  };
}

function clampSize(options, fallback) {
  const size = sizeFrom(options, fallback);
  return { columns: Math.max(40, Math.min(200, size.columns)), rows: Math.max(14, Math.min(80, size.rows)) };
}

function paint(text, code) {
  if (!process.stdout.isTTY || "NO_COLOR" in process.env) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function section(title, body) {
  process.stdout.write(`\n${paint(title, "1;38;2;0;255;65")}\n`);
  process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
}

function maybeStrip(text, options) {
  return options.mono ? stripAnsi(text) : text;
}

async function captureDemoRun(options = {}) {
  if (!existsSync(DEMO_ROOT)) throw new Error("demo-project is missing");
  const temp = mkdtempSync(join(tmpdir(), "matrix-tour-"));
  const workspace = join(temp, "demo-project");
  const home = join(temp, ".matrix");
  const previousHome = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = home;
  try {
    cpSync(DEMO_ROOT, workspace, { recursive: true, force: true, filter: (src) => !src.includes("__pycache__") && !src.includes(".pytest_cache") });
    const project = detectProject(workspace);
    const task = "Fix the off-by-one in the bounds slice in src/processor.py";
    let proposal = null;
    let swarmState = createSwarmState({ task, project });
    const events = [];
    const result = await runLocalAgent({
      task,
      project,
      autoApprove: false,
      requestApproval: async (next) => {
        proposal = next;
        return "y";
      },
      onEvent: (event) => {
        events.push(event);
        swarmState = applySwarmEvent(swarmState, event);
      },
    });
    const edited = result.editFile?.path ?? proposal?.file ?? firstSource(project);
    const scope = sourceData(project, edited);
    const history = [
      { id: "tour-user", role: "user", content: task, timestamp: Date.now() },
      result,
    ];
    return {
      temp,
      home,
      project,
      task,
      result,
      proposal,
      swarmState,
      events,
      history,
      scope,
      cleanup: () => {
        if (previousHome === undefined) delete process.env.MATRIX_HOME;
        else process.env.MATRIX_HOME = previousHome;
        rmSync(temp, { recursive: true, force: true });
      },
    };
  } catch (error) {
    process.env.MATRIX_HOME = previousHome ?? "";
    if (previousHome === undefined) delete process.env.MATRIX_HOME;
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function framePropsFromCapture(capture, options) {
  const model = MODELS[0];
  const size = clampSize(options, { columns: 100, rows: 34 });
  const tokenStats = capture.result.usage
    ? {
        inputTokens: capture.result.usage.prompt_tokens ?? 0,
        outputTokens: capture.result.usage.completion_tokens ?? 0,
        cachedTokens: capture.result.usage.cached_tokens ?? 0,
        cost: capture.result.cost ?? 0,
      }
    : { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
  return {
    project: capture.project,
    model,
    tokenStats,
    chatHistory: capture.history,
    permission: capture.proposal ? { ...capture.proposal, status: "approved" } : null,
    swarmState: capture.swarmState,
    scopeFile: capture.scope.file,
    scopeSource: capture.scope.source,
    scopeParsed: capture.scope.parsed,
    scopeSelection: 0,
    visionMode: "scope",
    usage: tokenStats,
    metrics: capture.result.metrics ?? {},
    testResult: capture.result.verifyTests ?? null,
    modelName: model.name,
    size,
  };
}

function renderCaptureScreen(screen, capture, options) {
  const props = framePropsFromCapture(capture, options);
  const ansi = renderScreen(
    screen,
    {
      project: props.project,
      model: props.model,
      tokenStats: props.tokenStats,
      chatHistory: props.chatHistory,
      permission: props.permission,
      proposal: props.permission,
      swarmState: props.swarmState,
      scopeFile: props.scopeFile,
      scopeSource: props.scopeSource,
      scopeParsed: props.scopeParsed,
      scopeSelection: props.scopeSelection,
      visionMode: props.visionMode,
      usage: props.usage,
      metrics: props.metrics,
      testResult: props.testResult,
      modelName: props.modelName,
      chatScroll: screen === "chat" ? 999 : 0,
    },
    props.size
  );
  return maybeStrip(ansi, options);
}

async function commandTour(options) {
  const capture = await captureDemoRun(options);
  try {
    const screens = [
      ["empty", "The forge rests on the actual demo workspace. Local Forge is offline."],
      ["chat", "One real run: plan, read, validated diff, verification, final result."],
      ["permission", "The patch gate. This is the exact hunk that was approved."],
      ["swarm", "The same event stream, rendered as three lanes."],
      ["scope", "Structural lens over the file that changed."],
      ["vision", "The same scope tree rasterised to a pixel canvas."],
    ];
    for (const [screen, note] of screens) {
      section(`MATRIX TOUR · ${screen.toUpperCase()}`, note);
      process.stdout.write(renderCaptureScreen(screen, capture, options));
    }
    process.stdout.write(`\n${paint("Tour complete.", "38;2;0;255;65")} The temp workspace was removed.\n`);
  } finally {
    capture.cleanup();
  }
}

async function commandDump(options) {
  const choices = [...SCREENS, "model", "help"];
  if (options.screen && !choices.includes(options.screen)) {
    throw new Error(`--screen expects one of: ${choices.join(", ")}`);
  }
  const capture = await captureDemoRun(options);
  try {
    const screens = options.screen ? [options.screen] : choices;
    for (const screen of screens) {
      section(`SCREEN: ${screen.toUpperCase()}`, "");
      process.stdout.write(renderCaptureScreen(screen, capture, options));
    }
  } finally {
    capture.cleanup();
  }
}

function smokeData(cwd) {
  const project = detectProject(cwd);
  const file = firstSource(project);
  const scope = sourceData(project, file);
  return {
    project,
    model: MODELS[0],
    tokenStats: { inputTokens: 1234, outputTokens: 456, cachedTokens: 0, cost: 0.0012 },
    chatHistory: [
      { id: "smoke-user", role: "user", content: "Inspect the workspace and propose one grounded change." },
      {
        id: "smoke-system",
        role: "system",
        content: "Render smoke: real workspace index. No model call and no writes.",
        timestamp: Date.now(),
      },
    ],
    permission: null,
    swarmState: createSwarmState({ project }),
    scopeFile: scope.file,
    scopeSource: scope.source,
    scopeParsed: scope.parsed,
    scopeSelection: 0,
    visionMode: "scope",
    usage: { inputTokens: 1234, outputTokens: 456, cost: 0.0012 },
    metrics: {},
    testResult: null,
    modelName: MODELS[0].name,
  };
}

function commandSmoke(options) {
  const cwd = resolveCwd(options);
  const data = smokeData(cwd);
  const sizes = [
    { columns: 60, rows: 22 },
    { columns: 80, rows: 26 },
    { columns: 100, rows: 30 },
    { columns: 140, rows: 40 },
  ];
  const report = [];
  for (const size of sizes) {
    for (const screen of [...SCREENS, "model", "help"]) {
      const ansi = renderScreen(screen, data, size);
      const check = checkFrame(ansi, size);
      report.push({ screen, ...size, ...check });
      if (!check.ok) throw new Error(`${screen} at ${size.columns}×${size.rows}: ${check.problems.join(", ")}`);
    }
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, checks: report.length, sizes, report }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`MATRIX SMOKE\n`);
  process.stdout.write(`  ${report.length} frame checks across ${sizes.length} geometries · all passed\n`);
  for (const size of sizes) {
    const rows = report.filter((item) => item.columns === size.columns && item.rows === size.rows);
    const max = Math.max(...rows.map((item) => item.width));
    process.stdout.write(`  ${String(size.columns).padStart(3)}×${String(size.rows).padStart(2)}  ${String(max).padStart(3)} max cols  ${rows.length} screens\n`);
  }
}

function commandBench(options) {
  const cwd = resolveCwd(options);
  const data = smokeData(cwd);
  const size = clampSize(options, { columns: 120, rows: 36 });
  const iterations = Math.max(1, Math.min(100, Number(options.benchIterations ?? 20)));
  const results = [];
  for (const screen of [...SCREENS, "model", "help"]) {
    const start = process.hrtime.bigint();
    let bytes = 0;
    for (let i = 0; i < iterations; i++) {
      const ansi = renderScreen(screen, data, size);
      bytes += ansi.length;
    }
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    results.push({ screen, iterations, totalMs: elapsed, perFrameMs: elapsed / iterations, bytesPerFrame: Math.round(bytes / iterations) });
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ size, results }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`MATRIX BENCH · ${size.columns}×${size.rows} · ${iterations} frames/screen\n`);
  process.stdout.write(`  screen       per frame   bytes\n`);
  for (const row of results) {
    process.stdout.write(`  ${row.screen.padEnd(12)} ${row.perFrameMs.toFixed(2).padStart(8)}ms  ${String(row.bytesPerFrame).padStart(6)}\n`);
  }
  const total = results.reduce((sum, row) => sum + row.perFrameMs, 0);
  process.stdout.write(`  total        ${total.toFixed(2).padStart(8)}ms for one full sweep\n`);
}

function commandVision(options) {
  const cwd = resolveCwd(options);
  const project = detectProject(cwd);
  const file = options.file ?? firstSource(project);
  if (!file) throw new Error("no source file found; pass --file");
  const data = sourceData(project, file);
  if (!data.parsed) throw new Error(data.error ?? `could not parse ${file}`);
  const size = clampSize(options, { columns: 120, rows: 34 });
  const canvasWidth = size.columns;
  const canvasHeight = Math.max(12, (size.rows - 1) * 2);
  // A static canvas should still show a meaningful active scope; line 1 is
  // usually the module prologue and leaves the highlight empty.
  const firstScope = data.parsed.flat.find((node) => node.kind !== "module");
  const graph = buildVision({
    mode: options.graphMode,
    parsed: data.parsed,
    file: data.file,
    activeLine: firstScope?.startLine ?? 1,
    project,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    metrics: {},
    testResult: null,
    modelName: MODELS[0].name,
    width: canvasWidth,
    height: canvasHeight,
  });
  if (options.exportPng) {
    const target = isAbsolute(options.exportPng) ? options.exportPng : resolve(process.cwd(), options.exportPng);
    mkdirSync(dirname(target), { recursive: true });
    const written = writePng(graph.canvas, target);
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${options.mono ? toAscii(graph.canvas, { width: canvasWidth }) : halfBlockAnsi(graph.canvas)}\n`);
  process.stdout.write(`${paint(`${graph.title ?? "VISION"} · ${data.file} · ${data.parsed.language}`, "38;2;132;169;140")}\n`);
}

function commandSessions(options) {
  const sessions = listSessions({ home: matrixHome() });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write(`No sessions saved in ${matrixHome()}.\n`);
    return;
  }
  process.stdout.write(`MATRIX SESSIONS · ${sessions.length} in ${matrixHome()}\n`);
  for (const session of sessions.slice(0, 40)) {
    const when = new Date(session.savedAt).toISOString().replace("T", " ").slice(0, 19);
    process.stdout.write(
      `  ${String(session.id).padEnd(20)} ${when}  ${String(session.modelId ?? "local").padEnd(8)} ${String(session.messages).padStart(3)} msgs  ${session.cwd ?? ""}\n`
    );
  }
}

function commandDoctor(options) {
  const cwd = resolveCwd(options);
  const report = runDoctor({ cwd, stdout: process.stdout });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ summary: report.summary, checks: report.checks }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDoctor(report, { color: !options.mono && process.stdout.isTTY })}\n`);
  }
  if (report.summary.fail > 0) process.exitCode = 1;
}

function verificationFailed(result) {
  const verify = result.verifyTests;
  if (!verify || verify.skipped) return false;
  return verify.ok === false || verify.timedOut === true || verify.aborted === true || Number(verify.failed) > 0;
}

function resultOk(result) {
  return !result.error && !result.failure && !verificationFailed(result);
}

function publicResult(result) {
  return {
    ok: resultOk(result),
    error: result.error ?? null,
    failure: result.failure ?? null,
    summary: result.summary,
    content: result.content,
    modelName: result.modelName,
    usage: result.usage ?? null,
    cost: result.cost ?? 0,
    elapsedMs: result.elapsedMs ?? null,
    plan: result.plan ?? [],
    editFile: result.editFile
      ? {
          path: result.editFile.path,
          scope: result.editFile.scope,
          stats: result.editFile.stats,
          status: result.editFile.status,
          backupPath: result.editFile.backupPath,
        }
      : null,
    verifyTests: result.verifyTests
      ? {
          cmd: result.verifyTests.cmd ?? result.verifyTests.command,
          passed: result.verifyTests.passed,
          failed: result.verifyTests.failed,
          summary: result.verifyTests.summary,
          skipped: result.verifyTests.skipped,
          duration: result.verifyTests.duration,
          ok: result.verifyTests.ok,
          timedOut: result.verifyTests.timedOut ?? false,
          aborted: result.verifyTests.aborted ?? false,
          parseConfident: result.verifyTests.parseConfident ?? null,
        }
      : null,
  };
}

async function runHeadlessTask(options, cwd) {
  const project = detectProject(cwd);
  const model = resolveModel(options.offline ? "local" : options.modelQuery ?? "local");
  if (model.remote && !isOpenRouterAvailable()) {
    throw new Error(`${model.name} needs an OpenRouter key; use Local Forge or set OPENROUTER_API_KEY`);
  }
  const events = [];
  const common = {
    task: options.task,
    project,
    onEvent: (event) => events.push(event),
    autoApprove: Boolean(options.autoApprove),
    requestApproval: async () => (options.autoApprove ? "y" : "n"),
  };
  const result = model.remote
    ? await runModelAgent({ ...common, model })
    : await runLocalAgent(common);
  const publicRun = publicResult(result);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ project: { name: project.name, root: project.root, branch: project.branch }, model: model.id, result: publicRun }, null, 2)}\n`);
  } else {
    process.stdout.write(`${paint(`MATRIX · ${model.name} · ${project.name}`, "1;38;2;0;255;65")}\n`);
    process.stdout.write(`${paint("TASK", "38;2;132;169;140")} ${options.task}\n`);
    if (result.plan?.length) {
      for (const step of result.plan) {
        process.stdout.write(`  ${step.status === "done" ? "✓" : step.status === "skipped" ? "-" : "·"} ${step.title}\n`);
      }
    }
    if (result.content) process.stdout.write(`\n${result.content.trim()}\n`);
    if (result.editFile) {
      const stats = result.editFile.stats ?? { adds: 0, dels: 0 };
      process.stdout.write(`\n${paint("EDIT", "38;2;132;169;140")} ${result.editFile.path} (+${stats.adds} −${stats.dels}) · ${result.editFile.status}\n`);
      if (result.editFile.backupPath) process.stdout.write(`  backup ${result.editFile.backupPath}\n`);
    }
    if (result.verifyTests) {
      const verify = result.verifyTests;
      process.stdout.write(`\n${paint("VERIFY", "38;2;132;169;140")} ${verify.cmd ?? verify.command ?? "tests"} · ${verify.summary ?? ""}\n`);
    }
    process.stdout.write(`\n${publicRun.ok ? "✓ complete" : "✗ failed"} · ${result.summary ?? ""}\n`);
  }
  process.exitCode = publicRun.ok ? 0 : 1;
}

async function commandInteractive(options, cwd) {
  if (options.demo && options.autoApprove) {
    throw new Error("refusing --yes on the bundled demo; copy demo-project and run there instead");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (options.task) return runHeadlessTask(options, cwd);
    throw new Error("interactive Matrix needs a TTY; pass a task for headless mode or use matrix dump/vision");
  }
  const session = options.sessionId
    ? loadSession(options.sessionId, { home: matrixHome(), cwd })
    : options.resume
    ? loadLatestSession(cwd, { home: matrixHome() })
    : null;
  if ((options.sessionId || options.resume) && !session) throw new Error("no matching saved session for this workspace");
  if (options.cols) process.env.MATRIX_COLS = String(options.cols);
  if (options.rows) process.env.MATRIX_ROWS = String(options.rows);
  if (options.mono) process.env.NO_COLOR = "1";

  const alt = !options.noAltScreen && isAltScreenSupported(process.stdout);
  if (alt) enterAltScreen(process.stdout);
  const stdout =
    options.noSync || !isSyncSupported()
      ? process.stdout
      : createSynchronizedStdout(process.stdout, { syncSupported: true });
  try {
    const app = render(
      h(MatrixApp, {
        cwd,
        initialTask: options.task,
        initialModel: options.modelQuery,
        initialSession: session,
        autoApprove: Boolean(options.autoApprove),
        offline: Boolean(options.offline),
      }),
      {
        stdout,
        stdin: process.stdin,
        exitOnCtrlC: false,
        patchConsole: false,
      }
    );
    await app.waitUntilExit();
  } finally {
    if (alt) exitAltScreen(process.stdout);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgv(argv, { cwd: process.cwd() });
  } catch (error) {
    process.stderr.write(`matrix: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Apply --mono to every path, including tour/dump headings and vision footers,
  // not only to the Ink renderer.
  if (options.mono) process.env.NO_COLOR = "1";
  if (options.version) {
    process.stdout.write(`matrix v${pkg().version}\n`);
    return;
  }
  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (options.command === "help") {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (options.command === "version") {
    process.stdout.write(`matrix v${pkg().version}\n`);
    return;
  }

  try {
    const cwd = resolveCwd(options);
    if (options.exportPng && options.command !== "vision") throw new Error("--png is only valid with matrix vision");
    if (options.command === "doctor") return commandDoctor(options);
    if (options.command === "sessions") return commandSessions(options);
    if (options.command === "vision") return commandVision(options);
    if (options.command === "smoke") return commandSmoke(options);
    if (options.command === "bench") return commandBench(options);
    if (options.command === "tour") return await commandTour(options);
    if (options.command === "dump") return await commandDump(options);
    return await commandInteractive(options, cwd);
  } catch (error) {
    process.stderr.write(`matrix: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const isDirectEntry = () => {
  if (!process.argv[1]) return false;
  try {
    const executedUrl = pathToFileURL(realpathSync(process.argv[1])).href;
    if (import.meta.url === executedUrl) return true;
  } catch {
    // continue to fallback
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
};

if (isDirectEntry()) {
  main();
}
