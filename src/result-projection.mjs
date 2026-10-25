// Shared interactive result cards. Terminal classification stays in lib/outcome.mjs;
// this module only projects classified results into transcript/session shapes.

import { OUTCOME, withOutcome } from "../lib/outcome.mjs";
import { retainedOutput, verificationForTranscript } from "./session-codec.mjs";

/** @typedef {import("../lib/contracts.mjs").RunResult} RunResult */
/** @typedef {import("../lib/contracts.mjs").RunMetrics} RunMetrics */
/** @typedef {import("../lib/contracts.mjs").ClassifiedRunResult} ClassifiedRunResult */
/** @typedef {import("../lib/contracts.mjs").VerificationResult} VerificationResult */

/**
 * @param {RunResult} result
 * @param {{liveVerification?: VerificationResult|null, modelName?: string, now?: function(): number}} [options]
 * @returns {{normalized: ClassifiedRunResult, finalMetrics: RunMetrics, message: RunResult}}
 */
export function projectResult(
  result,
  { liveVerification = null, modelName = "MATRIX", now = Date.now } = {},
) {
  const normalized = withOutcome(result);
  const finalMetrics =
    normalized.metrics ?? (normalized.elapsedMs != null ? { elapsedMs: normalized.elapsedMs } : {});
  const message = {
    id: normalized.id ?? `asst-${now()}`,
    role: "assistant",
    content: normalized.content ?? "",
    reasoning: normalized.reasoning ?? "",
    plan: normalized.plan ?? [],
    readFile: normalized.readFile ?? null,
    editFile: normalized.editFile ?? null,
    verifyTests: verificationForTranscript(normalized.verifyTests, liveVerification),
    toolCards: normalized.toolCards ?? [],
    summary: normalized.summary ?? "",
    ok: normalized.ok,
    status: normalized.status,
    outcome: normalized.outcome,
    error: normalized.error,
    failure: normalized.failure,
    aborted: normalized.aborted,
    timedOut: normalized.timedOut,
    budgetExhausted: normalized.budgetExhausted,
    modelName: normalized.modelName ?? modelName,
    mode: normalized.mode,
    usage: normalized.usage ?? null,
    cost: normalized.cost ?? null,
    usageProvenance: normalized.usageProvenance ?? normalized.usage?.provenance ?? "unavailable",
    costProvenance: normalized.costProvenance ?? normalized.usage?.costProvenance ?? "unavailable",
    costComplete: normalized.costComplete ?? normalized.usage?.costComplete ?? false,
    recovery: normalized.recovery ?? null,
    metrics: finalMetrics,
    elapsedMs: normalized.elapsedMs ?? finalMetrics.elapsedMs ?? 0,
    elapsedTime:
      normalized.elapsedTime ??
      Math.round((normalized.elapsedMs ?? finalMetrics.elapsedMs ?? 0) / 1000),
    timestamp: now(),
  };
  return { normalized, finalMetrics, message };
}

/**
 * @param {VerificationResult} result
 * @param {{aborted?: boolean, now?: function(): number}} [options]
 * @returns {{normalized: ClassifiedRunResult, message: RunResult}}
 */
export function projectDirectTestResult(result, { aborted = false, now = Date.now } = {}) {
  const normalized = withOutcome({
    error: result.error ? true : false,
    failure: result.error ?? null,
    verification: result,
    aborted: aborted && !result.timedOut,
    timedOut: result.timedOut,
  });
  const verify = {
    cmd: result.command,
    results: (result.cases ?? []).map((item) => ({ name: item.name, pass: item.pass })),
    passed: result.passed,
    failed: result.failed,
    duration: `${Math.round(result.durationMs)}ms`,
    output: retainedOutput(result.lines),
    summary: normalized.status === OUTCOME.ABORTED ? "test run aborted" : result.summary,
    ok: result.ok,
    processOk: result.processOk ?? result.ok,
    verified: result.verified ?? result.ok,
    verificationStatus:
      normalized.status === OUTCOME.ABORTED ? "aborted" : result.verificationStatus,
    skipped: result.skipped,
    aborted: normalized.aborted,
    timedOut: normalized.timedOut,
    outputLineCount: result.outputLineCount ?? result.lines?.length ?? 0,
    outputTruncated: Boolean(result.outputTruncated),
    testPlan: result.testPlan ?? null,
    trustStatus: result.trustStatus ?? null,
    trustReason: result.trustReason ?? null,
    trustDecision: result.trustDecision ?? null,
    trustGrants: result.trustGrants ?? [],
  };
  const message = {
    id: `test-${now()}`,
    role: "assistant",
    content:
      normalized.status === OUTCOME.ABORTED
        ? "Test run aborted. No file was modified by /test."
        : normalized.ok
          ? ""
          : normalized.status === OUTCOME.UNVERIFIED
            ? "Verification unavailable. The output is above; no file was modified by /test."
            : normalized.status === OUTCOME.TIMED_OUT
              ? "Test run timed out. No file was modified by /test."
              : "Tests failed. The output is above; no file was modified by /test.",
    verifyTests: verify,
    summary:
      normalized.failure ?? result.summary ?? `${result.passed} passed · ${result.failed} failed`,
    ok: normalized.ok,
    status: normalized.status,
    outcome: normalized.outcome,
    error: !normalized.ok && normalized.status !== OUTCOME.ABORTED,
    failure: normalized.failure,
    aborted: normalized.aborted,
    timedOut: normalized.timedOut,
    budgetExhausted: normalized.budgetExhausted,
    modelName: "matrix/test",
    metrics: { elapsedMs: result.durationMs },
    elapsedMs: result.durationMs,
    timestamp: now(),
  };
  return { normalized, message };
}
