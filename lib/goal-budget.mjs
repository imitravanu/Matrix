// ============================================================================
// Cumulative durable-goal budgets.
//
// The authoritative ledger lives in the goal store: every operation intent
// reserves its maximum charge before dispatch, and a receipt may only consume
// part of that reservation. Reservations belong to the goal, not the process,
// so a retry, crash or fresh invocation cannot reset or refund them.
//
// These helpers are pure. They validate shapes, compute conservative
// reservations and remaining capacity, and describe actionable stop reasons.
// ============================================================================

import { GOAL_MAX_BUDGET, validateGoalBudget, validateGoalUsage } from "./goal-contracts.mjs";

export const BUDGET_DIMENSIONS = Object.freeze(Object.keys(GOAL_MAX_BUDGET));

/** A provider round may take at most this long before it is interrupted. */
export const PROVIDER_MAX_MS = 30_000;
/** A tool dispatch may take at most this long before it is reported uncertain. */
export const TOOL_MAX_MS = 15_000;

export const PROVIDER_RESERVATION = Object.freeze({
  rounds: 1,
  tools: 0,
  requests: 1,
  activeMs: PROVIDER_MAX_MS,
});

export const TOOL_RESERVATION = Object.freeze({
  rounds: 0,
  tools: 1,
  requests: 0,
  activeMs: TOOL_MAX_MS,
});

const ZERO = Object.freeze({ rounds: 0, tools: 0, requests: 0, activeMs: 0 });

/** @returns {{rounds: number, tools: number, requests: number, activeMs: number}} */
export function zeroUsage() {
  return { ...ZERO };
}

/**
 * A conservative reservation for one durable operation. `activeMs` is the
 * maximum time the executor will allow before interrupting and recording
 * uncertainty, so a crash cannot repeatedly avoid time accounting.
 * @param {"provider" | "tool" | "read" | "search" | "edit" | "test"} kind
 */
export function reservationFor(kind) {
  if (kind === "provider") return { ...PROVIDER_RESERVATION };
  return { ...TOOL_RESERVATION };
}

/** @param {*} counters */
function validateCounters(counters) {
  if (
    !counters ||
    typeof counters !== "object" ||
    Array.isArray(counters) ||
    !counters.used ||
    !counters.reserved
  ) {
    throw new Error("invalid goal budget: malformed counters");
  }
  return {
    used: validateGoalUsage(counters.used),
    reserved: validateGoalUsage(counters.reserved),
  };
}

/**
 * Remaining capacity in each dimension. A reservation is never refunded, so
 * this is the amount a *new* operation may reserve without exceeding the cap.
 * @param {*} limit
 * @param {*} counters
 */
export function remainingBudget(limit, counters) {
  const budget = validateGoalBudget(limit);
  const { used, reserved } = validateCounters(counters);
  const remaining = /** @type {Record<string, number>} */ ({});
  for (const key of BUDGET_DIMENSIONS) {
    remaining[key] = budget[key] - used[key] - reserved[key];
  }
  return remaining;
}

/**
 * A bounded projection for context, UI and stop reasons.
 * @param {*} limit
 * @param {*} counters
 */
export function budgetSnapshot(limit, counters) {
  const budget = validateGoalBudget(limit);
  const value = validateCounters(counters);
  return {
    limit: budget,
    used: value.used,
    reserved: value.reserved,
    remaining: remainingBudget(budget, value),
  };
}

/**
 * @param {*} limit
 * @param {*} counters
 * @param {*} reservation
 */
export function canReserve(limit, counters, reservation) {
  const amount = validateGoalUsage(reservation);
  const remaining = remainingBudget(limit, counters);
  return BUDGET_DIMENSIONS.every((key) => amount[key] <= remaining[key]);
}

/**
 * Throws before any dispatch when the persisted ledger cannot admit the next
 * reservation. The message names only the exhausted dimensions.
 * @param {*} limit
 * @param {*} counters
 * @param {*} reservation
 */
export function assertReservationAvailable(limit, counters, reservation) {
  const amount = validateGoalUsage(reservation);
  const remaining = remainingBudget(limit, counters);
  const exhausted = BUDGET_DIMENSIONS.filter((key) => amount[key] > remaining[key]);
  if (exhausted.length) {
    throw new Error(`goal budget: exhausted (${exhausted.join(", ")})`);
  }
  return amount;
}

/**
 * Observed active time, clamped to the reservation. A provider or tool that
 * overruns its reservation is interrupted; the reservation is the recorded
 * charge so cumulative accounting cannot undercount.
 * @param {number} startedAt
 * @param {number} now
 * @param {*} reservation
 */
export function elapsedUsage(startedAt, now, reservation) {
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(now) || now < startedAt) {
    throw new Error("invalid goal budget: invalid active interval");
  }
  const amount = validateGoalUsage(reservation);
  return Math.min(now - startedAt, amount.activeMs);
}

/**
 * Validate an explicit budget amendment. The store performs the same checks
 * before publishing; this helper lets CLI/UI surfaces explain a refusal before
 * a mutation. Increases only, never a decrease or a reset, and never above the
 * frozen upper limits.
 * @param {{ record: *, nextBudget: * }} input
 */
export function validateBudgetAmendment({ record, nextBudget }) {
  if (!record || typeof record !== "object" || !record.budget) {
    throw new Error("invalid goal budget: goal record is required");
  }
  const current = validateGoalBudget(record.budget);
  const next = validateGoalBudget(nextBudget);
  for (const key of BUDGET_DIMENSIONS) {
    if (next[key] < current[key]) throw new Error(`goal budget: ${key} cannot decrease`);
  }
  if (!BUDGET_DIMENSIONS.some((key) => next[key] > current[key])) {
    throw new Error("goal budget: amendment must increase at least one dimension");
  }
  return next;
}

/**
 * @param {*} limit
 * @param {*} counters
 */
export function budgetStopReason(limit, counters) {
  const snapshot = budgetSnapshot(limit, counters);
  const exhausted = BUDGET_DIMENSIONS.filter((key) => snapshot.remaining[key] <= 0);
  const message = exhausted.length
    ? `Budget exhausted: ${exhausted.join(", ")} reached the persisted limit.`
    : "Budget cannot admit the next durable operation.";
  return {
    code: "budget-exhausted",
    message,
    nextAction:
      "Inspect the goal, then explicitly amend the budget upward with a fresh " +
      "invocation. Retrying or restarting does not reset used or reserved totals.",
    budget: snapshot,
  };
}

/**
 * Explain a refused reservation without inventing headroom.
 * @param {*} limit
 * @param {*} counters
 * @param {*} reservation
 */
export function reservationRefusal(limit, counters, reservation) {
  const amount = validateGoalUsage(reservation);
  const remaining = remainingBudget(limit, counters);
  const short = BUDGET_DIMENSIONS.filter((key) => amount[key] > remaining[key]);
  return {
    code: "budget-exhausted",
    message: `No budget remains for the next operation (${short.join(", ")}).`,
    nextAction:
      "Stop dispatching. Resume only after an explicit upward budget amendment; " +
      "reservations from interrupted work are retained.",
    dimensions: short,
  };
}
