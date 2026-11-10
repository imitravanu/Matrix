// Pure durable-goal contracts. Storage and dispatch must supply verified leases
// and evidence. This module neither acquires authority nor performs effects.
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { classifyOutcome } from "./outcome.mjs";

export const GOAL_SCHEMA_VERSION = 1;
export const JOURNAL_SCHEMA_VERSION = 1;
export const JOURNAL_PAYLOAD_SCHEMA_VERSION = 1;
export const OPERATION_INTENT_SCHEMA_VERSION = 1;
export const OPERATION_RECEIPT_SCHEMA_VERSION = 1;
export const LEASE_SCHEMA_VERSION = 1;
export const LEASE_MAX_MS = 120_000;
export const GOAL_LIMITS = Object.freeze({
  checkpointBytes: 1024 * 1024,
  journalRecordBytes: 64 * 1024,
  journalBytes: 32 * 1024 * 1024,
  blobBytes: 64 * 1024 * 1024,
  storeBytes: 256 * 1024 * 1024,
  operations: 128,
  criteria: 64,
  preconditions: 8,
  evidenceRefs: 16,
  receiptFiles: 128,
  journalRecords: 1024,
});
export const GOAL_DEFAULT_BUDGET = Object.freeze({
  rounds: 8,
  tools: 24,
  requests: 32,
  activeMs: 600_000,
});
export const GOAL_MAX_BUDGET = Object.freeze({
  rounds: 128,
  tools: 512,
  requests: 512,
  activeMs: 86_400_000,
});
export const GOAL_JOURNAL_KINDS = Object.freeze([
  "attempt",
  "intent",
  "dispatch",
  "receipt",
  "recovery-receipt",
  "state",
  "budget",
  "evidence",
  "terminal",
]);
export const GOAL_OPERATION_KINDS = Object.freeze([
  "read",
  "search",
  "edit",
  "test",
  "command",
  "provider",
]);
export const GOAL_AUTHORITY_KINDS = Object.freeze(["none", "edit", "test", "command"]);
export const GOAL_OPERATION_STATES = Object.freeze(["prepared", "dispatched", "observed"]);
export const GOAL_RECEIPT_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "denied",
  "cancelled",
  "interrupted",
  "uncertain",
]);
export const GOAL_RECEIPT_UNCERTAINTIES = Object.freeze([
  "none",
  "unknown-effect",
  "partial-write",
  "unknown-usage",
]);
const BUDGET_KEYS = Object.freeze(Object.keys(GOAL_MAX_BUDGET));
const TRANSITIONS = Object.freeze({
  ready: ["running", "cancelled"],
  running: [
    "awaiting-approval",
    "interrupted",
    "reconciling",
    "paused",
    "budget-exhausted",
    "needs-attention",
    "completed",
    "cancelled",
    "failed",
  ],
  "awaiting-approval": ["running", "interrupted", "paused", "cancelled", "failed"],
  interrupted: ["reconciling", "cancelled"],
  reconciling: ["ready", "running", "needs-attention", "cancelled", "failed"],
  paused: ["reconciling", "cancelled"],
  "budget-exhausted": ["ready", "cancelled"],
  "needs-attention": ["reconciling", "cancelled"],
  completed: [],
  cancelled: [],
  failed: ["reconciling", "cancelled"],
});
export const GOAL_STATES = Object.freeze(Object.keys(TRANSITIONS));
const JOURNAL_RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "sequence",
  "goalId",
  "attemptId",
  "generation",
  "kind",
  "operationId",
  "prevChecksum",
  "payload",
  "checksum",
]);
const JOURNAL_RECORD_BODY_FIELDS = Object.freeze(
  JOURNAL_RECORD_FIELDS.filter((name) => name !== "checksum"),
);
const INTENT_FIELDS = Object.freeze([
  "schemaVersion",
  "goalId",
  "attemptId",
  "generation",
  "operationId",
  "kind",
  "arguments",
  "planHash",
  "authority",
  "workspace",
  "preconditions",
  "edit",
  "reservation",
  "state",
]);
const RECEIPT_FIELDS = Object.freeze([
  "schemaVersion",
  "goalId",
  "attemptId",
  "generation",
  "operationId",
  "sequence",
  "status",
  "evidence",
  "files",
  "process",
  "usage",
  "uncertainty",
]);
const LEASE_FIELDS = Object.freeze([
  "schemaVersion",
  "leaseId",
  "goalId",
  "attemptId",
  "generation",
  "workspace",
  "owner",
  "acquiredAt",
  "expiresAt",
]);
const OWNER_FIELDS = Object.freeze(["pid", "startTime", "bootId"]);
const LEASE_WORKSPACE_FIELDS = Object.freeze(["path", "device", "inode"]);
const GOAL_WORKSPACE_FIELDS = Object.freeze(["path", "device", "inode", "revision", "manifest"]);
const ACTIVE_ATTEMPT_STATES = Object.freeze(["running", "awaiting-approval", "reconciling"]);
const OPERATION_JOURNAL_KINDS = Object.freeze([
  "intent",
  "dispatch",
  "receipt",
  "recovery-receipt",
]);
const FORBIDDEN_PERSISTED_KEYS =
  /^(?:__proto__|prototype|constructor|token|secret|password|passwd|credential|credentials|api[_-]?key|authorization|cookie|session[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|approval[_-]?token|bearer)$/i;

function requireValue(condition, message) {
  if (!condition) throw new Error(`invalid goal contract: ${message}`);
}
function fields(value, names) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "object required",
  );
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    "plain record required",
  );
  requireValue(
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name)),
    "unexpected or missing fields",
  );
}
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    "integer out of bounds",
  );
}
function text(value, max) {
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      Buffer.byteLength(value) <= max &&
      !value.includes("\0"),
    "invalid text",
  );
}
function digest(value) {
  requireValue(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "SHA-256 required");
}
function rootIdentity(value) {
  for (const key of ["device", "inode"])
    requireValue(
      typeof value[key] === "string" && /^[0-9]{1,32}$/.test(value[key]),
      "invalid root identity",
    );
}
function workspaceRoot(value, names) {
  fields(value, names);
  validateGoalPath(value.path, true);
  rootIdentity(value);
  return structuredClone(value);
}

// Canonical JSON is deterministic and bounded. It rejects values that cannot be
// persisted without loss, credential-like field names, and cycles. Checksums
// detect accidental damage; they are not authentication against a same-UID writer.
function canonicalValue(value, depth, state) {
  requireValue(depth <= state.maxDepth, "canonical payload nested too deeply");
  if (value === null) {
    state.bytes += 4;
    requireValue(state.bytes <= state.maxBytes, "canonical payload too large");
    return "null";
  }
  switch (typeof value) {
    case "boolean": {
      const result = value ? "true" : "false";
      state.bytes += result.length;
      requireValue(state.bytes <= state.maxBytes, "canonical payload too large");
      return result;
    }
    case "number": {
      requireValue(
        Number.isSafeInteger(value) && !Object.is(value, -0),
        "canonical number must be a safe integer",
      );
      const result = String(value);
      state.bytes += result.length;
      requireValue(state.bytes <= state.maxBytes, "canonical payload too large");
      return result;
    }
    case "string": {
      requireValue(
        Buffer.byteLength(value) <= state.maxStringBytes && !value.includes("\0"),
        "invalid canonical text",
      );
      const result = JSON.stringify(value);
      state.bytes += Buffer.byteLength(result);
      requireValue(state.bytes <= state.maxBytes, "canonical payload too large");
      return result;
    }
    case "object":
      break;
    default:
      throw new Error("invalid goal contract: canonical payload value is not persistable");
  }
  if (Array.isArray(value)) {
    requireValue(value.length <= state.maxItems, "canonical array too large");
    state.bytes += 2;
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      requireValue(Object.hasOwn(value, index), "canonical arrays must not be sparse");
      if (index > 0) state.bytes += 1;
      items.push(canonicalValue(value[index], depth + 1, state));
      requireValue(state.bytes <= state.maxBytes, "canonical payload too large");
    }
    return `[${items.join(",")}]`;
  }
  requireValue(
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    "canonical payload must be a plain object",
  );
  const keys = Object.keys(value);
  requireValue(keys.length <= state.maxKeys, "canonical object too large");
  keys.sort();
  state.bytes += 2;
  const parts = [];
  for (const key of keys) {
    requireValue(!FORBIDDEN_PERSISTED_KEYS.test(key), `forbidden persisted field: ${key}`);
    requireValue(
      Buffer.byteLength(key) <= 256 && !key.includes("\0"),
      "invalid canonical field name",
    );
    state.bytes += Buffer.byteLength(key) + 3;
    requireValue(state.bytes <= state.maxBytes, "canonical payload too large");
    parts.push(`${JSON.stringify(key)}:${canonicalValue(value[key], depth + 1, state)}`);
  }
  return `{${parts.join(",")}}`;
}
export function canonicalJson(
  value,
  { maxBytes = GOAL_LIMITS.journalRecordBytes, maxDepth = 32 } = {},
) {
  integer(maxBytes, 1, GOAL_LIMITS.storeBytes);
  integer(maxDepth, 1, 128);
  const state = {
    bytes: 0,
    maxBytes,
    maxDepth,
    maxStringBytes: maxBytes,
    maxItems: 4096,
    maxKeys: 256,
  };
  const result = canonicalValue(value, 0, state);
  requireValue(Buffer.byteLength(result) <= maxBytes, "canonical payload too large");
  return result;
}

export function validateGoalId(id, kind = "goal") {
  requireValue(
    ["goal", "attempt", "operation", "criterion", "lease", "decision"].includes(kind),
    "unknown ID kind",
  );
  requireValue(
    typeof id === "string" && new RegExp(`^${kind}_[a-f0-9]{32}$`).test(id),
    "invalid ID",
  );
  return id;
}
export function newGoalId(kind = "goal") {
  return validateGoalId(`${kind}_${randomUUID().replaceAll("-", "")}`, kind);
}
export function validateGoalPath(path, absolute = false) {
  text(path, 4096);
  requireValue(
    !path.includes("\\") &&
      !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    "unsafe path",
  );
  requireValue(
    posix.isAbsolute(path) === absolute && posix.normalize(path) === path,
    "path must be normalized",
  );
  requireValue(path !== "." && path !== "/" && !path.split("/").includes(".."), "unsafe path");
  return path;
}
export function validateGoalBudget(budget) {
  fields(budget, BUDGET_KEYS);
  for (const key of BUDGET_KEYS) integer(budget[key], 1, GOAL_MAX_BUDGET[key]);
  return structuredClone(budget);
}
export function validateGoalUsage(counts) {
  fields(counts, BUDGET_KEYS);
  for (const key of BUDGET_KEYS) integer(counts[key], 0, GOAL_MAX_BUDGET[key]);
  return structuredClone(counts);
}
export function validateGoalWorkspace(workspace) {
  workspaceRoot(workspace, GOAL_WORKSPACE_FIELDS);
  requireValue(
    workspace.revision === null ||
      (typeof workspace.revision === "string" &&
        /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(workspace.revision)),
    "invalid revision",
  );
  digest(workspace.manifest);
  return structuredClone(workspace);
}
function validateLeaseWorkspace(workspace) {
  return workspaceRoot(workspace, LEASE_WORKSPACE_FIELDS);
}
function validateAttemptOwner(owner) {
  fields(owner, OWNER_FIELDS);
  integer(owner.pid, 1, 4_194_304);
  requireValue(
    typeof owner.startTime === "string" && /^[0-9]{1,32}$/.test(owner.startTime),
    "invalid process start time",
  );
  text(owner.bootId, 128);
  return structuredClone(owner);
}
export function validateGoalRecord(record) {
  fields(record, [
    "schemaVersion",
    "id",
    "createdAt",
    "objective",
    "workspace",
    "provider",
    "state",
    "generation",
    "sequence",
    "criteria",
    "budget",
    "operations",
  ]);
  requireValue(record.schemaVersion === GOAL_SCHEMA_VERSION, "unsupported schema");
  validateGoalId(record.id);
  integer(record.createdAt);
  text(record.objective, 16_384);
  validateGoalWorkspace(record.workspace);
  fields(record.provider, ["id", "modelId", "digest"]);
  text(record.provider.id, 64);
  text(record.provider.modelId, 512);
  digest(record.provider.digest);
  requireValue(GOAL_STATES.includes(record.state), "unknown state");
  integer(record.generation);
  integer(record.sequence);
  validateGoalBudget(record.budget);
  requireValue(
    Array.isArray(record.operations) && record.operations.length <= GOAL_LIMITS.operations,
    "operation limit",
  );
  for (const id of record.operations) validateGoalId(id, "operation");
  requireValue(new Set(record.operations).size === record.operations.length, "duplicate operation");
  requireValue(
    Array.isArray(record.criteria) &&
      record.criteria.length > 0 &&
      record.criteria.length <= GOAL_LIMITS.criteria,
    "criterion limit",
  );
  for (const criterion of record.criteria) {
    const common = ["id", "revision", "kind"];
    switch (criterion.kind) {
      case "test":
        fields(criterion, [...common, "planHash"]);
        digest(criterion.planHash);
        break;
      case "artifact":
        fields(criterion, [...common, "path", "sha256"]);
        validateGoalPath(criterion.path);
        digest(criterion.sha256);
        break;
      case "human":
        fields(criterion, [...common, "description"]);
        text(criterion.description, 2048);
        break;
      default:
        throw new Error("invalid goal contract: unknown criterion");
    }
    validateGoalId(criterion.id, "criterion");
    integer(criterion.revision, 1);
  }
  requireValue(
    new Set(record.criteria.map((criterion) => criterion.id)).size === record.criteria.length,
    "duplicate criterion",
  );
  requireValue(
    Buffer.byteLength(JSON.stringify(record)) <= GOAL_LIMITS.checkpointBytes,
    "checkpoint too large",
  );
  return structuredClone(record);
}

// A journal record is sealed over canonical JSON of every field except its own
// checksum. The checksum links the next record through prevChecksum.
function withoutChecksum(record) {
  requireValue(
    record !== null && typeof record === "object" && !Array.isArray(record),
    "journal record object required",
  );
  const copy = {};
  for (const key of Object.keys(record)) {
    if (key === "checksum") continue;
    Object.defineProperty(copy, key, {
      value: record[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}
export function journalChecksum(record) {
  return createHash("sha256")
    .update(canonicalJson(withoutChecksum(record)))
    .digest("hex");
}
function validateJournalPayload(payload) {
  requireValue(
    payload !== null && typeof payload === "object" && !Array.isArray(payload),
    "journal payload object required",
  );
  requireValue(
    Object.getPrototypeOf(payload) === Object.prototype || Object.getPrototypeOf(payload) === null,
    "plain journal payload required",
  );
  requireValue(
    payload.schemaVersion === JOURNAL_PAYLOAD_SCHEMA_VERSION,
    "unsupported journal payload schema",
  );
}
export function validateJournalRecord(record) {
  fields(record, JOURNAL_RECORD_FIELDS);
  requireValue(record.schemaVersion === JOURNAL_SCHEMA_VERSION, "unsupported journal schema");
  validateGoalId(record.goalId);
  integer(record.sequence, 1);
  integer(record.generation);
  requireValue(GOAL_JOURNAL_KINDS.includes(record.kind), "unknown journal kind");
  if (record.generation === 0) {
    requireValue(record.attemptId === null, "generation zero requires no attempt");
  } else {
    validateGoalId(record.attemptId, "attempt");
  }
  if (OPERATION_JOURNAL_KINDS.includes(record.kind)) {
    validateGoalId(record.operationId, "operation");
  } else {
    requireValue(record.operationId === null, "unexpected operation ID");
  }
  requireValue(
    record.prevChecksum === null ? record.sequence === 1 : record.sequence > 1,
    "invalid journal link",
  );
  if (record.prevChecksum !== null) digest(record.prevChecksum);
  validateJournalPayload(record.payload);
  if (OPERATION_JOURNAL_KINDS.includes(record.kind)) {
    requireValue(record.payload.goalId === record.goalId, "journal goal mismatch");
    if (record.kind === "recovery-receipt") {
      requireValue(
        record.payload.generation <= record.generation &&
          record.payload.status === "uncertain" &&
          record.payload.evidence.length === 0,
        "invalid recovery receipt",
      );
    } else {
      requireValue(record.payload.attemptId === record.attemptId, "journal attempt mismatch");
      requireValue(record.payload.generation === record.generation, "journal generation mismatch");
    }
    requireValue(record.payload.operationId === record.operationId, "journal operation mismatch");
    if (record.kind === "receipt" || record.kind === "recovery-receipt") {
      const receipt = validateOperationReceipt(record.payload);
      requireValue(receipt.sequence === record.sequence, "receipt sequence mismatch");
    } else {
      const intent = validateOperationIntent(record.payload);
      requireValue(
        intent.state === (record.kind === "intent" ? "prepared" : "dispatched"),
        "journal operation state mismatch",
      );
    }
  }
  digest(record.checksum);
  requireValue(journalChecksum(record) === record.checksum, "journal checksum mismatch");
  requireValue(
    Buffer.byteLength(canonicalJson(record)) <= GOAL_LIMITS.journalRecordBytes,
    "journal record too large",
  );
  return structuredClone(record);
}
export function sealJournalRecord(body) {
  const copy = withoutChecksum(body);
  fields(copy, JOURNAL_RECORD_BODY_FIELDS);
  copy.checksum = journalChecksum(copy);
  return validateJournalRecord(copy);
}
export function encodeJournalRecord(record) {
  const value = validateJournalRecord(record);
  const bytes = canonicalJson(value);
  requireValue(
    Buffer.byteLength(bytes) <= GOAL_LIMITS.journalRecordBytes,
    "journal record too large",
  );
  return bytes;
}
export function decodeJournalRecord(input) {
  let bytes;
  if (typeof input === "string") bytes = Buffer.from(input, "utf8");
  else if (input instanceof Uint8Array) bytes = Buffer.from(input);
  else throw new Error("invalid goal contract: journal record bytes required");
  requireValue(bytes.length <= GOAL_LIMITS.journalRecordBytes, "journal record too large");
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid goal contract: malformed journal record");
  }
  return validateJournalRecord(value);
}
export function assertJournalAppend(previous, record) {
  const next = validateJournalRecord(record);
  if (previous === null) {
    requireValue(next.sequence === 1, "journal must start at sequence 1");
    requireValue(next.prevChecksum === null, "first journal record cannot link");
    requireValue(next.generation <= 1, "journal must start at generation 0 or 1");
    return;
  }
  const prior = validateJournalRecord(previous);
  requireValue(next.goalId === prior.goalId, "journal goal mismatch");
  requireValue(next.sequence === prior.sequence + 1, "journal sequence gap");
  requireValue(next.prevChecksum === prior.checksum, "journal checksum link mismatch");
  requireValue(next.generation >= prior.generation, "journal generation regression");
  requireValue(next.generation <= prior.generation + 1, "journal generation gap");
  if (next.generation === prior.generation) {
    requireValue(next.attemptId === prior.attemptId, "journal attempt changed within a generation");
  } else {
    requireValue(next.attemptId !== prior.attemptId, "journal generation reuses an attempt");
  }
}
export function validateJournalChain(
  records,
  { goalId = null, maxBytes = GOAL_LIMITS.journalBytes } = {},
) {
  requireValue(Array.isArray(records), "journal array required");
  requireValue(records.length <= GOAL_LIMITS.journalRecords, "journal record limit");
  integer(maxBytes, 1, GOAL_LIMITS.storeBytes);
  let previous = null;
  let bytes = 0;
  const attempts = new Map();
  const attemptIds = new Set();
  const operations = new Map();
  for (const record of records) {
    assertJournalAppend(previous, record);
    if (goalId !== null) requireValue(record.goalId === goalId, "journal goal mismatch");
    bytes += Buffer.byteLength(canonicalJson(record));
    requireValue(bytes <= maxBytes, "journal too large");
    if (record.generation > 0) {
      const known = attempts.get(record.generation);
      if (known === undefined) {
        requireValue(!attemptIds.has(record.attemptId), "journal attempt reuse");
        attempts.set(record.generation, record.attemptId);
        attemptIds.add(record.attemptId);
      } else {
        requireValue(known === record.attemptId, "journal attempt mismatch");
      }
    }
    if (record.kind === "intent") {
      requireValue(!operations.has(record.operationId), "duplicate operation intent");
      operations.set(record.operationId, {
        intentSequence: record.sequence,
        dispatchSequence: null,
        receiptSequence: null,
        status: null,
        intent: record.payload,
      });
      requireValue(operations.size <= GOAL_LIMITS.operations, "operation limit");
    } else if (record.kind === "dispatch") {
      const entry = operations.get(record.operationId);
      requireValue(
        entry && entry.dispatchSequence === null,
        "dispatch requires one prepared intent",
      );
      requireValue(
        canonicalJson({ ...record.payload, state: "prepared" }) === canonicalJson(entry.intent),
        "dispatch does not match its intent",
      );
      entry.dispatchSequence = record.sequence;
    } else if (record.kind === "receipt" || record.kind === "recovery-receipt") {
      const entry = operations.get(record.operationId);
      requireValue(
        entry && entry.dispatchSequence !== null && entry.receiptSequence === null,
        "receipt requires one dispatch and no prior receipt",
      );
      assertOperationReceipt(record.payload, entry.intent, {
        intentSequence: entry.intentSequence,
      });
      entry.receiptSequence = record.sequence;
      entry.status = record.payload.status;
    }
    previous = record;
  }
  return {
    goalId: previous?.goalId ?? goalId,
    count: records.length,
    sequence: previous?.sequence ?? 0,
    generation: previous?.generation ?? 0,
    checksum: previous?.checksum ?? null,
    bytes,
    operations: [...operations].map(([operationId, entry]) => ({
      operationId,
      intentSequence: entry.intentSequence,
      dispatchSequence: entry.dispatchSequence,
      receiptSequence: entry.receiptSequence,
      status: entry.status,
    })),
  };
}

function validateImage(image, label) {
  fields(image, ["exists", "sha256", "mode", "blob"]);
  requireValue(typeof image.exists === "boolean", `invalid ${label} image`);
  if (image.exists) {
    digest(image.sha256);
    integer(image.mode, 0, 0o777);
    digest(image.blob);
  } else {
    requireValue(
      image.sha256 === null && image.mode === null && image.blob === null,
      `absent ${label} image must not carry bytes`,
    );
  }
}
export function validateOperationIntent(intent) {
  fields(intent, INTENT_FIELDS);
  requireValue(
    intent.schemaVersion === OPERATION_INTENT_SCHEMA_VERSION,
    "unsupported intent schema",
  );
  validateGoalId(intent.goalId);
  validateGoalId(intent.attemptId, "attempt");
  integer(intent.generation, 1);
  validateGoalId(intent.operationId, "operation");
  requireValue(GOAL_OPERATION_KINDS.includes(intent.kind), "unknown operation kind");
  fields(intent.arguments, ["sha256", "blob"]);
  digest(intent.arguments.sha256);
  requireValue(
    intent.arguments.blob === null ||
      (typeof intent.arguments.blob === "string" && /^[a-f0-9]{64}$/.test(intent.arguments.blob)),
    "invalid argument artifact",
  );
  digest(intent.planHash);
  fields(intent.authority, ["kind", "planHash", "decisionId", "scope"]);
  requireValue(GOAL_AUTHORITY_KINDS.includes(intent.authority.kind), "unknown authority kind");
  requireValue(intent.authority.scope === "operation", "invalid authority scope");
  const requiredAuthority = ["edit", "test", "command"].includes(intent.kind)
    ? intent.kind
    : "none";
  requireValue(intent.authority.kind === requiredAuthority, "authority kind mismatch");
  if (intent.authority.kind === "none") {
    requireValue(
      intent.authority.planHash === null && intent.authority.decisionId === null,
      "unexpected authority binding",
    );
  } else {
    requireValue(intent.authority.planHash === intent.planHash, "authority plan mismatch");
    validateGoalId(intent.authority.decisionId, "decision");
  }
  validateGoalWorkspace(intent.workspace);
  fields(intent.preconditions, ["files"]);
  requireValue(
    Array.isArray(intent.preconditions.files) &&
      intent.preconditions.files.length <= GOAL_LIMITS.preconditions,
    "precondition limit",
  );
  const preconditionPaths = new Set();
  for (const file of intent.preconditions.files) {
    fields(file, ["path", "exists", "sha256"]);
    validateGoalPath(file.path);
    requireValue(typeof file.exists === "boolean", "invalid precondition exists");
    requireValue(!preconditionPaths.has(file.path), "duplicate precondition");
    preconditionPaths.add(file.path);
    if (file.exists) digest(file.sha256);
    else requireValue(file.sha256 === null, "absent precondition has a hash");
  }
  if (intent.kind === "edit") {
    fields(intent.edit, ["path", "before", "after"]);
    validateGoalPath(intent.edit.path);
    validateImage(intent.edit.before, "before");
    validateImage(intent.edit.after, "after");
    requireValue(
      intent.edit.before.exists !== intent.edit.after.exists ||
        intent.edit.before.sha256 !== intent.edit.after.sha256 ||
        intent.edit.before.mode !== intent.edit.after.mode,
      "edit is a no-op",
    );
    requireValue(
      intent.preconditions.files.length === 1 &&
        intent.preconditions.files[0].path === intent.edit.path &&
        intent.preconditions.files[0].exists === intent.edit.before.exists &&
        intent.preconditions.files[0].sha256 === intent.edit.before.sha256,
      "edit precondition mismatch",
    );
  } else {
    requireValue(intent.edit === null, "unexpected edit binding");
  }
  validateGoalUsage(intent.reservation);
  requireValue(GOAL_OPERATION_STATES.includes(intent.state), "unknown operation state");
  canonicalJson(intent, { maxBytes: GOAL_LIMITS.journalRecordBytes });
  return structuredClone(intent);
}
export function assertOperationFence(intent, fence) {
  const copy = validateOperationIntent(intent);
  fields(fence, ["goalId", "attemptId", "generation", "operationId"]);
  requireValue(
    fence.goalId === copy.goalId &&
      fence.attemptId === copy.attemptId &&
      fence.generation === copy.generation &&
      fence.operationId === copy.operationId,
    "stale operation fence",
  );
  return copy;
}
export function dispatchOperationIntent(intent, fence) {
  const copy = assertOperationFence(intent, fence);
  requireValue(copy.state === "prepared", "operation already dispatched");
  copy.state = "dispatched";
  return validateOperationIntent(copy);
}
export function observeOperationIntent(intent, fence) {
  const copy = assertOperationFence(intent, fence);
  requireValue(copy.state === "dispatched", "operation was not dispatched");
  copy.state = "observed";
  return validateOperationIntent(copy);
}

export function validateOperationReceipt(receipt) {
  fields(receipt, RECEIPT_FIELDS);
  requireValue(
    receipt.schemaVersion === OPERATION_RECEIPT_SCHEMA_VERSION,
    "unsupported receipt schema",
  );
  validateGoalId(receipt.goalId);
  validateGoalId(receipt.attemptId, "attempt");
  integer(receipt.generation, 1);
  validateGoalId(receipt.operationId, "operation");
  integer(receipt.sequence, 1);
  requireValue(GOAL_RECEIPT_STATUSES.includes(receipt.status), "unknown receipt status");
  requireValue(
    Array.isArray(receipt.evidence) && receipt.evidence.length <= GOAL_LIMITS.evidenceRefs,
    "evidence limit",
  );
  const evidence = new Set();
  for (const reference of receipt.evidence) {
    digest(reference);
    requireValue(!evidence.has(reference), "duplicate evidence reference");
    evidence.add(reference);
  }
  requireValue(
    Array.isArray(receipt.files) && receipt.files.length <= GOAL_LIMITS.receiptFiles,
    "receipt file limit",
  );
  const paths = new Set();
  for (const file of receipt.files) {
    fields(file, ["path", "state", "sha256"]);
    validateGoalPath(file.path);
    requireValue(!paths.has(file.path), "duplicate receipt file");
    paths.add(file.path);
    requireValue(
      ["matches-before", "matches-after", "absent", "unexpected"].includes(file.state),
      "unknown receipt file state",
    );
    if (file.state === "absent") {
      requireValue(file.sha256 === null, "absent receipt file has a hash");
    } else {
      digest(file.sha256);
    }
  }
  if (receipt.process !== null) {
    fields(receipt.process, ["exitCode", "signal"]);
    const { exitCode, signal } = receipt.process;
    requireValue(
      exitCode === null || (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255),
      "invalid process exit code",
    );
    requireValue(
      signal === null ||
        (typeof signal === "string" && signal.length <= 32 && /^SIG[A-Z0-9]+$/.test(signal)),
      "invalid process signal",
    );
    requireValue(exitCode !== null || signal !== null, "empty process result");
  }
  validateGoalUsage(receipt.usage);
  fields(receipt.uncertainty, ["kind", "detail"]);
  requireValue(
    GOAL_RECEIPT_UNCERTAINTIES.includes(receipt.uncertainty.kind),
    "unknown uncertainty kind",
  );
  if (receipt.uncertainty.kind === "none") {
    requireValue(receipt.uncertainty.detail === null, "unexpected uncertainty detail");
  } else {
    text(receipt.uncertainty.detail, 2048);
  }
  requireValue(
    receipt.status !== "uncertain" || receipt.uncertainty.kind !== "none",
    "uncertain receipt requires a reason",
  );
  canonicalJson(receipt, { maxBytes: GOAL_LIMITS.journalRecordBytes });
  return structuredClone(receipt);
}
export function assertOperationReceipt(receipt, intent, { intentSequence = null } = {}) {
  const value = validateOperationReceipt(receipt);
  const expected = validateOperationIntent(intent);
  requireValue(
    value.goalId === expected.goalId &&
      value.attemptId === expected.attemptId &&
      value.generation === expected.generation &&
      value.operationId === expected.operationId,
    "receipt does not match its intent",
  );
  if (intentSequence !== null) {
    integer(intentSequence, 1);
    requireValue(value.sequence > intentSequence, "receipt sequence precedes its intent");
  }
  if (expected.kind === "edit" && value.status === "succeeded") {
    const file = value.files.find((entry) => entry.path === expected.edit.path);
    requireValue(
      file &&
        (expected.edit.after.exists
          ? file.state === "matches-after" && file.sha256 === expected.edit.after.sha256
          : file.state === "absent" && file.sha256 === null),
      "receipt does not bind the edit after image",
    );
  }
  return value;
}
export function reserveOperationBudget(limit, counters, intent) {
  const value = validateOperationIntent(intent);
  return updateGoalBudget(limit, counters, "reserve", value.reservation);
}
export function settleOperationBudget(limit, counters, intent, receipt) {
  const expected = validateOperationIntent(intent);
  const value = assertOperationReceipt(receipt, expected);
  for (const key of BUDGET_KEYS) {
    requireValue(value.usage[key] <= expected.reservation[key], "usage exceeds reservation");
  }
  return updateGoalBudget(limit, counters, "consume", value.usage);
}

export function validateGoalLease(lease) {
  fields(lease, LEASE_FIELDS);
  requireValue(lease.schemaVersion === LEASE_SCHEMA_VERSION, "unsupported lease schema");
  validateGoalId(lease.leaseId, "lease");
  validateGoalId(lease.goalId);
  validateGoalId(lease.attemptId, "attempt");
  integer(lease.generation, 1);
  validateLeaseWorkspace(lease.workspace);
  validateAttemptOwner(lease.owner);
  integer(lease.acquiredAt);
  integer(lease.expiresAt);
  requireValue(lease.expiresAt > lease.acquiredAt, "invalid lease interval");
  requireValue(lease.expiresAt - lease.acquiredAt <= LEASE_MAX_MS, "lease too long");
  canonicalJson(lease);
  return structuredClone(lease);
}
/**
 * @param {*} goal
 * @param {{attemptId?: string, owner?: *, now?: number, ttlMs?: number}} options
 */
export function createGoalLease(goal, { attemptId, owner, now, ttlMs = LEASE_MAX_MS } = {}) {
  const record = validateGoalRecord(goal);
  validateGoalId(attemptId, "attempt");
  validateAttemptOwner(owner);
  integer(now);
  integer(ttlMs, 1, LEASE_MAX_MS);
  requireValue(ACTIVE_ATTEMPT_STATES.includes(record.state), "lease requires an active attempt");
  requireValue(record.generation >= 1, "lease requires a generation");
  requireValue(now <= Number.MAX_SAFE_INTEGER - ttlMs, "lease time out of bounds");
  return validateGoalLease({
    schemaVersion: LEASE_SCHEMA_VERSION,
    leaseId: newGoalId("lease"),
    goalId: record.id,
    attemptId,
    generation: record.generation,
    workspace: {
      path: record.workspace.path,
      device: record.workspace.device,
      inode: record.workspace.inode,
    },
    owner: structuredClone(owner),
    acquiredAt: now,
    expiresAt: now + ttlMs,
  });
}
/**
 * @param {*} lease
 * @param {{owner?: *, now?: number, ttlMs?: number}} options
 */
export function renewGoalLease(lease, { owner, now, ttlMs = LEASE_MAX_MS } = {}) {
  const copy = validateGoalLease(lease);
  validateAttemptOwner(owner);
  integer(now);
  integer(ttlMs, 1, LEASE_MAX_MS);
  requireValue(
    copy.owner.pid === owner.pid &&
      copy.owner.startTime === owner.startTime &&
      copy.owner.bootId === owner.bootId,
    "lease owner mismatch",
  );
  requireValue(now >= copy.acquiredAt && now < copy.expiresAt, "lease expired");
  requireValue(now <= Number.MAX_SAFE_INTEGER - ttlMs, "lease time out of bounds");
  // Renewal re-mints the bounded window; the original attempt time is retained
  // by the journal and lease id, not by an ever-growing interval.
  copy.acquiredAt = now;
  copy.expiresAt = now + ttlMs;
  return validateGoalLease(copy);
}
export function assertLeaseForGoal(lease, goal, now) {
  const value = validateGoalLease(lease);
  const record = validateGoalRecord(goal);
  integer(now);
  requireValue(ACTIVE_ATTEMPT_STATES.includes(record.state), "goal has no active attempt");
  requireValue(
    value.goalId === record.id && value.generation === record.generation,
    "stale lease for goal",
  );
  requireValue(
    value.workspace.path === record.workspace.path &&
      value.workspace.device === record.workspace.device &&
      value.workspace.inode === record.workspace.inode,
    "lease workspace mismatch",
  );
  requireValue(now >= value.acquiredAt && now < value.expiresAt, "lease expired");
  return value;
}
export function assertLeaseHeld(lease, fence) {
  const value = validateGoalLease(lease);
  fields(fence, ["goalId", "attemptId", "generation", "workspace", "owner", "now"]);
  validateGoalId(fence.goalId);
  validateGoalId(fence.attemptId, "attempt");
  integer(fence.generation, 1);
  validateLeaseWorkspace(fence.workspace);
  validateAttemptOwner(fence.owner);
  integer(fence.now);
  requireValue(
    value.goalId === fence.goalId &&
      value.generation === fence.generation &&
      value.attemptId === fence.attemptId,
    "stale lease fence",
  );
  requireValue(
    value.workspace.path === fence.workspace.path &&
      value.workspace.device === fence.workspace.device &&
      value.workspace.inode === fence.workspace.inode,
    "lease workspace mismatch",
  );
  requireValue(
    value.owner.pid === fence.owner.pid &&
      value.owner.startTime === fence.owner.startTime &&
      value.owner.bootId === fence.owner.bootId,
    "lease owner mismatch",
  );
  requireValue(fence.now >= value.acquiredAt, "lease not yet valid");
  requireValue(fence.now < value.expiresAt, "lease expired");
  return value;
}
// The trusted runtime calls this before every mutation. It joins the persisted
// goal, the held lease, the caller's own process identity and the operation.
/**
 * @param {*} intent
 * @param {{goal?: *, lease?: *, owner?: *, now?: number}} options
 */
export function assertOperationAuthority(intent, { goal, lease, owner, now } = {}) {
  const value = validateOperationIntent(intent);
  const record = validateGoalRecord(goal);
  const held = assertLeaseForGoal(lease, record, now);
  assertLeaseHeld(held, {
    goalId: record.id,
    attemptId: held.attemptId,
    generation: record.generation,
    workspace: {
      path: record.workspace.path,
      device: record.workspace.device,
      inode: record.workspace.inode,
    },
    owner,
    now,
  });
  requireValue(value.goalId === record.id, "intent goal mismatch");
  requireValue(value.generation === record.generation, "stale intent generation");
  requireValue(value.attemptId === held.attemptId, "intent attempt mismatch");
  requireValue(
    value.workspace.path === record.workspace.path &&
      value.workspace.device === record.workspace.device &&
      value.workspace.inode === record.workspace.inode &&
      value.workspace.manifest === record.workspace.manifest,
    "intent workspace mismatch",
  );
  return value;
}

// A fence is compared under the store's writer lease before any mutation.
export function assertGoalFence(record, fence) {
  fields(fence, ["goalId", "generation", "sequence"]);
  requireValue(
    fence.goalId === record.id &&
      fence.generation === record.generation &&
      fence.sequence === record.sequence,
    "stale fence",
  );
}
export function transitionGoal(record, next, fence) {
  const copy = validateGoalRecord(record);
  assertGoalFence(copy, fence);
  requireValue(
    Object.hasOwn(TRANSITIONS, next) && TRANSITIONS[copy.state].includes(next),
    "forbidden transition",
  );
  // Evidence validation belongs to the executor. A generic lifecycle event
  // cannot assert that every acceptance criterion has current evidence.
  requireValue(next !== "completed", "completion requires criterion evidence");
  requireValue(
    copy.state !== "budget-exhausted" || next === "cancelled",
    "budget amendment required",
  );
  integer(copy.sequence + 1);
  if (next === "reconciling" || (copy.state === "ready" && next === "running")) {
    integer(copy.generation + 1);
    copy.generation++;
  }
  copy.sequence++;
  copy.state = next;
  return copy;
}

// Counters retain reservations after interruption. Settlement consumes a known
// reservation and moves its observed charge to used without refunding unknown work.
export function updateGoalBudget(limit, counters, action, amount) {
  validateGoalBudget(limit);
  fields(counters, ["used", "reserved"]);
  fields(counters.used, BUDGET_KEYS);
  fields(counters.reserved, BUDGET_KEYS);
  fields(amount, BUDGET_KEYS);
  requireValue(action === "reserve" || action === "consume", "unknown budget action");
  const copy = structuredClone(counters);
  for (const key of BUDGET_KEYS) {
    integer(copy.used[key]);
    integer(copy.reserved[key]);
    integer(amount[key]);
    requireValue(copy.used[key] <= limit[key] - copy.reserved[key], "invalid budget ledger");
    if (action === "reserve") {
      requireValue(
        amount[key] <= limit[key] - copy.used[key] - copy.reserved[key],
        "budget exhausted",
      );
      copy.reserved[key] += amount[key];
    } else {
      requireValue(amount[key] <= copy.reserved[key], "unreserved consumption");
      copy.reserved[key] -= amount[key];
      copy.used[key] += amount[key];
    }
  }
  return copy;
}

export function goalStateFromOutcome(result) {
  const outcome = classifyOutcome(result);
  switch (outcome.status) {
    case "aborted":
      return "interrupted";
    case "budgetExhausted":
      return "budget-exhausted";
    default:
      return "needs-attention";
  }
}

export function completeGoal(record, evidence, fence) {
  const copy = validateGoalRecord(record);
  assertGoalFence(copy, fence);
  requireValue(copy.state === "running", "completion requires a running attempt");
  requireValue(
    Array.isArray(evidence) && evidence.length === copy.criteria.length,
    "incomplete evidence",
  );
  const seen = new Set();
  for (const entry of evidence) {
    fields(entry, ["criterionId", "revision", "generation", "manifest", "binding", "accepted"]);
    const criterion = copy.criteria.find((item) => item.id === entry.criterionId);
    requireValue(criterion && !seen.has(entry.criterionId), "unknown or duplicate evidence");
    seen.add(entry.criterionId);
    requireValue(
      entry.accepted === true &&
        entry.revision === criterion.revision &&
        entry.generation === copy.generation &&
        entry.manifest === copy.workspace.manifest,
      "stale or failed evidence",
    );
    const binding =
      criterion.kind === "test"
        ? criterion.planHash
        : criterion.kind === "artifact"
          ? criterion.sha256
          : null;
    requireValue(entry.binding === binding, "evidence binding mismatch");
  }
  integer(copy.sequence + 1);
  copy.sequence++;
  copy.state = "completed";
  return copy;
}

export function amendGoalBudget(record, nextBudget, counters, fence) {
  const copy = validateGoalRecord(record);
  assertGoalFence(copy, fence);
  requireValue(copy.state === "budget-exhausted", "budget amendment requires stopped goal");
  copy.budget = validateGoalBudget(nextBudget);
  requireValue(
    BUDGET_KEYS.some((key) => copy.budget[key] > record.budget[key]),
    "budget increase required",
  );
  requireValue(
    BUDGET_KEYS.every((key) => copy.budget[key] >= record.budget[key]),
    "budget cannot decrease",
  );
  updateGoalBudget(copy.budget, counters, "reserve", {
    rounds: 0,
    tools: 0,
    requests: 0,
    activeMs: 0,
  });
  integer(copy.sequence + 1);
  copy.sequence++;
  copy.state = "ready";
  return copy;
}
