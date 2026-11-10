import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { withWorkspaceWriteLock } from "./workspace.mjs";

const held = new WeakMap();

function identity(path) {
  const real = realpathSync(path);
  const stat = statSync(real, { bigint: true });
  if (!stat.isDirectory()) throw new Error("goal lock: workspace is not a directory");
  return { path: real, device: String(stat.dev), inode: String(stat.ino) };
}

function checkIdentity(actual, expected) {
  if (
    actual.path !== expected.path ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode
  ) {
    throw new Error("goal lock: workspace identity changed");
  }
}

/**
 * @template T @param {string} path @param {(token: object) => T} use
 * @param {{home?: string, skipDurableProbe?: boolean, recoveryGoalId?: string, verifiedOperations?: Set<string>}} [options]
 *   `skipDurableProbe` is reserved for the verified lease-reclamation path in
 *   `lib/goal-policy.mjs`; it bypasses only the durable-goal probe, never the
 *   flock or the workspace identity check.
 * @returns {T} */
export function withGoalLock(path, use, options = {}) {
  if (process.platform !== "linux") throw new Error("goal lock: Linux is required");
  const workspace = identity(path);
  return withWorkspaceWriteLock(
    workspace.path,
    () => {
      checkIdentity(identity(path), workspace);
      const stat = readFileSync("/proc/self/stat", "utf8");
      const owner = {
        pid: process.pid,
        startTime: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      };
      const token = Object.freeze({});
      held.set(token, { workspace, owner });
      try {
        return use(token);
      } finally {
        held.delete(token);
      }
    },
    { ...options, goalLock: true },
  );
}

export function assertGoalLock(token, workspace) {
  const lock = held.get(token);
  if (!lock) throw new Error("goal lock: a held workspace lock is required");
  if (lock.workspace.device !== workspace.device || lock.workspace.inode !== workspace.inode) {
    throw new Error("goal lock: workspace identity changed");
  }
  checkIdentity(identity(lock.workspace.path), lock.workspace);
  return { ...lock.owner };
}

/** Serialize capacity checks and publication after the workspace lock, when needed. */
export function withStoreLock(path, use) {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o7777) !== 0o600
    ) {
      throw new Error("goal store: invalid store lock");
    }
    const result = spawnSync("flock", ["-n", "-E", "75", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      timeout: 2000,
    });
    if (result.status !== 0)
      throw new Error(
        result.status === 75 ? "goal store: writer busy" : "goal store: lock unavailable",
      );
    return use();
  } finally {
    closeSync(fd);
  }
}
