#!/usr/bin/env node
// ============================================================================
// Matrix CLI.
//
// Interactive workbench, headless task runner, doctor, real demo tour, pixel
// canvas export, render dumps, smoke checks and a benchmark.
// ============================================================================

import React from "react";
import { render } from "ink";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseArgv, HELP_TEXT } from "../lib/cli.mjs";
import { detectProject, readFileSafe } from "../lib/project.mjs";
import { resolveInside } from "../lib/workspace.mjs";
import { parseScopes } from "../lib/scope.mjs";
import { runLocalAgent } from "../lib/local-agent.mjs";
import { runModelAgent } from "../lib/model-agent.mjs";
import { classifyOutcome } from "../lib/outcome.mjs";
import { withTestExecutionMetadata } from "../lib/process.mjs";
import { isOpenRouterAvailable } from "../lib/openrouter.mjs";
import { MODELS, resolveModel } from "../lib/models.mjs";
import { createSwarmState, applySwarmEvent } from "../lib/swarm.mjs";
import {
  loadLatestSession,
  loadSession,
  listSessions,
  matrixHome,
  newRunId,
} from "../lib/session.mjs";
import { createTestPolicy, TEST_ORIGIN, withTestExecutionContext } from "../lib/test-policy.mjs";
import { createCommandPolicy } from "../lib/command-policy.mjs";
import { runDoctorAsync, formatDoctor } from "../lib/doctor.mjs";
import { halfBlockAnsi, toAscii, writePng } from "../lib/raster.mjs";
import { buildVision } from "../lib/graph.mjs";
import { stripAnsi } from "../lib/text.mjs";
import { enterAltScreen, exitAltScreen, isAltScreenSupported } from "../lib/alt-screen.mjs";
import { createSynchronizedStdout, isSyncSupported } from "../lib/sync-stream.mjs";
import { MatrixApp } from "../src/matrix.mjs";
import { ALL_VIEWS, DEFAULT_SCOPE_EXTENSIONS } from "../src/views.mjs";
import { checkFrame, renderScreen } from "../src/render.mjs";

const h = React.createElement;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_ROOT = join(PACKAGE_ROOT, "demo-project");
const SOURCE_EXTENSIONS = DEFAULT_SCOPE_EXTENSIONS;
const CLI_HELP_TEXT = HELP_TEXT.replace(
  "      --yes                   auto-approve edits (careful)",
  "      --yes                   auto-approve edits only; does not trust tests\n      --allow-tests           trust one exact test plan; required for headless tests",
).replace(
  "  matrix bench                rendering/layout benchmark\n      --iterations <n>        frames per screen for bench",
  "  matrix bench                local smoke benchmarks (no provider network)\n      --iterations <n>        samples per case (bounded per profile/case)\n      --stress                opt into larger bounded stress fixtures\n      --suite <names>         comma-separated suites or all",
);

const VALUE_OPTION_NAMES = new Set([
  "--model",
  "-m",
  "--cwd",
  "-C",
  "--cols",
  "--rows",
  "--screen",
  "--mode",
  "--file",
  "--png",
  "--out",
  "--session",
  "--iterations",
  "--bench-iterations",
  "--suite",
  "--allow-command",
]);

function extractTestTrustFlag(argv) {
  let allowTests = false;
  let afterDoubleDash = false;
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!afterDoubleDash && arg === "--") afterDoubleDash = true;
    if (!afterDoubleDash && VALUE_OPTION_NAMES.has(arg) && index + 1 < argv.length) {
      // Do not steal a would-be value: parseArgv must continue to reject
      // `--model --allow-tests` as a missing model rather than a new flag.
      args.push(arg, argv[++index]);
      continue;
    }
    if (!afterDoubleDash && arg === "--allow-tests") {
      allowTests = true;
      continue;
    }
    args.push(arg);
  }
  return { args, allowTests };
}

function extractBenchmarkFlags(argv) {
  let stress = false;
  let suite = null;
  let afterDoubleDash = false;
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!afterDoubleDash && arg === "--") afterDoubleDash = true;
    if (!afterDoubleDash && arg === "--stress") {
      stress = true;
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("--stress=")) {
      throw new Error("--stress does not take a value");
    }
    if (!afterDoubleDash && (arg === "--suite" || arg.startsWith("--suite="))) {
      const inline = arg.startsWith("--suite=");
      const value = inline ? arg.slice("--suite=".length) : argv[++index];
      if (!value || (!inline && VALUE_OPTION_NAMES.has(value)) || value.startsWith("-")) {
        throw new Error("--suite expects a comma-separated suite name");
      }
      suite = value;
      continue;
    }
    if (!afterDoubleDash && VALUE_OPTION_NAMES.has(arg) && index + 1 < argv.length) {
      // Preserve another option's would-be value so parseArgv remains the
      // authority on missing values and flag-as-value errors.
      args.push(arg, argv[++index]);
      continue;
    }
    args.push(arg);
  }
  return { args, stress, suite };
}

function pkg() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
}

function resolveCwd(options) {
  const raw = options.demo ? DEMO_ROOT : (options.cwd ?? process.cwd());
  const cwd = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(cwd)) throw new Error(`workspace not found: ${cwd}`);
  if (options.demo && !existsSync(DEMO_ROOT))
    throw new Error("demo-project is missing from the package");
  return cwd;
}

function firstSource(project, preferred = null) {
  if (preferred) return preferred;
  const file = project.files.find((entry) => SOURCE_EXTENSIONS.has(entry.ext));
  return file?.rel ?? null;
}

function sourceData(project, file) {
  if (!file) return { file: null, source: "", parsed: null };
  const resolved = resolveInside(project.root, file);
  if (!resolved.ok) return { file, source: "", parsed: null, error: resolved.error };
  const readable = readFileSafe(resolved.path);
  if (!readable.ok) return { file: resolved.rel, source: "", parsed: null, error: readable.error };
  return {
    file: resolved.rel,
    source: readable.content,
    parsed: parseScopes(readable.content, resolved.rel, { truncated: Boolean(readable.truncated) }),
  };
}

function sizeFrom(options, fallback = { columns: 100, rows: 30 }) {
  return {
    columns: options.cols ?? fallback.columns,
    rows: options.rows ?? fallback.rows,
  };
}

function clampSize(options, fallback) {
  const size = sizeFrom(options, fallback);
  return {
    columns: Math.max(40, Math.min(200, size.columns)),
    rows: Math.max(14, Math.min(80, size.rows)),
  };
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
  return options.mono || "NO_COLOR" in process.env ? stripAnsi(text) : text;
}

async function captureDemoRun(_options = {}) {
  if (!existsSync(DEMO_ROOT)) throw new Error("demo-project is missing");
  const temp = mkdtempSync(join(tmpdir(), "matrix-tour-"));
  const workspace = join(temp, "demo-project");
  const home = join(temp, ".matrix");
  const previousHome = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = home;
  try {
    cpSync(DEMO_ROOT, workspace, {
      recursive: true,
      force: true,
      filter: (src) => !src.includes("__pycache__") && !src.includes(".pytest_cache"),
    });
    const project = detectProject(workspace);
    const task = "Fix the off-by-one in the bounds slice in src/processor.py";
    let proposal = null;
    let swarmState = createSwarmState({ task, project });
    const events = [];
    const runId = newRunId();
    // Tour/dump/smoke explicitly execute Matrix's bundled, read-only demo
    // source on a private temp copy. Scope this one-time test trust decision to
    // that exact copy and plan; it never persists or weakens the edit gate.
    const policy = createTestPolicy({ home, headless: true, allowTests: true });
    const result = await withTestExecutionContext(
      {
        home,
        runId,
        origin: TEST_ORIGIN.MODEL,
        policy,
      },
      () =>
        runLocalAgent({
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
        }),
    );
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
    props.size,
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
    process.stdout.write(
      `\n${paint("Tour complete.", "38;2;0;255;65")} The temp workspace was removed.\n`,
    );
  } finally {
    capture.cleanup();
  }
}

async function commandDump(options) {
  const choices = ALL_VIEWS;
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
      {
        id: "smoke-user",
        role: "user",
        content: "Inspect the workspace and propose one grounded change.",
      },
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
    for (const screen of ALL_VIEWS) {
      const ansi = renderScreen(screen, data, size);
      const check = checkFrame(ansi, size);
      report.push({ screen, ...size, ...check });
      if (!check.ok)
        throw new Error(`${screen} at ${size.columns}×${size.rows}: ${check.problems.join(", ")}`);
    }
  }
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, checks: report.length, sizes, report }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`MATRIX SMOKE\n`);
  process.stdout.write(
    `  ${report.length} frame checks across ${sizes.length} geometries · all passed\n`,
  );
  for (const size of sizes) {
    const rows = report.filter((item) => item.columns === size.columns && item.rows === size.rows);
    const max = Math.max(...rows.map((item) => item.width));
    process.stdout.write(
      `  ${String(size.columns).padStart(3)}×${String(size.rows).padStart(2)}  ${String(max).padStart(3)} max cols  ${rows.length} screens\n`,
    );
  }
}

async function commandBench(options) {
  const size = clampSize(options, { columns: 120, rows: 36 });
  // Keep the ordinary CLI free of benchmark-only Ink test streams and fixture
  // code. Benchmarks never use the resolved workspace or a provider.
  const { runBenchmarks, formatBenchmarkText } = await import("../bench/run.mjs");
  const report = await runBenchmarks({
    mode: options.benchStress ? "stress" : "smoke",
    iterations: options.benchIterations,
    suites: options.benchSuite,
    size,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatBenchmarkText(report));
  if (!report.ok) process.exitCode = 1;
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
    const target = isAbsolute(options.exportPng)
      ? options.exportPng
      : resolve(process.cwd(), options.exportPng);
    mkdirSync(dirname(target), { recursive: true });
    const written = writePng(graph.canvas, target);
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
    return;
  }
  const monochrome = options.mono || "NO_COLOR" in process.env;
  process.stdout.write(
    `${monochrome ? toAscii(graph.canvas, { width: canvasWidth }) : halfBlockAnsi(graph.canvas)}\n`,
  );
  process.stdout.write(
    `${paint(`${graph.title ?? "VISION"} · ${data.file} · ${data.parsed.language}`, "38;2;132;169;140")}\n`,
  );
}

function commandSessions(options) {
  const sessions = listSessions({
    home: matrixHome(),
    onWarning: (warning) => process.stderr.write(`matrix: session warning: ${warning.message}\n`),
  });
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
      `  ${String(session.id).padEnd(20)} ${when}  ${String(session.modelId ?? "local").padEnd(8)} ${String(session.messages).padStart(3)} msgs  ${session.cwd ?? ""}\n`,
    );
  }
}

async function commandDoctor(options) {
  const cwd = resolveCwd(options);
  const report = await runDoctorAsync({ cwd, stdout: process.stdout });
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ summary: report.summary, checks: report.checks, sandbox: report.sandbox }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${formatDoctor(report, { color: !options.mono && process.stdout.isTTY })}\n`,
    );
  }
  if (report.summary.fail > 0) process.exitCode = 1;
}

function publicResult(result) {
  const outcome = classifyOutcome(result);
  return {
    ok: outcome.ok,
    status: outcome.status,
    outcome: outcome.status,
    error: result.error ?? null,
    failure: outcome.failure,
    aborted: outcome.aborted,
    timedOut: outcome.timedOut,
    budgetExhausted: outcome.budgetExhausted,
    summary: result.summary,
    content: result.content,
    modelName: result.modelName,
    usage: result.usage ?? null,
    cost: result.cost ?? null,
    usageProvenance: result.usageProvenance ?? result.usage?.provenance ?? "unavailable",
    costProvenance: result.costProvenance ?? result.usage?.costProvenance ?? "unavailable",
    costComplete: result.costComplete ?? result.usage?.costComplete ?? false,
    recovery: result.recovery ?? null,
    elapsedMs: result.elapsedMs ?? result.metrics?.elapsedMs ?? null,
    metrics: result.metrics ?? {},
    plan: result.plan ?? [],
    commands: Array.isArray(result.commands) ? result.commands : [],
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
          processOk: result.verifyTests.processOk ?? result.verifyTests.ok,
          verified: result.verifyTests.verified ?? result.verifyTests.ok,
          verificationStatus:
            result.verifyTests.verificationStatus ??
            (result.verifyTests.ok ? "verified" : "failed"),
          timedOut: result.verifyTests.timedOut ?? false,
          aborted: result.verifyTests.aborted ?? false,
          parseConfident: result.verifyTests.parseConfident ?? null,
          trustDenied: result.verifyTests.trustDenied ?? false,
          trustStatus: result.verifyTests.trustStatus ?? null,
          trustReason: result.verifyTests.trustReason ?? null,
          auditStatus: result.verifyTests.auditStatus ?? null,
          auditError: result.verifyTests.auditError ?? null,
          executionOrigin: result.verifyTests.executionOrigin ?? null,
          testPlan: result.verifyTests.testPlan ?? null,
        }
      : null,
  };
}

async function runHeadlessTask(options, cwd) {
  const project = detectProject(cwd);
  const query = options.offline ? "local" : (options.modelQuery ?? "local");
  const model = resolveModel(query, { fallback: false });
  if (!model) throw new Error(`unknown model "${query}"; use --help to list supported aliases`);
  if (options.approvedCommandPlanHash && !model.remote) {
    throw new Error(
      "--allow-command requires a remote tool-calling model; Local Forge never infers a command plan",
    );
  }
  if (model.remote && !isOpenRouterAvailable(model.id)) {
    throw new Error(
      `${model.name} needs an OpenRouter key; use Local Forge or set OPENROUTER_API_KEY`,
    );
  }
  let lastVerification = null;
  const common = {
    task: options.task,
    project,
    autoApprove: Boolean(options.autoApprove),
    requestApproval: async () => (options.autoApprove ? "y" : "n"),
    onEvent: (event) => {
      if (event.type === "verify:end") lastVerification = event.result ?? null;
    },
  };
  const home = matrixHome();
  const runId = newRunId();
  const commandCapability = options.enableCommands
    ? {
        enabled: true,
        headless: true,
        home,
        runId,
        // Exactly one object for this invocation, even when the provider asks
        // for the same command twice. Edit/test approval never fills this hash.
        policy: createCommandPolicy({
          enabled: true,
          headless: true,
          approvedPlanHash: options.approvedCommandPlanHash,
        }),
      }
    : null;
  // Edit approval and repository-test trust are independent decisions. In
  // headless mode even previously stored interactive trust is insufficient
  // unless an embedding caller explicitly opts into it; --allow-tests is exact-
  // plan and invocation-scoped.
  const policy = createTestPolicy({
    home,
    headless: true,
    allowTests: Boolean(options.allowTests),
  });
  const agentResult = await withTestExecutionContext(
    {
      home,
      runId,
      origin: TEST_ORIGIN.MODEL,
      policy,
    },
    () =>
      model.remote ? runModelAgent({ ...common, model, commandCapability }) : runLocalAgent(common),
  );
  const result = withTestExecutionMetadata(agentResult, lastVerification);
  const publicRun = publicResult(result);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ project: { name: project.name, root: project.root, branch: project.branch }, model: model.id, result: publicRun }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `${paint(`MATRIX · ${model.name} · ${project.name}`, "1;38;2;0;255;65")}\n`,
    );
    process.stdout.write(`${paint("TASK", "38;2;132;169;140")} ${options.task}\n`);
    if (result.plan?.length) {
      for (const step of result.plan) {
        process.stdout.write(
          `  ${step.status === "done" ? "✓" : step.status === "skipped" ? "-" : "·"} ${step.title}\n`,
        );
      }
    }
    if (result.content) process.stdout.write(`\n${result.content.trim()}\n`);
    if (result.editFile) {
      const stats = result.editFile.stats ?? { adds: 0, dels: 0 };
      process.stdout.write(
        `\n${paint("EDIT", "38;2;132;169;140")} ${result.editFile.path} (+${stats.adds} −${stats.dels}) · ${result.editFile.status}\n`,
      );
      if (result.editFile.backupPath)
        process.stdout.write(`  backup ${result.editFile.backupPath}\n`);
    }
    for (const command of publicRun.commands) {
      process.stdout.write(
        `\n${paint("SANDBOX", "38;2;132;169;140")} ${command.commandStatus} · ${command.reason} · processOk=${command.processOk} · audit=${command.auditStatus} · cleanup=${command.cleanupStatus}\n`,
      );
      if (command.commandPlan?.planHash)
        process.stdout.write(`  plan ${command.commandPlan.planHash}\n`);
      process.stdout.write("  live workspace unchanged · writes discarded · undo not applicable\n");
    }
    if (result.verifyTests) {
      const verify = result.verifyTests;
      process.stdout.write(
        `\n${paint("VERIFY", "38;2;132;169;140")} ${verify.cmd ?? verify.command ?? "tests"} · ${verify.summary ?? ""}\n`,
      );
      if (verify.testPlan) {
        process.stdout.write(`  executable/argv ${verify.testPlan.command}\n`);
        if (verify.testPlan.script) process.stdout.write(`  script ${verify.testPlan.script}\n`);
      }
    }
    process.stdout.write(
      `\n${publicRun.ok ? "✓ complete" : `✗ ${publicRun.status}`} · ${result.summary ?? ""}\n`,
    );
  }
  process.exitCode = publicRun.ok ? 0 : 1;
}

async function commandInteractive(options, cwd) {
  if (options.demo && options.autoApprove) {
    throw new Error("refusing --yes on the bundled demo; copy demo-project and run there instead");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (options.task) return runHeadlessTask(options, cwd);
    throw new Error(
      "interactive Matrix needs a TTY; pass a task for headless mode or use matrix dump/vision",
    );
  }
  if (options.approvedCommandPlanHash) {
    throw new Error("--allow-command is only valid for a non-interactive headless task");
  }
  if (options.modelQuery && !options.offline) {
    const selected = resolveModel(options.modelQuery, { fallback: false });
    if (!selected)
      throw new Error(
        `unknown model "${options.modelQuery}"; use --help to list supported aliases`,
      );
  }
  const session = options.sessionId
    ? loadSession(options.sessionId, {
        home: matrixHome(),
        cwd,
        onWarning: (warning) =>
          process.stderr.write(`matrix: session warning: ${warning.message}\n`),
      })
    : options.resume
      ? loadLatestSession(cwd, {
          home: matrixHome(),
          onWarning: (warning) =>
            process.stderr.write(`matrix: session warning: ${warning.message}\n`),
        })
      : null;
  if ((options.sessionId || options.resume) && !session)
    throw new Error("no matching saved session for this workspace");
  if (options.cols) process.env.MATRIX_COLS = String(options.cols);
  if (options.rows) process.env.MATRIX_ROWS = String(options.rows);
  if (options.mono) process.env.NO_COLOR = "1";

  const alt = !options.noAltScreen && isAltScreenSupported(process.stdout);
  if (alt) enterAltScreen(process.stdout);
  const stdout =
    options.noSync || !isSyncSupported()
      ? process.stdout
      : createSynchronizedStdout(process.stdout, { syncSupported: true });
  const home = matrixHome();
  const policy = createTestPolicy({ home, allowTests: Boolean(options.allowTests) });
  await withTestExecutionContext({ home, policy, origin: TEST_ORIGIN.USER }, async () => {
    try {
      const app = render(
        h(MatrixApp, {
          cwd,
          initialTask: options.task,
          initialModel: options.modelQuery,
          initialSession: session,
          autoApprove: Boolean(options.autoApprove),
          offline: Boolean(options.offline),
          enableCommands: Boolean(options.enableCommands),
        }),
        {
          stdout,
          stdin: process.stdin,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await app.waitUntilExit();
    } finally {
      if (alt) exitAltScreen(process.stdout);
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    const extracted = extractTestTrustFlag(argv);
    const benchmark = extractBenchmarkFlags(extracted.args);
    options = parseArgv(benchmark.args, { cwd: process.cwd() });
    if (extracted.allowTests && options.command !== "interactive") {
      throw new Error("--allow-tests is only valid with an interactive or headless task");
    }
    if ((benchmark.stress || benchmark.suite !== null) && options.command !== "bench") {
      throw new Error("--stress and --suite are only valid with matrix bench");
    }
    options.allowTests = extracted.allowTests;
    options.benchStress = benchmark.stress;
    options.benchSuite = benchmark.suite;
  } catch (error) {
    process.stderr.write(`matrix: ${error.message}\nTry 'matrix --help' for usage.\n`);
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
    process.stdout.write(`${CLI_HELP_TEXT}\n`);
    return;
  }
  if (options.command === "help") {
    process.stdout.write(`${CLI_HELP_TEXT}\n`);
    return;
  }
  if (options.command === "version") {
    process.stdout.write(`matrix v${pkg().version}\n`);
    return;
  }

  try {
    const cwd = resolveCwd(options);
    if (options.exportPng && options.command !== "vision")
      throw new Error("--png is only valid with matrix vision");
    if (options.command === "doctor") return await commandDoctor(options);
    if (options.command === "sessions") return commandSessions(options);
    if (options.command === "vision") return commandVision(options);
    if (options.command === "smoke") return commandSmoke(options);
    if (options.command === "bench") return await commandBench(options);
    if (options.command === "tour") return await commandTour(options);
    if (options.command === "dump") return await commandDump(options);
    return await commandInteractive(options, cwd);
  } catch (error) {
    process.stderr.write(`matrix: ${error.message}\nTry 'matrix --help' for usage.\n`);
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
