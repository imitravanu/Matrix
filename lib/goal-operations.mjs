// Operation intents, recovery blobs, and validated execution boundaries for durable goals.
// Plan identity is separated from provider tool-call IDs, and effects require fresh authority.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  GOAL_AUTHORITY_KINDS,
  GOAL_LIMITS,
  OPERATION_INTENT_SCHEMA_VERSION,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  assertLeaseHeld,
  assertGoalFence,
  assertOperationAuthority,
  assertOperationReceipt,
  canonicalJson,
  newGoalId,
  validateGoalId,
  validateGoalPath,
  validateOperationIntent,
  validateOperationReceipt,
} from "./goal-contracts.mjs";
import { assertGoalLock } from "./goal-lock.mjs";
import { deletePinnedVerified, writePinnedVerified } from "./pinned-write.mjs";
import { resolveInside } from "./workspace.mjs";
import { inspectGoalCommitArtifacts } from "./goal-recovery.mjs";

const DEFAULT_TOOL_RESERVATION = Object.freeze({
  rounds: 0,
  tools: 1,
  requests: 0,
  activeMs: 0,
});

function requireOp(condition, message) {
  if (!condition) throw new Error(`invalid goal operation: ${message}`);
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyRootIdentity(workspaceRoot, expected) {
  if (!expected?.device || !expected?.inode) return;
  let stat;
  try {
    stat = lstatSync(workspaceRoot, { bigint: true });
  } catch (err) {
    throw new Error(
      `workspace root missing or inaccessible: ${/** @type {Error} */ (err).message}`,
      {
        cause: err,
      },
    );
  }
  requireOp(
    stat.isDirectory() &&
      String(stat.dev) === String(expected.device) &&
      String(stat.ino) === String(expected.inode),
    "workspace identity changed or root is not a directory",
  );
}

function safeResolvePath(workspaceRoot, relPath) {
  validateGoalPath(relPath);
  const res = resolveInside(workspaceRoot, relPath);
  requireOp(res.ok, res.error ?? "path escapes workspace");
  return res.path;
}

function readRegularFileAtPath(fullPath, label, maxBytes) {
  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      return { exists: false, bytes: null, sha256: null, mode: null, type: "absent" };
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Unsafe target: ${label} is a symbolic link`);
  }
  if (!stat.isFile()) {
    throw new Error(`Unsafe target: ${label} is not a regular file`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`File ${label} exceeds maximum byte limit of ${maxBytes}`);
  }

  const fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`File ${label} changed to non-regular file`);
    }
    if (opened.size > maxBytes) {
      throw new Error(`File ${label} exceeds maximum byte limit`);
    }
    const buf = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buf.length) {
      const read = readSync(fd, buf, offset, buf.length - offset, null);
      if (read === 0) {
        throw new Error(`File ${label} truncated while reading`);
      }
      offset += read;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, null) !== 0) {
      throw new Error(`File ${label} grew while reading`);
    }

    return {
      exists: true,
      bytes: buf,
      sha256: digestBytes(buf),
      mode: opened.mode & 0o777,
      type: "file",
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Safely read a regular file within workspace bounds.
 * Nonblocking descriptor, never follows leaf symlinks, rejects directories and devices.
 */
export function readWorkspaceFileBounded(workspaceRoot, relPath, maxBytes = GOAL_LIMITS.blobBytes) {
  validateGoalPath(relPath);
  const directPath = join(workspaceRoot, relPath);
  try {
    const directStat = lstatSync(directPath);
    if (directStat.isSymbolicLink()) {
      throw new Error(`Unsafe target: ${relPath} is a symbolic link`);
    }
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      return { exists: false, bytes: null, sha256: null, mode: null, type: "absent" };
    }
    if (/** @type {Error} */ (err).message?.includes("symbolic link")) throw err;
  }

  const fullPath = safeResolvePath(workspaceRoot, relPath);
  return readRegularFileAtPath(fullPath, relPath, maxBytes);
}

/**
 * Read a bounded regular file by absolute path. Used for quarantined commit
 * objects whose original workspace name is temporarily absent.
 */
export function readAbsoluteFileBounded(fullPath, maxBytes = GOAL_LIMITS.blobBytes) {
  return readRegularFileAtPath(fullPath, fullPath, maxBytes);
}

/**
 * Deterministic plan hash separating plan identity from provider tool-call IDs.
 */
export function computePlanHash(plan) {
  const normalized = {
    kind: plan.kind,
    workspace: plan.workspace
      ? {
          path: plan.workspace.path,
          device: String(plan.workspace.device),
          inode: String(plan.workspace.inode),
        }
      : null,
    path: plan.path ?? null,
    before: plan.before
      ? {
          exists: plan.before.exists,
          sha256: plan.before.sha256 ?? null,
          mode: plan.before.mode ?? null,
        }
      : null,
    after: plan.after
      ? {
          exists: plan.after.exists,
          sha256: plan.after.sha256 ?? null,
          mode: plan.after.mode ?? null,
        }
      : null,
    argsSha256: plan.argsSha256 ?? null,
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

/**
 * Prepare an authority record for an operation.
 */
export function createOperationAuthority({ kind, planHash, decisionId = null }) {
  requireOp(GOAL_AUTHORITY_KINDS.includes(kind), `unknown authority kind: ${kind}`);
  if (kind === "none") {
    return { kind: "none", planHash: null, decisionId: null, scope: "operation" };
  }
  requireOp(
    typeof planHash === "string" && /^[a-f0-9]{64}$/.test(planHash),
    "valid planHash required",
  );
  const decId = decisionId ?? newGoalId("decision");
  validateGoalId(decId, "decision");
  return {
    kind,
    planHash,
    decisionId: decId,
    scope: "operation",
  };
}

/**
 * Prepare a validated edit operation intent and recovery blobs before effect execution.
 */
export function prepareEditOperation({
  goal,
  attemptId,
  generation,
  path: relPath,
  content,
  mode = null,
  authority = null,
  reservation = null,
  args = null,
  toolCallId = null,
  workspaceRoot = null,
}) {
  const root = workspaceRoot ?? goal.workspace.path;
  verifyRootIdentity(root, goal.workspace);
  validateGoalPath(relPath);

  const before = readWorkspaceFileBounded(root, relPath);

  let afterBytes = null;
  let after;
  if (content === null) {
    after = { exists: false, sha256: null, mode: null, blob: null };
  } else {
    afterBytes = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : Buffer.from(String(content), "utf8");
    requireOp(afterBytes.length <= GOAL_LIMITS.blobBytes, "edit content exceeds blob byte limit");
    const afterSha = digestBytes(afterBytes);
    const afterMode = mode !== null && mode !== undefined ? mode & 0o777 : (before.mode ?? 0o644);
    after = {
      exists: true,
      sha256: afterSha,
      mode: afterMode,
      blob: afterSha,
    };
  }

  requireOp(
    before.exists !== after.exists || before.sha256 !== after.sha256 || before.mode !== after.mode,
    "edit is a no-op",
  );

  let argsSha256;
  if (args !== null && args !== undefined) {
    argsSha256 = digestBytes(Buffer.from(canonicalJson(args), "utf8"));
  } else {
    argsSha256 = createHash("sha256").update("").digest("hex");
  }

  const planHash = computePlanHash({
    kind: "edit",
    workspace: goal.workspace,
    path: relPath,
    before,
    after,
    argsSha256,
  });

  let authRecord;
  if (authority) {
    if (typeof authority === "string") {
      authRecord = createOperationAuthority({
        kind: "edit",
        planHash,
        decisionId: authority,
      });
    } else {
      requireOp(authority.kind === "edit", "authority kind mismatch");
      requireOp(authority.planHash === planHash, "authority plan mismatch");
      authRecord = createOperationAuthority({
        kind: "edit",
        planHash,
        decisionId: authority.decisionId,
      });
    }
  } else {
    authRecord = createOperationAuthority({
      kind: "edit",
      planHash,
    });
  }

  const opAttemptId = attemptId ?? goal.attemptId ?? newGoalId("attempt");
  const opGeneration = generation ?? goal.generation ?? 1;
  const opId = newGoalId("operation");

  const intent = {
    schemaVersion: OPERATION_INTENT_SCHEMA_VERSION,
    goalId: goal.id,
    attemptId: opAttemptId,
    generation: opGeneration,
    operationId: opId,
    kind: "edit",
    arguments: { sha256: argsSha256, blob: null },
    planHash,
    authority: authRecord,
    workspace: {
      path: goal.workspace.path,
      device: goal.workspace.device,
      inode: goal.workspace.inode,
      revision: goal.workspace.revision,
      manifest: goal.workspace.manifest,
    },
    preconditions: {
      files: [
        {
          path: relPath,
          exists: before.exists,
          sha256: before.sha256,
        },
      ],
    },
    edit: {
      path: relPath,
      before: {
        exists: before.exists,
        sha256: before.sha256,
        mode: before.mode,
        blob: before.sha256,
      },
      after,
    },
    reservation: reservation ?? { ...DEFAULT_TOOL_RESERVATION },
    state: "prepared",
  };

  const validated = validateOperationIntent(intent);

  const blobs = [];
  if (before.exists && before.bytes !== null) {
    blobs.push(before.bytes);
  }
  if (after.exists && afterBytes !== null) {
    blobs.push(afterBytes);
  }

  return {
    intent: validated,
    blobs,
    planHash,
    operationId: opId,
    toolCallId: toolCallId ?? null,
    beforeBytes: before.bytes,
    afterBytes,
  };
}

/**
 * Prepare a non-edit operation intent (read, search, test, command, provider).
 */
export function prepareOperationIntent({
  goal,
  attemptId,
  generation,
  kind,
  planHash = null,
  authority = null,
  preconditions = { files: [] },
  args = null,
  reservation = null,
  toolCallId = null,
}) {
  requireOp(kind !== "edit", "use prepareEditOperation for edit intents");
  requireOp(
    ["read", "search", "test", "command", "provider"].includes(kind),
    `unsupported operation kind: ${kind}`,
  );

  let argsSha256;
  if (args !== null && args !== undefined) {
    argsSha256 = digestBytes(Buffer.from(canonicalJson(args), "utf8"));
  } else {
    argsSha256 = createHash("sha256").update("").digest("hex");
  }

  const computedPlanHash =
    planHash ??
    computePlanHash({
      kind,
      workspace: goal.workspace,
      argsSha256,
    });

  const requiredAuthorityKind = ["test", "command"].includes(kind) ? kind : "none";

  let authRecord;
  if (requiredAuthorityKind === "none") {
    authRecord = { kind: "none", planHash: null, decisionId: null, scope: "operation" };
  } else if (authority) {
    const decisionId = typeof authority === "string" ? authority : authority.decisionId;
    authRecord = createOperationAuthority({
      kind: requiredAuthorityKind,
      planHash: computedPlanHash,
      decisionId,
    });
  } else {
    authRecord = createOperationAuthority({
      kind: requiredAuthorityKind,
      planHash: computedPlanHash,
    });
  }

  const opAttemptId = attemptId ?? goal.attemptId ?? newGoalId("attempt");
  const opGeneration = generation ?? goal.generation ?? 1;
  const opId = newGoalId("operation");

  const intent = {
    schemaVersion: OPERATION_INTENT_SCHEMA_VERSION,
    goalId: goal.id,
    attemptId: opAttemptId,
    generation: opGeneration,
    operationId: opId,
    kind,
    arguments: { sha256: argsSha256, blob: null },
    planHash: computedPlanHash,
    authority: authRecord,
    workspace: {
      path: goal.workspace.path,
      device: goal.workspace.device,
      inode: goal.workspace.inode,
      revision: goal.workspace.revision,
      manifest: goal.workspace.manifest,
    },
    preconditions,
    edit: null,
    reservation: reservation ?? { ...DEFAULT_TOOL_RESERVATION },
    state: "prepared",
  };

  const validated = validateOperationIntent(intent);
  return {
    intent: validated,
    blobs: [],
    planHash: computedPlanHash,
    operationId: opId,
    toolCallId: toolCallId ?? null,
  };
}

/**
 * Apply an approved edit operation to the workspace filesystem.
 *
 * Enforces:
 * 1. Current execution authority and active writer lease on the goal.
 * 2. Held workspace lock token (assertGoalLock).
 * 3. Matching workspace identity (verifyRootIdentity).
 * 4. Committed dispatch: operation must be committed as dispatch in store journal.
 * 5. Preconditions: target disk state must match approved intent.edit.before.
 * 6. Atomic write or safe deletion.
 */
export function applyEditOperation(workspaceRoot, intent, afterBytes = null, options = {}) {
  let effectiveBytes = afterBytes;
  let opts = options;
  if (afterBytes && !Buffer.isBuffer(afterBytes) && typeof afterBytes === "object") {
    opts = afterBytes;
    effectiveBytes = null;
  }

  requireOp(intent && typeof intent === "object", "intent is required");
  const callerIntent = validateOperationIntent(intent);
  requireOp(callerIntent.kind === "edit" && callerIntent.edit, "intent is not an edit");
  requireOp(callerIntent.workspace && callerIntent.workspace.path, "intent workspace is required");

  const { lock = null, store = null, goalStore = null } = opts;
  const effectiveStore = store ?? goalStore;

  // 1. Require held workspace lock and derive owner identity exclusively from the held workspace lock
  requireOp(lock, "applyEditOperation requires a held workspace lock");
  const owner = assertGoalLock(lock, callerIntent.workspace);

  // 2. Require matching workspace identity
  verifyRootIdentity(workspaceRoot, callerIntent.workspace);

  // 3. Require goal store to verify authority, lease, and cancellation status
  requireOp(
    effectiveStore,
    "applyEditOperation requires goalStore to verify dispatch and authority",
  );
  const goalStatus = effectiveStore.inspect(callerIntent.goalId);
  requireOp(goalStatus && goalStatus.goal, "goal record not found in store");
  requireOp(goalStatus.goal.state !== "cancelled", "cannot apply edit: goal is cancelled");
  requireOp(goalStatus.goal.state !== "completed", "cannot apply edit: goal is completed");
  requireOp(
    ["running", "reconciling"].includes(goalStatus.goal.state),
    `cannot apply edit: goal attempt is not active (state: ${goalStatus.goal.state})`,
  );
  requireOp(goalStatus.lease, "cannot apply edit: no active writer lease");

  // Derive time from the runtime immediately before validation and mutation
  const now = Date.now();

  // Validate the persisted lease against actual held-lock owner, workspace identity, current time, goal, attempt, generation
  assertLeaseHeld(goalStatus.lease, {
    goalId: goalStatus.goal.id,
    attemptId: goalStatus.lease.attemptId,
    generation: goalStatus.goal.generation,
    workspace: {
      path: goalStatus.goal.workspace.path,
      device: goalStatus.goal.workspace.device,
      inode: goalStatus.goal.workspace.inode,
    },
    owner,
    now,
  });

  // 4. Require committed dispatch in journal
  const records = effectiveStore.readJournal(callerIntent.goalId);
  requireOp(
    inspectGoalCommitArtifacts(workspaceRoot, callerIntent.goalId, records).length === 0,
    "unresolved commit artifacts require reconciliation before effects",
  );
  const dispatch = records.find(
    (r) => r.kind === "dispatch" && r.operationId === callerIntent.operationId,
  );
  requireOp(
    dispatch,
    `operation intent ${callerIntent.operationId} has not been committed to dispatch`,
  );
  requireOp(
    dispatch.payload && dispatch.payload.state === "dispatched",
    "dispatch record is not in dispatched state",
  );
  const receipt = records.find(
    (r) =>
      (r.kind === "receipt" || r.kind === "recovery-receipt") &&
      r.operationId === callerIntent.operationId,
  );
  requireOp(
    !receipt,
    `operation receipt for ${callerIntent.operationId} has already been committed`,
  );

  // Exact dispatch binding:
  const committed = validateOperationIntent(dispatch.payload);
  requireOp(
    committed.kind === "edit" && committed.edit,
    "committed dispatch payload is not an edit",
  );

  // Validate that caller-supplied intent matches the exact committed dispatch payload,
  // accounting for the prepared/dispatched state representation.
  requireOp(
    canonicalJson({ ...callerIntent, state: "dispatched" }) === canonicalJson(committed),
    "executed intent does not match committed dispatch payload",
  );

  // Validate the full intent and its authority against current lease & goal
  assertOperationAuthority(committed, {
    goal: goalStatus.goal,
    lease: goalStatus.lease,
    owner,
    now,
  });

  // 5. Prefer executing verified persisted data (committed)
  const operativeIntent = committed;
  const relPath = operativeIntent.edit.path;
  const fullPath = safeResolvePath(workspaceRoot, relPath);
  const verifyBeforeImage = () => {
    verifyRootIdentity(workspaceRoot, operativeIntent.workspace);
    requireOp(
      safeResolvePath(workspaceRoot, relPath) === fullPath,
      "workspace target path changed",
    );
    const currentDisk = readWorkspaceFileBounded(workspaceRoot, relPath);

    if (operativeIntent.edit.before.exists === false) {
      requireOp(
        currentDisk.exists === false,
        `precondition failed: target file ${relPath} already exists`,
      );
    } else {
      requireOp(
        currentDisk.exists === true,
        `precondition failed: target file ${relPath} does not exist`,
      );
      requireOp(
        currentDisk.type === "file",
        `precondition failed: target file ${relPath} is not a regular file (${currentDisk.type})`,
      );
      requireOp(
        currentDisk.sha256 === operativeIntent.edit.before.sha256,
        `precondition failed: target file ${relPath} content changed after approval (expected ${operativeIntent.edit.before.sha256}, got ${currentDisk.sha256})`,
      );
      if (operativeIntent.edit.before.mode !== null) {
        requireOp(
          (currentDisk.mode & 0o777) === (operativeIntent.edit.before.mode & 0o777),
          `precondition failed: target file ${relPath} mode changed after approval (expected 0o${(operativeIntent.edit.before.mode & 0o777).toString(8)}, got 0o${(currentDisk.mode & 0o777).toString(8)})`,
        );
      }
    }
  };
  verifyBeforeImage();

  let finalBytes = effectiveBytes;
  if (!operativeIntent.edit.after.exists) {
    finalBytes = null;
  } else if (finalBytes) {
    requireOp(Buffer.isBuffer(finalBytes), "afterBytes Buffer required for write");
    requireOp(
      digestBytes(finalBytes) === operativeIntent.edit.after.sha256,
      `afterBytes does not match committed dispatch after image sha256 (expected ${operativeIntent.edit.after.sha256}, got ${digestBytes(finalBytes)})`,
    );
  } else {
    requireOp(operativeIntent.edit.after.blob, "missing after blob in committed intent");
    const blob = effectiveStore.readBlob(operativeIntent.goalId, operativeIntent.edit.after.blob);
    requireOp(blob, `after blob ${operativeIntent.edit.after.blob} not found in store`);
    finalBytes = Buffer.from(blob);
    requireOp(
      digestBytes(finalBytes) === operativeIntent.edit.after.sha256,
      "store blob checksum does not match committed dispatch after image",
    );
  }

  // Pin the parent before staging. Revalidate after all reads, hashing and
  // temporary-file syncs, at the publication that makes the effect visible.
  const parentFd = openSync(dirname(fullPath), constants.O_RDONLY | constants.O_DIRECTORY);
  let commitResult;
  try {
    const parent = fstatSync(parentFd, { bigint: true });
    const pinnedPath = join(`/proc/self/fd/${parentFd}`, basename(fullPath));

    const assertCurrentCommitAuthority = (latest) => {
      assertGoalFence(latest.goal, {
        goalId: goalStatus.goal.id,
        generation: goalStatus.goal.generation,
        sequence: goalStatus.goal.sequence,
      });
      requireOp(latest.uncommittedBytes === 0, "uncommitted journal tail requires recovery");
      verifyRootIdentity(workspaceRoot, operativeIntent.workspace);
      assertOperationAuthority(operativeIntent, {
        goal: latest.goal,
        lease: latest.lease,
        owner: assertGoalLock(lock, operativeIntent.workspace),
        now: Date.now(),
      });
    };

    const verifyLiveParent = () => {
      const liveParent = lstatSync(dirname(fullPath), { bigint: true });
      requireOp(
        liveParent.isDirectory() && liveParent.dev === parent.dev && liveParent.ino === parent.ino,
        "workspace target parent changed",
      );
    };

    // This read is the last target snapshot before capture. Re-inspect the goal
    // after it so a cancellation or fence advance committed during the read
    // cannot be hidden by the earlier snapshot.
    const beforeCapture = () => {
      assertCurrentCommitAuthority(effectiveStore.inspect(operativeIntent.goalId));
      verifyBeforeImage();
      verifyLiveParent();
      assertCurrentCommitAuthority(effectiveStore.inspect(operativeIntent.goalId));
    };

    const verifyDisplaced = (quarantine) => {
      const expected = operativeIntent.edit.before;
      const captured = readAbsoluteFileBounded(quarantine);
      requireOp(
        captured.exists && captured.type === "file",
        `workspace target ${relPath} changed type during commit`,
      );
      requireOp(
        captured.sha256 === expected.sha256,
        `workspace target ${relPath} changed during commit`,
      );
      if (expected.mode !== null) {
        requireOp(
          captured.mode === (expected.mode & 0o777),
          `workspace target ${relPath} mode changed during commit`,
        );
      }
    };

    const beforePublish = () => {
      assertCurrentCommitAuthority(effectiveStore.inspect(operativeIntent.goalId));
      verifyLiveParent();
      let targetExists = true;
      try {
        lstatSync(fullPath);
      } catch (err) {
        if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") targetExists = false;
        else throw err;
      }
      requireOp(!targetExists, `workspace target ${relPath} reappeared during commit`);
    };

    if (!operativeIntent.edit.after.exists) {
      const result = deletePinnedVerified(pinnedPath, {
        beforeCapture,
        verifyDisplaced,
        beforePublish,
        context: {
          goalId: operativeIntent.goalId,
          operationId: operativeIntent.operationId,
          path: relPath,
          action: "edit",
        },
      });
      return {
        ok: true,
        committed: true,
        retained: result.retained,
        cleanupPending: result.retained.length > 0,
        sha256: null,
        mode: null,
        absent: true,
      };
    }

    commitResult = writePinnedVerified(pinnedPath, finalBytes, operativeIntent.edit.after.mode, {
      createOnly: operativeIntent.edit.before.exists === false,
      beforeCapture,
      verifyDisplaced: operativeIntent.edit.before.exists ? verifyDisplaced : undefined,
      beforePublish,
      context: {
        goalId: operativeIntent.goalId,
        operationId: operativeIntent.operationId,
        path: relPath,
        action: "edit",
      },
    });
  } finally {
    closeSync(parentFd);
  }
  return {
    ok: true,
    committed: true,
    retained: commitResult.retained,
    cleanupPending: commitResult.retained.length > 0,
    sha256: operativeIntent.edit.after.sha256,
    mode: operativeIntent.edit.after.mode,
    absent: false,
  };
}

/**
 * Build a validated operation receipt.
 */
export function buildOperationReceipt(
  intent,
  {
    sequence,
    status = "succeeded",
    files = null,
    process = null,
    usage = null,
    uncertainty = { kind: "none", detail: null },
    evidence = [],
    effect = null,
  },
) {
  let fileEntries = files;
  if (!fileEntries && intent.kind === "edit") {
    if (status === "succeeded") {
      fileEntries = [
        {
          path: intent.edit.path,
          state: intent.edit.after.exists ? "matches-after" : "absent",
          sha256: intent.edit.after.sha256,
        },
      ];
    } else {
      fileEntries = [
        {
          path: intent.edit.path,
          state: intent.edit.before.exists ? "matches-before" : "absent",
          sha256: intent.edit.before.sha256,
        },
      ];
    }
  }

  const receipt = {
    schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
    goalId: intent.goalId,
    attemptId: intent.attemptId,
    generation: intent.generation,
    operationId: intent.operationId,
    sequence,
    status,
    evidence: evidence ?? [],
    files: fileEntries ?? [],
    process: process ?? null,
    usage: usage ?? intent.reservation,
    uncertainty: effect?.cleanupPending
      ? {
          kind: "unknown-effect",
          detail: `Effect committed; cleanup pending for ${effect.retained.length} retained artifacts. Inspect commit recovery before continuing.`,
        }
      : (uncertainty ?? { kind: "none", detail: null }),
  };

  const validated = validateOperationReceipt(receipt);
  assertOperationReceipt(validated, intent);
  return validated;
}
