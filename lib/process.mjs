// ============================================================================
// Process runner.
//
// Real verification means spawning the project's own test command, streaming
// its output while it runs, and killing the whole process group on timeout or
// user abort. There is no shell interpolation here: a test plan is a file plus
// an argument vector.
// ============================================================================

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { stripAnsi } from "./text.mjs";
import { createRedactor, isSensitiveEnvName, secretValuesFromEnv } from "./redaction.mjs";
import { appendRunEvent, matrixHome, newRunId } from "./session.mjs";
import {
  createTestPolicy,
  currentTestExecutionContext,
  inspectTestPlan,
  redactTestPlan,
  TEST_ORIGIN,
  testPlanAudit,
} from "./test-policy.mjs";

const DEFAULT_TIMEOUT = 120_000;
const MAX_CAPTURE = 512 * 1024;
const UNSAFE_ENV = new Set([
  "BASH_ENV",
  "DYLD_INSERT_LIBRARIES",
  "ENV",
  "GIT_SSH_COMMAND",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PYTHONINSPECT",
  "PYTHONSTARTUP",
  "SSH_AUTH_SOCK",
]);

export function sanitizeProcessEnv(env = process.env, { allow = [] } = {}) {
  const allowed = new Set(allow);
  /** @type {NodeJS.ProcessEnv} */
  const clean = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (allowed.has(key) || (!isSensitiveEnvName(key) && !UNSAFE_ENV.has(key))) clean[key] = value;
  }
  return clean;
}

function splitLines(onLine) {
  const states = new Map();
  const emit = (state, line, stream) => {
    const prefix = state.truncated ? "…" : "";
    onLine(prefix + line.slice(-MAX_CAPTURE).replace(/\r$/, ""), stream);
    state.truncated = false;
  };
  return {
    push(chunk, stream) {
      if (!states.has(stream)) states.set(stream, { buffer: "", truncated: false });
      const state = states.get(stream);
      state.buffer += chunk;
      let index;
      while ((index = state.buffer.indexOf("\n")) !== -1) {
        const line = state.buffer.slice(0, index);
        state.buffer = state.buffer.slice(index + 1);
        emit(state, line, stream);
      }
      if (state.buffer.length > MAX_CAPTURE) {
        state.buffer = state.buffer.slice(-MAX_CAPTURE);
        state.truncated = true;
      }
    },
    end() {
      for (const [stream, state] of states) {
        if (state.buffer.length > 0) emit(state, state.buffer, stream);
        state.buffer = "";
      }
    },
  };
}

/**
 * Spawn a command and stream its lines. Never throws for spawn errors.
 * Returns { ok, code, signal, timedOut, aborted, stdout, stderr, durationMs }.
 * @param {Partial<import("./contracts.mjs").RunProcessOptions>} [options]
 */
export function runProcess({
  file,
  args = [],
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT,
  signal,
  env = process.env,
  display = null,
  onLine = null,
  stdin = "ignore",
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutChars = 0;
    let stderrChars = 0;
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let settled = false;
    let killTimer = null;

    const child = spawn(file, args, {
      cwd,
      env,
      stdio: [stdin, "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const reader = splitLines((line, stream) => {
      if (typeof onLine === "function") {
        try {
          onLine(stripAnsi(line), stream);
        } catch {
          // A rendering callback must never crash the runner.
        }
      }
    });

    const decoders = new Map();
    const captureText = (text, stream) => {
      if (!text) return;
      reader.push(text, stream);
      if (stream === "stdout") {
        stdoutChars += text.length;
        stdout = text.length >= MAX_CAPTURE ? text.slice(-MAX_CAPTURE) : stdout + text;
        if (stdout.length > MAX_CAPTURE) stdout = stdout.slice(-MAX_CAPTURE);
      } else {
        stderrChars += text.length;
        stderr = text.length >= MAX_CAPTURE ? text.slice(-MAX_CAPTURE) : stderr + text;
        if (stderr.length > MAX_CAPTURE) stderr = stderr.slice(-MAX_CAPTURE);
      }
    };
    const capture = (chunk, stream) => {
      if (!decoders.has(stream)) decoders.set(stream, new StringDecoder("utf8"));
      captureText(decoders.get(stream).write(chunk), stream);
    };

    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream) stdoutStream.on("data", (chunk) => capture(chunk, "stdout"));
    if (stderrStream) stderrStream.on("data", (chunk) => capture(chunk, "stderr"));

    const killGroup = (sig) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // Already gone.
      }
    };

    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      for (const [stream, decoder] of decoders) captureText(decoder.end(), stream);
      reader.end();
      cleanup();
      resolve({
        ok: !spawnError && !timedOut && !aborted && code === 0,
        code,
        signal: sig,
        timedOut,
        aborted,
        error: spawnError?.message ?? null,
        stdout,
        stderr,
        stdoutTruncated: stdoutChars > MAX_CAPTURE,
        stderrTruncated: stderrChars > MAX_CAPTURE,
        durationMs: Date.now() - started,
        command: display ?? `${file} ${args.join(" ")}`.trim(),
        cwd,
      });
    };

    const escalateKill = (delayMs) => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, delayMs);
      killTimer.unref?.();
    };

    const timeout =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup("SIGTERM");
            escalateKill(1500);
          }, timeoutMs)
        : null;

    const onAbort = () => {
      aborted = true;
      killGroup("SIGTERM");
      escalateKill(800);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.on("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on("close", (code, sig) => finish(code, sig));
  });
}

/** Human-readable command for a test plan. */
export function testPlanCommand(plan) {
  if (!plan) return null;
  return plan.display ?? `${plan.file} ${(plan.args ?? []).join(" ")}`.trim();
}

/** Restore trust/audit metadata that legacy agent result cards do not project. */
export function withTestExecutionMetadata(result, verification) {
  if (!result?.verifyTests || !verification) return result;
  const metadata = {};
  for (const key of [
    "trustDenied",
    "trustStatus",
    "trustReason",
    "trustDecision",
    "auditStatus",
    "auditError",
    "executionOrigin",
    "testPlan",
  ]) {
    if (verification[key] !== undefined) metadata[key] = verification[key];
  }
  return { ...result, verifyTests: { ...result.verifyTests, ...metadata } };
}

function deniedTestResult(
  plan,
  reason,
  {
    aborted = false,
    descriptor = null,
    redactor = createRedactor(),
    origin = TEST_ORIGIN.USER,
    trustStatus = "denied",
    auditStatus = "not-started",
    auditError = null,
    auditPath = null,
    runId = null,
  } = {},
) {
  return {
    ok: false,
    processOk: false,
    verified: false,
    verificationStatus: aborted ? "aborted" : "unverified",
    skipped: false,
    trustDenied: trustStatus === "denied",
    trustStatus,
    trustReason: redactor.text(reason),
    auditStatus,
    auditError,
    audit: { start: false, end: false, path: auditPath, runId },
    error: null,
    code: null,
    signal: null,
    timedOut: false,
    aborted,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    summary: `${aborted ? "test run aborted" : "verification unavailable"}: ${redactor.text(reason)}`,
    passed: 0,
    failed: 0,
    cases: [],
    lines: [],
    outputLineCount: 0,
    outputTruncated: false,
    durationMs: 0,
    command: redactor.text(testPlanCommand(plan)),
    cwd: descriptor?.cwd ?? plan?.cwd ?? null,
    testPlan: redactTestPlan(descriptor, redactor),
    executionOrigin: origin,
    framework: plan?.framework ?? "generic",
  };
}

/**
 * Approve, audit and run a repository test plan, then parse bounded/redacted
 * output. A missing trust decision or start-audit write always prevents spawn.
 */
export async function runTests(plan, options = {}) {
  if (!plan) {
    return {
      ok: false,
      processOk: false,
      verified: false,
      verificationStatus: "skipped",
      skipped: true,
      error: "No test command detected for this project",
      summary: "no test runner detected",
      passed: 0,
      failed: 0,
      cases: [],
      lines: [],
      outputLineCount: 0,
      outputTruncated: false,
      durationMs: 0,
      command: null,
    };
  }

  const active = currentTestExecutionContext();
  const rawEnv = options.env ?? process.env;
  const redactor = createRedactor({
    env: rawEnv,
    secretValues: [
      ...secretValuesFromEnv(process.env),
      ...(active?.secretValues ?? []),
      ...(options.secretValues ?? []),
    ],
  });
  const home = options.home ?? active?.home ?? matrixHome();
  const executionId = newRunId();
  const runId = options.runId ?? active?.runId ?? executionId;
  const origin = options.origin ?? active?.origin ?? TEST_ORIGIN.USER;
  const cwd = options.cwd ?? plan.cwd ?? process.cwd();
  let policy = options.policy ?? active?.policy ?? null;
  const requestTestApproval = options.requestTestApproval ?? null;
  if (!policy) {
    policy = createTestPolicy({
      home,
      headless: options.headless ?? false,
      allowStored: options.allowStored,
      allowTests: options.allowTests ?? false,
      requestApproval: requestTestApproval,
    });
  } else if (requestTestApproval) {
    policy = policy.withRequestApproval(requestTestApproval);
  }

  const auditOptions = { home, secretValues: redactor.values };
  const deny = (
    reason,
    {
      descriptor = null,
      aborted = false,
      trustStatus = "denied",
      auditStatus = "not-started",
      auditError = null,
    } = {},
  ) => {
    const auditPath = appendRunEvent(
      runId,
      {
        type: "trust:decision",
        status: aborted ? "aborted" : trustStatus === "denied" ? "denied" : "blocked",
        reason: redactor.text(reason),
        origin,
        executionId,
        testPlan: testPlanAudit(descriptor),
      },
      auditOptions,
    );
    return deniedTestResult(plan, reason, {
      aborted,
      descriptor,
      redactor,
      origin,
      trustStatus,
      auditStatus,
      auditError,
      auditPath,
      runId,
    });
  };

  const approval = await policy.authorize({
    plan,
    cwd,
    env: rawEnv,
    origin,
    signal: options.signal,
  });
  if (!approval.ok) {
    return deny(approval.reason, {
      descriptor: approval.plan,
      aborted: Boolean(options.signal?.aborted || /aborted/i.test(approval.reason ?? "")),
    });
  }

  // Close the approval-window metadata race. A changed executable, argv, cwd,
  // or current npm pretest/test/posttest hash needs a fresh decision.
  const reinspected = inspectTestPlan(plan, { cwd, env: rawEnv });
  if (!reinspected.ok || reinspected.plan.planHash !== approval.plan.planHash) {
    return deny(
      "test plan or script changed while approval was being decided; approve the new plan before running",
      {
        descriptor: reinspected.plan ?? approval.plan,
      },
    );
  }
  const descriptor = reinspected.plan;

  const startedAt = Date.now();
  const auditPath = appendRunEvent(
    runId,
    {
      type: "execution:start",
      executionId,
      status: "started",
      startedAt,
      origin,
      trustDecision: approval.decision,
      trustGrants: approval.grants,
      testPlan: testPlanAudit(descriptor),
    },
    { ...auditOptions, requireComplete: true },
  );
  if (!auditPath) {
    return deny("execution start audit could not be persisted; test execution was not started", {
      descriptor,
      trustStatus: "approved",
      auditStatus: "start-failed",
      auditError: "execution start audit write failed",
    });
  }

  const consoleLines = [];
  let outputLineCount = 0;
  // Repository tests are arbitrary code: do not expose provider credentials or
  // ambient loader hooks. Explicit integration tests can opt variables back in.
  // Also drop NODE_TEST_CONTEXT, which can make a nested suite exit with no tests.
  const env = sanitizeProcessEnv(rawEnv, { allow: options.allowEnv ?? [] });
  delete env.NODE_TEST_CONTEXT;
  let run;
  try {
    run = await runProcess({
      file: descriptor.executable,
      args: [...descriptor.args],
      cwd: descriptor.cwd,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
      signal: options.signal,
      env,
      display: testPlanCommand(plan),
      onLine: (line, stream) => {
        outputLineCount += 1;
        let safeLine = redactor.text(line);
        if (safeLine.length > MAX_CAPTURE + 1) safeLine = `…${safeLine.slice(-MAX_CAPTURE)}`;
        if (consoleLines.length >= 400) consoleLines.shift();
        consoleLines.push(safeLine);
        options.onLine?.(safeLine, stream);
      },
    });

    // Raw captures never leave this function. Redact before parsing, provider
    // projections, session cards or run-log serialization can observe them.
    run.stdout = redactor.text(run.stdout);
    run.stderr = redactor.text(run.stderr);
    if (run.stdout.length > MAX_CAPTURE) {
      run.stdout = run.stdout.slice(-MAX_CAPTURE);
      run.stdoutTruncated = true;
    }
    if (run.stderr.length > MAX_CAPTURE) {
      run.stderr = run.stderr.slice(-MAX_CAPTURE);
      run.stderrTruncated = true;
    }
    run.error = run.error ? redactor.text(run.error) : null;

    const parsed = parseTestOutput(`${run.stdout}\n${run.stderr}`, descriptor.framework);
    const understood = parsed.parseConfident || parsed.cases.length > 0;
    const verificationStatus = run.aborted
      ? "aborted"
      : run.timedOut
        ? "timedOut"
        : !run.ok || (parsed.failed ?? 0) > 0
          ? "failed"
          : !understood
            ? "unverified"
            : "verified";
    const verified = verificationStatus === "verified";
    const result = {
      ...run,
      ...parsed,
      processOk: run.ok,
      ok: verified,
      verified,
      verificationStatus,
      trustDenied: false,
      trustStatus: "approved",
      trustDecision: approval.decision,
      summary:
        parsed.summary ??
        (verificationStatus === "unverified"
          ? "unrecognized test output; verification unavailable"
          : parsed.summary),
      durationMs: parsed.durationMs ?? run.durationMs,
      lines: consoleLines,
      outputLineCount,
      outputTruncated: outputLineCount > consoleLines.length,
      framework: descriptor.framework,
      command: redactor.text(testPlanCommand(plan)),
      testPlan: redactTestPlan(descriptor, redactor),
      executionOrigin: origin,
    };
    const endPath = appendRunEvent(
      runId,
      {
        type: "execution:end",
        executionId,
        status: verificationStatus,
        endedAt: Date.now(),
        origin,
        processOk: run.ok,
        verified,
        code: run.code,
        signal: run.signal,
        timedOut: run.timedOut,
        aborted: run.aborted,
        durationMs: run.durationMs,
        outputTruncated: Boolean(
          result.outputTruncated || run.stdoutTruncated || run.stderrTruncated,
        ),
        error: run.error,
      },
      { ...auditOptions, requireComplete: true },
    );
    result.auditStatus = endPath ? "complete" : "end-failed";
    result.auditError = endPath ? null : "execution end audit could not be persisted";
    result.audit = { start: true, end: Boolean(endPath), path: auditPath, runId, executionId };
    return result;
  } catch (error) {
    appendRunEvent(
      runId,
      {
        type: "execution:end",
        executionId,
        status: run?.aborted ? "aborted" : run?.timedOut ? "timedOut" : "error",
        endedAt: Date.now(),
        origin,
        processOk: false,
        verified: false,
        code: run?.code ?? null,
        signal: run?.signal ?? null,
        timedOut: Boolean(run?.timedOut),
        aborted: Boolean(run?.aborted),
        durationMs: run?.durationMs ?? Date.now() - startedAt,
        error: redactor.text(error?.message ?? "test execution failed"),
      },
      { ...auditOptions, requireComplete: true },
    );
    throw error;
  }
}

const caseLines = (text) => {
  const cases = [];
  const seen = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const clean = stripAnsi(line).trim();
    let match;
    let pass;
    let name;
    if ((match = /^(?:not ok|✗|✖)\s*(?:\d+\s*[-–]\s*)?(.+)$/i.exec(clean))) {
      pass = false;
      name = match[1];
    } else if (/^FAILED\s+/.test(clean)) {
      pass = false;
      name = clean.replace(/^FAILED\s+/, "");
    } else if ((match = /^(?:ok|✓|✔|PASSED)\s*(?:\d+\s*[-–]\s*)?(.+)$/i.exec(clean))) {
      pass = true;
      name = match[1];
    } else {
      continue;
    }
    name = name.slice(0, 160);
    const key = `${pass ? "P" : "F"}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cases.push({ name, pass });
  }
  return cases.slice(0, 40);
};

/** Parse pytest / node:test / cargo / go / generic output. */
export function parseTestOutput(text, framework = "generic") {
  const raw = stripAnsi(String(text ?? ""));
  let passed = null;
  let failed = null;
  let duration = null;
  let summary = null;
  let confident = false;

  const set = (re) => {
    const match = re.exec(raw);
    return match ? Number(match[1]) : null;
  };
  const setLast = (re) => {
    let value = null;
    for (const match of raw.matchAll(re)) value = Number(match[1]);
    return value;
  };

  const pytest = framework === "pytest" || /(?:^|\n)=+.*(?:passed|failed).*in\s+[\d.]+s/m.test(raw);
  if (pytest) {
    // Use the last occurrence: a traceback can print arbitrary numbers that
    // look like "N failed" long before the real pytest summary line.
    passed = setLast(/(\d+)\s+passed/gi) ?? passed;
    const failedCount = setLast(/(\d+)\s+failed/gi) ?? 0;
    const errorCount = setLast(/(\d+)\s+errors?(?:\s|,|$)/gi) ?? 0;
    failed = failedCount + errorCount;
    const time = /in\s+([\d.]+)s/i.exec(raw);
    if (time) duration = Number(time[1]) * 1000;
    const summaryLine =
      /(?:^|\n)=+\s*(.+?(?:passed|failed|error).*?)\s*=+\s*$/im.exec(raw) ||
      /(?:^|\n)(\d+ (?:passed|failed).+? in [\d.]+s)\s*$/im.exec(raw);
    if (summaryLine) summary = summaryLine[1].trim();
    if (summaryLine || passed !== null || /\b\d+\s+(?:failed|error)/i.test(raw)) confident = true;
  }

  if (framework === "cargo") {
    const match = /test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed/i.exec(raw);
    if (match) {
      passed = Number(match[1]);
      failed = Number(match[2]);
      duration = set(/([\d.]+)s/) ?? duration;
      if (duration !== null && duration < 1000) duration *= 1000;
      summary = `${passed} passed · ${failed} failed`;
      confident = true;
    }
  }

  const nodeOutput =
    framework === "npm" ||
    framework === "node --test" ||
    /^(?:#|ℹ\uFE0F?)\s*(?:pass|fail)\s+\d+/m.test(raw);
  if (nodeOutput) {
    const nodePass = setLast(/^ℹ\uFE0F?\s*pass\s+(\d+)/gim) ?? set(/^# pass\s+(\d+)/im);
    const nodeFail = setLast(/^ℹ\uFE0F?\s*fail\s+(\d+)/gim) ?? set(/^# fail\s+(\d+)/im);
    if (nodePass !== null || nodeFail !== null) {
      passed = nodePass ?? passed;
      failed = nodeFail ?? failed;
      const time =
        /^ℹ\uFE0F?\s*duration_ms\s+([\d.]+)/im.exec(raw) || /^# duration_ms\s+([\d.]+)/im.exec(raw);
      if (time) duration = Number(time[1]);
      summary = `${passed ?? 0} passed · ${failed ?? 0} failed`;
      confident = true;
    }
  }

  if (framework === "go") {
    passed = null;
    failed = (raw.match(/^--- FAIL/gm) ?? []).length || (/\bFAIL\b/.test(raw) ? 1 : 0);
    summary = failed > 0 ? "FAIL" : /\bok\b/.test(raw) ? "ok" : null;
    if (summary !== null) confident = true;
  }

  if (passed === null && failed === null) {
    const p = (raw.match(/\b(\d+)\s+pass(?:ed)?\b/i) ?? [])[1];
    const f = (raw.match(/\b(\d+)\s+fail(?:ed)?\b/i) ?? [])[1];
    if (p !== undefined) passed = Number(p);
    if (f !== undefined) failed = Number(f);
    if (p !== undefined || f !== undefined) confident = true;
  }

  const cases = caseLines(raw);
  if (passed === null) passed = cases.filter((c) => c.pass).length;
  if (failed === null) failed = cases.filter((c) => !c.pass).length;

  return {
    passed,
    failed,
    durationMs: duration ?? null,
    summary:
      summary ??
      (confident
        ? `${passed ?? 0} passed · ${failed ?? 0} failed`
        : cases.length > 0
          ? `${passed ?? 0} passed · ${failed ?? 0} failed`
          : null),
    cases,
    parseConfident: confident,
  };
}

/** Check whether an executable can be spawned. */
export async function commandExists(file, args = ["--version"]) {
  if (!file) return false;
  const result = await runProcess({
    file,
    args,
    timeoutMs: 4000,
    onLine: null,
  });
  return !result.error;
}
