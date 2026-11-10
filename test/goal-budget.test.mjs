import test from "node:test";
import assert from "node:assert/strict";
import { GOAL_DEFAULT_BUDGET, GOAL_MAX_BUDGET } from "../lib/goal-contracts.mjs";
import {
  BUDGET_DIMENSIONS,
  PROVIDER_RESERVATION,
  TOOL_RESERVATION,
  assertReservationAvailable,
  budgetSnapshot,
  budgetStopReason,
  canReserve,
  elapsedUsage,
  remainingBudget,
  reservationFor,
  validateBudgetAmendment,
  zeroUsage,
} from "../lib/goal-budget.mjs";

const counters = (used = {}, reserved = {}) => ({
  used: { ...zeroUsage(), ...used },
  reserved: { ...zeroUsage(), ...reserved },
});

test("reservations are explicit, bounded and cumulative", () => {
  assert.deepEqual(reservationFor("provider"), PROVIDER_RESERVATION);
  assert.deepEqual(reservationFor("edit"), TOOL_RESERVATION);
  assert.deepEqual(remainingBudget(GOAL_DEFAULT_BUDGET, counters()), {
    ...GOAL_DEFAULT_BUDGET,
  });
  const ledger = counters({ tools: 2 }, { activeMs: 30_000 });
  assert.deepEqual(remainingBudget(GOAL_DEFAULT_BUDGET, ledger), {
    rounds: 8,
    tools: 22,
    requests: 32,
    activeMs: 570_000,
  });
  assert.equal(canReserve(GOAL_DEFAULT_BUDGET, ledger, PROVIDER_RESERVATION), true);
  assert.equal(canReserve(GOAL_DEFAULT_BUDGET, ledger, TOOL_RESERVATION), true);
});

test("a reservation is refused before dispatch when any dimension is short", () => {
  const ledger = counters({ tools: 24 });
  assert.equal(canReserve(GOAL_DEFAULT_BUDGET, ledger, TOOL_RESERVATION), false);
  assert.throws(
    () => assertReservationAvailable(GOAL_DEFAULT_BUDGET, ledger, TOOL_RESERVATION),
    /goal budget: exhausted \(tools\)/,
  );
  const reason = budgetStopReason(GOAL_DEFAULT_BUDGET, ledger);
  assert.equal(reason.code, "budget-exhausted");
  assert.match(reason.nextAction, /amend/i);
  assert.deepEqual(reason.budget.used.tools, 24);
});

test("observed active time is clamped and never negative or unbounded", () => {
  assert.equal(elapsedUsage(100, 250, TOOL_RESERVATION), 150);
  assert.equal(elapsedUsage(100, 20_000, TOOL_RESERVATION), TOOL_RESERVATION.activeMs);
  assert.throws(() => elapsedUsage(200, 100, TOOL_RESERVATION), /invalid active interval/);
  assert.throws(() => elapsedUsage(Number.NaN, 100, TOOL_RESERVATION), /invalid active interval/);
});

test("budget amendments increase monotonically and respect the frozen maximum", () => {
  const record = { budget: { ...GOAL_DEFAULT_BUDGET } };
  const amended = { ...GOAL_DEFAULT_BUDGET, rounds: 12 };
  assert.deepEqual(validateBudgetAmendment({ record, nextBudget: amended }), amended);
  assert.throws(
    () =>
      validateBudgetAmendment({
        record,
        nextBudget: { ...GOAL_DEFAULT_BUDGET, rounds: 7 },
      }),
    /rounds cannot decrease/,
  );
  assert.throws(
    () =>
      validateBudgetAmendment({
        record,
        nextBudget: { ...GOAL_DEFAULT_BUDGET, tools: 1 },
      }),
    /cannot decrease/,
  );
  assert.throws(
    () =>
      validateBudgetAmendment({
        record,
        nextBudget: { ...GOAL_DEFAULT_BUDGET, requests: GOAL_MAX_BUDGET.requests + 1 },
      }),
    /invalid goal contract/,
  );
  assert.throws(
    () => validateBudgetAmendment({ record, nextBudget: { ...GOAL_DEFAULT_BUDGET } }),
    /must increase/,
  );
});

test("budget snapshots preserve used and reserved rather than refunding", () => {
  const ledger = counters({ activeMs: 1_000, requests: 2 }, { activeMs: 30_000, rounds: 1 });
  const snapshot = budgetSnapshot(GOAL_DEFAULT_BUDGET, ledger);
  assert.deepEqual(snapshot.used, ledger.used);
  assert.deepEqual(snapshot.reserved, ledger.reserved);
  assert.deepEqual(Object.keys(snapshot.remaining), [...BUDGET_DIMENSIONS]);
  assert.throws(
    () => budgetSnapshot(GOAL_DEFAULT_BUDGET, { used: {}, reserved: {} }),
    /invalid goal contract/,
  );
});
