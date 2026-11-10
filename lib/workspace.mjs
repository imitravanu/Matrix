// ============================================================================
// Workspace safety: path containment and atomic writes.
// ============================================================================

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { assertNoDurableGoalOwnsWorkspace } from "./goal-lease-probe.mjs";

/**
 * Resolve `requested` under `root`, rejecting traversal and symlink escapes.
 * Existing paths are realpath'd; new paths are resolved lexically.
 */
export function resolveInside(root, requested) {
  if (!requested) return { ok: false, error: "empty path" };
  const rootAbs = resolve(root);
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(rootAbs, requested);

  let rootReal = rootAbs;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    // root itself may not exist in a test fixture; lexical containment is used.
  }

  let targetReal = absolute;
  try {
    targetReal = realpathSync(absolute);
  } catch {
    // New file: realpath the nearest existing parent.
    let parent = dirname(absolute);
    while (parent !== dirname(parent)) {
      try {
        const realParent = realpathSync(parent);
        targetReal = join(realParent, relative(parent, absolute));
        break;
      } catch {
        parent = dirname(parent);
      }
    }
  }

  const rel = relative(rootReal, targetReal);
  if (rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))) {
    return {
      ok: true,
      path: targetReal,
      root: rootReal,
      rel: relative(rootReal, targetReal).split(sep).join("/"),
    };
  }
  return { ok: false, error: `path escapes workspace: ${requested}` };
}

/** Atomic write that preserves the file mode when the target exists. */
export function writeFileAtomic(path, content) {
  const dir = dirname(path);
  const temp = join(
    dir,
    `.matrix-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // New file.
  }
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // best effort
  }
  return path;
}

export function relativePath(root, path) {
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

/** Check the provisional lease marker while holding the workspace lock. */
function checkWorkspaceLease(root) {
  let fd;
  try {
    fd = openSync(join(root, "workspace.lease.json"), constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("refusing to write: workspace lease is unavailable", { cause: error });
  }
  try {
    const invalidLease = "refusing to write: workspace lease is invalid";
    const limit = 4096;
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(invalidLease);
    const bytes = Buffer.alloc(limit + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size) throw new Error(invalidLease);
    let lease;
    try {
      lease = JSON.parse(bytes.toString("utf8", 0, length));
    } catch (error) {
      throw new Error(invalidLease, { cause: error });
    }
    if (!Number.isSafeInteger(lease?.expiresAt) || !Number.isSafeInteger(lease?.owner?.pid)) {
      throw new Error(invalidLease);
    }
    if (Date.now() < lease.expiresAt && lease.owner.pid !== process.pid) {
      throw new Error("refusing to write: workspace is locked by an active goal lease");
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Hold the canonical Linux workspace lock for a synchronous mutation.
 * The child locks fd 3, which shares the parent's open file description. The
 * parent's descriptor keeps the lock held after the child exits.
 *
 * @template T
 * @param {string} workspaceRoot
 * @param {() => T} mutate
 * @param {{ home?: string, skipDurableProbe?: boolean, goalLock?: boolean, recoveryGoalId?: string, verifiedOperations?: Set<string> }} [options]
 *   `skipDurableProbe` is reserved for the verified lease-reclamation path in
 *   `lib/goal-policy.mjs`, which calls it only after independently verifying
 *   the lease owner's death. It must never be derived from caller or model
 *   input, and never bypasses the flock itself or the lease-marker check.
 * @returns {T}
 */
export function withWorkspaceWriteLock(workspaceRoot, mutate, options = {}) {
  if (process.platform !== "linux") return mutate();
  const root = realpathSync(workspaceRoot);
  const lockPath = `${root}.lock`;
  const fd = openSync(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error("refusing to write: invalid workspace lock file");
    const result = spawnSync("flock", ["-n", "-E", "75", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout: 2000,
    });
    if (result.status === 75) {
      throw new Error("refusing to write: workspace is locked by an active goal");
    }
    if (result.status !== 0) {
      throw new Error("refusing to write: workspace lock is unavailable", { cause: result.error });
    }
    checkWorkspaceLease(root);
    // A durable goal that released its descriptor still owns this workspace;
    // the durable probe refuses foreign writers until it is attested or gone.
    if (!options.skipDurableProbe) assertNoDurableGoalOwnsWorkspace(root, options);
    return mutate();
  } finally {
    closeSync(fd);
  }
}
