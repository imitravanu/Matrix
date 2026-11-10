// ============================================================================
// Durable-goal lease probe for ordinary writers.
//
// `withWorkspaceWriteLock` covers writers that run while a goal's descriptor is
// alive, but the durable goal releases that descriptor between effects. This
// probe closes the remaining gap: before any cooperating writer is allowed to
// touch a workspace, it inspects the durable goal store and refuses when a
// goal bound to this workspace identity holds a live lease, or when an
// execution owned by a durable goal has not been verified torn down.
//
// The probe is fail-closed. Any state it cannot read or trust refuses the
// write with a clear message rather than risk bypassing an active goal's
// authority. It never signals a process and never mutates anything.
//
// The owning goal's own process (same pid, same start time, same boot id) is
// recognised and allowed; every other process is refused while an unverified
// execution may survive.
// ============================================================================

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { TextDecoder } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  GOAL_LIMITS,
  canonicalJson,
  validateGoalLease,
  validateGoalRecord,
} from "./goal-contracts.mjs";

import { createGoalStore } from "./goal-store.mjs";
import { receiptSummary } from "./goal-context.mjs";

export const GOAL_UNSAFE_CODE = "durable-goal-unsafe";
export const GOAL_BLOCK_CODE = "durable-goal-active";
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const ACTIVE = ["running", "awaiting-approval", "reconciling"];
const GOAL_DIR = /^goal_[a-f0-9]{32}$/;
const OWNERSHIP_RECORD = /^operation_[a-f0-9]{32}\.json$/;
const MAX_ENTRIES = 10_000;
const OWNERSHIP_BYTES = GOAL_LIMITS.journalRecordBytes;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Reconciliation mechanisms that may release an ownership block — and only
// when the record also binds the sha256 of the reviewed pidfd helper
// installed under MATRIX_HOME/bin. Legacy process-group-only records (or any
// record not bound to the reviewed binary) leave the block in place.
const RECONCILED_MECHANISMS = new Set(["pidfd-teardown", "already-exited", "host-reboot"]);

/**
 * sha256 of the reviewed pidfd helper at home/bin/matrix-pidfd-helper, or
 * null when it is absent or not a private, owner-owned regular file. The bin
 * directory must itself be private so the digest cannot be pointed at a
 * swapped binary.
 */
function trustedHelperSha256(home) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let binStat;
  try {
    binStat = lstatSync(join(home, "bin"), { bigint: true });
  } catch {
    return null;
  }
  if (
    !binStat.isDirectory() ||
    (uid !== null && Number(binStat.uid) !== uid) ||
    (Number(binStat.mode) & 0o7777) !== 0o700
  ) {
    return null;
  }
  const helperPath = join(home, "bin", "matrix-pidfd-helper");
  let stat;
  try {
    stat = lstatSync(helperPath, { bigint: true });
  } catch {
    return null;
  }
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (Number(stat.mode) & 0o022) !== 0 ||
    (uid !== null && Number(stat.uid) !== uid)
  ) {
    return null;
  }
  try {
    return createHash("sha256").update(readFileSync(helperPath)).digest("hex");
  } catch {
    return null;
  }
}

/** True only for a reconciliation record produced by the reviewed mechanism. */
function trustedReconciliation(sealed, helperDigest) {
  return (
    isPlainObject(sealed) &&
    RECONCILED_MECHANISMS.has(sealed.mechanism) &&
    isHash(sealed.helperSha256) &&
    sealed.helperSha256 === helperDigest
  );
}

function containmentBound(record) {
  const containment = record?.containment;
  if (!isPlainObject(containment) || containment.kind !== "pid-namespace") return false;
  const namespace = containment.namespace;
  const monitor = containment.monitor;
  const init = containment.init;
  return (
    isPlainObject(namespace) &&
    Number.isSafeInteger(namespace.initPid) &&
    namespace.initPid > 0 &&
    typeof namespace.initStartTime === "string" &&
    /^[0-9]{1,32}$/.test(namespace.initStartTime) &&
    typeof namespace.inode === "string" &&
    /^[0-9]{1,20}$/.test(namespace.inode) &&
    isPlainObject(monitor) &&
    Number.isSafeInteger(monitor.pid) &&
    monitor.pid > 0 &&
    typeof monitor.startTime === "string" &&
    /^[0-9]{1,32}$/.test(monitor.startTime) &&
    isPlainObject(init) &&
    init.pid === namespace.initPid &&
    init.startTime === namespace.initStartTime
  );
}

function sameContainment(left, right) {
  if (!containmentBound({ containment: left }) || !containmentBound({ containment: right })) {
    return false;
  }
  return (
    left.namespace.initPid === right.namespace.initPid &&
    left.namespace.initStartTime === right.namespace.initStartTime &&
    left.namespace.inode === right.namespace.inode &&
    left.monitor.pid === right.monitor.pid &&
    left.monitor.startTime === right.monitor.startTime
  );
}

/** A refusal the writer must surface; nothing was written. */
export class DurableGoalUnsafeError extends Error {
  /** @param {string} detail */
  constructor(detail) {
    super(`refusing to write: durable goal state is corrupt or unsafe (${detail})`);
    this.name = "DurableGoalUnsafeError";
    this.code = GOAL_UNSAFE_CODE;
  }
}

function defaultHome() {
  return process.env.MATRIX_HOME || join(homedir(), ".matrix");
}

function identityOf(root) {
  const real = realpathSync(root);
  const stat = statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new DurableGoalUnsafeError("workspace is not a directory");
  return { path: real, device: String(stat.dev), inode: String(stat.ino) };
}

function matchesWorkspace(workspace, identity) {
  if (!workspace || typeof workspace !== "object") return false;
  if (workspace.path === identity.path) return true;
  return String(workspace.device) === identity.device && String(workspace.inode) === identity.inode;
}

function privateDirectoryStat(stat, detail) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !stat.isDirectory() ||
    (uid !== null && Number(stat.uid) !== uid) ||
    (Number(stat.mode) & 0o7777) !== 0o700
  ) {
    throw new DurableGoalUnsafeError(detail);
  }
}

function privateDirectory(path, detail) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    throw new DurableGoalUnsafeError(detail);
  }
  privateDirectoryStat(stat, detail);
}

function readBoundedJson(path, limit, detail) {
  let fd;
  try {
    fd = openSync(path, READ);
  } catch {
    throw new DurableGoalUnsafeError(detail);
  }
  try {
    const stat = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (uid !== null && stat.uid !== uid) ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > limit
    ) {
      throw new DurableGoalUnsafeError(detail);
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length !== stat.size) throw new DurableGoalUnsafeError(detail);
    try {
      return {
        bytes: bytes.subarray(0, length),
        value: JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
        ),
      };
    } catch {
      throw new DurableGoalUnsafeError(detail);
    }
  } finally {
    closeSync(fd);
  }
}

const CHECKPOINT_KEYS = new Set([
  "schemaVersion",
  "goal",
  "counters",
  "lease",
  "receiptSlots",
  "journalBytes",
  "journalChecksum",
  "checksum",
]);

/** Byte-exact checkpoint verification mirroring the store's load path. */
function verifyCheckpoint(value, bytes, detail) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableGoalUnsafeError(detail);
  }
  const keys = Object.keys(value);
  if (keys.length > CHECKPOINT_KEYS.size || keys.some((key) => !CHECKPOINT_KEYS.has(key))) {
    throw new DurableGoalUnsafeError(detail);
  }
  const { checksum, ...body } = value;
  const options = { maxBytes: GOAL_LIMITS.checkpointBytes };
  const canonical = (input) => Buffer.from(canonicalJson(input, options));
  if (!isHash(checksum)) throw new DurableGoalUnsafeError(detail);
  if (digest(canonical(body)) !== checksum) {
    throw new DurableGoalUnsafeError(`${detail}; checkpoint checksum mismatch`);
  }
  if (!canonical({ ...body, checksum }).equals(bytes)) {
    throw new DurableGoalUnsafeError(`${detail}; checkpoint bytes are not canonical`);
  }
  const goal = validateGoalRecord(body.goal);
  if (goal.sequence < 1) throw new DurableGoalUnsafeError(detail);
  let lease = null;
  if (Object.hasOwn(body, "lease") && body.lease != null) {
    lease = validateGoalLease(body.lease);
    if (lease.goalId !== goal.id || lease.generation !== goal.generation) {
      throw new DurableGoalUnsafeError(`${detail}; lease does not match the checkpoint goal`);
    }
  }
  const active = ACTIVE.includes(goal.state);
  if ((lease !== null) !== active) {
    throw new DurableGoalUnsafeError(`${detail}; checkpoint lease does not match goal state`);
  }
  return { goal, lease };
}

function readDirectoryEntries(directory, detail) {
  let fd;
  try {
    fd = openSync(directory, DIRECTORY);
  } catch {
    throw new DurableGoalUnsafeError(detail);
  }
  try {
    privateDirectoryStat(fstatSync(fd, { bigint: true }), detail);
    const names = readdirSync(`/proc/self/fd/${fd}`);
    if (names.length > MAX_ENTRIES) throw new DurableGoalUnsafeError(`${detail}; too many entries`);
    return names;
  } finally {
    closeSync(fd);
  }
}

function ownStartTime() {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const value = rest[19];
  if (!/^\d{1,32}$/.test(value)) throw new DurableGoalUnsafeError("cannot read own start time");
  return value;
}

function currentBootId() {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[0-9a-f-]{36}$/i.test(boot)) {
    throw new DurableGoalUnsafeError("cannot read the host boot id");
  }
  return boot;
}

function isSelf(owner) {
  if (!owner || typeof owner !== "object") return false;
  return (
    owner.pid === process.pid &&
    typeof owner.startTime === "string" &&
    owner.startTime === ownStartTime() &&
    typeof owner.bootId === "string" &&
    owner.bootId === currentBootId()
  );
}

function ownershipDirectory(home) {
  return join(home, "ownership");
}

/**
 * Scan the ownership registry for an execution bound to this workspace that
 * has no matching durable reconciliation record. Returns the record or null.
 * Throws DurableGoalUnsafeError on any unreadable or untrusted state.
 *
 * `selfLeases` lists leases owned by the calling process (goal, attempt,
 * generation). An in-flight operation of the caller's own lease is not a
 * foreign survivor: the lease itself still refuses every other writer, so the
 * owner may finish its own receipt without deadlocking on its own dispatch.
 */
function findUnresolvedOwnership(home, identity, selfLeases, released) {
  const directory = ownershipDirectory(home);
  if (!existsSync(directory)) return null;
  privateDirectory(directory, "ownership registry is not a private directory");
  const names = readDirectoryEntries(directory, "ownership registry is unreadable");
  const helperDigest = trustedHelperSha256(home);
  const reconciledDirectory = join(directory, "reconciled");
  const reconciled = new Map();
  if (existsSync(reconciledDirectory)) {
    privateDirectory(reconciledDirectory, "ownership reconciliations are not a private directory");
    const reLimit = GOAL_LIMITS.journalRecordBytes;
    for (const name of readDirectoryEntries(
      reconciledDirectory,
      "ownership reconciliations are unreadable",
    )) {
      if (!OWNERSHIP_RECORD.test(name)) continue;
      // The reconciled file is only trusted when it parses and binds to the
      // same operation, attempt, generation and workspace as the ownership
      // record it releases. Otherwise the workspace stays blocked.
      try {
        const { value } = readBoundedJson(
          join(reconciledDirectory, name),
          reLimit,
          `reconciliation record ${name} is unreadable`,
        );
        if (
          value?.schemaVersion === 1 &&
          value.operationId === name.slice(0, -".json".length) &&
          typeof value.goalId === "string" &&
          typeof value.attemptId === "string" &&
          Number.isSafeInteger(value.generation) &&
          typeof value.mechanism === "string" &&
          /^[\x20-\x7e]{1,120}$/.test(value.mechanism) &&
          Number.isSafeInteger(value.verifiedAt) &&
          isPlainObject(value.workspace)
        ) {
          reconciled.set(name.slice(0, -".json".length), value);
        } else {
          reconciled.set(name.slice(0, -".json".length), null);
        }
      } catch {
        reconciled.set(name.slice(0, -".json".length), null);
      }
    }
  }
  for (const name of names) {
    if (!OWNERSHIP_RECORD.test(name)) continue;
    const operationId = name.slice(0, -".json".length);
    const { value } = readBoundedJson(
      join(directory, name),
      OWNERSHIP_BYTES,
      `ownership record ${operationId} is unreadable`,
    );
    const record = value;
    if (
      !record ||
      typeof record !== "object" ||
      record.schemaVersion !== 1 ||
      typeof record.operationId !== "string" ||
      record.operationId !== operationId ||
      typeof record.goalId !== "string" ||
      !isPlainObject(record.workspace) ||
      typeof record.workspace.path !== "string" ||
      typeof record.workspace.device !== "string" ||
      typeof record.workspace.inode !== "string"
    ) {
      throw new DurableGoalUnsafeError(`ownership record ${operationId} is invalid`);
    }
    if (!matchesWorkspace(record.workspace, identity)) continue;
    const sealed = reconciled.get(operationId);
    // Only a reconciliation record bound to the sha256 of the reviewed pidfd
    // helper releases the block. A same-host reboot is definitionally safe;
    // any other mechanism must also bind the exact PID-namespace identity.
    // Legacy process-group-only attestations cannot prove that detached
    // descendants have stopped and stay blocked.
    const closedGate =
      record.gatePending === true &&
      !record.containment &&
      !record.namespace &&
      sealed?.gatePending === true &&
      !sealed.containment &&
      !sealed.namespace &&
      sealed.mechanism === "gate-not-released";
    const releaseReady =
      closedGate ||
      (trustedReconciliation(sealed, helperDigest) &&
        containmentBound(record) &&
        sameContainment(sealed.containment, record.containment));
    if (record.gatePending === true) {
      const status = createGoalStore(home).inspect(record.goalId);
      if (
        !status.journal.operations.some(
          (entry) => entry.operationId === operationId && entry.dispatchSequence !== null,
        )
      )
        continue;
    }
    if (releaseReady) {
      if (
        sealed.operationId === operationId &&
        sealed.goalId === record.goalId &&
        sealed.attemptId === record.attemptId &&
        sealed.generation === record.generation &&
        sealed.pid === record.pid &&
        sealed.startTime === record.startTime &&
        sealed.bootId === record.bootId &&
        sealed.machineId === record.machineId &&
        sealed.workspace.path === record.workspace.path &&
        sealed.workspace.device === record.workspace.device &&
        sealed.workspace.inode === record.workspace.inode
      ) {
        released.add(operationId);
        continue;
      }
      // A present but mismatched reconciliation releases nothing.
    }
    const selfOwned = selfLeases.some(
      (lease) =>
        lease.goalId === record.goalId &&
        lease.attemptId === record.attemptId &&
        lease.generation === record.generation,
    );
    if (selfOwned) continue;
    return record;
  }
  return null;
}

/**
 * Inspect the durable goal store for authority bound to `root`. Returns a
 * blocker object when a foreign active lease or an unverified execution is
 * bound to the workspace, otherwise null. Throws DurableGoalUnsafeError when
 * the state cannot be trusted. This function never writes and never signals.
 *
 * @param {string} root workspace root (absolute or relative)
 * @param {{ home?: string, now?: number, goalLock?: boolean, recoveryGoalId?: string, verifiedOperations?: Set<string> }} [options]
 */
export function findBlockingDurableGoal(
  root,
  {
    home = defaultHome(),
    now = Date.now(),
    goalLock = false,
    recoveryGoalId,
    verifiedOperations,
  } = {},
) {
  const identity = identityOf(root);
  const goalsDir = join(home, "goals");
  // Ownership records can survive a partial restore of the goal store.
  const names = lstatSync(goalsDir, { throwIfNoEntry: false })
    ? readDirectoryEntries(goalsDir, "goals directory is unreadable")
    : [];
  const goals = [];
  const selfLeases = [];
  for (const name of names) {
    if (!GOAL_DIR.test(name)) continue;
    const directory = join(goalsDir, name);
    privateDirectory(directory, `goal ${name} directory is not private`);
    const { bytes, value } = readBoundedJson(
      join(directory, "checkpoint.json"),
      GOAL_LIMITS.checkpointBytes,
      `goal ${name} checkpoint is unreadable`,
    );
    const { goal, lease } = verifyCheckpoint(value, bytes, `goal ${name} checkpoint is invalid`);
    if (!matchesWorkspace(goal.workspace, identity)) continue;
    const own = goalLock && lease && lease.expiresAt > now && isSelf(lease.owner);
    if (own) selfLeases.push(lease);
    goals.push({ goal, lease, own });
  }

  const released = new Set();
  const unresolved = findUnresolvedOwnership(home, identity, selfLeases, released);
  if (unresolved) {
    return {
      blocked: true,
      reason: "surviving-execution-unverified",
      goalId: unresolved.goalId,
      operationId: unresolved.operationId,
      message:
        "a durable goal reported an unverified execution in this workspace; " +
        "verify its teardown before any writer runs",
    };
  }

  if (goals.length === 0) return null;
  const store = createGoalStore(home);
  for (const { goal, lease, own } of goals) {
    if (own) continue;
    if (lease) {
      return {
        blocked: true,
        reason: "active-lease",
        goalId: goal.id,
        state: goal.state,
        leaseId: lease.leaseId,
        message: `workspace is locked by durable goal ${goal.id}`,
      };
    }
    const status = store.inspect(goal.id);
    if (status.uncommittedBytes > 0) {
      throw new DurableGoalUnsafeError(`goal ${goal.id} has an uncommitted journal tail`);
    }
    if (!status.journal.operations.some((entry) => entry.dispatchSequence !== null)) continue;
    const records = store.readJournal(goal.id);
    for (const entry of status.journal.operations) {
      if (
        entry.dispatchSequence === null ||
        released.has(entry.operationId) ||
        (goalLock && verifiedOperations?.has(entry.operationId))
      )
        continue;
      const intent = records[entry.intentSequence - 1].payload;
      const receipt = entry.receiptSequence === null ? null : records[entry.receiptSequence - 1];
      const execution = intent.kind === "test" || intent.kind === "command";
      let blocked =
        intent.kind === "edit" &&
        recoveryGoalId !== goal.id &&
        (!receipt || (receipt.kind === "receipt" && receipt.payload.status === "uncertain"));
      if (execution && receipt?.kind !== "recovery-receipt") {
        const summary = receipt && receiptSummary(store, goal.id, receipt.payload);
        blocked = !summary || summary.execution?.teardown === "unverified";
      }
      if (blocked) {
        return {
          blocked: true,
          reason: "unresolved-dispatch",
          goalId: goal.id,
          operationId: entry.operationId,
          message: `durable goal ${goal.id} has an unresolved dispatch; recover it before writing`,
        };
      }
    }
  }
  return null;
}

/**
 * Throwing variant used by cooperating writers. The message is safe to show;
 * it never contains file bytes or credentials.
 */
export function assertNoDurableGoalOwnsWorkspace(root, options = {}) {
  const blocker = findBlockingDurableGoal(root, options);
  if (blocker) {
    const error = Object.assign(new Error(`refusing to write: ${blocker.message}`), {
      code: GOAL_BLOCK_CODE,
      blocker,
    });
    throw error;
  }
}
