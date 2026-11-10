// Effect reconciliation, exact undo reconstruction, and workspace drift verification.
// Preserves exact file modes, CRLF, empty originals, missing final newlines, and creation distinctions.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { GOAL_LIMITS, validateGoalPath } from "./goal-contracts.mjs";
import { assertGoalLock } from "./goal-lock.mjs";
import { readAbsoluteFileBounded, readWorkspaceFileBounded } from "./goal-operations.mjs";
import { deletePinnedVerified, writePinnedVerified } from "./pinned-write.mjs";
import { resolveInside } from "./workspace.mjs";

function requireRec(condition, message) {
  if (!condition) throw new Error(`goal recovery error: ${message}`);
}

function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyRoot(workspaceRoot, expected) {
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
  requireRec(
    stat.isDirectory() &&
      String(stat.dev) === String(expected.device) &&
      String(stat.ino) === String(expected.inode),
    "workspace identity changed or root is not a directory",
  );
}

function safeResolvePath(workspaceRoot, relPath) {
  validateGoalPath(relPath);
  const res = resolveInside(workspaceRoot, relPath);
  requireRec(res.ok, res.error ?? "path escapes workspace");
  return res.path;
}

/**
 * Reconcile a single workspace file against recorded before/after images without modifying disk.
 * Returns classification: applied, pending, divergent, missing, or type-changed.
 */
export function reconcileFile(
  workspaceRoot,
  relPath,
  { before, after },
  expectedRootIdentity = null,
  options = {},
) {
  let expectedRoot = expectedRootIdentity;
  let opts = options;
  if (
    expectedRootIdentity &&
    typeof expectedRootIdentity === "object" &&
    !expectedRootIdentity.device &&
    Object.hasOwn(expectedRootIdentity, "dispatched")
  ) {
    opts = expectedRootIdentity;
    expectedRoot = null;
  }
  const { dispatched = true } = opts;
  if (expectedRoot) {
    verifyRoot(workspaceRoot, expectedRoot);
  }
  validateGoalPath(relPath);
  const directPath = join(workspaceRoot, relPath);
  try {
    const directStat = lstatSync(directPath);
    if (directStat.isSymbolicLink()) {
      return {
        path: relPath,
        state: "type-changed",
        substate: "symlink",
        sha256: null,
        mode: null,
      };
    }
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      if (after.exists === false) {
        if (!dispatched) {
          return {
            path: relPath,
            state: "divergent",
            substate: "matches-undispatched-after",
            sha256: null,
            mode: null,
          };
        }
        return {
          path: relPath,
          state: "applied",
          substate: "absent",
          sha256: null,
          mode: null,
        };
      }
      if (before.exists === false) {
        return {
          path: relPath,
          state: "pending",
          substate: "not-created",
          sha256: null,
          mode: null,
        };
      }
      return {
        path: relPath,
        state: "missing",
        substate: "missing-before",
        sha256: null,
        mode: null,
      };
    }
  }

  const fullPath = safeResolvePath(workspaceRoot, relPath);

  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      if (after.exists === false) {
        return {
          path: relPath,
          state: "applied",
          substate: "absent",
          sha256: null,
          mode: null,
        };
      }
      if (before.exists === false) {
        return {
          path: relPath,
          state: "pending",
          substate: "not-created",
          sha256: null,
          mode: null,
        };
      }
      return {
        path: relPath,
        state: "missing",
        substate: "missing-before",
        sha256: null,
        mode: null,
      };
    }
    throw err;
  }

  if (stat.isSymbolicLink()) {
    return {
      path: relPath,
      state: "type-changed",
      substate: "symlink",
      sha256: null,
      mode: null,
    };
  }
  if (stat.isDirectory()) {
    return {
      path: relPath,
      state: "type-changed",
      substate: "directory",
      sha256: null,
      mode: null,
    };
  }
  if (!stat.isFile()) {
    const isFifo = typeof stat.isFIFO === "function" && stat.isFIFO();
    return {
      path: relPath,
      state: "type-changed",
      substate: isFifo ? "fifo" : "special",
      sha256: null,
      mode: null,
    };
  }

  if (stat.size > GOAL_LIMITS.blobBytes) {
    return {
      path: relPath,
      state: "divergent",
      substate: "oversized",
      sha256: null,
      mode: stat.mode & 0o777,
    };
  }

  // Nonblocking open prevents hanging on unexpectedly converted FIFOs or devices
  const fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      return {
        path: relPath,
        state: "type-changed",
        substate: "opened-non-file",
        sha256: null,
        mode: null,
      };
    }
    const buf = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buf.length) {
      const read = readSync(fd, buf, offset, buf.length - offset, null);
      if (read === 0) {
        return {
          path: relPath,
          state: "divergent",
          substate: "truncated-while-reading",
          sha256: null,
          mode: null,
        };
      }
      offset += read;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, null) !== 0) {
      return {
        path: relPath,
        state: "divergent",
        substate: "grew-while-reading",
        sha256: null,
        mode: null,
      };
    }

    const currentHash = digestBytes(buf);
    const currentMode = opened.mode & 0o777;

    const matchesAfter =
      after.exists === true &&
      currentHash === after.sha256 &&
      (after.mode === null || currentMode === after.mode);

    if (matchesAfter) {
      if (!dispatched) {
        return {
          path: relPath,
          state: "divergent",
          substate: "matches-undispatched-after",
          sha256: currentHash,
          mode: currentMode,
        };
      }
      return {
        path: relPath,
        state: "applied",
        substate: "matches-after",
        sha256: currentHash,
        mode: currentMode,
      };
    }

    const matchesBefore =
      before.exists === true &&
      currentHash === before.sha256 &&
      (before.mode === null || currentMode === before.mode);

    if (matchesBefore) {
      return {
        path: relPath,
        state: "pending",
        substate: "matches-before",
        sha256: currentHash,
        mode: currentMode,
      };
    }

    return {
      path: relPath,
      state: "divergent",
      substate: "matches-neither",
      sha256: currentHash,
      mode: currentMode,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Reconcile goal journal records against disk state.
 * Identifies applied, pending, divergent, missing, and type-changed states without modifying workspace.
 */
function inspectCommitArtifacts(root, goalId, operations) {
  const paths = new Map();
  for (const op of operations.values()) {
    if (op.intent?.kind === "edit") paths.set(op.intent.edit.path, []);
  }
  const directories = new Set(
    [...paths.keys()].map((path) => dirname(safeResolvePath(root, path))),
  );
  let entries = 0;
  for (const directory of directories) {
    const fd = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const pinned = `/proc/self/fd/${fd}`;
      const dir = opendirSync(pinned);
      const displaced = [];
      const accounted = new Set();
      try {
        for (let item; (item = dir.readSync());) {
          requireRec(++entries <= 16384, "commit artifact inventory limit exceeded");
          if (/^\.matrix-commit-.*\.displaced$/.test(item.name)) displaced.push(item.name);
          if (!/^\.matrix-transaction-[a-f0-9]{32}\.json$/.test(item.name)) continue;
          const bytes = readAbsoluteFileBounded(join(pinned, item.name), 65536);
          requireRec(bytes.exists, "commit transaction disappeared during inspection");
          const record = JSON.parse(bytes.bytes.toString("utf8"));
          if (record.goalId !== goalId) continue;
          const op = operations.get(record.operationId);
          requireRec(
            record.schemaVersion === 1 &&
              op?.intent?.edit?.path === record.path &&
              paths.has(record.path) &&
              record.target === basename(record.path) &&
              dirname(safeResolvePath(root, record.path)) === directory &&
              ["pending", "verified", "published"].includes(record.phase) &&
              ["edit", "undo"].includes(record.action),
            "invalid commit transaction identity",
          );
          const retained = [join(realpathSync(pinned), item.name)];
          for (const name of [record.staged, record.displaced]) {
            if (name === null) continue;
            requireRec(
              typeof name === "string" &&
                basename(name) === name &&
                /^\.matrix-(integration|commit)-/.test(name),
              "invalid commit artifact path",
            );
            accounted.add(name);
            if (lstatSync(join(pinned, name), { throwIfNoEntry: false }))
              retained.push(join(realpathSync(pinned), name));
          }
          paths.get(record.path).push({ ...record, manifest: retained[0], retained });
        }
      } finally {
        dir.closeSync();
      }
      for (const name of displaced) {
        if (accounted.has(name)) continue;
        for (const [path, artifacts] of paths) {
          const stem = basename(path)
            .replace(/[^a-zA-Z0-9._-]/g, "_")
            .slice(0, 96);
          if (
            dirname(safeResolvePath(root, path)) === directory &&
            name.startsWith(`.matrix-commit-${stem}-`)
          )
            artifacts.push({
              phase: "unknown",
              path,
              retained: [join(realpathSync(pinned), name)],
            });
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  return paths;
}

export function reconcileGoalOperations(goalStore, goalId, { workspaceRoot = null } = {}) {
  const goalStatus = goalStore.inspect(goalId);
  const goal = goalStatus.goal;
  const root = workspaceRoot ?? goal.workspace.path;
  verifyRoot(root, goal.workspace);

  const records = goalStore.readJournal(goalId);

  const operationsMap = new Map();
  for (const record of records) {
    if (!record.operationId) continue;
    let op = operationsMap.get(record.operationId);
    if (!op) {
      op = {
        operationId: record.operationId,
        attemptId: record.attemptId,
        generation: record.generation,
        intent: null,
        dispatch: null,
        receipt: null,
      };
      operationsMap.set(record.operationId, op);
    }
    if (record.kind === "intent") op.intent = record.payload;
    if (record.kind === "dispatch") op.dispatch = record.payload;
    if (record.kind === "receipt" || record.kind === "recovery-receipt")
      op.receipt = record.payload;
  }

  const fileReconciliations = new Map();
  const commitArtifacts = inspectCommitArtifacts(root, goalId, operationsMap);
  const operations = [];
  let needsAttention = false;
  let hasInterruptedEffects = false;

  // Group edit operations by path in chronological order
  const editsByPath = new Map();
  for (const opId of goal.operations) {
    const op = operationsMap.get(opId);
    if (!op || !op.intent) continue;
    if (op.intent.kind === "edit") {
      const p = op.intent.edit.path;
      if (!editsByPath.has(p)) editsByPath.set(p, []);
      editsByPath.get(p).push(op);
    }
  }

  // Reconcile each path's ordered edit history against current disk state
  for (const [relPath, pathOps] of editsByPath) {
    const unresolved = commitArtifacts.get(relPath);
    if (unresolved?.length) {
      needsAttention = true;
      hasInterruptedEffects = true;
      fileReconciliations.set(relPath, {
        path: relPath,
        state: "uncertain",
        substate: "unresolved-commit",
        commits: unresolved,
      });
      for (const op of pathOps) {
        op.observedApplied = false;
        op.status = "uncertain";
        op.unacknowledgedReceipt = false;
        op.requiresFreshAuthority = true;
      }
      continue;
    }
    validateGoalPath(relPath);
    let currentDisk = null;
    let directStat = null;
    const directPath = join(root, relPath);
    try {
      directStat = lstatSync(directPath);
    } catch (err) {
      if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
        currentDisk = { exists: false, sha256: null, mode: null, type: "absent" };
      } else {
        throw err;
      }
    }

    if (directStat) {
      if (directStat.isSymbolicLink()) {
        currentDisk = { exists: true, sha256: null, mode: null, type: "symlink" };
      } else if (directStat.isDirectory()) {
        currentDisk = { exists: true, sha256: null, mode: null, type: "directory" };
      } else if (!directStat.isFile()) {
        const isFifo = typeof directStat.isFIFO === "function" && directStat.isFIFO();
        currentDisk = { exists: true, sha256: null, mode: null, type: isFifo ? "fifo" : "special" };
      } else if (directStat.size > GOAL_LIMITS.blobBytes) {
        currentDisk = {
          exists: true,
          sha256: null,
          mode: directStat.mode & 0o777,
          type: "oversized",
        };
      } else {
        const fullPath = safeResolvePath(root, relPath);
        const fd = openSync(
          fullPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = fstatSync(fd);
          if (!opened.isFile()) {
            currentDisk = { exists: true, sha256: null, mode: null, type: "special" };
          } else {
            const buf = Buffer.alloc(opened.size);
            let offset = 0;
            while (offset < buf.length) {
              const r = readSync(fd, buf, offset, buf.length - offset, null);
              if (r === 0) break;
              offset += r;
            }
            currentDisk = {
              exists: true,
              sha256: digestBytes(buf),
              mode: opened.mode & 0o777,
              type: "file",
            };
          }
        } finally {
          closeSync(fd);
        }
      }
    }

    if (["symlink", "directory", "fifo", "special"].includes(currentDisk?.type)) {
      fileReconciliations.set(relPath, {
        path: relPath,
        state: "type-changed",
        substate: currentDisk.type,
        sha256: null,
        mode: null,
      });
      needsAttention = true;
      for (const op of pathOps) {
        op.observedApplied = false;
        op.status = "type-changed";
        op.unacknowledgedReceipt = false;
        op.requiresFreshAuthority = true;
      }
      continue;
    }

    if (currentDisk?.type === "oversized") {
      fileReconciliations.set(relPath, {
        path: relPath,
        state: "divergent",
        substate: "oversized",
        sha256: null,
        mode: currentDisk.mode,
      });
      needsAttention = true;
      for (const op of pathOps) {
        op.observedApplied = false;
        op.status = "divergent";
        op.unacknowledgedReceipt = false;
        op.requiresFreshAuthority = true;
      }
      continue;
    }

    const matchesCheckpoint = (img) => {
      if (img.exists === false) return currentDisk.exists === false;
      return (
        currentDisk.exists === true &&
        currentDisk.sha256 === img.sha256 &&
        (img.mode === null || (currentDisk.mode & 0o777) === (img.mode & 0o777))
      );
    };

    // Only genuinely dispatched operations can produce valid reachable
    // checkpoints. Undispatched intents are skipped, not treated as a barrier:
    // a later attempt can still dispatch and apply a fresh operation on the same
    // path. Track every continuous chain through the dispatched history so a
    // dispatched-but-unapplied branch cannot hide a later operation that resumed
    // from an earlier reachable image.
    const imageKey = (img) =>
      img.exists ? `present:${img.sha256}:${img.mode === null ? "" : img.mode & 0o777}` : "absent";
    const states = new Map();
    const addState = (image, chain) => {
      const key = imageKey(image);
      const existing = states.get(key);
      if (!existing || chain.length > existing.chain.length) {
        states.set(key, { image, chain });
      }
    };
    addState(pathOps[0].intent.edit.before, []);
    for (const op of pathOps) {
      if (!op.dispatch) continue;
      const before = op.intent.edit.before;
      const source = states.get(imageKey(before));
      if (!source) continue;
      addState(op.intent.edit.after, [...source.chain, op]);
    }

    // Bytes matching an undispatched after-image remain external provenance
    // unless a continuous dispatched operation independently reaches the same
    // observable state. An undispatched intent by itself never supplies a
    // reachable checkpoint; it cannot claim external bytes.
    const matchesUndispatchedAfter = pathOps.some(
      (op) => !op.dispatch && matchesCheckpoint(op.intent.edit.after),
    );

    let selected = null;
    for (const state of states.values()) {
      if (!matchesCheckpoint(state.image)) continue;
      if (!selected || state.chain.length > selected.chain.length) selected = state;
    }
    if (selected && selected.chain.length === 0 && matchesUndispatchedAfter) selected = null;

    if (!selected) {
      const terminalImage = pathOps[pathOps.length - 1].intent.edit.after;
      const isMissing =
        !matchesUndispatchedAfter && currentDisk.exists === false && terminalImage.exists === true;
      const state = matchesUndispatchedAfter ? "divergent" : isMissing ? "missing" : "divergent";
      const substate = matchesUndispatchedAfter
        ? "matches-undispatched-after"
        : isMissing
          ? "missing-expected"
          : "matches-neither";
      fileReconciliations.set(relPath, {
        path: relPath,
        state,
        substate,
        sha256: currentDisk.sha256,
        mode: currentDisk.mode,
      });
      needsAttention = true;
      for (const op of pathOps) {
        op.observedApplied = false;
        op.status = "pending";
        op.unacknowledgedReceipt = false;
        op.requiresFreshAuthority = true;
      }
    } else {
      const appliedOps = new Set(selected.chain);
      const lastApplied = selected.chain.at(-1) ?? null;
      const lastAppliedIndex = lastApplied ? pathOps.indexOf(lastApplied) : -1;
      const hasLaterDispatched = pathOps
        .slice(lastAppliedIndex + 1)
        .some((op) => Boolean(op.dispatch));
      const finalState = selected.chain.length === 0 ? "pending" : "applied";
      const finalSubstate =
        selected.chain.length === 0
          ? "matches-before"
          : hasLaterDispatched
            ? "matches-intermediate"
            : "matches-after";

      fileReconciliations.set(relPath, {
        path: relPath,
        state: finalState,
        substate: finalSubstate,
        sha256: currentDisk.sha256,
        mode: currentDisk.mode,
      });

      for (const op of pathOps) {
        if (appliedOps.has(op)) {
          op.observedApplied = true;
          if (op.receipt) {
            op.status = op.receipt.status === "succeeded" ? "succeeded" : op.receipt.status;
            op.unacknowledgedReceipt = false;
          } else {
            op.status = "applied";
            op.unacknowledgedReceipt = true;
            hasInterruptedEffects = true;
          }
        } else {
          op.observedApplied = false;
          op.status = "pending";
          op.unacknowledgedReceipt = false;
          op.requiresFreshAuthority = true;
          if (op.dispatch) {
            hasInterruptedEffects = true;
          }
        }
      }
    }
  }

  // Collect operations and handle non-edit kinds
  for (const opId of goal.operations) {
    const op = operationsMap.get(opId);
    if (!op || !op.intent) continue;

    const { intent, dispatch, receipt } = op;
    const kind = intent.kind;

    if (kind === "edit") {
      const relPath = intent.edit.path;
      const fileResult = fileReconciliations.get(relPath);
      operations.push({
        operationId: opId,
        kind,
        path: relPath,
        status: op.status,
        observedApplied: op.observedApplied,
        unacknowledgedReceipt: op.unacknowledgedReceipt ?? false,
        requiresFreshAuthority: op.requiresFreshAuthority ?? false,
        fileState: fileResult?.state ?? "uncertain",
        fileSubstate: fileResult?.substate ?? "uncertain",
        intent,
        dispatch,
        receipt,
      });
    } else if (kind === "test") {
      if (receipt) {
        operations.push({
          operationId: opId,
          kind,
          status: receipt.status,
          observedApplied: false,
          unacknowledgedReceipt: false,
          requiresFreshAuthority: false,
          intent,
          dispatch,
          receipt,
        });
      } else {
        hasInterruptedEffects = true;
        operations.push({
          operationId: opId,
          kind,
          status: "uncertain",
          observedApplied: false,
          unacknowledgedReceipt: false,
          requiresFreshAuthority: true,
          detail: "interrupted test process has uncertain result",
          intent,
          dispatch,
          receipt: null,
        });
      }
    } else if (kind === "provider") {
      if (receipt) {
        operations.push({
          operationId: opId,
          kind,
          status: receipt.status,
          observedApplied: false,
          unacknowledgedReceipt: false,
          requiresFreshAuthority: false,
          intent,
          dispatch,
          receipt,
        });
      } else {
        hasInterruptedEffects = true;
        operations.push({
          operationId: opId,
          kind,
          status: "uncertain",
          observedApplied: false,
          unacknowledgedReceipt: false,
          requiresFreshAuthority: true,
          detail: "interrupted provider request discarded with conservative usage",
          intent,
          dispatch,
          receipt: null,
        });
      }
    } else {
      operations.push({
        operationId: opId,
        kind,
        status: receipt ? receipt.status : "pending",
        observedApplied: false,
        unacknowledgedReceipt: false,
        requiresFreshAuthority: !receipt,
        intent,
        dispatch,
        receipt,
      });
    }
  }

  const appliedOperations = operations.filter((op) => op.observedApplied);
  const pendingOperations = operations.filter((op) => op.status === "pending");
  const unacknowledgedOperations = operations.filter((op) => op.unacknowledgedReceipt);

  return {
    goalId,
    goal,
    workspaceRoot: root,
    canResume: !needsAttention,
    needsAttention,
    hasInterruptedEffects,
    operations,
    appliedOperations,
    pendingOperations,
    unacknowledgedOperations,
    fileReconciliations: Object.fromEntries(fileReconciliations),
    unresolvedCommits: [...commitArtifacts.values()].flat(),
  };
}

/** Read only transaction metadata, without inspecting live target bytes. */
export function inspectGoalCommitArtifacts(root, goalId, records) {
  const operations = new Map(
    records
      .filter((record) => record.kind === "intent")
      .map((record) => [record.operationId, { intent: record.payload }]),
  );
  return [...inspectCommitArtifacts(root, goalId, operations).values()].flat();
}

/**
 * Reconstruct exact undo data from committed journal records and store blobs.
 * Preserves exact bytes, line endings (CRLF), empty originals, modes, and creations.
 */
export function reconstructExactUndo(goalStore, goalId, { workspaceRoot = null } = {}) {
  const reconciliation = reconcileGoalOperations(goalStore, goalId, {
    workspaceRoot,
  });
  const root = reconciliation.workspaceRoot;
  requireRec(
    reconciliation.unresolvedCommits.length === 0,
    "unresolved commit artifacts require reconciliation before undo",
  );

  const appliedEdits = reconciliation.appliedOperations.filter((op) => op.kind === "edit");

  const undoStack = [];
  const prestateMap = new Map();

  for (const op of appliedEdits) {
    const edit = op.intent.edit;
    const relPath = edit.path;
    const fullPath = safeResolvePath(root, relPath);

    let originalBytes = null;
    let originalHash = null;
    let originalMode = null;
    const isCreation = edit.before.exists === false;

    if (!isCreation) {
      const blobHash = edit.before.blob;
      requireRec(blobHash, `missing before blob hash for ${relPath}`);
      const blob = goalStore.readBlob(goalId, blobHash);
      requireRec(
        digestBytes(blob) === edit.before.sha256,
        `blob checksum mismatch for ${relPath}; recovery refused`,
      );
      originalBytes = Buffer.from(blob);
      originalHash = edit.before.sha256;
      originalMode = edit.before.mode;
    }

    const undoEntry = {
      operationId: op.operationId,
      path: relPath,
      absPath: fullPath,
      isCreation,
      isDeletion: edit.after.exists === false,
      originalBytes,
      originalHash,
      originalMode,
      targetHash: edit.after.sha256,
      targetMode: edit.after.mode,
    };

    undoStack.push(undoEntry);

    // Track initial pre-goal state for repeated edits on the same file
    if (!prestateMap.has(relPath)) {
      prestateMap.set(relPath, {
        path: relPath,
        absPath: fullPath,
        isCreation,
        originalBytes,
        originalHash,
        originalMode,
      });
    }
  }

  // Reverse order for stack: latest applied edit is undone first (slice preserves Buffer instances)
  const entriesInReverse = undoStack.slice().reverse();

  return {
    goalId,
    workspaceRoot: root,
    count: appliedEdits.length,
    undoEntries: entriesInReverse,
    prestate: Object.fromEntries(prestateMap),
  };
}

/**
 * Execute exact undo restoring files to original pre-operation state.
 * Refuses if current files changed after edit, or if recovery blobs are corrupted.
 */
export function applyExactUndo(
  goalStore,
  goalId,
  undoEntries,
  { workspaceRoot = null, lock = null } = {},
) {
  const goalStatus = goalStore.inspect(goalId);
  const root = workspaceRoot ?? goalStatus.goal.workspace.path;
  verifyRoot(root, goalStatus.goal.workspace);

  requireRec(
    reconcileGoalOperations(goalStore, goalId, { workspaceRoot: root }).unresolvedCommits.length ===
      0,
    "unresolved commit artifacts require reconciliation before undo",
  );

  if (!undoEntries || undoEntries.length === 0) {
    return { ok: true, restored: [] };
  }

  requireRec(lock, "applyExactUndo requires a held workspace lock");
  assertGoalLock(lock, goalStatus.goal.workspace);

  // Simulated state tracker across sequential undo steps
  const simulatedState = new Map();

  // Preflight validation: verify ALL targets before touching any file
  for (const entry of undoEntries) {
    const fullPath = safeResolvePath(root, entry.path);

    if (!simulatedState.has(entry.path)) {
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch (err) {
        if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
          simulatedState.set(entry.path, { exists: false, sha256: null, mode: null });
        } else {
          throw err;
        }
      }
      if (stat) {
        if (!stat.isFile()) {
          throw new Error(
            `Cannot undo ${entry.path}: target is not a regular file; refusing to overwrite`,
          );
        }
        const fd = openSync(
          fullPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const buf = Buffer.alloc(stat.size);
          readSync(fd, buf, 0, buf.length, null);
          simulatedState.set(entry.path, {
            exists: true,
            sha256: digestBytes(buf),
            mode: stat.mode & 0o777,
          });
        } finally {
          closeSync(fd);
        }
      }
    }

    const currentSim = simulatedState.get(entry.path);

    if (entry.isDeletion) {
      if (currentSim.exists) {
        throw new Error(
          `Cannot undo ${entry.path}: file exists where deletion was expected; refusing to overwrite`,
        );
      }
    } else {
      if (
        !currentSim.exists ||
        currentSim.sha256 !== entry.targetHash ||
        (entry.targetMode !== null && currentSim.mode !== entry.targetMode)
      ) {
        throw new Error(
          `Cannot undo ${entry.path}: target file diverged after edit was applied; refusing to overwrite`,
        );
      }
    }

    if (!entry.isCreation) {
      requireRec(
        entry.originalBytes !== null,
        `Cannot undo ${entry.path}: missing original recovery bytes`,
      );
      const buf = Buffer.isBuffer(entry.originalBytes)
        ? entry.originalBytes
        : Buffer.from(entry.originalBytes);
      requireRec(
        digestBytes(buf) === entry.originalHash,
        `Cannot undo ${entry.path}: backup integrity check failed`,
      );
      simulatedState.set(entry.path, {
        exists: true,
        sha256: entry.originalHash,
        mode: entry.originalMode,
      });
    } else {
      simulatedState.set(entry.path, {
        exists: false,
        sha256: null,
        mode: null,
      });
    }
  }

  // Preflight passed; restore in order
  const restored = [];
  const retained = [];
  for (const entry of undoEntries) {
    const fullPath = safeResolvePath(root, entry.path);
    const parentFd = openSync(dirname(fullPath), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const parent = fstatSync(parentFd, { bigint: true });
      const pinnedPath = join(`/proc/self/fd/${parentFd}`, basename(fullPath));

      const verifyLiveParent = () => {
        const liveParent = lstatSync(dirname(fullPath), { bigint: true });
        requireRec(
          liveParent.isDirectory() &&
            liveParent.dev === parent.dev &&
            liveParent.ino === parent.ino,
          "undo target parent changed",
        );
      };

      const beforeCapture = () => {
        verifyRoot(root, goalStatus.goal.workspace);
        assertGoalLock(lock, goalStatus.goal.workspace);
        requireRec(safeResolvePath(root, entry.path) === fullPath, "undo target path changed");
        const current = readWorkspaceFileBounded(root, entry.path);
        requireRec(
          entry.isDeletion
            ? !current.exists
            : current.exists &&
                current.sha256 === entry.targetHash &&
                (entry.targetMode === null || current.mode === entry.targetMode),
          `Cannot undo ${entry.path}: target file diverged before commit`,
        );
        verifyLiveParent();
      };

      const verifyDisplaced = (quarantine) => {
        let captured;
        try {
          captured = readAbsoluteFileBounded(quarantine);
        } catch (err) {
          throw new Error(`Cannot undo ${entry.path}: target file diverged before commit`, {
            cause: err,
          });
        }
        requireRec(
          captured.exists &&
            captured.type === "file" &&
            captured.sha256 === entry.targetHash &&
            (entry.targetMode === null || captured.mode === entry.targetMode),
          `Cannot undo ${entry.path}: target file diverged before commit`,
        );
      };

      const beforePublish = () => {
        verifyRoot(root, goalStatus.goal.workspace);
        assertGoalLock(lock, goalStatus.goal.workspace);
        requireRec(safeResolvePath(root, entry.path) === fullPath, "undo target path changed");
        verifyLiveParent();
        let targetExists = true;
        try {
          lstatSync(fullPath);
        } catch (err) {
          if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") targetExists = false;
          else throw err;
        }
        requireRec(!targetExists, `Cannot undo ${entry.path}: target reappeared during commit`);
      };

      if (entry.isCreation) {
        const result = deletePinnedVerified(pinnedPath, {
          beforeCapture,
          verifyDisplaced,
          beforePublish,
          context: { goalId, operationId: entry.operationId, path: entry.path, action: "undo" },
        });
        retained.push(...result.retained);
      } else {
        const buf = Buffer.isBuffer(entry.originalBytes)
          ? entry.originalBytes
          : Buffer.from(entry.originalBytes);
        const result = writePinnedVerified(pinnedPath, buf, entry.originalMode, {
          createOnly: entry.isDeletion,
          beforeCapture,
          verifyDisplaced: entry.isDeletion ? undefined : verifyDisplaced,
          beforePublish,
          context: { goalId, operationId: entry.operationId, path: entry.path, action: "undo" },
        });
        retained.push(...result.retained);
      }
      restored.push(entry.path);
    } finally {
      closeSync(parentFd);
    }
  }

  return {
    ok: true,
    restored,
    retained,
    cleanupPending: retained.length > 0,
  };
}

/**
 * Capture fingerprint of workspace files for drift detection.
 */
export function captureWorkspaceFingerprints(workspaceRoot, relPaths, expectedRootIdentity = null) {
  if (expectedRootIdentity) verifyRoot(workspaceRoot, expectedRootIdentity);
  const fingerprints = {};
  for (const relPath of relPaths) {
    const fullPath = safeResolvePath(workspaceRoot, relPath);
    try {
      const stat = lstatSync(fullPath);
      if (stat.isFile()) {
        const fd = openSync(
          fullPath,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const opened = fstatSync(fd);
          const buf = Buffer.alloc(opened.size);
          let offset = 0;
          while (offset < buf.length) {
            const count = readSync(fd, buf, offset, buf.length - offset, null);
            if (count === 0) break;
            offset += count;
          }
          fingerprints[relPath] = {
            exists: true,
            sha256: digestBytes(buf),
            mode: opened.mode & 0o777,
          };
        } finally {
          closeSync(fd);
        }
      } else {
        fingerprints[relPath] = {
          exists: true,
          sha256: null,
          mode: stat.mode & 0o777,
          type: stat.isDirectory() ? "directory" : "special",
        };
      }
    } catch (err) {
      if (/** @type {{ code?: string }} */ (err)?.code === "ENOENT") {
        fingerprints[relPath] = { exists: false, sha256: null, mode: null };
      } else {
        throw err;
      }
    }
  }
  return fingerprints;
}

/**
 * Detect workspace drift against a baseline set of file fingerprints.
 */
export function detectWorkspaceDrift(
  workspaceRoot,
  baselineFingerprints,
  expectedRootIdentity = null,
) {
  if (expectedRootIdentity) verifyRoot(workspaceRoot, expectedRootIdentity);
  const changed = [];
  const currentFingerprints = captureWorkspaceFingerprints(
    workspaceRoot,
    Object.keys(baselineFingerprints),
    expectedRootIdentity,
  );

  for (const [path, base] of Object.entries(baselineFingerprints)) {
    const cur = currentFingerprints[path];
    if (!cur) {
      changed.push({ path, reason: "unobserved" });
      continue;
    }
    if (base.exists !== cur.exists) {
      changed.push({
        path,
        reason: base.exists ? "file-removed" : "file-created",
      });
    } else if (base.exists) {
      if (base.sha256 !== cur.sha256) {
        changed.push({ path, reason: "content-changed" });
      } else if (base.mode !== cur.mode) {
        changed.push({ path, reason: "mode-changed" });
      }
    }
  }

  return {
    drifted: changed.length > 0,
    changed,
    currentFingerprints,
  };
}

/**
 * Check if an operation authority is valid for the current attempt and generation.
 * Resumed work requires fresh authority; old decisions and tokens expire on attempt restart.
 */
export function checkOperationAuthorityFreshness(intent, currentAttemptId, currentGeneration) {
  if (intent.generation !== currentGeneration || intent.attemptId !== currentAttemptId) {
    return {
      valid: false,
      reason:
        "Authority belongs to a prior attempt or generation; fresh authority is required for resumed work",
    };
  }
  return { valid: true, reason: null };
}
