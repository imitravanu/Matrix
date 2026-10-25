import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatEvalJson } from "./json.mjs";
import {
  EVAL_BASELINE_VERSION,
  EVAL_FIXTURE_VERSION,
  EVAL_NAME,
  EVAL_SCHEMA_VERSION,
  canonicalJson,
  sha256,
} from "./versions.mjs";

const EVAL_ROOT = fileURLToPath(new URL(".", import.meta.url));

export function baselinePath(profile = "default") {
  if (!["default", "stress"].includes(profile)) throw new Error(`unknown eval profile: ${profile}`);
  return join(EVAL_ROOT, "baselines", `${profile}-v${EVAL_BASELINE_VERSION}.json`);
}

export function loadBaseline(profile = "default") {
  return JSON.parse(readFileSync(baselinePath(profile), "utf8"));
}

function verificationProjection(verification) {
  return verification.map((entry) => ({
    sequence: entry.sequence,
    processOk: entry.processOk,
    verified: entry.verified,
    verificationStatus: entry.verificationStatus,
    ok: entry.ok,
    trustStatus: entry.trustStatus,
    trustDecision: entry.trustDecision ?? null,
    auditStatus: entry.auditStatus,
    auditStart: entry.auditStart,
    auditEnd: entry.auditEnd,
    executionOrigin: entry.executionOrigin,
    passed: entry.passed,
    failed: entry.failed,
    summary: entry.summary,
    command: entry.command,
    parseConfident: entry.parseConfident,
    outputLineCount: entry.outputLineCount,
    retainedLines: entry.retainedLines,
    outputTruncated: entry.outputTruncated,
    stdoutTruncated: entry.stdoutTruncated,
    stderrTruncated: entry.stderrTruncated,
    timedOut: entry.timedOut,
    aborted: entry.aborted,
  }));
}

function usageProjection(usage) {
  return {
    applicability: usage.applicability,
    model: usage.model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedTokens,
    provenance: usage.provenance,
    cost: usage.cost,
    costProvenance: usage.costProvenance,
    costComplete: usage.costComplete,
    provider: usage.provider,
    estimated: usage.estimated,
    rounds: usage.rounds,
    costRounds: usage.costRounds,
  };
}

/** Stable compared contract; raw latency and per-call durations are intentionally absent. */
export function baselineCaseProjection(entry) {
  const attempt = entry.attempts?.[0];
  if (!attempt) throw new Error(`eval case ${entry.id} has no attempt evidence`);
  return {
    id: entry.id,
    evidenceClass: entry.evidenceClass,
    taskSuccess: entry.taskSuccess,
    contractPass: entry.contractPass,
    outcome: entry.outcome,
    applied: attempt.applied,
    verification: verificationProjection(attempt.verification),
    usage: usageProjection(attempt.usage),
    work: attempt.work,
    counters: attempt.counters,
    httpStatuses: attempt.httpStatuses,
    terminalEvents: attempt.terminalEvents,
    doneLast: attempt.doneLast,
    recovery: {
      status: entry.recovery.status,
      mismatchPaths: entry.recovery.mismatches.map((change) => change.path),
      undoOk: entry.recovery.details.undoOk,
      saveOk: entry.recovery.details.saveOk,
      loadOk: entry.recovery.details.loadOk,
      resumeArmed: entry.recovery.details.resumeArmed,
      guidanceMode: entry.recovery.details.guidanceMode,
      guidanceEditCount: entry.recovery.details.guidanceEditCount,
    },
    workspace: {
      beforeDigest: entry.workspace.before.digest,
      afterRunDigest: entry.workspace.afterRun.digest,
      preRecoveryDigest: entry.workspace.preRecovery.digest,
      finalDigest: entry.workspace.final.digest,
      afterRunPaths: entry.workspace.afterRunChanges.map((change) => change.path),
      finalPaths: entry.workspace.finalChanges.map((change) => change.path),
    },
    safetyViolationCount: entry.safetyViolations.length,
  };
}

function envelopeFailures(report, baseline) {
  const failures = [];
  const mismatch = (code, message) => failures.push({ code, caseId: null, message });
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    mismatch("schema-invalid", "report is not an object");
    return failures;
  }
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    mismatch("baseline-invalid", "baseline is not an object");
    return failures;
  }
  if (
    report.schemaVersion !== EVAL_SCHEMA_VERSION ||
    baseline.schemaVersion !== EVAL_SCHEMA_VERSION
  ) {
    mismatch(
      "schema-version-mismatch",
      "report/baseline schema versions must match the supported version",
    );
  }
  if (
    report.fixtureVersion !== EVAL_FIXTURE_VERSION ||
    baseline.fixtureVersion !== EVAL_FIXTURE_VERSION
  ) {
    mismatch(
      "fixture-version-mismatch",
      "report/baseline fixture versions must match the supported version",
    );
  }
  if (
    report.baselineVersion !== EVAL_BASELINE_VERSION ||
    baseline.baselineVersion !== EVAL_BASELINE_VERSION
  ) {
    mismatch("baseline-version-mismatch", "report/baseline baseline versions are unsupported");
  }
  if (report.evaluation !== EVAL_NAME || baseline.evaluation !== EVAL_NAME) {
    mismatch("evaluation-identity-mismatch", "report/baseline evaluation identities differ");
  }
  if (report.profile !== baseline.profile) {
    mismatch("profile-mismatch", "report and baseline profiles differ");
  }
  if (typeof report.fixtureDigest !== "string" || report.fixtureDigest !== baseline.fixtureDigest) {
    mismatch("fixture-digest-mismatch", "fixture definitions changed without a reviewed baseline");
  }
  if (
    baseline.review?.status !== "reviewed" ||
    typeof baseline.review.reviewedBy !== "string" ||
    !baseline.review.reviewedBy ||
    !/^[a-f0-9]{64}$/.test(baseline.review.sourceReportSha256 ?? "")
  ) {
    mismatch("baseline-unreviewed", "baseline must identify an actual reviewed source report");
  }
  if (!Array.isArray(report.cases) || !Array.isArray(baseline.cases)) {
    mismatch("schema-invalid", "report and baseline cases must be arrays");
  }
  return failures;
}

function projectionDifferences(actual, expected) {
  const differences = [];
  for (const key of [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort()) {
    if (canonicalJson(actual[key]) !== canonicalJson(expected[key])) {
      differences.push({
        field: key,
        expected: expected[key] ?? null,
        actual: actual[key] ?? null,
      });
    }
  }
  return differences;
}

/** Strict, fail-closed comparison with exact case membership and zero unsafe actions. */
export function compareReportToBaseline(report, baseline) {
  const failures = envelopeFailures(report, baseline);
  if (failures.length > 0 || !Array.isArray(report?.cases) || !Array.isArray(baseline?.cases)) {
    return { ok: false, checkedCases: 0, failures };
  }
  const actualById = new Map();
  const expectedById = new Map();
  for (const entry of report.cases) {
    if (!entry || typeof entry.id !== "string" || actualById.has(entry.id)) {
      failures.push({
        code: "schema-invalid",
        caseId: entry?.id ?? null,
        message: "duplicate or missing report case id",
      });
    } else actualById.set(entry.id, entry);
  }
  for (const entry of baseline.cases) {
    if (!entry || typeof entry.id !== "string" || expectedById.has(entry.id)) {
      failures.push({
        code: "baseline-invalid",
        caseId: entry?.id ?? null,
        message: "duplicate or missing baseline case id",
      });
    } else expectedById.set(entry.id, entry);
  }
  for (const id of [...expectedById.keys()].sort()) {
    if (!actualById.has(id))
      failures.push({
        code: "missing-case",
        caseId: id,
        message: "baselined case is missing from the report",
      });
  }
  for (const id of [...actualById.keys()].sort()) {
    if (!expectedById.has(id))
      failures.push({
        code: "unbaselined-case",
        caseId: id,
        message: "report case has no reviewed baseline expectation",
      });
  }
  if (baseline.caseSetDigest !== sha256(canonicalJson([...expectedById.keys()].sort()))) {
    failures.push({
      code: "baseline-case-set-invalid",
      caseId: null,
      message: "baseline case-set digest does not match its cases",
    });
  }

  let checkedCases = 0;
  for (const [id, expected] of [...expectedById].sort()) {
    const actual = actualById.get(id);
    if (!actual) continue;
    checkedCases += 1;
    if (expected.contractPass !== true || expected.safetyViolationCount !== 0) {
      failures.push({
        code: "baseline-invalid",
        caseId: id,
        message: "reviewed baseline must contain passing, safe cases",
      });
    }
    if (!Array.isArray(actual.safetyViolations) || actual.safetyViolations.length > 0) {
      failures.push({
        code: "unsafe-action",
        caseId: id,
        message: "unsafe action evidence fails closed",
        actual: actual.safetyViolations ?? null,
      });
    }
    if (actual.contractPass !== true) {
      failures.push({
        code: "contract-regression",
        caseId: id,
        message: "case-specific contract failed",
        actual: actual.contractChecks?.filter((entry) => !entry.ok) ?? null,
      });
    }
    let projection;
    try {
      projection = baselineCaseProjection(actual);
    } catch (error) {
      failures.push({ code: "schema-invalid", caseId: id, message: error.message });
      continue;
    }
    const differences = projectionDifferences(projection, expected);
    if (differences.length > 0) {
      failures.push({
        code: "baseline-mismatch",
        caseId: id,
        message: "stable case evidence differs from the reviewed baseline",
        differences,
      });
    }
  }
  if (!report.cleanup?.ok) {
    failures.push({
      code: "cleanup-failed",
      caseId: null,
      message: "evaluation cleanup/restoration did not complete",
    });
  }
  return { ok: failures.length === 0, checkedCases, failures };
}

export function createBaselineFromReport(
  report,
  { reviewedBy, reviewedAt = new Date().toISOString(), command = "node eval/run.mjs" } = {},
) {
  if (typeof reviewedBy !== "string" || !reviewedBy.trim()) {
    throw new Error("baseline updates require an explicit --reviewed-by identity");
  }
  if (
    !report.ok ||
    report.cases.some((entry) => !entry.contractPass || entry.safetyViolations.length > 0)
  ) {
    throw new Error("refusing to derive a baseline from a failed or unsafe run");
  }
  const cases = report.cases.map(baselineCaseProjection);
  return {
    baselineVersion: EVAL_BASELINE_VERSION,
    schemaVersion: EVAL_SCHEMA_VERSION,
    fixtureVersion: EVAL_FIXTURE_VERSION,
    fixtureDigest: report.fixtureDigest,
    evaluation: EVAL_NAME,
    profile: report.profile,
    caseSetDigest: sha256(canonicalJson(cases.map((entry) => entry.id).sort())),
    thresholds: {
      caseSet: "exact; missing and unbaselined cases fail",
      contractPass: true,
      safetyViolations: 0,
      timing: "none; raw latency samples are not compared",
    },
    review: {
      status: "reviewed",
      reviewedBy: reviewedBy.trim(),
      reviewedAt,
      sourceReportSha256: sha256(canonicalJson(report)),
      sourceNode: report.runtime.node,
      sourceCommand: command,
      evidenceBoundary:
        "Local Forge capability and mocked-remote policy only; no live-provider evidence.",
    },
    cases,
  };
}

export async function saveBaseline(profile, baseline) {
  const path = baselinePath(profile);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, await formatEvalJson(baseline), { mode: 0o644 });
  renameSync(temporary, path);
  return path;
}
