// ============================================================================
// Shared terminal-outcome classification.
//
// Process success, understood verification, and run success are different
// things. Every agent and result consumer uses this module so a denied edit can
// complete cleanly while failed, unknown, timed-out, aborted, and incomplete
// work can never be projected as success.
// ============================================================================

/** @typedef {import("./contracts.mjs").RunResult} RunResult */
/** @typedef {import("./contracts.mjs").VerificationResult} VerificationResult */
/** @typedef {import("./contracts.mjs").OutcomeStatus} OutcomeStatus */
/** @typedef {import("./contracts.mjs").OutcomeClassification} OutcomeClassification */
/** @typedef {import("./contracts.mjs").ClassifiedRunResult} ClassifiedRunResult */

export const OUTCOME = Object.freeze({
  SUCCESS: "success",
  DENIED: "denied",
  FAILED: "failed",
  UNVERIFIED: "unverified",
  TIMED_OUT: "timedOut",
  ABORTED: "aborted",
  BUDGET_EXHAUSTED: "budgetExhausted",
});

const STATUSES = new Set(Object.values(OUTCOME));

/** @param {RunResult} input */
function declaredStatus(input) {
  if (STATUSES.has(input.status)) return input.status;
  if (STATUSES.has(input.outcome)) return input.outcome;
  return null;
}

/** @param {VerificationResult|null|undefined} verification */
function verificationStatus(verification) {
  if (!verification || typeof verification !== "object") return null;
  if (typeof verification.verificationStatus === "string") return verification.verificationStatus;
  if (verification.aborted === true) return "aborted";
  if (verification.timedOut === true) return "timedOut";
  if (verification.skipped === true) return "skipped";
  if (verification.verified === true) return "verified";
  // Legacy result cards only have `ok`. A false legacy value is a failure,
  // never evidence of successful or understood verification.
  if (verification.ok === true) return "verified";
  if (verification.ok === false) return "failed";
  return null;
}

/** @param {RunResult} input */
function failureText(input) {
  if (typeof input.failure === "string" && input.failure.trim()) return input.failure;
  if (typeof input.error === "string" && input.error.trim()) return input.error;
  return null;
}

/**
 * @param {OutcomeStatus} status
 * @param {VerificationResult|null} verification
 */
function defaultFailure(status, verification) {
  const summary =
    typeof verification?.summary === "string" && verification.summary.trim()
      ? verification.summary
      : null;
  switch (status) {
    case OUTCOME.ABORTED:
      return "run aborted";
    case OUTCOME.TIMED_OUT:
      return `verification timed out${summary ? `: ${summary}` : ""}`;
    case OUTCOME.BUDGET_EXHAUSTED:
      return "run budget exhausted";
    case OUTCOME.UNVERIFIED:
      return `verification unavailable${summary ? `: ${summary}` : ""}`;
    case OUTCOME.FAILED:
      return verification ? `tests failed${summary ? `: ${summary}` : ""}` : "run failed";
    default:
      return null;
  }
}

/**
 * Classify one terminal run. `verification` and `verifyTests` are aliases, and
 * the optional booleans let an agent distinguish an outer abort or an explicit
 * budget stop before constructing its public result.
 *
 * Precedence is abort, timeout, budget exhaustion, failed verification,
 * declared failure/unverified state, other errors, missing/unrecognized
 * verification, denial, then success. In particular, a pre-existing `ok: true`
 * or `status: "success"` cannot override contrary process evidence.
 * @param {RunResult|null} [value]
 * @returns {OutcomeClassification}
 */
export function classifyOutcome(value = {}) {
  /** @type {RunResult} */
  const input = value && typeof value === "object" ? value : {};
  const verification = input.verification ?? input.verifyTests ?? null;
  const verifyStatus = verificationStatus(verification);
  const declared = declaredStatus(input);
  const failure = failureText(input);
  const editStatus = input.editStatus ?? input.editFile?.status ?? null;
  const hasAppliedEdits = Boolean(input.hasAppliedEdits ?? input.applied);
  const denied = Boolean(
    input.denied === true || (!hasAppliedEdits && editStatus === OUTCOME.DENIED),
  );

  const aborted = Boolean(
    input.aborted === true ||
    verification?.aborted === true ||
    verifyStatus === "aborted" ||
    declared === OUTCOME.ABORTED,
  );
  const timedOut = Boolean(
    input.timedOut === true ||
    verification?.timedOut === true ||
    verifyStatus === "timedOut" ||
    declared === OUTCOME.TIMED_OUT,
  );
  const budgetExhausted = Boolean(
    input.budgetExhausted === true || declared === OUTCOME.BUDGET_EXHAUSTED,
  );

  /** @type {OutcomeStatus} */
  let status;
  if (aborted) status = OUTCOME.ABORTED;
  else if (timedOut) status = OUTCOME.TIMED_OUT;
  else if (budgetExhausted) status = OUTCOME.BUDGET_EXHAUSTED;
  else if (verifyStatus === "failed") status = OUTCOME.FAILED;
  else if (declared === OUTCOME.FAILED) status = OUTCOME.FAILED;
  else if (declared === OUTCOME.UNVERIFIED && input.error !== true) status = OUTCOME.UNVERIFIED;
  else if (failure || input.error === true) status = OUTCOME.FAILED;
  else if (verifyStatus === "unverified" || verifyStatus === "skipped") status = OUTCOME.UNVERIFIED;
  else if (hasAppliedEdits && (!verification || input.verificationCurrent === false)) {
    status = OUTCOME.UNVERIFIED;
  } else if (denied) status = OUTCOME.DENIED;
  else status = OUTCOME.SUCCESS;

  const ok = status === OUTCOME.SUCCESS || status === OUTCOME.DENIED;
  return {
    ok,
    status,
    outcome: status,
    phase: status === OUTCOME.ABORTED ? "aborted" : ok ? "complete" : "failed",
    mode: status === OUTCOME.ABORTED ? "aborted" : ok ? "done" : "error",
    error: Boolean(input.error),
    failure: ok ? null : (failure ?? defaultFailure(status, verification)),
    aborted: status === OUTCOME.ABORTED,
    timedOut: status === OUTCOME.TIMED_OUT,
    budgetExhausted: status === OUTCOME.BUDGET_EXHAUSTED,
  };
}

/**
 * Return a result with one coherent, idempotent set of terminal fields.
 * @param {RunResult|null} result
 * @param {RunResult} [overrides]
 * @returns {ClassifiedRunResult}
 */
export function withOutcome(result, overrides = {}) {
  /** @type {RunResult} */
  const source = result && typeof result === "object" ? result : {};
  // `mode` already means local/remote on assistant messages, and `phase` is an
  // event concern. Keep those projections out of the persisted result shape.
  const {
    mode: _swarmMode,
    phase: _phase,
    ...fields
  } = classifyOutcome({ ...source, ...overrides });
  return {
    ...source,
    ...fields,
  };
}
