import test from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_DEFAULT_BUDGET,
  GOAL_LIMITS,
  GOAL_STATES,
  JOURNAL_SCHEMA_VERSION,
  LEASE_MAX_MS,
  LEASE_SCHEMA_VERSION,
  OPERATION_INTENT_SCHEMA_VERSION,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  amendGoalBudget,
  assertJournalAppend,
  assertLeaseForGoal,
  assertLeaseHeld,
  assertOperationAuthority,
  assertOperationReceipt,
  completeGoal,
  createGoalLease,
  decodeJournalRecord,
  dispatchOperationIntent,
  encodeJournalRecord,
  goalStateFromOutcome,
  journalChecksum,
  newGoalId,
  observeOperationIntent,
  renewGoalLease,
  reserveOperationBudget,
  sealJournalRecord,
  settleOperationBudget,
  transitionGoal,
  updateGoalBudget,
  validateGoalBudget,
  validateGoalId,
  validateGoalLease,
  validateGoalPath,
  validateGoalRecord,
  validateJournalChain,
  validateJournalRecord,
  validateOperationIntent,
  validateOperationReceipt,
} from "../lib/goal-contracts.mjs";

const hash = "a".repeat(64);
function record() {
  return {
    schemaVersion: 1,
    id: newGoalId(),
    createdAt: 1,
    objective: "Fix the defect",
    workspace: { path: "/tmp/project", device: "1", inode: "42", revision: null, manifest: hash },
    provider: { id: "local", modelId: "local", digest: hash },
    state: "ready",
    generation: 0,
    sequence: 0,
    budget: { ...GOAL_DEFAULT_BUDGET },
    operations: [],
    criteria: [
      { id: newGoalId("criterion"), revision: 1, kind: "test", planHash: hash },
      {
        id: newGoalId("criterion"),
        revision: 1,
        kind: "artifact",
        path: "src/file.js",
        sha256: hash,
      },
      { id: newGoalId("criterion"), revision: 1, kind: "human", description: "Review the diff" },
    ],
  };
}
const fence = (value) => ({
  goalId: value.id,
  generation: value.generation,
  sequence: value.sequence,
});
const zeros = () => ({ rounds: 0, tools: 0, requests: 0, activeMs: 0 });

test("goal metadata round-trips without aliasing and rejects unsupported or lossy input", () => {
  const value = record();
  assert.deepEqual(validateGoalRecord(JSON.parse(JSON.stringify(value))), value);
  const copy = validateGoalRecord(value);
  copy.criteria[0].revision++;
  assert.equal(value.criteria[0].revision, 1);
  for (const mutate of [
    (r) => (r.schemaVersion = 2),
    (r) => (r.sequence = NaN),
    (r) => (r.generation = Infinity),
    (r) => (r.createdAt = -1),
    (r) => (r.id = "../../escape"),
    (r) => (r.extra = true),
    (r) => (r.workspace.path = "/tmp/../escape"),
    (r) => (r.workspace.inode = 3),
    (r) => (r.workspace.manifest = "unknown"),
    (r) => (r.workspace.revision = "main"),
    (r) => (r.provider.apiKey = "secret"),
    (r) => (r.objective = " "),
    (r) => (r.state = "done"),
    (r) => (r.operations = ["bad"]),
    (r) => {
      const id = newGoalId("operation");
      r.operations = [id, id];
    },
    (r) => r.criteria.push(r.criteria[0]),
    (r) => (r.criteria = []),
    (r) => (r.criteria[0].kind = "model-says-done"),
    (r) => (r.criteria[0].revision = 0),
    (r) => (r.criteria[1].path = "../escape"),
    (r) => (r.criteria[2].description = ""),
    (r) => (r.budget.rounds = 129),
    (r) => (r.objective = "x".repeat(16385)),
  ]) {
    const invalid = record();
    mutate(invalid);
    assert.throws(() => validateGoalRecord(invalid), /invalid goal contract/);
  }
});

test("IDs and workspace-relative paths refuse traversal and ambiguous forms", () => {
  for (const kind of ["goal", "attempt", "operation", "criterion"]) {
    assert.equal(validateGoalId(newGoalId(kind), kind).startsWith(kind), true);
  }
  assert.throws(() => newGoalId("unknown"));
  for (const path of [
    "../x",
    "a/../../x",
    "/absolute",
    "a//b",
    "a/./b",
    "a\\b",
    ".",
    "a\0b",
    "a\nb",
  ]) {
    assert.throws(() => validateGoalPath(path), path);
  }
  assert.equal(validateGoalPath("src/a.js"), "src/a.js");
  assert.equal(validateGoalPath("/tmp/project", true), "/tmp/project");
});

test("lifecycle fences reject late callbacks and terminal restart", () => {
  const original = record();
  const running = transitionGoal(original, "running", fence(original));
  assert.equal(running.generation, 1);
  assert.equal(running.sequence, 1);
  assert.throws(() => transitionGoal(running, "paused", fence(original)), /stale fence/);
  const stopped = transitionGoal(running, "interrupted", fence(running));
  const recovered = transitionGoal(stopped, "reconciling", fence(stopped));
  assert.equal(recovered.generation, 2);
  assert.throws(() => transitionGoal(recovered, "running", fence(running)), /stale fence/);
  for (const state of GOAL_STATES) {
    for (const terminal of ["completed", "cancelled"]) {
      assert.throws(() => transitionGoal({ ...original, state: terminal }, state, fence(original)));
    }
  }
  assert.throws(() => transitionGoal(original, "unknown", fence(original)), /forbidden/);
  assert.throws(() => transitionGoal(running, "completed", fence(running)), /evidence/);
});

test("completion requires every criterion bound to the current generation and manifest", () => {
  const value = { ...record(), state: "running", generation: 2 };
  const evidence = value.criteria.map((c) => ({
    criterionId: c.id,
    revision: c.revision,
    generation: 2,
    manifest: hash,
    binding: c.planHash ?? c.sha256 ?? null,
    accepted: true,
  }));
  assert.equal(completeGoal(value, evidence, fence(value)).state, "completed");
  for (const mutate of [
    (e) => e.pop(),
    (e) => (e[0].accepted = false),
    (e) => e[0].generation--,
    (e) => (e[0].manifest = "b".repeat(64)),
    (e) => (e[0].binding = "b".repeat(64)),
    (e) => e[0].revision++,
    (e) => (e[1] = e[0]),
    (e) => (e[0].criterionId = newGoalId("criterion")),
  ]) {
    const invalid = structuredClone(evidence);
    mutate(invalid);
    assert.throws(() => completeGoal(value, invalid, fence(value)));
  }
});

test("budget reservations survive round trips, cap uncertain work, and consume atomically", () => {
  const initial = { used: zeros(), reserved: zeros() };
  const charge = { rounds: 1, tools: 2, requests: 3, activeMs: 1000 };
  const reserved = updateGoalBudget(GOAL_DEFAULT_BUDGET, initial, "reserve", charge);
  assert.deepEqual(initial.reserved, zeros());
  const reopened = JSON.parse(JSON.stringify(reserved));
  assert.deepEqual(reopened.reserved, charge);
  const consumed = updateGoalBudget(GOAL_DEFAULT_BUDGET, reopened, "consume", charge);
  assert.deepEqual(consumed.used, charge);
  assert.deepEqual(consumed.reserved, zeros());
  assert.throws(
    () => updateGoalBudget(GOAL_DEFAULT_BUDGET, initial, "consume", charge),
    /unreserved/,
  );
  assert.throws(() => updateGoalBudget(GOAL_DEFAULT_BUDGET, initial, "refund", charge), /unknown/);
  const max = updateGoalBudget(GOAL_DEFAULT_BUDGET, initial, "reserve", GOAL_DEFAULT_BUDGET);
  assert.throws(() => updateGoalBudget(GOAL_DEFAULT_BUDGET, max, "reserve", charge), /exhausted/);
  assert.deepEqual(max.reserved, GOAL_DEFAULT_BUDGET);
  for (const bad of [-1, Infinity, NaN, 1.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() =>
      updateGoalBudget(GOAL_DEFAULT_BUDGET, initial, "reserve", { ...charge, tools: bad }),
    );
  }
  assert.throws(() => validateGoalBudget({ ...GOAL_DEFAULT_BUDGET, money: 1 }));
});

test("budget amendment preserves consumed counters and requires a stopped fenced goal", () => {
  const value = { ...record(), state: "budget-exhausted" };
  const counters = { used: { ...GOAL_DEFAULT_BUDGET }, reserved: zeros() };
  const next = { ...GOAL_DEFAULT_BUDGET, rounds: 16 };
  const amended = amendGoalBudget(value, next, counters, fence(value));
  assert.equal(amended.state, "ready");
  assert.deepEqual(counters.used, GOAL_DEFAULT_BUDGET);
  assert.throws(
    () => amendGoalBudget(value, GOAL_DEFAULT_BUDGET, counters, fence(value)),
    /increase/,
  );
  assert.throws(
    () => amendGoalBudget(value, { ...next, tools: 1 }, counters, fence(value)),
    /decrease/,
  );
  assert.throws(() => transitionGoal(value, "ready", fence(value)), /amendment/);
});

test("a successful or denied run does not supply goal completion evidence", () => {
  assert.equal(
    goalStateFromOutcome({ status: "success", verification: { ok: true } }),
    "needs-attention",
  );
  assert.equal(goalStateFromOutcome({ status: "denied" }), "needs-attention");
  assert.equal(goalStateFromOutcome({ status: "aborted" }), "interrupted");
  assert.equal(goalStateFromOutcome({ status: "budgetExhausted" }), "budget-exhausted");
});

const otherHash = "b".repeat(64);
const afterHash = "d".repeat(64);
function runningGoal(overrides = {}) {
  return { ...record(), state: "running", generation: 1, sequence: 1, ...overrides };
}
function operator(overrides = {}) {
  return { pid: 4242, startTime: "12345", bootId: "boot-0001", ...overrides };
}
function workspaceRootOf(goal) {
  return { path: goal.workspace.path, device: goal.workspace.device, inode: goal.workspace.inode };
}
function image(exists, sha256 = hash, mode = 0o644) {
  return exists
    ? { exists: true, sha256, mode, blob: "c".repeat(64) }
    : { exists: false, sha256: null, mode: null, blob: null };
}
function editIntent(goal, overrides = {}) {
  const attemptId = overrides.attemptId ?? newGoalId("attempt");
  return {
    schemaVersion: OPERATION_INTENT_SCHEMA_VERSION,
    goalId: goal.id,
    attemptId,
    generation: goal.generation,
    operationId: newGoalId("operation"),
    kind: "edit",
    arguments: { sha256: hash, blob: "c".repeat(64) },
    planHash: hash,
    authority: {
      kind: "edit",
      planHash: hash,
      decisionId: newGoalId("decision"),
      scope: "operation",
    },
    workspace: structuredClone(goal.workspace),
    preconditions: { files: [{ path: "src/file.js", exists: true, sha256: hash }] },
    edit: {
      path: "src/file.js",
      before: image(true, hash),
      after: image(true, afterHash, 0o755),
    },
    reservation: { rounds: 0, tools: 1, requests: 0, activeMs: 1000 },
    state: "prepared",
    ...overrides,
  };
}
function readIntent(goal, overrides = {}) {
  return editIntent(goal, {
    kind: "read",
    authority: { kind: "none", planHash: null, decisionId: null, scope: "operation" },
    preconditions: { files: [{ path: "src/file.js", exists: true, sha256: hash }] },
    edit: null,
    reservation: { rounds: 0, tools: 1, requests: 0, activeMs: 500 },
    ...overrides,
  });
}
function receiptFor(intent, overrides = {}) {
  const path = intent.edit?.path ?? "src/file.js";
  const sha256 = intent.edit?.after?.exists ? intent.edit.after.sha256 : hash;
  return {
    schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
    goalId: intent.goalId,
    attemptId: intent.attemptId,
    generation: intent.generation,
    operationId: intent.operationId,
    sequence: 3,
    status: "succeeded",
    evidence: [],
    files: [{ path, state: "matches-after", sha256 }],
    process: null,
    usage: structuredClone(intent.reservation),
    uncertainty: { kind: "none", detail: null },
    ...overrides,
  };
}
function leaseFor(goal, attemptId, overrides = {}) {
  return {
    schemaVersion: LEASE_SCHEMA_VERSION,
    leaseId: newGoalId("lease"),
    goalId: goal.id,
    attemptId,
    generation: goal.generation,
    workspace: workspaceRootOf(goal),
    owner: operator(),
    acquiredAt: 1000,
    expiresAt: 1000 + LEASE_MAX_MS,
    ...overrides,
  };
}
function journalRecord({
  goal,
  attemptId,
  generation = goal.generation,
  sequence,
  previous = null,
  kind,
  operationId = null,
  payload,
}) {
  return sealJournalRecord({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sequence,
    goalId: goal.id,
    attemptId,
    generation,
    kind,
    operationId,
    prevChecksum: previous === null ? null : previous.checksum,
    payload,
  });
}

test("journal records round-trip canonical bytes and link checksums", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const intent = editIntent(goal, { attemptId });
  const intentRecord = journalRecord({
    goal,
    attemptId,
    sequence: 1,
    kind: "intent",
    operationId: intent.operationId,
    payload: intent,
  });
  const dispatchRecord = journalRecord({
    goal,
    attemptId,
    sequence: 2,
    previous: intentRecord,
    kind: "dispatch",
    operationId: intent.operationId,
    payload: { ...intent, state: "dispatched" },
  });
  const receiptRecord = journalRecord({
    goal,
    attemptId,
    sequence: 3,
    previous: dispatchRecord,
    kind: "receipt",
    operationId: intent.operationId,
    payload: receiptFor(intent, { sequence: 3 }),
  });
  const chain = [intentRecord, dispatchRecord, receiptRecord];
  const summary = validateJournalChain(chain, { goalId: goal.id });
  assert.equal(summary.sequence, 3);
  assert.equal(summary.checksum, receiptRecord.checksum);
  assert.deepEqual(summary.operations, [
    {
      operationId: intent.operationId,
      intentSequence: 1,
      dispatchSequence: 2,
      receiptSequence: 3,
      status: "succeeded",
    },
  ]);
  const encoded = encodeJournalRecord(receiptRecord);
  assert.deepEqual(decodeJournalRecord(encoded), receiptRecord);
  assert.deepEqual(decodeJournalRecord(Buffer.from(encoded, "utf8")), receiptRecord);
  const reordered = Object.fromEntries(Object.entries(receiptRecord).reverse());
  assert.equal(encodeJournalRecord(reordered), encoded);
  assert.equal(journalChecksum(reordered), receiptRecord.checksum);
  assert.throws(() => validateJournalChain(chain, { goalId: newGoalId() }), /goal mismatch/);
});

test("journal decoding rejects unsupported versions, malformed and oversized records", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const value = journalRecord({
    goal,
    attemptId,
    sequence: 1,
    kind: "state",
    payload: { schemaVersion: 1, state: "running" },
  });
  assert.throws(() => decodeJournalRecord("{"), /malformed journal record/);
  assert.throws(() => decodeJournalRecord(Buffer.from([0xff, 0xfe])), /malformed journal record/);
  assert.throws(
    () => decodeJournalRecord("x".repeat(GOAL_LIMITS.journalRecordBytes + 1)),
    /too large/,
  );
  assert.throws(() => decodeJournalRecord(42), /bytes required/);
  for (const mutate of [
    (v) => (v.schemaVersion = 2),
    (v) => (v.payload.schemaVersion = 2),
    (v) => (v.kind = "unknown"),
    (v) => (v.checksum = otherHash),
    (v) => (v.prevChecksum = otherHash),
    (v) => (v.attemptId = "bad"),
    (v) => (v.generation = -1),
    (v) => (v.extra = true),
    (v) => (v.payload.token = "secret"),
    (v) => (v.payload.bad = undefined),
    (v) => (v.payload.oversized = "x".repeat(GOAL_LIMITS.journalRecordBytes)),
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.throws(() => validateJournalRecord(invalid), /invalid goal contract/);
  }
  assert.throws(
    () =>
      sealJournalRecord({
        ...value,
        payload: { schemaVersion: 1, blob: "x".repeat(GOAL_LIMITS.journalRecordBytes) },
      }),
    /too large/,
  );
});

test("journal chains reject sequence gaps, duplicate operations and reused attempts", () => {
  const goal = runningGoal();
  const attemptA = newGoalId("attempt");
  const attemptB = newGoalId("attempt");
  const payload = { schemaVersion: 1, state: "running" };
  const first = journalRecord({ goal, attemptId: attemptA, sequence: 1, kind: "state", payload });
  const second = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 2,
    previous: first,
    kind: "state",
    payload,
  });
  assert.equal(validateJournalChain([first, second]).sequence, 2);
  const gap = sealJournalRecord({ ...second, sequence: 3 });
  assert.throws(() => assertJournalAppend(first, gap), /sequence gap/);
  assert.throws(() => validateJournalChain([first, gap]), /sequence gap/);
  const changedAttempt = sealJournalRecord({ ...second, attemptId: attemptB });
  assert.throws(() => assertJournalAppend(first, changedAttempt), /attempt changed/);
  const generationGap = sealJournalRecord({
    ...second,
    generation: 3,
    attemptId: attemptB,
  });
  assert.throws(() => assertJournalAppend(first, generationGap), /generation gap/);
  const regression = sealJournalRecord({ ...second, generation: 0, attemptId: null });
  assert.throws(() => assertJournalAppend(first, regression), /generation regression/);
  const lateStart = sealJournalRecord({
    ...first,
    generation: 2,
    attemptId: attemptB,
  });
  assert.throws(() => assertJournalAppend(null, lateStart), /generation 0 or 1/);

  const generationTwo = journalRecord({
    goal,
    attemptId: attemptB,
    generation: 2,
    sequence: 2,
    previous: first,
    kind: "state",
    payload,
  });
  const generationThree = journalRecord({
    goal,
    attemptId: attemptA,
    generation: 3,
    sequence: 3,
    previous: generationTwo,
    kind: "state",
    payload,
  });
  assert.throws(
    () => validateJournalChain([first, generationTwo, generationThree]),
    /attempt reuse/,
  );

  const intent = editIntent(goal, { attemptId: attemptA });
  const intentRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 1,
    kind: "intent",
    operationId: intent.operationId,
    payload: intent,
  });
  const duplicateIntent = sealJournalRecord({
    ...intentRecord,
    sequence: 2,
    prevChecksum: intentRecord.checksum,
  });
  assert.throws(
    () => validateJournalChain([intentRecord, duplicateIntent]),
    /duplicate operation intent/,
  );
  const dispatchRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 2,
    previous: intentRecord,
    kind: "dispatch",
    operationId: intent.operationId,
    payload: { ...intent, state: "dispatched" },
  });
  const mismatchedDispatch = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 2,
    previous: intentRecord,
    kind: "dispatch",
    operationId: intent.operationId,
    payload: {
      ...intent,
      state: "dispatched",
      planHash: otherHash,
      authority: { ...intent.authority, planHash: otherHash },
    },
  });
  assert.throws(
    () => validateJournalChain([intentRecord, mismatchedDispatch]),
    /does not match its intent/,
  );
  const orphanDispatch = sealJournalRecord({ ...dispatchRecord, sequence: 1, prevChecksum: null });
  assert.throws(() => validateJournalChain([orphanDispatch]), /dispatch requires/);
  const receiptRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 3,
    previous: dispatchRecord,
    kind: "receipt",
    operationId: intent.operationId,
    payload: receiptFor(intent, { sequence: 3 }),
  });
  const orphanReceipt = sealJournalRecord({
    ...receiptRecord,
    sequence: 1,
    prevChecksum: null,
    payload: receiptFor(intent, { sequence: 1 }),
  });
  assert.throws(() => validateJournalChain([orphanReceipt]), /receipt requires/);
  const duplicateReceipt = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 4,
    previous: receiptRecord,
    kind: "receipt",
    operationId: intent.operationId,
    payload: receiptFor(intent, { sequence: 4 }),
  });
  assert.throws(
    () => validateJournalChain([intentRecord, dispatchRecord, receiptRecord, duplicateReceipt]),
    /receipt requires/,
  );

  // Reproduction A: successful edit receipt with wrong after-image hash rejected by chain validation
  const wrongAfterReceiptRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 3,
    previous: dispatchRecord,
    kind: "receipt",
    operationId: intent.operationId,
    payload: receiptFor(intent, {
      sequence: 3,
      files: [{ path: "src/file.js", state: "matches-after", sha256: otherHash }],
    }),
  });
  assert.throws(
    () => validateJournalChain([intentRecord, dispatchRecord, wrongAfterReceiptRecord]),
    /receipt does not bind the edit after image/,
  );

  // Reproduction B: receipt with same operationId but different attemptId and generation
  const crossAttemptReceiptRecord = journalRecord({
    goal,
    attemptId: attemptB,
    generation: 2,
    sequence: 3,
    previous: dispatchRecord,
    kind: "receipt",
    operationId: intent.operationId,
    payload: {
      ...receiptFor(intent, { sequence: 3 }),
      attemptId: attemptB,
      generation: 2,
    },
  });
  assert.throws(
    () => validateJournalChain([intentRecord, dispatchRecord, crossAttemptReceiptRecord]),
    /receipt does not match its intent/,
  );

  // Alternate case: deletion edit receipt in chain
  const deletion = editIntent(goal, {
    attemptId: attemptA,
    edit: { path: "src/file.js", before: image(true, hash), after: image(false) },
    preconditions: { files: [{ path: "src/file.js", exists: true, sha256: hash }] },
  });
  const deletionIntentRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 1,
    kind: "intent",
    operationId: deletion.operationId,
    payload: deletion,
  });
  const deletionDispatchRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 2,
    previous: deletionIntentRecord,
    kind: "dispatch",
    operationId: deletion.operationId,
    payload: { ...deletion, state: "dispatched" },
  });
  const validDeletionReceiptRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 3,
    previous: deletionDispatchRecord,
    kind: "receipt",
    operationId: deletion.operationId,
    payload: receiptFor(deletion, {
      sequence: 3,
      files: [{ path: "src/file.js", state: "absent", sha256: null }],
    }),
  });
  assert.equal(
    validateJournalChain([deletionIntentRecord, deletionDispatchRecord, validDeletionReceiptRecord])
      .operations[0].status,
    "succeeded",
  );

  const invalidDeletionReceiptRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 3,
    previous: deletionDispatchRecord,
    kind: "receipt",
    operationId: deletion.operationId,
    payload: receiptFor(deletion, {
      sequence: 3,
      files: [{ path: "src/file.js", state: "matches-after", sha256: hash }],
    }),
  });
  assert.throws(
    () =>
      validateJournalChain([
        deletionIntentRecord,
        deletionDispatchRecord,
        invalidDeletionReceiptRecord,
      ]),
    /receipt does not bind the edit after image/,
  );

  const missingFileDeletionReceiptRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 3,
    previous: deletionDispatchRecord,
    kind: "receipt",
    operationId: deletion.operationId,
    payload: receiptFor(deletion, {
      sequence: 3,
      files: [],
    }),
  });
  assert.throws(
    () =>
      validateJournalChain([
        deletionIntentRecord,
        deletionDispatchRecord,
        missingFileDeletionReceiptRecord,
      ]),
    /receipt does not bind the edit after image/,
  );

  // Alternate case: non-succeeded edit receipt (failed) does not require after image
  const failedReceiptRecord = journalRecord({
    goal,
    attemptId: attemptA,
    sequence: 3,
    previous: dispatchRecord,
    kind: "receipt",
    operationId: intent.operationId,
    payload: receiptFor(intent, {
      sequence: 3,
      status: "failed",
      files: [{ path: "src/file.js", state: "matches-before", sha256: hash }],
      process: { exitCode: 1, signal: null },
    }),
  });
  assert.equal(
    validateJournalChain([intentRecord, dispatchRecord, failedReceiptRecord]).operations[0].status,
    "failed",
  );
});

test("operation intents round-trip exact edit bindings and reject malformed authority", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const value = editIntent(goal, { attemptId });
  assert.deepEqual(validateOperationIntent(JSON.parse(JSON.stringify(value))), value);
  const copy = validateOperationIntent(value);
  copy.edit.before.mode = 0o600;
  assert.equal(value.edit.before.mode, 0o644);
  const creation = editIntent(goal, {
    attemptId,
    edit: { path: "src/new.js", before: image(false), after: image(true, otherHash) },
    preconditions: { files: [{ path: "src/new.js", exists: false, sha256: null }] },
  });
  assert.equal(validateOperationIntent(creation).edit.before.exists, false);
  const deletion = editIntent(goal, {
    attemptId,
    edit: { path: "src/file.js", before: image(true, hash), after: image(false) },
    preconditions: { files: [{ path: "src/file.js", exists: true, sha256: hash }] },
  });
  assert.equal(validateOperationIntent(deletion).edit.after.exists, false);
  assert.equal(validateOperationIntent(readIntent(goal, { attemptId })).kind, "read");

  // Precondition exists boolean validation and inconsistent hashes
  const read = readIntent(goal, { attemptId });
  const validTruePre = {
    ...read,
    preconditions: { files: [{ path: "src/file.js", exists: true, sha256: hash }] },
  };
  assert.equal(validateOperationIntent(validTruePre).preconditions.files[0].exists, true);
  const validFalsePre = {
    ...read,
    preconditions: { files: [{ path: "src/file.js", exists: false, sha256: null }] },
  };
  assert.equal(validateOperationIntent(validFalsePre).preconditions.files[0].exists, false);

  for (const badExists of ["false", "true", "", 0, 1, null, undefined, {}]) {
    const badWithHash = {
      ...read,
      preconditions: { files: [{ path: "src/file.js", exists: badExists, sha256: hash }] },
    };
    assert.throws(
      () => validateOperationIntent(badWithHash),
      /invalid precondition exists|invalid goal contract/,
    );
    const badWithNull = {
      ...read,
      preconditions: { files: [{ path: "src/file.js", exists: badExists, sha256: null }] },
    };
    assert.throws(
      () => validateOperationIntent(badWithNull),
      /invalid precondition exists|invalid goal contract/,
    );
  }

  assert.throws(
    () =>
      validateOperationIntent({
        ...read,
        preconditions: { files: [{ path: "src/file.js", exists: true, sha256: null }] },
      }),
    /SHA-256 required/,
  );
  assert.throws(
    () =>
      validateOperationIntent({
        ...read,
        preconditions: { files: [{ path: "src/file.js", exists: false, sha256: hash }] },
      }),
    /absent precondition has a hash/,
  );

  assert.throws(
    () =>
      validateOperationIntent(
        editIntent(goal, {
          attemptId,
          edit: {
            path: "src/file.js",
            before: image(true, hash, 0o644),
            after: image(true, hash, 0o644),
          },
        }),
      ),
    /no-op/,
  );
  for (const mutate of [
    (v) => (v.schemaVersion = 2),
    (v) => (v.kind = "delete"),
    (v) => (v.attemptId = null),
    (v) => (v.generation = 0),
    (v) => (v.generation = Infinity),
    (v) => (v.authority.kind = "none"),
    (v) => (v.authority.planHash = otherHash),
    (v) => (v.authority.decisionId = "approval-token"),
    (v) => (v.authority.scope = "workspace"),
    (v) => (v.authority.decisionId = "decision_" + "a".repeat(31)),
    (v) => (v.planHash = otherHash),
    (v) => (v.arguments.blob = "not-a-digest"),
    (v) => (v.workspace.path = "/tmp/../escape"),
    (v) => (v.workspace.revision = "main"),
    (v) => (v.workspace.manifest = "unknown"),
    (v) => (v.preconditions.files = []),
    (v) => (v.preconditions.files[0].sha256 = otherHash),
    (v) => (v.edit.before.blob = null),
    (v) => (v.edit.after.mode = 0o1000),
    (v) => (v.edit = null),
    (v) => (v.reservation.tools = -1),
    (v) => (v.reservation.money = 1),
    (v) => (v.state = "done"),
    (v) => (v.token = "secret"),
  ]) {
    const invalid = editIntent(goal, { attemptId });
    mutate(invalid);
    assert.throws(() => validateOperationIntent(invalid), /invalid goal contract/);
  }
});

test("receipts bind completion to the dispatched intent and exact after image", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const intent = editIntent(goal, { attemptId });
  const fence = {
    goalId: goal.id,
    attemptId,
    generation: goal.generation,
    operationId: intent.operationId,
  };
  const dispatched = dispatchOperationIntent(intent, fence);
  const value = receiptFor(dispatched, { sequence: 7 });
  assert.deepEqual(validateOperationReceipt(JSON.parse(JSON.stringify(value))), value);
  assert.deepEqual(assertOperationReceipt(value, dispatched, { intentSequence: 2 }), value);
  const failure = receiptFor(dispatched, {
    sequence: 7,
    status: "failed",
    files: [{ path: "src/file.js", state: "matches-before", sha256: hash }],
    process: { exitCode: 1, signal: null },
  });
  assert.equal(assertOperationReceipt(failure, dispatched).status, "failed");
  assert.equal(
    validateOperationReceipt(
      receiptFor(dispatched, {
        sequence: 7,
        status: "uncertain",
        uncertainty: { kind: "partial-write", detail: "bytes preserved" },
      }),
    ).status,
    "uncertain",
  );
  assert.deepEqual(
    validateOperationReceipt(
      receiptFor(dispatched, { sequence: 7, process: { exitCode: null, signal: "SIGTERM" } }),
    ).process,
    { exitCode: null, signal: "SIGTERM" },
  );
  assert.equal(
    validateOperationReceipt(
      receiptFor(dispatched, {
        sequence: 7,
        files: [{ path: "src/file.js", state: "absent", sha256: null }],
      }),
    ).files[0].state,
    "absent",
  );
  assert.throws(
    () =>
      assertOperationReceipt(
        receiptFor(dispatched, {
          sequence: 7,
          files: [{ path: "src/file.js", state: "matches-before", sha256: hash }],
        }),
        dispatched,
      ),
    /after image/,
  );
  assert.throws(
    () => assertOperationReceipt(value, editIntent(goal, { attemptId })),
    /does not match/,
  );
  assert.throws(() => assertOperationReceipt(value, dispatched, { intentSequence: 7 }), /precedes/);

  // Operation identity mismatches: goalId, attemptId, generation, operationId
  assert.throws(
    () => assertOperationReceipt({ ...value, goalId: newGoalId() }, dispatched),
    /does not match its intent/,
  );
  assert.throws(
    () => assertOperationReceipt({ ...value, attemptId: newGoalId("attempt") }, dispatched),
    /does not match its intent/,
  );
  assert.throws(
    () => assertOperationReceipt({ ...value, generation: goal.generation + 1 }, dispatched),
    /does not match its intent/,
  );
  assert.throws(
    () => assertOperationReceipt({ ...value, operationId: newGoalId("operation") }, dispatched),
    /does not match its intent/,
  );

  // Deletion receipts in assertOperationReceipt
  const deletionIntent = editIntent(goal, {
    attemptId,
    edit: { path: "src/file.js", before: image(true, hash), after: image(false) },
    preconditions: { files: [{ path: "src/file.js", exists: true, sha256: hash }] },
  });
  const dispatchedDeletion = dispatchOperationIntent(deletionIntent, {
    goalId: goal.id,
    attemptId,
    generation: goal.generation,
    operationId: deletionIntent.operationId,
  });
  const validDeletionReceipt = receiptFor(dispatchedDeletion, {
    sequence: 7,
    files: [{ path: "src/file.js", state: "absent", sha256: null }],
  });
  assert.equal(
    assertOperationReceipt(validDeletionReceipt, dispatchedDeletion).files[0].state,
    "absent",
  );
  assert.throws(
    () =>
      assertOperationReceipt(
        receiptFor(dispatchedDeletion, {
          sequence: 7,
          files: [{ path: "src/file.js", state: "matches-after", sha256: hash }],
        }),
        dispatchedDeletion,
      ),
    /after image/,
  );
  assert.throws(
    () =>
      assertOperationReceipt(
        receiptFor(dispatchedDeletion, {
          sequence: 7,
          files: [],
        }),
        dispatchedDeletion,
      ),
    /after image/,
  );
  for (const mutate of [
    (v) => (v.schemaVersion = 2),
    (v) => (v.sequence = 0),
    (v) => (v.status = "done"),
    (v) => (v.evidence = ["bad"]),
    (v) => (v.evidence = [hash, hash]),
    (v) => (v.files[0].state = "unknown"),
    (v) => (v.files[0].sha256 = "bad"),
    (v) => (v.files = [{ path: "src/file.js", state: "absent", sha256: hash }]),
    (v) => v.files.push({ ...v.files[0] }),
    (v) => (v.process = { exitCode: 300, signal: null }),
    (v) => (v.process = { exitCode: null, signal: "TERM" }),
    (v) => (v.process = { exitCode: null, signal: null }),
    (v) => (v.usage.tools = -1),
    (v) => (v.uncertainty = { kind: "unknown", detail: "x" }),
    (v) => (v.uncertainty = { kind: "none", detail: "x" }),
    (v) => (v.status = "uncertain"),
    (v) => (v.token = "secret"),
  ]) {
    const invalid = receiptFor(dispatched, { sequence: 7 });
    mutate(invalid);
    assert.throws(() => validateOperationReceipt(invalid), /invalid goal contract/);
  }
});

test("leases bind goal, generation, workspace root, owner and bounded expiry", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const lease = createGoalLease(goal, { attemptId, owner: operator(), now: 1000 });
  assert.equal(lease.goalId, goal.id);
  assert.equal(lease.generation, goal.generation);
  assert.equal(lease.expiresAt, 1000 + LEASE_MAX_MS);
  assert.deepEqual(validateGoalLease(JSON.parse(JSON.stringify(lease))), lease);
  const fence = {
    goalId: goal.id,
    attemptId,
    generation: goal.generation,
    workspace: workspaceRootOf(goal),
    owner: operator(),
    now: 2000,
  };
  assert.deepEqual(assertLeaseHeld(lease, fence), lease);
  assert.deepEqual(assertLeaseForGoal(lease, goal, 2000), lease);
  const renewed = renewGoalLease(lease, { owner: operator(), now: 2000 });
  assert.equal(renewed.acquiredAt, 2000);
  assert.equal(renewed.expiresAt, 2000 + LEASE_MAX_MS);
  assert.equal(lease.expiresAt, 1000 + LEASE_MAX_MS);
  assert.throws(() => assertLeaseHeld(lease, { ...fence, now: lease.expiresAt }), /expired/);
  assert.throws(() => assertLeaseForGoal(lease, goal, lease.expiresAt), /expired/);
  assert.throws(
    () => renewGoalLease(lease, { owner: operator(), now: lease.expiresAt }),
    /expired/,
  );
  for (const badOwner of [
    operator({ pid: 1 }),
    operator({ startTime: "99999" }),
    operator({ bootId: "boot-0002" }),
  ]) {
    assert.throws(() => assertLeaseHeld(lease, { ...fence, owner: badOwner }), /owner/);
    assert.throws(() => renewGoalLease(lease, { owner: badOwner, now: 2000 }), /owner/);
  }
  assert.throws(
    () => assertLeaseHeld(lease, { ...fence, workspace: { ...fence.workspace, inode: "43" } }),
    /workspace/,
  );
  assert.throws(
    () =>
      assertLeaseForGoal(lease, { ...goal, workspace: { ...goal.workspace, inode: "43" } }, 2000),
    /workspace/,
  );
  assert.throws(() => assertLeaseHeld(lease, { ...fence, generation: 2 }), /stale/);
  assert.throws(
    () => assertLeaseHeld(lease, { ...fence, attemptId: newGoalId("attempt") }),
    /stale/,
  );
  assert.throws(() => assertLeaseForGoal(lease, { ...goal, generation: 2 }, 2000), /stale/);
  assert.throws(() => assertLeaseForGoal(lease, { ...goal, state: "paused" }, 2000), /active/);
  for (const mutate of [
    (v) => (v.schemaVersion = 2),
    (v) => (v.leaseId = "lease"),
    (v) => (v.generation = 0),
    (v) => (v.workspace.path = "tmp/project"),
    (v) => (v.workspace.device = 1),
    (v) => (v.owner.pid = 0),
    (v) => (v.owner.startTime = "not-a-time"),
    (v) => (v.owner.bootId = ""),
    (v) => (v.expiresAt = v.acquiredAt),
    (v) => (v.expiresAt = v.acquiredAt + LEASE_MAX_MS + 1),
    (v) => (v.extra = true),
    (v) => (v.approvalToken = "secret"),
    (v) => (v.workspace.manifest = hash),
  ]) {
    const invalid = leaseFor(goal, attemptId);
    mutate(invalid);
    assert.throws(() => validateGoalLease(invalid), /invalid goal contract/);
  }
  assert.throws(
    () =>
      createGoalLease(
        { ...goal, state: "ready", generation: 0 },
        { attemptId, owner: operator(), now: 1000 },
      ),
    /active/,
  );
  assert.throws(
    () =>
      createGoalLease(goal, { attemptId, owner: operator(), now: 1000, ttlMs: LEASE_MAX_MS + 1 }),
    /bounds/,
  );
  assert.throws(
    () =>
      createGoalLease(goal, {
        attemptId,
        owner: operator(),
        now: Number.MAX_SAFE_INTEGER,
      }),
    /bounds/,
  );
});

test("pre-mutation authority joins intent, goal, lease and caller identity", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const intent = editIntent(goal, { attemptId });
  const lease = createGoalLease(goal, { attemptId, owner: operator(), now: 1000 });
  assert.deepEqual(
    assertOperationAuthority(intent, { goal, lease, owner: operator(), now: 2000 }),
    intent,
  );
  for (const mutate of [
    (v) => (v.generation = 2),
    (v) => (v.workspace.inode = "43"),
    (v) => (v.workspace.manifest = otherHash),
    (v) => (v.attemptId = newGoalId("attempt")),
  ]) {
    const invalid = editIntent(goal, { attemptId });
    mutate(invalid);
    assert.throws(
      () => assertOperationAuthority(invalid, { goal, lease, owner: operator(), now: 2000 }),
      /invalid goal contract/,
    );
  }
  assert.throws(
    () => assertOperationAuthority(intent, { goal, lease, owner: operator({ pid: 7 }), now: 2000 }),
    /owner/,
  );
  assert.throws(
    () =>
      assertOperationAuthority(intent, { goal, lease, owner: operator(), now: lease.expiresAt }),
    /expired/,
  );
  assert.throws(
    () =>
      assertOperationAuthority(intent, {
        goal: { ...goal, generation: 2 },
        lease,
        owner: operator(),
        now: 2000,
      }),
    /stale/,
  );
});

test("operation fences reject callbacks from older attempts and generations", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const intent = editIntent(goal, { attemptId });
  const fence = {
    goalId: goal.id,
    attemptId,
    generation: goal.generation,
    operationId: intent.operationId,
  };
  const dispatched = dispatchOperationIntent(intent, fence);
  assert.equal(dispatched.state, "dispatched");
  assert.equal(observeOperationIntent(dispatched, fence).state, "observed");
  assert.throws(() => dispatchOperationIntent(dispatched, fence), /already/);
  assert.throws(() => observeOperationIntent(intent, fence), /not dispatched/);
  for (const stale of [
    { ...fence, generation: fence.generation + 1 },
    { ...fence, attemptId: newGoalId("attempt") },
    { ...fence, operationId: newGoalId("operation") },
    { ...fence, goalId: newGoalId() },
  ]) {
    assert.throws(() => dispatchOperationIntent(intent, stale), /stale operation fence/);
    assert.throws(() => observeOperationIntent(dispatched, stale), /stale operation fence/);
  }
  assert.equal(intent.state, "prepared");
});

test("operation reservations and receipts use the existing budget ledger", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const intent = editIntent(goal, { attemptId });
  const counters = { used: zeros(), reserved: zeros() };
  const reserved = reserveOperationBudget(GOAL_DEFAULT_BUDGET, counters, intent);
  assert.deepEqual(counters.reserved, zeros());
  assert.deepEqual(reserved.reserved, intent.reservation);
  const receiptValue = receiptFor(intent, {
    sequence: 5,
    usage: { rounds: 0, tools: 1, requests: 0, activeMs: 800 },
  });
  const settled = settleOperationBudget(GOAL_DEFAULT_BUDGET, reserved, intent, receiptValue);
  assert.equal(settled.used.tools, 1);
  assert.equal(settled.reserved.tools, 0);
  assert.equal(settled.used.activeMs, 800);
  assert.equal(settled.reserved.activeMs, 200);
  const overspend = receiptFor(intent, {
    sequence: 5,
    usage: { rounds: 0, tools: 2, requests: 0, activeMs: 0 },
  });
  assert.throws(
    () => settleOperationBudget(GOAL_DEFAULT_BUDGET, reserved, intent, overspend),
    /usage exceeds reservation/,
  );
  assert.deepEqual(reserved.reserved, intent.reservation);
  const huge = editIntent(goal, {
    attemptId,
    reservation: { rounds: 0, tools: 512, requests: 0, activeMs: 0 },
  });
  assert.throws(() => reserveOperationBudget(GOAL_DEFAULT_BUDGET, counters, huge), /exhausted/);
});

test("persisted contracts reject credentials and executable approval material", () => {
  const goal = runningGoal();
  const attemptId = newGoalId("attempt");
  const intent = editIntent(goal, { attemptId });
  const receiptValue = receiptFor(intent);
  const lease = leaseFor(goal, attemptId);
  for (const [validate, value, mutate] of [
    [validateOperationIntent, intent, (v) => (v.approvalToken = "executable")],
    [validateOperationIntent, intent, (v) => (v.authority.token = "executable")],
    [validateOperationIntent, intent, (v) => (v.credentials = { apiKey: "secret" })],
    [validateOperationReceipt, receiptValue, (v) => (v.credential = "secret")],
    [validateGoalLease, lease, (v) => (v.secret = "secret")],
    [validateGoalLease, lease, (v) => (v.owner.token = "secret")],
  ]) {
    const invalid = structuredClone(value);
    mutate(invalid);
    assert.throws(() => validate(invalid), /invalid goal contract/);
  }
  const journal = journalRecord({
    goal,
    attemptId,
    sequence: 1,
    kind: "state",
    payload: { schemaVersion: 1, state: "running" },
  });
  assert.throws(
    () => sealJournalRecord({ ...journal, payload: { schemaVersion: 1, apiKey: "secret" } }),
    /forbidden persisted field/,
  );
  assert.throws(
    () => sealJournalRecord({ ...journal, payload: { schemaVersion: 1, approvalToken: "x" } }),
    /forbidden persisted field/,
  );
});
