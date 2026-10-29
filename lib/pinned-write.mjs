import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Atomic write through a pinned parent, without a path-based chmod after rename. */
export function writePinnedAtomic(path, content, mode, { createOnly = false } = {}) {
  const temp = join(dirname(path), `.matrix-integration-${randomBytes(16).toString("hex")}.tmp`);
  let descriptor;
  let renamed = false;
  try {
    descriptor = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, content);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (createOnly) {
      linkSync(temp, path);
      unlinkSync(temp);
      renamed = true;
    } else {
      renameSync(temp, path);
      renamed = true;
    }
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        /* No temporary file, or cleanup failed. */
      }
    }
  }
}
