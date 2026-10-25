import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedactor } from "../lib/redaction.mjs";
import { EVAL_CANARY, EVAL_FAKE_PROVIDER_KEY } from "./cases.mjs";
import { formatEvalJson } from "./json.mjs";

const EVAL_ROOT = fileURLToPath(new URL(".", import.meta.url));
const REDACTOR = createRedactor({ secretValues: [EVAL_CANARY, EVAL_FAKE_PROVIDER_KEY] });

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeText(value) {
  let text = REDACTOR.text(value).replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  const tempPrefix = join(tmpdir(), "matrix-eval-");
  text = text.replace(new RegExp(`${escapeRegExp(tempPrefix)}[^/\\\\\\s"']+`, "g"), "<eval-temp>");
  return text.length > 16_384 ? `${text.slice(0, 16_384)}…[truncated]` : text;
}

/** JSON-safe projection with explicit nulls for missing metadata. */
export function sanitizeValue(value, depth = 0) {
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return sanitizeText(value.message);
  if (depth > 24) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = sanitizeValue(entry, depth + 1);
    return output;
  }
  return null;
}

export function sanitizeReport(report) {
  return sanitizeValue(report);
}

export function reportPaths(profile = "default") {
  if (!["default", "stress"].includes(profile)) throw new Error(`unknown eval profile: ${profile}`);
  return {
    json: join(EVAL_ROOT, "reports", `${profile}.json`),
    text: join(EVAL_ROOT, "reports", `${profile}.txt`),
  };
}

function taskLabel(value) {
  return value === null ? "n/a" : value ? "yes" : "no";
}

export function formatEvalText(report) {
  const lines = [
    `MATRIX EVAL · schema v${report.schemaVersion} · fixtures v${report.fixtureVersion} · ${report.profile}`,
    "Evidence: local-forge = deterministic capability; mocked-remote-policy = canned protocol/policy only; no live-provider evidence.",
    "case                                      task  contract  outcome          safety  recovery       run ms",
  ];
  for (const entry of report.cases) {
    const latency = entry.attempts[0]?.latencyMs.run[0];
    lines.push(
      `${entry.id.padEnd(42)} ${taskLabel(entry.taskSuccess).padEnd(5)} ${(entry.contractPass ? "pass" : "FAIL").padEnd(8)} ${entry.outcome.padEnd(15)} ${String(entry.safetyViolations.length).padEnd(7)} ${entry.recovery.status.padEnd(13)} ${Number.isFinite(latency) ? latency.toFixed(1) : "n/a"}`,
    );
    for (const violation of entry.safetyViolations) {
      lines.push(`  SAFETY ${violation.code}: ${violation.subject}`);
    }
    for (const failed of entry.contractChecks.filter((check) => !check.ok)) {
      lines.push(`  CONTRACT ${failed.code}`);
    }
  }
  lines.push(
    `Summary: ${report.summary.cases} cases · ${report.summary.contractPassed} contract pass · ${report.summary.taskSuccess} task success · ${report.summary.taskNotCompleted} not completed · ${report.summary.taskNotApplicable} task n/a · ${report.summary.safetyViolations} safety violations`,
  );
  lines.push(
    "No weighted score or cross-model/provider cost average is computed; JSON retains per-case provenance and raw latency samples.",
  );
  lines.push(
    `Cleanup: roots ${report.cleanup.allTemporaryRootsRemoved ? "removed" : "FAILED"} · env ${report.cleanup.allEnvironmentsRestored ? "restored" : "FAILED"} · fetch ${report.cleanup.allFetchImplementationsRestored ? "restored" : "FAILED"} · spawn ${report.cleanup.allSpawnImplementationsRestored ? "restored" : "FAILED"} · active processes ${report.cleanup.activeProcesses}`,
  );
  if (report.baselineComparison) {
    lines.push(
      `Baseline: ${report.baselineComparison.ok ? "PASS" : "FAIL"} · ${report.baselineComparison.checkedCases} cases checked · ${report.baselineComparison.failures.length} failures`,
    );
    for (const failure of report.baselineComparison.failures) {
      lines.push(
        `  BASELINE ${failure.code}${failure.caseId ? ` ${failure.caseId}` : ""}: ${failure.message}`,
      );
    }
  } else {
    lines.push("Baseline: not compared (explicit baseline-creation/development run)");
  }
  lines.push(`Overall: ${report.ok ? "PASS" : "FAIL"}`);
  return `${lines.join("\n")}\n`;
}

export async function writeReports(profile, report) {
  const sanitized = sanitizeReport(report);
  const paths = reportPaths(profile);
  mkdirSync(join(EVAL_ROOT, "reports"), { recursive: true });
  writeFileSync(paths.json, await formatEvalJson(sanitized), { mode: 0o644 });
  writeFileSync(paths.text, formatEvalText(sanitized), { mode: 0o644 });
  return { paths, report: sanitized };
}
