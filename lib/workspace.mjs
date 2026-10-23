// ============================================================================
// Workspace safety: path containment and atomic writes.
// ============================================================================

import { chmodSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  const temp = join(dir, `.matrix-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
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
