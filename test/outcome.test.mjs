import test from "node:test";
import assert from "node:assert/strict";

import { OUTCOME, classifyOutcome, withOutcome } from "../lib/outcome.mjs";

test("outcome classification permits success and non-error denial only", () => {
  const success = classifyOutcome({});
  assert.equal(success.status, OUTCOME.SUCCESS);
  assert.equal(success.ok, true);
  assert.equal(success.mode, "done");
  assert.equal(success.failure, null);

  const denied = classifyOutcome({ editFile: { status: "denied" }, error: false });
  assert.equal(denied.status, OUTCOME.DENIED);
  assert.equal(denied.outcome, OUTCOME.DENIED);
  assert.equal(denied.ok, true);
  assert.equal(denied.error, false);
  assert.equal(denied.failure, null);
  assert.equal(denied.mode, "done");
});

test("failed verification and operational failures are never success", () => {
  for (const input of [
    { failure: "could not ground an edit" },
    { error: true },
    {
      ok: true,
      status: "success",
      verifyTests: { ok: false, verificationStatus: "failed", summary: "1 failed" },
    },
  ]) {
    const outcome = classifyOutcome(input);
    assert.equal(outcome.status, OUTCOME.FAILED);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.mode, "error");
    assert.ok(outcome.failure);
  }
});

test("unrecognized, skipped, and missing edit verification are unverified", () => {
  const unrecognized = classifyOutcome({
    ok: true,
    verifyTests: {
      ok: false,
      processOk: true,
      verified: false,
      verificationStatus: "unverified",
      summary: "unrecognized test output; verification unavailable",
    },
  });
  assert.equal(unrecognized.status, OUTCOME.UNVERIFIED);
  assert.equal(unrecognized.ok, false);
  assert.match(unrecognized.failure, /unrecognized test output/);

  assert.equal(
    classifyOutcome({ verifyTests: { skipped: true, summary: "no test runner detected" } }).status,
    OUTCOME.UNVERIFIED,
  );
  assert.equal(classifyOutcome({ hasAppliedEdits: true }).status, OUTCOME.UNVERIFIED);
  assert.equal(
    classifyOutcome({
      hasAppliedEdits: true,
      verificationCurrent: false,
      verifyTests: { ok: true, verificationStatus: "verified" },
    }).status,
    OUTCOME.UNVERIFIED,
  );
});

test("timeout, abort, and budget exhaustion retain distinct terminal states", () => {
  const timeout = classifyOutcome({ failure: "stop", verifyTests: { timedOut: true, ok: false } });
  assert.equal(timeout.status, OUTCOME.TIMED_OUT);
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.aborted, false);
  assert.equal(timeout.ok, false);

  const aborted = classifyOutcome({
    error: true,
    failure: "stop",
    verifyTests: { aborted: true, timedOut: false },
  });
  assert.equal(aborted.status, OUTCOME.ABORTED);
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.phase, "aborted");
  assert.equal(aborted.mode, "aborted");
  assert.equal(aborted.ok, false);

  const budget = classifyOutcome({
    error: true,
    failure: "model reached the 24-call tool budget",
    budgetExhausted: true,
  });
  assert.equal(budget.status, OUTCOME.BUDGET_EXHAUSTED);
  assert.equal(budget.budgetExhausted, true);
  assert.equal(budget.ok, false);
});

test("explicit process evidence cannot be hidden by a legacy success field", () => {
  for (const [input, status] of [
    [{ ok: true, status: "success", aborted: true }, OUTCOME.ABORTED],
    [{ ok: true, status: "success", timedOut: true }, OUTCOME.TIMED_OUT],
    [{ ok: true, status: "success", budgetExhausted: true }, OUTCOME.BUDGET_EXHAUSTED],
    [{ ok: true, status: "success", failure: "failed" }, OUTCOME.FAILED],
  ]) {
    assert.equal(classifyOutcome(input).status, status);
    assert.equal(classifyOutcome(input).ok, false);
  }
});

test("withOutcome is idempotent and preserves the public result payload", () => {
  const original = {
    role: "assistant",
    content: "applied but output was not understood",
    elapsedMs: 42,
    metrics: { elapsedMs: 42 },
    error: false,
    verifyTests: {
      processOk: true,
      verified: false,
      ok: false,
      verificationStatus: "unverified",
      summary: "unrecognized test output; verification unavailable",
    },
  };
  const result = withOutcome(original);
  assert.equal(result.status, OUTCOME.UNVERIFIED);
  assert.equal(result.outcome, OUTCOME.UNVERIFIED);
  assert.equal(result.ok, false);
  assert.equal(result.content, original.content);
  assert.equal(result.elapsedMs, 42);
  assert.deepEqual(withOutcome(result), result);
});
