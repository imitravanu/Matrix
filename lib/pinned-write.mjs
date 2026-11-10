import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const TEMP_PREFIX = ".matrix-integration-";
const QUARANTINE_PREFIX = ".matrix-commit-";

function temporaryPath(path) {
  return join(dirname(path), `${TEMP_PREFIX}${randomBytes(16).toString("hex")}.tmp`);
}

function quarantinePath(path) {
  const stem = basename(path)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 96);
  return join(
    dirname(path),
    `${QUARANTINE_PREFIX}${stem}-${randomBytes(16).toString("hex")}.displaced`,
  );
}

function stageFile(path, content, mode) {
  const temp = temporaryPath(path);
  let descriptor;
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
    return temp;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temp);
    } catch {
      /* No temporary file, or cleanup failed. */
    }
    throw error;
  }
}

function restoreDisplaced(quarantine, path) {
  try {
    // link(2) publishes the exact displaced inode only if the target path is
    // still free. It never replaces a newer concurrent target.
    linkSync(quarantine, path);
  } catch (error) {
    if (/** @type {{ code?: string }} */ (error)?.code === "EEXIST") {
      return { restored: false, retained: quarantine };
    }
    let targetExists = true;
    try {
      lstatSync(path);
    } catch (statError) {
      if (/** @type {{ code?: string }} */ (statError)?.code === "ENOENT") {
        targetExists = false;
      } else {
        throw statError;
      }
    }
    if (targetExists) return { restored: false, retained: quarantine };
    try {
      // Directories cannot be hard-linked. The target was checked absent and
      // the workspace lock still excludes cooperating writers.
      renameSync(quarantine, path);
      return { restored: true, retained: null };
    } catch {
      return { restored: false, retained: quarantine };
    }
  }
  try {
    unlinkSync(quarantine);
    return { restored: true, retained: null };
  } catch {
    return { restored: true, retained: quarantine };
  }
}

function syncParent(path) {
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

/** Atomic write through a pinned parent, without a path-based chmod after rename. */
export function writePinnedAtomic(
  path,
  content,
  mode,
  { createOnly = false, beforeCommit = () => {} } = {},
) {
  const temp = temporaryPath(path);
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
    beforeCommit();
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

/**
 * Publish or remove a workspace target while preserving and verifying the exact
 * object displaced at publication.
 *
 * Replacement and deletion first rename the live target to a private quarantine
 * name in the same directory. `verifyDisplaced` receives that path and validates
 * the captured object before anything is published. The new target is then
 * published with link(2), which is atomic and refuses to replace a newer external
 * target. A mismatch restores the quarantined object with link(2) when the target
 * path is still free. If a further concurrent replacement occupies the target,
 * both objects are retained and the error identifies the quarantine path.
 *
 * The filesystem cannot combine a goal-store fence read and publication into one
 * atomic operation. Callers must re-read the fence after the displaced-target
 * read; this protocol then verifies the actual object removed from the target path
 * instead of trusting an earlier precheck.
 *
 * Crash boundaries: a crash after quarantine retains the displaced object under
 * `.matrix-commit-*.displaced`; a crash after publication can leave both the new
 * target and the quarantined old target. Nothing is unlinked before its bytes have
 * been verified. Returned `retained` lists verified cleanup paths that could not
 * be removed: a retained quarantine still contains the exact displaced old bytes,
 * while a retained staging path contains the bytes that were published.
 */
export function commitPinnedVerified(
  path,
  content,
  mode,
  {
    createOnly = false,
    beforeCapture = null,
    beforeCommit = null,
    verifyDisplaced = null,
    beforePublish = () => {},
    context = null,
  } = {},
) {
  const remove = content === null;
  const before = beforeCommit ?? beforeCapture ?? (() => {});
  if (remove && createOnly) {
    throw new TypeError("commitPinnedVerified cannot combine removal with createOnly");
  }
  if (!remove && !Buffer.isBuffer(content) && typeof content !== "string") {
    throw new TypeError("commitPinnedVerified requires Buffer or string content");
  }
  if ((remove || !createOnly) && typeof verifyDisplaced !== "function") {
    throw new Error("commitPinnedVerified requires displaced-target verification");
  }

  let temp = null;
  let quarantine = null;
  let published = false;
  let captured = false;
  let marker = null;
  let transaction = null;
  const retained = [];
  const stable = (value) => join(realpathSync(dirname(path)), basename(value));
  const recordPhase = (phase) => {
    if (!marker) return;
    transaction.phase = phase;
    writePinnedAtomic(marker, JSON.stringify(transaction), 0o600);
  };
  try {
    if (!remove) temp = stageFile(path, content, mode);
    if (!createOnly) quarantine = quarantinePath(path);
    if (context) {
      marker = join(dirname(path), `.matrix-transaction-${randomBytes(16).toString("hex")}.json`);
      transaction = {
        schemaVersion: 1,
        ...context,
        target: basename(path),
        staged: temp ? basename(temp) : null,
        displaced: quarantine ? basename(quarantine) : null,
        phase: "pending",
      };
      recordPhase("pending");
    }
    before();

    if (createOnly) {
      beforePublish();
      try {
        linkSync(temp, path);
      } catch (error) {
        if (/** @type {{ code?: string }} */ (error)?.code === "EEXIST") {
          throw new Error(`precondition failed: target ${path} already exists`, { cause: error });
        }
        throw error;
      }
      published = true;
      recordPhase("published");
      try {
        unlinkSync(temp);
        temp = null;
      } catch {
        retained.push(temp);
        temp = null;
      }
      syncParent(path);
      return { ok: true, retained };
    }

    try {
      renameSync(path, quarantine);
      captured = true;
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error)?.code === "ENOENT") {
        throw new Error(`precondition failed: target ${path} does not exist`, { cause: error });
      }
      throw error;
    }

    try {
      verifyDisplaced(quarantine);
      recordPhase("verified");
      beforePublish();
    } catch (error) {
      const outcome = restoreDisplaced(quarantine, path);
      captured = !outcome.restored;
      const retainedPath = outcome.retained;
      quarantine = null;
      if (retainedPath) {
        retained.push(retainedPath);
        throw new Error(
          `${/** @type {Error} */ (error).message}; displaced target retained at ${retainedPath}`,
          { cause: error },
        );
      }
      throw error;
    }

    if (remove) {
      published = true;
      recordPhase("published");
      try {
        unlinkSync(quarantine);
        quarantine = null;
      } catch {
        retained.push(quarantine);
        quarantine = null;
      }
      published = true;
      syncParent(path);
      return { ok: true, retained };
    }

    try {
      linkSync(temp, path);
    } catch (error) {
      if (/** @type {{ code?: string }} */ (error)?.code === "EEXIST") {
        const retainedPath = quarantine;
        quarantine = null;
        if (retainedPath) retained.push(retainedPath);
        throw new Error(
          `commit refused: target ${path} was replaced before publication; displaced target retained at ${retainedPath}`,
          { cause: error },
        );
      }
      // A non-conflict publication failure leaves the target path free, so put
      // the exact displaced object back instead of stranding it in quarantine.
      const outcome = restoreDisplaced(quarantine, path);
      captured = !outcome.restored;
      const retainedPath = outcome.retained;
      quarantine = null;
      if (retainedPath) {
        retained.push(retainedPath);
        throw new Error(
          `${/** @type {Error} */ (error).message}; displaced target retained at ${retainedPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    published = true;
    recordPhase("published");
    try {
      unlinkSync(temp);
      temp = null;
    } catch {
      retained.push(temp);
      temp = null;
    }
    syncParent(path);

    try {
      unlinkSync(quarantine);
      quarantine = null;
    } catch {
      retained.push(quarantine);
      quarantine = null;
    }
    return { ok: true, retained };
  } catch (error) {
    Object.assign(error, { retained, committed: published });
    throw error;
  } finally {
    if (temp !== null) {
      try {
        unlinkSync(temp);
      } catch {
        retained.push(temp);
      }
    }
    if (quarantine !== null && captured && !published) {
      try {
        const outcome = restoreDisplaced(quarantine, path);
        captured = !outcome.restored;
        if (outcome.retained) retained.push(outcome.retained);
      } catch {
        /* The quarantine path remains on disk; never unlink unverified bytes. */
        retained.push(quarantine);
      }
    }
    if (quarantine !== null && captured && published) retained.push(quarantine);
    if (marker) {
      if (retained.length === 0 && (!captured || published)) {
        try {
          unlinkSync(marker);
          syncParent(path);
          marker = null;
        } catch {
          retained.push(marker);
        }
      } else retained.push(marker);
    }
    for (let i = 0; i < retained.length; i++) retained[i] = stable(retained[i]);
  }
}

/** Publish bytes over an existing target, or create it without clobbering. */
export function writePinnedVerified(path, content, mode, options = {}) {
  return commitPinnedVerified(path, content, mode, options);
}

/** Remove an existing target after verifying the exact object captured at commit. */
export function deletePinnedVerified(path, options = {}) {
  return commitPinnedVerified(path, null, null, options);
}
