// Private, bounded, no-follow workspace snapshots for the Linux command backend.

import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const WORKSPACE_SNAPSHOT_LIMITS = Object.freeze({
  entries: 16_384,
  directories: 4096,
  depth: 48,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  symlinkBytes: 4096,
});

const OMITTED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".matrix",
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
]);
const SENSITIVE_FILES =
  /^(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|\.netrc$|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))/i;
const SENSITIVE_SUFFIX = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i;

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function aborted(signal) {
  return signal?.aborted === true;
}

function checkAbort(signal) {
  if (aborted(signal)) {
    const error = new Error("workspace snapshot aborted");
    error.code = "COMMAND_ABORTED";
    throw error;
  }
}

function normalizedLimits(overrides) {
  const result = { ...WORKSPACE_SNAPSHOT_LIMITS };
  for (const key of Object.keys(overrides ?? {})) {
    if (!(key in result)) throw new Error(`unsupported snapshot limit: ${key}`);
    const value = overrides[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > result[key]) {
      throw new Error(
        `snapshot limit ${key} must be a positive integer no greater than ${result[key]}`,
      );
    }
    result[key] = value;
  }
  return result;
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs];
}

function sameIdentity(left, right) {
  const a = identity(left);
  const b = identity(right);
  return a.every((value, index) => value === b[index]);
}

function mode(stat) {
  return Number(stat.mode & 0o777n);
}

function omitted(name, absolutePath, matrixHome) {
  if (OMITTED_DIRECTORIES.has(name)) return true;
  if (SENSITIVE_FILES.test(name) || SENSITIVE_SUFFIX.test(name)) return true;
  return matrixHome != null && inside(matrixHome, absolutePath);
}

function makeRemovable(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  try {
    chmodSync(path, 0o700);
  } catch {
    // rmSync below reports the actionable cleanup failure.
  }
  for (const name of requireNames(path)) makeRemovable(join(path, name));
}

function requireNames(path) {
  // Kept separate so a permissions failure never turns into a silent successful cleanup.
  return readdirNames(path);
}

function readdirNames(path) {
  const directory = opendirSync(path);
  try {
    const names = [];
    for (;;) {
      const entry = directory.readSync();
      if (entry == null) return names;
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
}

/** Remove a snapshot without following any symlink. Returns a visible failure, never a false success. */
export function cleanupWorkspaceSnapshot(snapshot) {
  if (!snapshot?.root) return { ok: true, error: null };
  try {
    makeRemovable(snapshot.root);
    rmSync(snapshot.root, { recursive: true, force: true });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: `snapshot cleanup failed: ${error.message}` };
  }
}

/**
 * Copy through held directory descriptors and O_NOFOLLOW. Parent-directory swaps
 * cannot redirect an open traversal to a host path; metadata is revalidated after
 * every file and directory. Hardlinks become independent regular files.
 */
export function createWorkspaceSnapshot(
  workspace,
  { scratchDir = tmpdir(), matrixHome = null, limits = {}, signal = null } = {},
) {
  checkAbort(signal);
  const sourceRoot = realpathSync(resolve(workspace));
  if (!statSync(sourceRoot).isDirectory()) throw new Error("snapshot workspace is not a directory");
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(scratchDir);
  if (inside(sourceRoot, scratch))
    throw new Error("snapshot scratch directory must be outside the workspace");
  const excludedHome = matrixHome == null ? null : resolve(matrixHome);
  const budget = normalizedLimits(limits);
  const root = mkdtempSync(join(scratch, "matrix-command-"));
  chmodSync(root, 0o700);
  const workspacePath = join(root, "workspace");
  const snapshot = {
    root,
    workspacePath,
    sourceRoot,
    stats: {
      entries: 0,
      files: 0,
      directories: 0,
      symlinks: 0,
      bytes: 0,
      omittedEntries: 0,
      unsupportedEntries: 0,
    },
  };

  const copyFile = (source, destination, maximumBytes) => {
    checkAbort(signal);
    const before = lstatSync(source, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error("snapshot source is not a regular file");
    if (before.size > BigInt(maximumBytes))
      throw new Error("snapshot file exceeds its byte budget");
    if (snapshot.stats.bytes + Number(before.size) > budget.totalBytes) {
      throw new Error("workspace snapshot exceeds its total byte budget");
    }
    const sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    let destinationFd = null;
    try {
      const opened = fstatSync(sourceFd, { bigint: true });
      if (!opened.isFile() || !sameIdentity(before, opened)) {
        throw new Error("snapshot file identity changed while opening it");
      }
      destinationFd = openSync(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let total = 0;
      for (;;) {
        checkAbort(signal);
        const chunk = Buffer.allocUnsafe(64 * 1024);
        const count = readSync(sourceFd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        total += count;
        if (total > maximumBytes || snapshot.stats.bytes + total > budget.totalBytes) {
          throw new Error("snapshot file changed beyond a byte budget while being copied");
        }
        let offset = 0;
        while (offset < count) offset += writeSync(destinationFd, chunk, offset, count - offset);
      }
      const after = fstatSync(sourceFd, { bigint: true });
      const current = lstatSync(source, { bigint: true });
      if (
        !sameIdentity(opened, after) ||
        !sameIdentity(opened, current) ||
        total !== Number(opened.size)
      ) {
        throw new Error("snapshot file changed while it was being copied");
      }
      chmodSync(destination, mode(opened));
      snapshot.stats.files += 1;
      snapshot.stats.bytes += total;
    } finally {
      if (destinationFd != null) closeSync(destinationFd);
      closeSync(sourceFd);
    }
  };

  const copyDirectory = (source, destination, absolutePath, depth) => {
    checkAbort(signal);
    if (depth > budget.depth)
      throw new Error("workspace snapshot exceeds its directory-depth budget");
    snapshot.stats.directories += 1;
    if (snapshot.stats.directories > budget.directories) {
      throw new Error("workspace snapshot exceeds its directory budget");
    }
    const before = lstatSync(source, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("snapshot source directory changed type");
    }
    const sourceFd = openSync(
      source,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let directory = null;
    try {
      const opened = fstatSync(sourceFd, { bigint: true });
      if (!opened.isDirectory() || !sameIdentity(before, opened)) {
        throw new Error("snapshot directory identity changed while opening it");
      }
      mkdirSync(destination, { mode: 0o700 });
      directory = opendirSync(`/proc/self/fd/${sourceFd}`);
      for (;;) {
        checkAbort(signal);
        const entry = directory.readSync();
        if (entry == null) break;
        snapshot.stats.entries += 1;
        if (snapshot.stats.entries > budget.entries) {
          throw new Error("workspace snapshot exceeds its entry budget");
        }
        const name = entry.name;
        const childAbsolute = join(absolutePath, name);
        if (omitted(name, childAbsolute, excludedHome)) {
          snapshot.stats.omittedEntries += 1;
          continue;
        }
        const childSource = `/proc/self/fd/${sourceFd}/${name}`;
        const childDestination = join(destination, name);
        const child = lstatSync(childSource, { bigint: true });
        if (child.isSymbolicLink()) {
          const target = readlinkSync(childSource, { encoding: "buffer" });
          if (target.length > budget.symlinkBytes)
            throw new Error("snapshot symlink target is too large");
          symlinkSync(target, childDestination);
          const current = lstatSync(childSource, { bigint: true });
          if (!sameIdentity(child, current))
            throw new Error("snapshot symlink changed while being copied");
          snapshot.stats.symlinks += 1;
        } else if (child.isDirectory()) {
          copyDirectory(childSource, childDestination, childAbsolute, depth + 1);
        } else if (child.isFile()) {
          copyFile(childSource, childDestination, budget.fileBytes);
        } else {
          // Sockets, FIFOs and device nodes are never imported into the sandbox.
          snapshot.stats.unsupportedEntries += 1;
        }
      }
      directory.closeSync();
      directory = null;
      const after = fstatSync(sourceFd, { bigint: true });
      const current = lstatSync(source, { bigint: true });
      if (!sameIdentity(opened, after) || !sameIdentity(opened, current)) {
        throw new Error("snapshot directory changed while it was being copied");
      }
      chmodSync(destination, mode(opened));
    } finally {
      if (directory) {
        try {
          directory.closeSync();
        } catch {
          // The original traversal error is more useful than a duplicate close error.
        }
      }
      closeSync(sourceFd);
    }
  };

  try {
    copyDirectory(sourceRoot, workspacePath, sourceRoot, 0);
    return snapshot;
  } catch (error) {
    const cleaned = cleanupWorkspaceSnapshot(snapshot);
    if (!cleaned.ok) error.cleanupError = cleaned.error;
    throw error;
  }
}
