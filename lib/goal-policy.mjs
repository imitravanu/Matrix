// ============================================================================
// Durable-goal policy: authority, ownership and admission.
//
// This module is the trusted integration boundary for the durable goal
// workflow. It provides:
//
//   - createGoalAuthority(): the decision broker bound to one goal attempt.
//     Every authorization is bound to the exact operation, workspace,
//     generation and plan; restart discards pending authority; edit, test and
//     command decisions are independent; commands are unsupported by design.
//
//   - createExecutionOwnership(): the process-ownership boundary. Identity
//     (boot id, PID start time and namespace) is proven through the reviewed
//     pidfd helper before any signal. It never signals a PID based on its name
//     alone, never signals across a host/boot mismatch, and persists durable
//     reconciliation records bound to the helper binary for later invocations.
//
//   - createGoalTestRunner(): the trusted adapter that executes a repository
//     test plan for a dispatched goal operation, under the same trust and
//     audit path as ordinary runs, and binds the spawned tree to the
//     ownership boundary.
//
//   - createGoalRuntime(): the integrated runtime path wiring the store,
//     executor, authority, ownership and test runner together.
//
//   - reclaimStaleGoalAttempt(): releases the lease of an attempt whose
//     owner is verifiably dead, using the reviewed identity rules. Reclaim
//     alone never enables resume of a goal whose execution is unverified.
//
// Nothing in this module is reachable from model output or goal text.
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { TextDecoder } from "node:util";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { appendRunEvent } from "./session.mjs";
import { GOAL_LIMITS, canonicalJson, validateGoalId } from "./goal-contracts.mjs";
import { createGoalStore } from "./goal-store.mjs";
import { withGoalLock } from "./goal-lock.mjs";
import { prepareEditOperation } from "./goal-operations.mjs";
import { createGoalExecutor } from "./goal-executor.mjs";
import { inspectTestPlan, TEST_ORIGIN } from "./test-policy.mjs";
import { runTests } from "./process.mjs";
import { createContainmentProcessRunner, createGoalTestIsolation } from "./goal-containment.mjs";
import { hashGoalSourceManifest, resolveGoalSourceManifest } from "./goal-source-manifest.mjs";
import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from "./linux-snapshot.mjs";

const OWNERSHIP_SCHEMA = 1;
const RECONCILED_SCHEMA = 1;
const ownershipRecordLimit = GOAL_LIMITS.journalRecordBytes;
const MECHANISM_PATTERN = /^[\x20-\x7e]{1,120}$/;

// Reconciliation mechanisms that may release an ownership block. A record is
// only trusted when it also binds the sha256 of the reviewed pidfd helper
// binary (see writeReconciledRecord and lib/goal-lease-probe.mjs), so the
// evidence is always tied to the reviewed verification mechanism.
const RECONCILED_MECHANISMS = new Set([
  "pidfd-teardown",
  "already-exited",
  "host-reboot",
  "gate-not-released",
]);

// A process group is not a containment boundary: a descendant can call
// setsid() and survive. Each ownership instance therefore gates dispatch and
// recovery on its configured pidfd helper (helperUsable) and refuses to
// certify a tree whose descendant walk shows a process-group escape.

/** Thrown when a caller enables a capability the goal workflow must refuse. */
export class GoalCommandUnsupportedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GoalCommandUnsupportedError";
    this.code = "goal-command-unsupported";
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nowMs = () => Date.now();
const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function defaultHome() {
  return process.env.MATRIX_HOME || join(homedir(), ".matrix");
}

function readFileTrimmed(path, limit = 4096) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(Math.min(limit, 4096));
    for (;;) {
      let count = 0;
      try {
        count = readSync(fd, buffer, 0, buffer.length, null);
      } catch {
        return null;
      }
      if (count <= 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      total += count;
      if (total >= limit) break;
    }
    if (total === 0) return null;
    const value = Buffer.concat(chunks, Math.min(total, limit)).toString("utf8").trim();
    return value.length > 0 && value.length <= limit ? value : null;
  } finally {
    closeSync(fd);
  }
}

/** @returns {string|null} */
function readBootId() {
  try {
    const value = readFileTrimmed("/proc/sys/kernel/random/boot_id", 128);
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** @returns {string|null} */
function readMachineId() {
  for (const candidate of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = readFileTrimmed(candidate, 128);
      if (value && /^[0-9a-f]{32}$/i.test(value)) return value.toLowerCase();
    } catch {
      // Try the next source.
    }
  }
  return null;
}

/** Parse /proc/<pid>/stat into the fields the ownership boundary needs. */
function procIdentity(pid) {
  let raw;
  try {
    raw = readFileTrimmed(`/proc/${pid}/stat`, 8192);
  } catch {
    return null;
  }
  if (!raw) return null;
  const rparen = raw.lastIndexOf(")");
  if (rparen < 0) return null;
  const rest = raw.slice(rparen + 2).split(" ");
  const state = rest[0];
  if (!/^[A-Za-z]$/.test(state ?? "")) return null;
  const pgrp = Number(rest[2]);
  const ppid = Number(rest[1]);
  const startTime = rest[19];
  if (!Number.isSafeInteger(pgrp) || pgrp < 0) return null;
  if (!Number.isSafeInteger(ppid) || ppid < 0) return null;
  if (!/^\d{1,32}$/.test(startTime ?? "")) return null;
  return { state, pgrp, ppid, startTime };
}

/** Read host boot id and machine id once per call; both are required. */
function hostIdentity() {
  const bootId = readBootId();
  const machineId = readMachineId();
  if (!bootId) throw new Error("goal ownership: the host boot id is unavailable");
  if (!machineId) {
    throw new Error("goal ownership: the host machine id is unavailable (/etc/machine-id)");
  }
  return { bootId, machineId };
}

/** Workspace identity (realpath + device/inode), matching the goal record rules. */
export function workspaceIdentityOf(root) {
  const real = realpathSync(root);
  const stat = statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error("goal ownership: workspace is not a directory");
  return { path: real, device: String(stat.dev), inode: String(stat.ino) };
}

function privateWriteJsonAtomic(directory, name, value) {
  const bytes = Buffer.from(canonicalJson(value, { maxBytes: ownershipRecordLimit }));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Best effort; the store pattern does the same.
  }
  const temp = join(
    directory,
    `.matrix-ownership-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("goal ownership: short write");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, join(directory, name));
  const dirFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return bytes;
}

function readPrivateJson(file, limit, detail) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
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
      throw new Error(`goal ownership: ${detail} is not a private regular file`);
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length !== stat.size) {
      throw new Error(`goal ownership: ${detail} changed while being read`);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
      );
    } catch {
      throw new Error(`goal ownership: ${detail} is not valid JSON`);
    }
  } finally {
    closeSync(fd);
  }
}

// ============================================================================
// Authority: decision broker bound to one attempt
// ============================================================================

const DECISION_AUDIT_TYPE = "goal:decision";
const GRANT_AUDIT_TYPE = "goal:grant";

function decisionId() {
  return `decision_${randomBytes(16).toString("hex")}`;
}

/** Fingerprint binding a pre-issued decision to one exact proposal. */
function grantKey(kind, parts) {
  return createHash("sha256")
    .update(canonicalJson([kind, ...parts]))
    .digest("hex");
}

function assertOperationBinding(binding, kind) {
  if (!isPlainObject(binding)) throw new Error("goal authority: invalid operation binding");
  const { goalId, attemptId, generation, operationId, path, planHash, contentSha256 } = binding;
  if (typeof goalId !== "string" || !/^goal_[a-f0-9]{32}$/.test(goalId)) {
    throw new Error("goal authority: invalid goal id in binding");
  }
  if (typeof attemptId !== "string" || !/^attempt_[a-f0-9]{32}$/.test(attemptId)) {
    throw new Error("goal authority: invalid attempt id in binding");
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("goal authority: invalid generation in binding");
  }
  if (typeof operationId !== "string" || !/^operation_[a-f0-9]{32}$/.test(operationId)) {
    throw new Error("goal authority: invalid operation id in binding");
  }
  if (planHash !== null && (typeof planHash !== "string" || !/^[a-f0-9]{64}$/.test(planHash))) {
    throw new Error("goal authority: invalid plan hash in binding");
  }
  if (kind === "edit") {
    if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
      throw new Error("goal authority: invalid path in binding");
    }
    if (typeof contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(contentSha256)) {
      throw new Error("goal authority: invalid content digest in binding");
    }
  }
}

function writeAudit(home, goalId, event) {
  return appendRunEvent(goalId, event, { home, requireComplete: true });
}

/**
 * Create the decision broker for one invocation.
 *
 * Authority is collected one step before dispatch, by the trusted engine
 * adapter, never inside the synchronous dispatch boundary (a human answer is
 * never available synchronously). The adapter registers an exact-operation
 * grant here after any user/headless decision; authorize*() then consumes it
 * one-shot inside the dispatch gate. A proposal with no pre-issued grant and
 * no invocation-scoped flag is denied — the gate never fabricates authority.
 *
 * Edit, test and command decisions are fully independent. `allowEdits`
 * mirrors standalone `--yes` (edit-only, this invocation); `allowTests`
 * mirrors `--allow-tests` (one exact plan per invocation). Flags and grants
 * expire with the invocation and are never replayed after a restart.
 */
export function createGoalAuthority({
  home = defaultHome(),
  headless = false,
  allowEdits = false,
  allowTests = false,
  workspace = null,
  origin = "model-or-automatic",
} = {}) {
  const workspaceIdentity = workspace
    ? { path: workspace.path, device: String(workspace.device), inode: String(workspace.inode) }
    : null;
  const state = {
    autoEdits: Boolean(allowEdits),
    autoTests: Boolean(allowTests),
    testPlanAllowance: null,
    // One-shot pre-issued decisions, keyed by exact proposal fingerprint.
    grants: new Map(),
  };

  let runtime = null;
  const grantScope = (goalId) => {
    if (!runtime) return null;
    if (!runtime.currentInvocation()) throw new Error("goal authority: stale invocation");
    if (goalId !== runtime.goalId) throw new Error("goal authority: grant targets another goal");
    const { goal, lease } = runtime.store.inspect(goalId);
    if (!lease || goal.state !== "running") {
      throw new Error("goal authority: grant requires a running attempt");
    }
    return { goal, attemptId: lease.attemptId, generation: goal.generation };
  };

  const audit = (type, kind, binding, decision, reason) =>
    writeAudit(home, binding.goalId, {
      type,
      kind,
      goalId: binding.goalId,
      attemptId: binding.attemptId ?? null,
      generation: binding.generation ?? null,
      operationId: binding.operationId ?? null,
      workspace: workspaceIdentity,
      path: kind === "edit" ? binding.path : null,
      contentSha256: kind === "edit" ? binding.contentSha256 : null,
      editAction: kind === "edit" ? binding.editAction : null,
      mode: kind === "edit" ? binding.mode : null,
      planHash: binding.planHash ?? null,
      origin,
      decision,
      reason: reason ?? null,
    });

  const denied = (binding, reason, kind) => {
    audit(DECISION_AUDIT_TYPE, kind, binding, "denied", reason);
    return null;
  };

  const granted = (binding, kind) => {
    const id = decisionId();
    if (!audit(DECISION_AUDIT_TYPE, kind, binding, "approved", null)) return null;
    return id;
  };

  function registerGrant(kind, key, goalId, decision, detail) {
    const approved = decision === "approved" || decision === true;
    state.grants.set(`${kind}:${key}`, { decision: approved ? "approved" : "denied", ...detail });
    const auditPath = writeAudit(home, goalId, {
      type: GRANT_AUDIT_TYPE,
      kind,
      goalId,
      operationId: null,
      attemptId: detail?.attemptId ?? null,
      generation: detail?.generation ?? null,
      workspace: workspaceIdentity,
      path: detail?.path ?? null,
      contentSha256: detail?.contentSha256 ?? null,
      editAction: detail?.editAction ?? null,
      mode: detail?.mode ?? null,
      planHash: detail?.planHash ?? null,
      origin,
      decision: approved ? "approved" : "denied",
      reason: null,
    });
    if (!auditPath) {
      state.grants.delete(`${kind}:${key}`);
      throw new Error(
        "goal authority: the grant audit could not be persisted; no authority was issued",
      );
    }
    return approved;
  }

  function consumeGrant(kind, key, binding) {
    const value = state.grants.get(`${kind}:${key}`);
    if (value === undefined) return null;
    state.grants.delete(`${kind}:${key}`);
    if (
      runtime &&
      (value.attemptId !== binding.attemptId ||
        value.generation !== binding.generation ||
        value.planHash !== binding.planHash)
    )
      return "denied";
    return value.decision;
  }

  function authorize(kind, binding, key) {
    if (kind === "command") {
      throw new GoalCommandUnsupportedError(
        "the durable goal workflow does not support run_sandboxed_command or any command tool; " +
          "existing standalone command behavior is unchanged",
      );
    }
    assertOperationBinding(binding, kind);

    // An exact pre-issued decision always wins over invocation flags.
    const preissued = consumeGrant(kind, key, binding);
    if (preissued === "approved") return granted(binding, kind);
    if (preissued === "denied") return denied(binding, "denied by the pre-issued decision", kind);

    if (kind === "test" && state.autoTests && state.testPlanAllowance === null) {
      state.testPlanAllowance = binding.planHash;
    }
    if (
      kind === "test" &&
      state.testPlanAllowance !== null &&
      state.testPlanAllowance !== binding.planHash
    ) {
      return denied(
        binding,
        "the dedicated test allowance covers one exact plan per invocation",
        kind,
      );
    }
    if (kind === "test" && state.testPlanAllowance === binding.planHash) {
      state.testPlanAllowance = "spent";
      return granted(binding, kind);
    }
    if (kind === "edit" && state.autoEdits) {
      return granted(binding, kind);
    }
    return denied(
      binding,
      headless
        ? kind === "edit"
          ? "no grant was pre-issued for this exact edit and this invocation has no edit allowance"
          : "no grant was pre-issued for this exact test plan and no dedicated allowance is active"
        : `no decision was pre-issued for this exact ${kind}; the trusted adapter must collect one first`,
      kind,
    );
  }

  return {
    /**
     * Pre-issue one exact decision. Called by the trusted engine adapter
     * after the user (or headless policy) decides on an exact proposal; the
     * grant is consumed once inside the dispatch gate. Throws when the audit
     * cannot be persisted (fail closed, nothing granted).
     */
    registerEditGrant: ({ path, content, mode = null, approved, goalId }) => {
      if (typeof path !== "string" || path.length === 0 || path.length > 1024) {
        throw new Error("goal authority: invalid grant path");
      }
      if (typeof content !== "string" && content !== null) {
        throw new Error("goal authority: grant content must be a string or null");
      }
      if (typeof goalId !== "string" || !/^goal_[a-f0-9]{32}$/.test(goalId)) {
        throw new Error("goal authority: invalid goal id in grant");
      }
      if (mode !== null && (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777)) {
        throw new Error("goal authority: invalid edit mode in grant");
      }
      const contentSha256 = sha256(Buffer.from(content ?? "", "utf8"));
      const key = grantKey("edit", [
        goalId,
        path,
        content === null ? "delete" : "write",
        contentSha256,
        mode,
      ]);
      const scope = grantScope(goalId);
      const planHash = scope
        ? prepareEditOperation({
            ...scope,
            path,
            content,
            mode,
            workspaceRoot: runtime.root,
          }).planHash
        : null;
      return registerGrant("edit", key, goalId, approved, {
        path,
        contentSha256,
        editAction: content === null ? "delete" : "write",
        mode,
        planHash,
        attemptId: scope?.attemptId,
        generation: scope?.generation,
      });
    },
    /** Pre-issue one exact test-plan decision. */
    registerTestGrant: ({ planHash, approved, goalId }) => {
      if (typeof planHash !== "string" || !/^[a-f0-9]{64}$/.test(planHash)) {
        throw new Error("goal authority: invalid test plan hash in grant");
      }
      if (typeof goalId !== "string" || !/^goal_[a-f0-9]{32}$/.test(goalId)) {
        throw new Error("goal authority: invalid goal id in grant");
      }
      const key = grantKey("test", [goalId, planHash]);
      const scope = grantScope(goalId);
      return registerGrant("test", key, goalId, approved, {
        planHash,
        attemptId: scope?.attemptId,
        generation: scope?.generation,
      });
    },
    /** Authorize one edit operation; returns a decisionId or null (denied). */
    authorizeEdit: ({ path, content, mode = null, planHash, intent, goal }) => {
      const contentSha256 = sha256(Buffer.from(content ?? "", "utf8"));
      return authorize(
        "edit",
        {
          goalId: goal?.id,
          attemptId: intent?.attemptId,
          generation: intent?.generation,
          operationId: intent?.operationId,
          planHash,
          path,
          contentSha256,
          editAction: content === null ? "delete" : "write",
          mode,
        },
        grantKey("edit", [
          goal?.id,
          path,
          content === null ? "delete" : "write",
          contentSha256,
          mode,
        ]),
      );
    },
    /** Authorize one exact test plan; returns a decisionId or null (denied). */
    authorizeTest: ({ planHash, intent, goal }) =>
      authorize(
        "test",
        {
          goalId: goal?.id,
          attemptId: intent?.attemptId,
          generation: intent?.generation,
          operationId: intent?.operationId,
          planHash,
          path: null,
          contentSha256: null,
        },
        grantKey("test", [goal?.id, planHash]),
      ),
    /** Always refuses: the goal workflow exposes no command capability. */
    authorizeCommand: () => {
      throw new GoalCommandUnsupportedError(
        "the durable goal workflow does not support run_sandboxed_command or any command tool",
      );
    },
    bindRuntime(binding) {
      if (runtime) throw new Error("goal authority: already bound to a runtime");
      state.grants.clear();
      runtime = binding;
    },
    finishAttempt() {
      state.grants.clear();
      state.autoEdits = false;
      state.autoTests = false;
      state.testPlanAllowance = null;
    },
    /** Introspection for tests and doctor; exposes no authority. */
    inspect: () => ({
      autoEdits: state.autoEdits,
      testPlanAllowance: state.testPlanAllowance,
      pendingGrants: state.grants.size,
    }),
  };
}

// ============================================================================
// Execution ownership: record, verify, reconcile
// ============================================================================

const HELPER_NAME = "matrix-pidfd-helper";

function ownershipDirs(home) {
  const base = join(home, "ownership");
  return { ownershipDir: base, reconciledDir: join(base, "reconciled") };
}

function operationRecordName(operationId) {
  if (typeof operationId !== "string" || !/^operation_[a-f0-9]{32}$/.test(operationId)) {
    throw new Error("goal ownership: invalid operation id");
  }
  return `${operationId}.json`;
}

/** Default helper location: built per machine into MATRIX_HOME by the build script. */
export function defaultOwnershipHelperPath(home = defaultHome()) {
  return join(home, "bin", HELPER_NAME);
}

/** Run the helper; returns { status, stdout, stderr } and never throws. */
function runHelper(helperPath, args, timeoutMs = 10_000) {
  try {
    const result = spawnSync(helperPath, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch {
    return { status: -1, stdout: "", stderr: "helper could not be executed" };
  }
}

const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";
const NAMESPACE_INODE = /^[0-9]{1,20}$/;

/** Block the current thread briefly without a timer (the ownership path is synchronous). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Host PID-namespace inode for a pid, or null when it cannot be read. */
function readNamespaceInode(pid) {
  try {
    const link = readlinkSync(`/proc/${pid}/ns/pid`);
    const match = /^pid:\[(\d+)\]$/.exec(link);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** True only when the process is namespace PID 1 (NSpid's last field is 1). */
function namespacePidIsInit(pid) {
  const status = readFileTrimmed(`/proc/${pid}/status`, 16_384);
  if (!status) return false;
  const match = /^NSpid:\s*(.+)$/m.exec(status);
  if (!match) return false;
  const ids = match[1].trim().split(/\s+/);
  return ids.length >= 2 && ids[ids.length - 1] === "1";
}

function validProcessRef(value, label) {
  if (
    !isPlainObject(value) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.startTime !== "string" ||
    !/^[0-9]{1,32}$/.test(value.startTime)
  ) {
    throw new Error(`goal ownership: invalid ${label}`);
  }
  return { pid: value.pid, startTime: value.startTime };
}

function normalizeNamespace(value, label, { requireStart = false } = {}) {
  if (!isPlainObject(value)) throw new Error(`goal ownership: invalid ${label}`);
  const start = value.initStartTime;
  const validStart =
    (typeof start === "string" && /^[0-9]{1,32}$/.test(start)) || (!requireStart && start === null);
  if (
    !Number.isSafeInteger(value.initPid) ||
    value.initPid < 1 ||
    typeof value.inode !== "string" ||
    !NAMESPACE_INODE.test(value.inode) ||
    !validStart
  ) {
    throw new Error(`goal ownership: invalid ${label}`);
  }
  return { initPid: value.initPid, initStartTime: start, inode: value.inode };
}

function normalizeContainment(value) {
  if (!isPlainObject(value) || value.kind !== "pid-namespace") {
    throw new Error("goal ownership: invalid containment record");
  }
  const namespace = normalizeNamespace(value.namespace, "containment namespace", {
    requireStart: true,
  });
  const monitor = validProcessRef(value.monitor, "containment monitor");
  const init = validProcessRef(value.init, "containment init");
  if (init.pid !== namespace.initPid || init.startTime !== namespace.initStartTime) {
    throw new Error("goal ownership: containment init does not match the namespace");
  }
  return { kind: "pid-namespace", namespace, monitor, init };
}

/** Prove the pinned monitor and namespace init still have the recorded identity. */
function verifyContainmentIdentity(value) {
  const containment = normalizeContainment(value);
  const monitor = procIdentity(containment.monitor.pid);
  if (!monitor || monitor.state === "Z" || monitor.startTime !== containment.monitor.startTime) {
    throw new Error("goal ownership: the containment monitor identity changed");
  }
  const init = procIdentity(containment.init.pid);
  if (!init || init.state === "Z" || init.startTime !== containment.init.startTime) {
    throw new Error("goal ownership: the namespace init identity changed");
  }
  if (init.ppid !== containment.monitor.pid) {
    throw new Error("goal ownership: the namespace init is no longer a child of the monitor");
  }
  if (readNamespaceInode(containment.init.pid) !== containment.namespace.inode) {
    throw new Error("goal ownership: the namespace init left the recorded PID namespace");
  }
  if (!namespacePidIsInit(containment.init.pid)) {
    throw new Error("goal ownership: the recorded namespace init is not namespace PID 1");
  }
  return containment;
}

/**
 * Enumerate live (non-zombie) members of one host PID namespace. Returns null
 * when /proc cannot be enumerated. Zombies cannot run again and are omitted.
 */
function namespaceMembers(inode) {
  let names;
  try {
    names = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  } catch {
    return null;
  }
  const members = [];
  for (const name of names) {
    const pid = Number(name);
    if (pid === process.pid) continue;
    if (readNamespaceInode(pid) !== inode) continue;
    const identity = procIdentity(pid);
    if (!identity || identity.state === "Z") continue;
    members.push({ pid, identity });
  }
  members.sort((a, b) => a.pid - b.pid);
  return members;
}

/** True only when a real PID-namespace probe succeeds under this Bubblewrap binary. */
function probeBwrap(bwrapPath) {
  if (typeof bwrapPath !== "string" || !existsSync(bwrapPath)) {
    return { ok: false, reason: "bubblewrap is not installed" };
  }
  try {
    const result = spawnSync(
      bwrapPath,
      [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--chdir",
        "/tmp",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.error) return { ok: false, reason: result.error.message };
    if (result.status !== 0) {
      return {
        ok: false,
        reason: (result.stderr || result.stdout || `exit ${result.status}`).trim().slice(0, 160),
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The trusted process-ownership boundary. Installed via createExecutionOwnership;
 * the returned object is passed to the executor as `executionOwnership` and is
 * never exposed to the model or to goal text.
 */
export function createExecutionOwnership({
  home = defaultHome(),
  helperPath = null,
  bwrapPath = null,
  verificationTimeoutMs = 5_000,
} = {}) {
  const helper = helperPath ?? defaultOwnershipHelperPath(home);
  const bwrap = bwrapPath ?? process.env.MATRIX_BWRAP ?? DEFAULT_BWRAP_PATH;
  const { ownershipDir, reconciledDir } = ownershipDirs(home);
  let bwrapProbe = null;

  function bwrapUsable() {
    if (bwrapProbe === null) bwrapProbe = probeBwrap(bwrap);
    return bwrapProbe.ok;
  }

  function stageDispatch({ operationId, goalId, attemptId, generation, workspaceRoot }) {
    const name = operationRecordName(operationId);
    if (readOwnershipRecord(operationId)) {
      throw new Error("goal ownership: dispatch already has ownership state");
    }
    const owner = procIdentity(process.pid);
    if (!owner) throw new Error("goal ownership: cannot identify the launch owner");
    const record = {
      schemaVersion: OWNERSHIP_SCHEMA,
      operationId,
      goalId,
      attemptId,
      generation,
      kind: "test",
      ...hostIdentity(),
      pid: process.pid,
      pgid: owner.pgrp,
      startTime: owner.startTime,
      startedAt: nowMs(),
      workspace: workspaceIdentityOf(workspaceRoot),
      gatePending: true,
    };
    privateWriteJsonAtomic(ownershipDir, name, record);
  }

  function recordDispatch(input) {
    if (!isPlainObject(input)) throw new Error("goal ownership: dispatch record required");
    const {
      operationId,
      goalId,
      attemptId,
      generation,
      kind = "test",
      planHash = null,
      pid,
      pgid = null,
      guardian = null,
      namespace = null,
      containment = null,
      workspaceRoot,
    } = input;
    validateGoalId(operationId, "operation");
    validateGoalId(goalId, "goal");
    validateGoalId(attemptId, "attempt");
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("goal ownership: invalid generation");
    }
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("goal ownership: invalid pid");
    }
    const normalizedContainment =
      containment === null ? null : verifyContainmentIdentity(containment);
    if (normalizedContainment !== null && normalizedContainment.monitor.pid !== pid) {
      throw new Error("goal ownership: containment monitor does not match the spawned process");
    }
    const guardianValue = normalizedContainment?.monitor ?? guardian;
    const namespaceValue = normalizedContainment?.namespace ?? namespace;
    const workspace = workspaceIdentityOf(workspaceRoot);
    const identity = procIdentity(pid);
    if (!identity) {
      throw new Error("goal ownership: spawned process is not inspectable under /proc");
    }
    const observedPgid = identity.pgrp;
    if (pgid !== null && pgid !== observedPgid) {
      throw new Error("goal ownership: recorded pgid does not match /proc");
    }
    if (guardianValue !== null) {
      if (
        !isPlainObject(guardianValue) ||
        !Number.isSafeInteger(guardianValue.pid) ||
        guardianValue.pid < 1 ||
        guardianValue.pid !== pid ||
        typeof guardianValue.startTime !== "string" ||
        !/^[0-9]{1,32}$/.test(guardianValue.startTime) ||
        guardianValue.startTime !== identity.startTime
      ) {
        throw new Error("goal ownership: guardian identity does not match the spawned process");
      }
    }
    if (namespaceValue !== null) {
      const normalizedNamespace = normalizeNamespace(namespaceValue, "PID-namespace identity");
      if (normalizedNamespace.initStartTime !== null) {
        const init = procIdentity(normalizedNamespace.initPid);
        if (!init || init.startTime !== normalizedNamespace.initStartTime) {
          throw new Error("goal ownership: namespace init identity does not match /proc");
        }
        if (readNamespaceInode(normalizedNamespace.initPid) !== normalizedNamespace.inode) {
          throw new Error("goal ownership: namespace init is not in the recorded PID namespace");
        }
        if (!namespacePidIsInit(normalizedNamespace.initPid)) {
          throw new Error("goal ownership: recorded namespace init is not namespace PID 1");
        }
      }
    }
    const { bootId, machineId } = hostIdentity();
    const record = {
      schemaVersion: OWNERSHIP_SCHEMA,
      operationId,
      goalId,
      attemptId,
      generation,
      kind,
      planHash,
      bootId,
      machineId,
      pid,
      pgid: observedPgid,
      startTime: identity.startTime,
      startedAt: nowMs(),
      workspace,
    };
    if (guardianValue !== null) record.guardian = guardianValue;
    if (namespaceValue !== null) {
      record.namespace = normalizeNamespace(namespaceValue, "PID-namespace identity");
    }
    if (normalizedContainment !== null) record.containment = normalizedContainment;
    privateWriteJsonAtomic(ownershipDir, `${operationId}.json`, record);
    return record;
  }

  function readOwnershipRecord(operationId) {
    const record = readPrivateJson(
      join(ownershipDir, operationRecordName(operationId)),
      ownershipRecordLimit,
      `ownership record ${operationId}`,
    );
    if (record === null) return null;
    if (
      record.schemaVersion !== OWNERSHIP_SCHEMA ||
      record.operationId !== operationId ||
      typeof record.bootId !== "string" ||
      typeof record.machineId !== "string" ||
      typeof record.startTime !== "string" ||
      !/^[0-9]{1,32}$/.test(record.startTime) ||
      !Number.isSafeInteger(record.pid) ||
      !Number.isSafeInteger(record.pgid) ||
      !isPlainObject(record.workspace)
    ) {
      throw new Error(`goal ownership: ownership record ${operationId} is invalid`);
    }
    if (record.guardian !== undefined && record.guardian !== null) {
      try {
        validProcessRef(record.guardian, "guardian");
      } catch {
        throw new Error(`goal ownership: ownership record ${operationId} has an invalid guardian`);
      }
    }
    let namespace = null;
    if (record.namespace !== undefined && record.namespace !== null) {
      try {
        namespace = normalizeNamespace(record.namespace, "namespace");
      } catch {
        throw new Error(`goal ownership: ownership record ${operationId} has an invalid namespace`);
      }
    }
    if (record.containment !== undefined && record.containment !== null) {
      let containment;
      try {
        containment = normalizeContainment(record.containment);
      } catch {
        throw new Error(
          `goal ownership: ownership record ${operationId} has an invalid containment record`,
        );
      }
      if (
        containment.monitor.pid !== record.pid ||
        containment.monitor.startTime !== record.startTime
      ) {
        throw new Error(
          `goal ownership: ownership record ${operationId} does not bind the monitor`,
        );
      }
      if (
        namespace !== null &&
        (namespace.initPid !== containment.namespace.initPid ||
          namespace.initStartTime !== containment.namespace.initStartTime ||
          namespace.inode !== containment.namespace.inode)
      ) {
        throw new Error(
          `goal ownership: ownership record ${operationId} has inconsistent containment identity`,
        );
      }
      if (
        record.guardian !== undefined &&
        record.guardian !== null &&
        (record.guardian.pid !== containment.monitor.pid ||
          record.guardian.startTime !== containment.monitor.startTime)
      ) {
        throw new Error(
          `goal ownership: ownership record ${operationId} has inconsistent monitor identity`,
        );
      }
    }
    return record;
  }

  function readReconciledRecord(operationId) {
    const record = readPrivateJson(
      join(reconciledDir, operationRecordName(operationId)),
      ownershipRecordLimit,
      `reconciliation record ${operationId}`,
    );
    if (record === null) return null;
    if (
      record.schemaVersion !== RECONCILED_SCHEMA ||
      record.operationId !== operationId ||
      typeof record.mechanism !== "string" ||
      !MECHANISM_PATTERN.test(record.mechanism) ||
      !Number.isSafeInteger(record.verifiedAt) ||
      !isPlainObject(record.workspace)
    ) {
      throw new Error(`goal ownership: reconciliation record ${operationId} is invalid`);
    }
    if (record.containment !== undefined && record.containment !== null) {
      try {
        normalizeContainment(record.containment);
      } catch {
        throw new Error(
          `goal ownership: reconciliation record ${operationId} has invalid containment`,
        );
      }
    }
    return record;
  }

  function helperUsable() {
    if (!helperSha256()) return false;
    const probe = runHelper(helper, ["probe"], 5_000);
    if (probe.status !== 0) return false;
    try {
      const parsed = JSON.parse(probe.stdout.trim());
      return parsed?.ok === true && parsed?.pidfd === true;
    } catch {
      return false;
    }
  }

  /** Both the reviewed pidfd helper and a real PID-namespace probe must work. */
  function containmentUsable() {
    return helperUsable() && bwrapUsable();
  }

  /**
   * sha256 of the configured helper binary, or null when it cannot be read.
   * Reconciliation records carry this digest so later invocations (and the
   * lease probe) bind their trust to this exact reviewed binary.
   */
  function helperSha256() {
    if (!helper) return null;
    let stat;
    try {
      const parent = lstatSync(dirname(helper));
      if (!parent.isDirectory() || (parent.mode & 0o022) !== 0) return null;
      stat = lstatSync(helper);
    } catch {
      return null;
    }
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      (stat.uid !== process.getuid?.() && stat.uid !== 0)
    )
      return null;
    try {
      return sha256(readFileSync(helper));
    } catch {
      return null;
    }
  }

  /**
   * Verify and stop a record that owns a Linux PID namespace. Killing namespace
   * PID 1 makes the kernel stop every remaining task in that namespace,
   * including descendants that called setsid() and left the recorded process
   * group. Each signal still goes through the pidfd helper after boot id and
   * start time verification; a reused PID is never signalled.
   */
  function teardownNamespace({ bootId, namespace, monitor }) {
    const inode = namespace.inode;
    const tree = [];
    const recorded = new Set();
    let signals = 0;
    const note = (pid, startTime, disposition) => {
      const key = `${pid}:${startTime}`;
      if (recorded.has(key)) return;
      recorded.add(key);
      tree.push({ pid, startTime, disposition });
    };

    const initIdentity = procIdentity(namespace.initPid);
    const initMatches =
      Boolean(initIdentity) &&
      namespace.initStartTime !== null &&
      initIdentity.startTime === namespace.initStartTime &&
      readNamespaceInode(namespace.initPid) === inode &&
      namespacePidIsInit(namespace.initPid);
    if (initIdentity && namespace.initStartTime !== null && !initMatches) {
      // The recorded init is gone and its pid now belongs to another task.
      // The current occupant must never be signalled.
      note(namespace.initPid, initIdentity.startTime, "identity-mismatch");
    }

    const initialMembers = namespaceMembers(inode);
    if (initialMembers === null) {
      return { ok: false, reason: "proc-unreadable", detail: "/proc could not be enumerated" };
    }
    if (
      (initialMembers.length > 0 || (initMatches && initIdentity.state !== "Z")) &&
      !helperUsable()
    ) {
      return {
        ok: false,
        reason: "ownership-helper-unavailable",
        detail:
          "the pidfd ownership helper is unavailable or failed; no process was signalled and teardown stays unverified",
      };
    }

    if (initMatches && initIdentity.state !== "Z") {
      const kill = runHelper(
        helper,
        [
          "kill",
          "--pid",
          String(namespace.initPid),
          "--boot-id",
          bootId,
          "--start-time",
          namespace.initStartTime,
          "--sig",
          "9",
          "--wait-ms",
          String(verificationTimeoutMs),
        ],
        verificationTimeoutMs + 5_000,
      );
      if (kill.status === 0) {
        signals += 1;
        note(namespace.initPid, namespace.initStartTime, "signalled-and-exited");
      } else if (kill.status === 3) {
        note(namespace.initPid, namespace.initStartTime, "identity-mismatch");
      } else if (kill.status === 4) {
        note(namespace.initPid, namespace.initStartTime, "already-gone");
      } else {
        return {
          ok: false,
          reason: "namespace-init-refused-to-exit",
          detail: `namespace init ${namespace.initPid} did not exit after SIGKILL (exit ${kill.status})`,
        };
      }
    }

    // Kernel teardown is asynchronous. Never signal a process found solely
    // by a namespace inode: the old namespace may have exited and its inode
    // may have been reused. Only the recorded init and monitor may be signalled.
    const deadline = Date.now() + verificationTimeoutMs;
    for (;;) {
      const members = namespaceMembers(inode);
      if (members === null) {
        return { ok: false, reason: "proc-unreadable", detail: "/proc could not be enumerated" };
      }
      if (members.length === 0) break;
      if (!initMatches || Date.now() > deadline) {
        return {
          ok: false,
          reason: "namespace-member-survived",
          detail: "the recorded PID namespace cannot be proven empty",
        };
      }
      sleepSync(20);
    }

    // The Bubblewrap monitor should exit once its namespace init is gone. If a
    // matching monitor survives, stop it through the same verified helper.
    const guardian = monitor;
    const guardianIdentity = procIdentity(guardian.pid);
    if (
      guardianIdentity &&
      guardianIdentity.startTime === guardian.startTime &&
      guardianIdentity.state !== "Z"
    ) {
      if (!helperUsable()) {
        return {
          ok: false,
          reason: "ownership-helper-unavailable",
          detail: "the Bubblewrap monitor is still alive and the pidfd helper is unavailable",
        };
      }
      const kill = runHelper(
        helper,
        [
          "kill",
          "--pid",
          String(guardian.pid),
          "--boot-id",
          bootId,
          "--start-time",
          guardian.startTime,
          "--sig",
          "9",
          "--wait-ms",
          String(verificationTimeoutMs),
        ],
        verificationTimeoutMs + 5_000,
      );
      if (kill.status === 0) {
        signals += 1;
        note(guardian.pid, guardian.startTime, "signalled-and-exited");
      } else if (kill.status === 3) {
        note(guardian.pid, guardian.startTime, "identity-mismatch");
      } else if (kill.status === 4) {
        note(guardian.pid, guardian.startTime, "already-gone");
      } else {
        return {
          ok: false,
          reason: "guardian-refused-to-exit",
          detail: `Bubblewrap monitor ${guardian.pid} did not exit after SIGKILL (exit ${kill.status})`,
        };
      }
    } else if (guardianIdentity && guardianIdentity.startTime !== guardian.startTime) {
      note(guardian.pid, guardianIdentity.startTime, "identity-mismatch");
    }

    const remaining = namespaceMembers(inode);
    if (remaining === null) {
      return { ok: false, reason: "proc-unreadable", detail: "/proc could not be enumerated" };
    }
    if (remaining.length > 0) {
      return {
        ok: false,
        reason: "namespace-member-survived",
        detail: "the recorded PID namespace still has live members after teardown",
      };
    }
    return { ok: true, mechanism: signals > 0 ? "pidfd-teardown" : "already-exited", tree };
  }

  function writeReconciledRecord(record, tree, mechanism) {
    const value = {
      schemaVersion: RECONCILED_SCHEMA,
      operationId: record.operationId,
      goalId: record.goalId,
      attemptId: record.attemptId,
      generation: record.generation,
      mechanism,
      verifiedAt: nowMs(),
      helperSha256: helperSha256(),
      bootId: record.bootId,
      machineId: record.machineId,
      pid: record.pid,
      startTime: record.startTime,
      guardian: record.guardian ?? null,
      namespace: record.namespace ?? null,
      containment: record.containment ?? null,
      gatePending: record.gatePending === true,
      workspace: record.workspace,
      tree,
    };
    mkdirSync(reconciledDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(reconciledDir, 0o700);
    } catch {
      // Best effort.
    }
    return privateWriteJsonAtomic(reconciledDir, `${record.operationId}.json`, value);
  }

  function attestOperation(op, mechanism, ownership) {
    return {
      operationId: op.operationId,
      attemptId: op.attemptId,
      generation: op.generation,
      mechanism,
      ownership: { pid: ownership.pid, startTime: ownership.startTime, bootId: ownership.bootId },
    };
  }

  /**
   * Pin the exact namespace identity before repository code runs. The monitor
   * is the host-side Bubblewrap process; init is the namespace PID 1 reaper.
   * Both start times and the namespace inode are recorded.
   */
  function pinContainment({ monitorPid, initPid }) {
    if (!Number.isSafeInteger(monitorPid) || monitorPid < 1) {
      throw new Error("goal ownership: invalid containment monitor pid");
    }
    if (!Number.isSafeInteger(initPid) || initPid < 1) {
      throw new Error("goal ownership: invalid namespace init pid");
    }
    if (!containmentUsable()) {
      throw new Error(
        "goal ownership: the reviewed pidfd helper and Bubblewrap PID namespace are required",
      );
    }
    const monitor = procIdentity(monitorPid);
    if (!monitor) throw new Error("goal ownership: the containment monitor is not inspectable");
    const init = procIdentity(initPid);
    if (!init) throw new Error("goal ownership: the namespace init is not inspectable");
    const inode = readNamespaceInode(initPid);
    if (inode === null) throw new Error("goal ownership: the PID namespace identity is unreadable");
    const containment = {
      kind: "pid-namespace",
      namespace: { initPid, initStartTime: init.startTime, inode },
      monitor: { pid: monitorPid, startTime: monitor.startTime },
      init: { pid: initPid, startTime: init.startTime },
    };
    return verifyContainmentIdentity(containment);
  }

  /** Refuse to release the dispatch gate if the pinned identity changed. */
  function assertContainmentIdentity(containment) {
    return verifyContainmentIdentity(containment);
  }

  /**
   * Stop a namespace that has no persisted ownership record yet (a pin or
   * record-write failure before the gate is released). The exact identity is
   * still checked through the reviewed helper before any signal.
   */
  function teardownContainment(containment) {
    let value;
    try {
      value = normalizeContainment(containment);
    } catch (error) {
      return {
        ok: false,
        reason: "invalid-containment",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    let bootId;
    try {
      ({ bootId } = hostIdentity());
    } catch (error) {
      return {
        ok: false,
        reason: "host-identity-unavailable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return teardownNamespace({
      bootId,
      namespace: value.namespace,
      monitor: value.monitor,
    });
  }

  /**
   * Prove and persist teardown for one recorded operation. The reconciliation
   * record is only written after the exact namespace (or legacy process group)
   * is verified empty; a write failure keeps the operation blocked.
   */
  function settleOperation(record) {
    if (!isPlainObject(record)) {
      return { ok: false, reason: "invalid-record", detail: "malformed ownership record" };
    }
    const { bootId, machineId } = hostIdentity();
    let result;
    if (machineId !== record.machineId) {
      return { ok: false, reason: "host-identity-mismatch" };
    }
    if (record.gatePending === true && !record.containment && !record.namespace) {
      // The host replaces this marker with the pinned identity before opening
      // the gate. Recovery of a stopped attempt may therefore settle it
      // without claiming that any repository process was run or observed.
      result = { ok: true, mechanism: "gate-not-released", tree: [] };
    } else if (!record.containment) {
      return { ok: false, reason: "containment-unverified" };
    } else if (bootId !== record.bootId) {
      result = { ok: true, mechanism: "host-reboot", tree: [] };
    } else {
      const { namespace, monitor } = normalizeContainment(record.containment);
      result = teardownNamespace({ bootId, namespace, monitor });
    }
    if (!result.ok) return result;
    try {
      writeReconciledRecord(record, result.tree ?? [], result.mechanism);
    } catch (error) {
      return {
        ok: false,
        reason: "reconciliation-persistence-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return { ok: true, mechanism: result.mechanism, tree: result.tree ?? [] };
  }

  function settleClosedGate(operationId, attemptId) {
    const record = readOwnershipRecord(operationId);
    if (record?.gatePending === true && record.attemptId === attemptId) {
      return settleOperation(record);
    }
    return null;
  }

  /**
   * Executor-facing boundary: verify every blocked operation's owned tree is
   * gone, releasing (or refusing) the durable teardown block. On success this
   * persists a reconciliation record per operation for later invocations.
   * Returns the attestation object the executor accepts, or { verified: false }.
   */
  function verifyTeardown(block) {
    if (!isPlainObject(block) || !Array.isArray(block.operations)) {
      return { verified: false, reason: "invalid-block", detail: "malformed teardown block" };
    }
    const goalId = block.goalId;
    const workspace = block.workspace;
    const operations = [];
    const auditOperations = [];
    for (const op of block.operations) {
      if (!isPlainObject(op) || typeof op.operationId !== "string") {
        return { verified: false, reason: "invalid-block", detail: "malformed operation entry" };
      }
      const record = readOwnershipRecord(op.operationId);
      if (!record) {
        return { verified: false, reason: "ownership-record-missing" };
      }
      if (
        record.attemptId !== op.attemptId ||
        record.generation !== op.generation ||
        record.goalId !== (op.goalId ?? goalId)
      ) {
        return { verified: false, reason: "ownership-mismatch" };
      }
      const recorded = record.workspace;
      if (
        !workspace ||
        (recorded.path !== workspace.path &&
          (recorded.device !== workspace.device || recorded.inode !== workspace.inode))
      ) {
        return { verified: false, reason: "ownership-workspace-mismatch" };
      }
      if (
        op.workspace &&
        (recorded.device !== op.workspace.device || recorded.inode !== op.workspace.inode)
      ) {
        return { verified: false, reason: "ownership-workspace-mismatch" };
      }
      if (record.machineId !== hostIdentity().machineId) {
        return { verified: false, reason: "host-identity-mismatch" };
      }
      if (op.workspace && createGoalStore(home).inspect(record.goalId).lease) {
        return { verified: false, reason: "active-attempt" };
      }
      if (!record.gatePending && !helperUsable()) {
        return { verified: false, reason: "containment-unverified" };
      }
      const reconciled = readReconciledRecord(op.operationId);
      if (reconciled) {
        const sameBoundary =
          record.gatePending === true
            ? reconciled.gatePending === true &&
              reconciled.mechanism === "gate-not-released" &&
              !record.containment &&
              !record.namespace &&
              !reconciled.containment &&
              !reconciled.namespace
            : record.containment &&
              reconciled.containment &&
              reconciled.mechanism !== "gate-not-released" &&
              canonicalJson(normalizeContainment(record.containment)) ===
                canonicalJson(normalizeContainment(reconciled.containment));
        if (
          !sameBoundary ||
          reconciled.goalId !== record.goalId ||
          reconciled.attemptId !== record.attemptId ||
          reconciled.generation !== record.generation ||
          reconciled.pid !== record.pid ||
          reconciled.startTime !== record.startTime ||
          reconciled.bootId !== record.bootId ||
          reconciled.machineId !== record.machineId ||
          canonicalJson(reconciled.workspace) !== canonicalJson(recorded) ||
          !RECONCILED_MECHANISMS.has(reconciled.mechanism) ||
          reconciled.helperSha256 !== helperSha256()
        ) {
          return { verified: false, reason: "reconciliation-mismatch" };
        }
        operations.push(attestOperation(op, reconciled.mechanism, record));
        auditOperations.push({
          operationId: op.operationId,
          mechanism: reconciled.mechanism,
          reused: true,
        });
        continue;
      }
      const settled = settleOperation(record);
      if (!settled.ok) {
        return {
          verified: false,
          reason: settled.reason,
          detail: settled.detail,
          operationId: op.operationId,
        };
      }
      operations.push(attestOperation(op, settled.mechanism, record));
      auditOperations.push({
        operationId: op.operationId,
        mechanism: settled.mechanism,
        reused: false,
      });
    }
    // Best-effort evidence for later invocations and auditors. This is
    // evidence, not authority; failure here does not weaken verification.
    try {
      appendRunEvent(
        block.goalId,
        {
          type: "goal:ownership-verified",
          goalId: block.goalId,
          operationCount: operations.length,
          operations: auditOperations,
        },
        { home, requireComplete: false },
      );
    } catch {
      // Evidence must not flip a verified teardown into an unverified one.
    }
    return { verified: true, goalId, operations };
  }

  return {
    stageDispatch,
    settleClosedGate,
    recordDispatch,
    pinContainment,
    assertContainmentIdentity,
    teardownContainment,
    settleOperation,
    verifyTeardown,
    helperUsable,
    helperSha256,
    helperPath: helper,
    bwrapPath: bwrap,
    containmentUsable,
    ownershipDir,
    reconciledDir,
  };
}

// ============================================================================
// Reclaim an abandoned attempt after verified owner death
// ============================================================================

/**
 * Release the lease of an attempt whose owner is verifiably dead. The owner
 * is verified with the reviewed identity rules (boot id, pid, start time);
 * a host/boot mismatch refuses without touching anything. Reclaim clears
 * the lease and marks the attempt interrupted; it never grants authority,
 * never retries operations and never releases a teardown block — an
 * unverified surviving execution still blocks every resume.
 *
 * @param {{ home?: string, goalId: string, workspace: string }} input
 */
export function reclaimStaleGoalAttempt({ home = defaultHome(), goalId, workspace }) {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("goal reclaim: workspace path is required");
  }
  validateGoalId(goalId);
  const root = realpathSync(workspace);
  const store = createGoalStore(home);
  const inspected = store.inspect(goalId);
  if (!inspected.lease) {
    return { reclaimed: false, reason: "no-active-lease", goalId };
  }
  const lease = inspected.lease;
  // Boot mismatch is never reclaimable from here: without a matching boot id
  // we cannot exclude a different host (shared home) that may still run it.
  const bootId = readBootId();
  if (!bootId) throw new Error("goal reclaim: the host boot id is unavailable");
  if (bootId !== lease.owner?.bootId) {
    return {
      reclaimed: false,
      reason: "host-or-boot-mismatch",
      goalId,
      attemptId: lease.attemptId,
      detail: "the host boot id changed; refusing to reclaim without human review",
    };
  }
  const ownerDead = () => {
    const identity = procIdentity(lease.owner.pid);
    if (!identity) return true; // absent: exited
    if (identity.startTime !== lease.owner.startTime) return true; // pid reused
    return identity.state === "Z"; // zombie: stopped
  };
  if (!ownerDead()) {
    return {
      reclaimed: false,
      reason: "lease-owner-alive",
      goalId,
      attemptId: lease.attemptId,
      detail: `pid ${lease.owner.pid} still runs with the recorded identity`,
    };
  }
  return withGoalLock(
    root,
    (lock) => {
      const current = store.inspect(goalId);
      if (!current.lease || current.lease.leaseId !== lease.leaseId) {
        return { reclaimed: false, reason: "lease-changed", goalId };
      }
      if (!ownerDead()) {
        return {
          reclaimed: false,
          reason: "lease-owner-alive",
          goalId,
          detail: `pid ${lease.owner.pid} is alive; refusing to reclaim`,
        };
      }
      const fence = {
        goalId,
        generation: current.goal.generation,
        sequence: current.goal.sequence,
      };
      const reclaimed = store.reclaimAttempt(goalId, { lock, fence });
      try {
        appendRunEvent(
          goalId,
          {
            type: "goal:lease-reclaimed",
            goalId,
            attemptId: lease.attemptId,
            generation: current.goal.generation,
            mechanism: "verified-owner-death",
          },
          { home, requireComplete: false },
        );
      } catch {
        // Evidence is not authority; reclaim already verified the owner.
      }
      return {
        reclaimed: true,
        goalId,
        attemptId: lease.attemptId,
        generation: current.goal.generation,
        state: reclaimed.goal.state,
      };
    },
    { skipDurableProbe: true, home },
  );
}

// ============================================================================
// Test execution adapter for a dispatched goal operation
// ============================================================================

/**
 * Create the trusted `runTest` adapter handed to the executor. The plan is
 * re-inspected at dispatch time; if the executable, argv or package script
 * changed since approval, nothing is spawned and the attestation fails. The
 * child is spawned detached with onSpawn bound to the ownership boundary; if
 * recording fails, the adapter throws so the executor marks the execution
 * unverified (durable teardown block) instead of reporting a plain failure.
 */
export function createGoalTestRunner({
  home = defaultHome(),
  plan,
  workspaceRoot,
  env = undefined,
  ownership,
  timeoutMs = undefined,
  bwrapPath = null,
  sourceManifest = null,
} = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("goal test runner: a test plan object is required");
  }
  if (!workspaceRoot) throw new Error("goal test runner: workspaceRoot is required");
  if (!ownership || typeof ownership.recordDispatch !== "function") {
    throw new Error("goal test runner: the execution-ownership boundary is required");
  }
  const root = realpathSync(workspaceRoot);
  const planCwd = plan.cwd ?? root;
  const bwrap = bwrapPath ?? ownership.bwrapPath ?? process.env.MATRIX_BWRAP ?? DEFAULT_BWRAP_PATH;
  // The executor does not pass its attemptId to adapters; recover it from the
  // committed journal rather than change the accepted executor contract.
  const store = createGoalStore(home);
  const attemptIdCache = new Map();
  const resolveAttemptId = (goalId, operationId) => {
    const cached = attemptIdCache.get(operationId);
    if (cached) return cached;
    const records = store.readJournal(goalId);
    const dispatch = records.find(
      (record) => record.kind === "dispatch" && record.operationId === operationId,
    );
    if (!dispatch?.attemptId) {
      throw new Error("goal test runner: no committed dispatch record for this operation");
    }
    attemptIdCache.set(operationId, dispatch.attemptId);
    return dispatch.attemptId;
  };

  /** Best-effort release of the executor's durable block for one dispatch. */
  function reconcileDispatchedOperation(goal, operationId, attemptId) {
    if (attemptId === null) return;
    try {
      if (ownership.settleClosedGate?.(operationId, attemptId)) return;
      ownership.verifyTeardown({
        goalId: goal.id,
        workspace: workspaceIdentityOf(root),
        operations: [
          {
            goalId: goal.id,
            operationId,
            attemptId,
            generation: goal.generation,
          },
        ],
      });
    } catch {
      // Conservative: the executor's teardown block remains in force.
    }
  }

  return async function runGoalTest({
    planHash,
    goal,
    signal,
    operationId,
    sourcePaths = [],
    sourceManifest: dispatchedManifest = null,
  }) {
    const sourceFingerprint = dispatchedManifest?.sha256 ?? null;
    const dispatchedAttemptId = goal && operationId ? resolveAttemptId(goal.id, operationId) : null;
    const refused = (status, summary) => {
      reconcileDispatchedOperation(goal, operationId, dispatchedAttemptId);
      return { status, process: null, summary, planHash, sourceFingerprint: null };
    };
    const contained =
      typeof ownership.containmentUsable === "function"
        ? ownership.containmentUsable()
        : typeof ownership.helperUsable === "function" && ownership.helperUsable();
    if (!contained) {
      return refused(
        "denied",
        "durable goal test execution is unavailable until process containment is verified by the reviewed pidfd ownership helper and a Bubblewrap PID namespace",
      );
    }
    const inspected = inspectTestPlan(plan, { cwd: planCwd, env: env ?? process.env });
    if (!inspected.ok) {
      return refused("failed", `test plan is no longer available: ${inspected.error}`);
    }
    const descriptor = inspected.plan;
    if (descriptor.planHash !== planHash) {
      return refused(
        "failed",
        "the executable, argv or package script changed before dispatch; nothing was run",
      );
    }
    // One-shot policy bound to this exact plan; it grants nothing else and
    // persists nothing. Approval already happened at the operation gate.
    const oneShot = {
      async authorize() {
        return {
          ok: true,
          plan: descriptor,
          origin: TEST_ORIGIN.MODEL,
          decision: "goal-operation",
          grants: ["workspace-once"],
        };
      },
      withRequestApproval() {
        return this;
      },
    };
    const runId = operationId;
    // The guardian waits for a host-owned gate, so the exact monitor, namespace
    // init and inode are persisted before any repository code can run. Normal
    // completion, cancellation and timeout settle the same identity.
    // The approved test command runs in a disposable snapshot of the goal
    // workspace, inside the same isolation layout as `run_sandboxed_command`.
    // The snapshot is bound at the canonical workspace path, so every write is
    // absorbed by the snapshot and the live workspace, the Matrix home and the
    // host filesystem stay unreachable to the test.
    if (!insideWorkspace(root, descriptor.cwd)) {
      return refused(
        "failed",
        "the approved test plan runs outside the goal workspace and cannot be isolated; nothing was run",
      );
    }
    const snapshot = createWorkspaceSnapshot(root, { matrixHome: home, signal });
    let snapshotCleaned = false;
    const discardSnapshot = () => {
      if (snapshotCleaned) return null;
      snapshotCleaned = true;
      return cleanupWorkspaceSnapshot(snapshot);
    };
    try {
      // The evidence must certify the exact bytes the goal dispatched. The
      // live workspace may not have moved since the intent was prepared, and
      // the disposable snapshot must be a faithful copy of those bytes. The
      // comparison covers the complete source identity of the goal, not only
      // its declared artifacts and edits.
      if (sourceFingerprint && typeof sourceManifest === "function") {
        let live;
        try {
          live = sourceManifest({ goal, paths: sourcePaths, root });
        } catch (error) {
          discardSnapshot();
          return refused(
            "failed",
            `the workspace inputs could not be read before the test ran: ${boundedReason(error)}`,
          );
        }
        if (live.sha256 !== sourceFingerprint) {
          discardSnapshot();
          return refused(
            "failed",
            "the workspace changed before the disposable test snapshot was taken; rerun verification against the current source",
          );
        }
        let bound;
        try {
          bound = sourceManifest({
            goal,
            paths: sourcePaths,
            root: snapshot.workspacePath,
            resolved: dispatchedManifest.resolved,
          });
        } catch (error) {
          discardSnapshot();
          return refused(
            "failed",
            `the disposable test snapshot could not be read: ${boundedReason(error)}`,
          );
        }
        if (bound.sha256 !== sourceFingerprint) {
          discardSnapshot();
          return refused(
            "failed",
            "the disposable test snapshot does not match the dispatched inputs; rerun verification against the current source",
          );
        }
      }
      const processRunner = createContainmentProcessRunner({
        ownership,
        gateRoot: join(home, "containment"),
        bwrapPath: bwrap,
        isolation: async ({ file, cwd: runCwd, env: runEnv, gateRoot }) => {
          const built = createGoalTestIsolation({
            workspace: root,
            cwd: runCwd,
            executable: file,
            gateRoot,
            snapshot,
            env: runEnv,
          });
          return { bwrapArgs: built.bwrapArgs, gateMount: built.gateMount };
        },
        onPin: (containment) => {
          const attemptId = dispatchedAttemptId;
          return ownership.recordDispatch({
            operationId,
            goalId: goal.id,
            attemptId,
            generation: goal.generation,
            kind: "test",
            planHash,
            pid: containment.monitor.pid,
            containment,
            workspaceRoot: root,
          });
        },
      });
      let result;
      try {
        result = await runTests(plan, {
          home,
          runId,
          origin: TEST_ORIGIN.MODEL,
          cwd: planCwd,
          env,
          policy: oneShot,
          signal,
          timeoutMs,
          processBackend: "bwrap-pidns",
          // The ownership boundary owns teardown; never signal an unverified group.
          cleanupProcessGroup: false,
          processRunner,
        });
      } catch (error) {
        // The runner settles the exact namespace before surfacing a failure, so
        // reconcile any operation that reached dispatch before rethrowing.
        reconcileDispatchedOperation(goal, operationId, dispatchedAttemptId);
        throw error instanceof Error ? error : new Error(String(error));
      }
      // The namespace is the containment boundary: after the command returns,
      // reconcile this exact operation so its ownership record cannot keep
      // blocking later writers. If teardown cannot be proven the executor keeps
      // its durable block and a later invocation must verify it.
      reconcileDispatchedOperation(goal, operationId, dispatchedAttemptId);
      const verified = result?.verified === true;
      const trustDenied = result?.trustDenied === true;
      const auditComplete = result?.auditStatus === "complete";
      const summary =
        typeof result?.summary === "string" && result.summary.length > 0
          ? result.summary.slice(0, 1_000)
          : verified
            ? "verification passed"
            : "verification unavailable";
      const summaryWithAudit = auditComplete
        ? summary
        : `${summary} (execution end audit could not be persisted)`;
      return {
        status: verified ? "succeeded" : trustDenied ? "denied" : "failed",
        process:
          Number.isSafeInteger(result?.code) || typeof result?.signal === "string"
            ? { exitCode: result?.code ?? null, signal: result?.signal ?? null }
            : null,
        summary: summaryWithAudit,
        planHash: descriptor.planHash,
        // The evidence is bound to the exact disposable snapshot that produced
        // it. The executor rejects a claim that does not match the inputs it
        // dispatched.
        sourceFingerprint: sourceFingerprint ?? undefined,
      };
    } finally {
      discardSnapshot();
    }
  };
}

/** A bounded diagnostic for a manifest failure; no file bytes are exposed. */
function boundedReason(error) {
  const message =
    error && typeof error === "object" ? String(error.message ?? error) : String(error);
  return message.slice(0, 300);
}

/**
 * Create the trusted source-manifest provider for one goal runtime.
 *
 * The provider resolves the complete set of inputs the approved test depends
 * on — the plan's own selection, the runner configuration and the imported
 * workspace modules — and hashes them against a workspace root. The same
 * provider is used for the live workspace and for the disposable snapshot, so
 * the two identities must agree before any repository code runs.
 *
 * @param {{root: string, plan: object, home: string, env?: object}} options
 * @returns {({goal?: object, paths?: string[], root?: string, resolved?: object}) => object}
 */
export function createGoalSourceManifestProvider({ root, plan, home, env = undefined }) {
  if (!root) throw new Error("goal source manifest: a workspace root is required");
  if (!plan) throw new Error("goal source manifest: a test plan is required");
  const planCwd = plan.cwd ?? root;
  return ({ paths = [], root: at = root, resolved = null } = {}) => {
    const inspected = inspectTestPlan(plan, { cwd: planCwd, env: env ?? process.env });
    if (!inspected.ok) {
      throw new Error(`goal source manifest: ${inspected.error}`);
    }
    const manifest =
      resolved ??
      resolveGoalSourceManifest({
        workspaceRoot: at,
        plan: inspected.plan,
        paths,
        matrixHome: home,
      });
    return hashGoalSourceManifest(at, manifest);
  };
}

// ============================================================================
// Integrated runtime path
// ============================================================================

/**
 * Wire the store, executor, authority and ownership boundary into one
 * runtime. The engine is required (a scripted or adapter engine for this
 * release; live engines are attached by the caller). The runtime owns the
 * control channel (pause/cancel) and exposes `resume()` for one attempt.
 *
 * @returns the runtime object; `resume()` settles every durable boundary and
 *   never reports success for unverifiable work.
 */
/** True when `candidate` is the workspace root or a path inside it. */
function insideWorkspace(root, candidate) {
  if (!root || !candidate) return false;
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

export function createGoalRuntime({
  home = defaultHome(),
  goalId,
  workspace,
  engine,
  tools = {},
  testPlan = null,
  env = undefined,
  headless = false,
  allowEdits = false,
  allowTests = false,
  executionOwnership = null,
  authority: injectedAuthority = null,
  store: injectedStore = null,
  helperPath = null,
  bwrapPath = null,
  humanDecisions = undefined,
  toolTimeoutMs = undefined,
  providerTimeoutMs = undefined,
} = {}) {
  if (typeof goalId !== "string" || !/^goal_[a-f0-9]{32}$/.test(goalId)) {
    throw new Error("goal runtime: a valid goal id is required");
  }
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw new Error("goal runtime: a workspace path is required");
  }
  if (!engine) throw new Error("goal runtime: an engine is required");
  const root = realpathSync(workspace);
  const store = injectedStore ?? createGoalStore(home);
  const record = store.inspect(goalId).goal;
  // A matching pathname is not an identity: the directory may have been
  // replaced since the goal was created. Also permit a rename of the same
  // directory, as long as its device and inode still match the record.
  const workspaceStat = statSync(root, { bigint: true });
  if (
    String(workspaceStat.dev) !== String(record.workspace.device) ||
    String(workspaceStat.ino) !== String(record.workspace.inode)
  ) {
    throw new Error("goal runtime: workspace identity does not match the goal record");
  }
  const ownership = executionOwnership ?? createExecutionOwnership({ home, helperPath, bwrapPath });
  const authority =
    injectedAuthority ??
    createGoalAuthority({
      home,
      headless,
      allowEdits,
      allowTests,
      workspace: record.workspace,
    });
  const invocation = new AsyncLocalStorage();
  let activeInvocation = null;
  authority.bindRuntime?.({
    store,
    goalId,
    root,
    currentInvocation: () =>
      activeInvocation !== null && invocation.getStore() === activeInvocation,
  });
  const controlState = { request: null };
  const control = {
    requested: () => controlState.request,
  };
  const sourceManifest = testPlan
    ? createGoalSourceManifestProvider({ root, plan: testPlan, home, env })
    : null;
  const runTest = testPlan
    ? createGoalTestRunner({
        home,
        plan: testPlan,
        workspaceRoot: root,
        env,
        ownership,
        bwrapPath,
        sourceManifest,
      })
    : null;
  const executorOptions = {
    store,
    goalId,
    engine,
    workspaceRoot: root,
    tools,
    control,
    authorizeEdit: authority.authorizeEdit,
    authorizeTest: authority.authorizeTest,
    runTest,
    sourceManifest,
    stageTestDispatch:
      runTest && ownership.stageDispatch
        ? (intent) => ownership.stageDispatch({ ...intent, workspaceRoot: root })
        : null,
    executionOwnership: ownership,
    humanDecisions,
  };
  if (toolTimeoutMs !== undefined) executorOptions.toolTimeoutMs = toolTimeoutMs;
  if (providerTimeoutMs !== undefined) executorOptions.providerTimeoutMs = providerTimeoutMs;
  const executor = createGoalExecutor(executorOptions);
  return {
    goalId,
    workspace: root,
    /** Request cancellation; the loop settles as cancelled at the next boundary. */
    cancel() {
      controlState.request = "cancel";
      return true;
    },
    /** Request a cooperative stop at the next safe boundary. */
    pause() {
      controlState.request = "pause";
      return true;
    },
    /** Resume or start the attempt; one call settles the whole loop. */
    async resume() {
      if (activeInvocation) throw new Error("goal runtime: an attempt is already active");
      activeInvocation = Object.freeze({});
      try {
        return await invocation.run(activeInvocation, () => executor.resume());
      } finally {
        authority.finishAttempt?.();
        controlState.request = null;
        activeInvocation = null;
      }
    },
    /** Record a trusted human decision for a review criterion. */
    recordHumanDecision(criterionId, decision) {
      return executor.recordHumanDecision(criterionId, decision);
    },
    /** The trusted ownership boundary, exposed for the reclaim workflows. */
    ownership,
    authority,
  };
}
