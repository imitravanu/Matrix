// ============================================================================
// Process runner.
//
// Real verification means spawning the project's own test command, streaming
// its output while it runs, and killing the whole process group on timeout or
// user abort. There is no shell interpolation here: a test plan is a file plus
// an argument vector.
// ============================================================================

import { spawn } from "node:child_process";
import { stripAnsi } from "./text.mjs";

const DEFAULT_TIMEOUT = 120_000;
const MAX_CAPTURE = 512 * 1024;

function splitLines(onLine) {
  let buffer = "";
  return {
    push(chunk, stream) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        onLine(line, stream);
      }
    },
    end() {
      if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ""), "stdout");
        buffer = "";
      }
    },
  };
}

/**
 * Spawn a command and stream its lines. Never throws for spawn errors.
 * Returns { ok, code, signal, timedOut, aborted, stdout, stderr, durationMs }.
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
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    let settled = false;

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

    const capture = (chunk, stream) => {
      const text = chunk.toString("utf8");
      reader.push(text, stream);
      if (stream === "stdout") {
        if (stdout.length < MAX_CAPTURE) stdout += text.slice(0, MAX_CAPTURE - stdout.length);
      } else if (stderr.length < MAX_CAPTURE) {
        stderr += text.slice(0, MAX_CAPTURE - stderr.length);
      }
    };

    child.stdout?.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => capture(chunk, "stderr"));

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
        durationMs: Date.now() - started,
        command: display ?? `${file} ${args.join(" ")}`.trim(),
        cwd,
      });
    };

    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killGroup("SIGTERM");
          setTimeout(() => killGroup("SIGKILL"), 1500).unref?.();
        }, timeoutMs)
      : null;

    const onAbort = () => {
      aborted = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 800).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
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

/**
 * Run a test plan and parse its output into a structured result.
 */
export async function runTests(plan, options = {}) {
  if (!plan) {
    return {
      ok: false,
      skipped: true,
      error: "No test command detected for this project",
      summary: "no test runner detected",
      passed: 0,
      failed: 0,
      cases: [],
      lines: [],
      durationMs: 0,
      command: null,
    };
  }

  const lines = [];
  const consoleLines = [];
  // A Matrix process launched from another node:test run inherits
  // NODE_TEST_CONTEXT. Passing it down makes Node skip the child suite and exit
  // zero with no results, which would look like a successful verification.
  const env = { ...(options.env ?? process.env) };
  delete env.NODE_TEST_CONTEXT;
  const run = await runProcess({
    file: plan.file,
    args: plan.args ?? [],
    cwd: options.cwd ?? plan.cwd,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
    signal: options.signal,
    env,
    display: testPlanCommand(plan),
    onLine: (line, stream) => {
      lines.push(line);
      if (consoleLines.length < 400) consoleLines.push(line);
      options.onLine?.(line, stream);
    },
  });

  const parsed = parseTestOutput(`${run.stdout}\n${run.stderr}`, plan.framework);
  return {
    ...run,
    ...parsed,
    lines: consoleLines,
    framework: plan.framework ?? "generic",
    command: testPlanCommand(plan),
  };
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

  const pytest =
    framework === "pytest" ||
    /(?:^|\n)=+.*(?:passed|failed).*in\s+[\d.]+s/m.test(raw);
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
    const nodePass =
      setLast(/^ℹ\uFE0F?\s*pass\s+(\d+)/gim) ?? set(/^# pass\s+(\d+)/im);
    const nodeFail =
      setLast(/^ℹ\uFE0F?\s*fail\s+(\d+)/gim) ?? set(/^# fail\s+(\d+)/im);
    if (nodePass !== null || nodeFail !== null) {
      passed = nodePass ?? passed;
      failed = nodeFail ?? failed;
      const time =
        /^ℹ\uFE0F?\s*duration_ms\s+([\d.]+)/im.exec(raw) ||
        /^# duration_ms\s+([\d.]+)/im.exec(raw);
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
      (confident ? `${passed ?? 0} passed · ${failed ?? 0} failed` : cases.length > 0 ? `${passed ?? 0} passed · ${failed ?? 0} failed` : null),
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
