// ============================================================================
// `matrix doctor`: verify the things the workbench actually depends on.
// ============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectProject } from "./project.mjs";
import { isOpenRouterAvailable } from "./openrouter.mjs";
import { isSyncSupported } from "./sync-stream.mjs";
import { isAltScreenSupported } from "./alt-screen.mjs";
import { matrixHome } from "./session.mjs";

function commandVersion(file, args) {
  try {
    const result = spawnSync(file, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0)
      return { ok: false, error: (result.stderr || result.stdout).trim().slice(0, 160) };
    return {
      ok: true,
      output: (result.stdout || result.stderr).trim().split("\n")[0].slice(0, 120),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function writableDir(path) {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const probe = join(path, `.doctor-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(probe, "ok", { mode: 0o600 });
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run checks synchronously so the CLI can print a complete report before Ink
 * starts. Returns { checks, summary, project }.
 */
export function runDoctor({
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
} = {}) {
  const checks = [];
  const add = (name, status, detail, hint = null) => checks.push({ name, status, detail, hint });

  add("node", "ok", `${process.version} · ${process.platform}/${process.arch}`);
  add("cwd", "ok", cwd);

  const tty = Boolean(stdout?.isTTY);
  add(
    "terminal",
    tty ? "ok" : "warn",
    tty
      ? `${stdout.columns ?? "?"}×${stdout.rows ?? "?"} TTY`
      : "not a TTY (interactive UI needs one)",
    tty ? null : "run from a real terminal, or use matrix vision / dump",
  );

  const color =
    env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || /truecolor/i.test(env.TERM ?? "");
  add(
    "truecolor",
    color ? "ok" : "warn",
    color ? `COLORTERM=${env.COLORTERM ?? env.TERM}` : "COLORTERM is not truecolor",
    color ? null : "use --mono or NO_COLOR=1 for an ASCII luminance canvas",
  );

  add(
    "dec-2026-sync",
    isSyncSupported(env) ? "ok" : "warn",
    isSyncSupported(env)
      ? "synchronized output enabled"
      : "disabled (NO_COLOR/CI/unsupported TERM)",
    null,
  );
  add(
    "alt-screen",
    isAltScreenSupported(stdout, env) ? "ok" : "warn",
    isAltScreenSupported(stdout, env) ? "isolated screen buffer" : "inline mode",
  );

  let project = null;
  try {
    project = detectProject(cwd);
    add(
      "workspace",
      "ok",
      `${project.name} · ${project.fileCount} files · ${
        project.languages
          .slice(0, 3)
          .map((l) => l.name)
          .join(", ") || "no code"
      }`,
    );
    add(
      "git",
      project.isGit ? "ok" : "warn",
      project.isGit
        ? `⎇ ${project.branch}${project.dirty ? ` · ${project.dirty} dirty` : " · clean"}${project.nestedRepo ? " · nested" : ""}`
        : "not a git repository (undo still works, but diffs have no branch context)",
    );
    add(
      "tests",
      project.test ? "ok" : "warn",
      project.test
        ? `${project.test.display} · ${project.test.framework}`
        : "no test runner detected",
      project.test
        ? null
        : "add a test command to package.json / pytest config to enable verification",
    );
  } catch (error) {
    add("workspace", "fail", error.message);
  }

  const python = commandVersion("python3", ["--version"]);
  add(
    "python3",
    python.ok ? "ok" : "warn",
    python.ok ? python.output : python.error || "not found",
  );
  const pytest = commandVersion("python3", ["-m", "pytest", "--version"]);
  add(
    "pytest",
    pytest.ok ? "ok" : "warn",
    pytest.ok ? pytest.output : pytest.error || "not installed",
  );

  add(
    "openrouter-key",
    isOpenRouterAvailable() ? "ok" : "warn",
    isOpenRouterAvailable()
      ? "credential present (value never printed)"
      : "no key; Local Forge remains available",
    isOpenRouterAvailable() ? null : "set OPENROUTER_API_KEY or ~/.matrix/credentials.json",
  );

  const home = matrixHome();
  try {
    const wrote = writableDir(home);
    add(
      "matrix-home",
      wrote ? "ok" : "warn",
      `${home}${wrote ? " · writable" : " · not writable"}`,
    );
  } catch (error) {
    add("matrix-home", "warn", error.message);
  }

  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const bundledDemo = join(packageRoot, "demo-project");
  const cwdDemo = join(cwd, "demo-project");
  const demo = existsSync(bundledDemo) ? bundledDemo : cwdDemo;
  add(
    "demo",
    existsSync(demo) ? "ok" : "warn",
    existsSync(demo) ? demo : "demo-project not found (tour unavailable)",
  );

  const count = (status) => checks.filter((c) => c.status === status).length;
  return {
    checks,
    project,
    summary: {
      ok: count("ok"),
      warn: count("warn"),
      fail: count("fail"),
      total: checks.length,
    },
    version: process.env.npm_package_version ?? null,
  };
}

const ICON = { ok: "✓", warn: "!", fail: "✗" };
const COLOR = {
  ok: "\x1b[38;2;0;255;65m",
  warn: "\x1b[38;2;251;191;36m",
  fail: "\x1b[38;2;248;113;113m",
  reset: "\x1b[0m",
};

export function formatDoctor(report, { color = true } = {}) {
  const paint = (status, text) => (color ? `${COLOR[status] ?? ""}${text}${COLOR.reset}` : text);
  const lines = [];
  lines.push("MATRIX DOCTOR");
  lines.push("─────────────");
  for (const check of report.checks) {
    const icon = ICON[check.status] ?? "?";
    lines.push(`  ${paint(check.status, icon)} ${check.name.padEnd(15)} ${check.detail}`);
    if (check.hint) lines.push(`    ${" ".repeat(16)}${paint("warn", "→ " + check.hint)}`);
  }
  lines.push("");
  const { ok, warn, fail, total } = report.summary;
  lines.push(
    `${total} checks · ${paint("ok", `${ok} ok`)} · ${paint("warn", `${warn} warn`)} · ${paint("fail", `${fail} fail`)}`,
  );
  if (fail === 0) lines.push("Ready. Local Forge works without a network key.");
  return lines.join("\n");
}
