// Durable write-ahead evidence for a retained result workspace. The record is
// deliberately outside the result tree so project tests cannot change it by
// accidentally cleaning ordinary project files.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  captureManifestEntry,
  manifestFingerprint,
  readManifestText,
  absoluteManifestPath,
} from "./isolated-manifest.mjs";

const INTENT_NAME = "integration-intent.json";
const MAX_INTENT_BYTES = 20 * 1024 * 1024;

export function integrationIntentFingerprint(record) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
const checksum = integrationIntentFingerprint;

/** Persist the exact approved before/after images before any result write. */
export function writeIntegrationIntent(plan) {
  const rootStat = lstatSync(plan.root, { bigint: true });
  if (!rootStat.isDirectory()) throw new Error("Integration root is not a direct directory");
  const record = {
    version: 2,
    planHash: plan.planHash,
    batchId: plan.batchId,
    integrationRunId: plan.integrationRunId,
    createdAt: plan.createdAt,
    publication: plan.publication ?? null,
    baseManifest: plan.baseManifest,
    rootIdentity: { dev: String(rootStat.dev), ino: String(rootStat.ino) },
    root: plan.root,
    entries: plan.entries.map((entry) => ({
      path: entry.path,
      before: entry.before,
      after: entry.after,
      original: entry.before ? readManifestText(plan.root, entry.before) : null,
      updatedText: readManifestText(entry.workspaceRoot, entry.after),
    })),
  };
  const payload = JSON.stringify({ record, checksum: checksum(record) });
  if (Buffer.byteLength(payload) > MAX_INTENT_BYTES)
    throw new Error("Integration intent is too large");
  const directory = dirname(plan.root);
  const path = join(directory, INTENT_NAME);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, payload);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const parent = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  return { path, fingerprint: checksum(record) };
}

/** Inspect a retained intent without modifying the workspace or inferring completion. */
export function readIntegrationIntent(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_INTENT_BYTES)
      throw new Error("Integration intent is not a bounded regular file");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error("Integration intent was truncated while reading");
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) {
      throw new Error("Integration intent grew while reading");
    }
  } finally {
    closeSync(descriptor);
  }
  if (bytes.length > MAX_INTENT_BYTES) throw new Error("Integration intent is too large");
  const envelope = JSON.parse(bytes.toString("utf8"));
  const record = envelope.record;
  if (
    !record ||
    ![1, 2].includes(record.version) ||
    !Array.isArray(record.entries) ||
    checksum(record) !== envelope.checksum
  ) {
    throw new Error("Integration intent is malformed or changed");
  }
  if (
    typeof record.root !== "string" ||
    !isAbsolute(record.root) ||
    resolve(record.root) !== record.root ||
    resolve(path) !== join(dirname(record.root), INTENT_NAME) ||
    !/^[a-f0-9]{64}$/.test(record.planHash) ||
    record.entries.length < 1 ||
    record.entries.length > 16384
  ) {
    throw new Error("Integration intent identity is invalid");
  }
  const paths = new Set();
  const validateImage = (entry, text, rel) => {
    if (
      !entry ||
      entry.path !== rel ||
      entry.type !== "file" ||
      entry.utf8 !== true ||
      entry.binary !== false ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      typeof text !== "string" ||
      Buffer.byteLength(text) !== entry.size ||
      createHash("sha256").update(text).digest("hex") !== entry.hash
    ) {
      throw new Error("Integration intent image is invalid");
    }
  };
  for (const entry of record.entries) {
    absoluteManifestPath(record.root, entry.path);
    if (paths.has(entry.path)) throw new Error("Integration intent has duplicate paths");
    paths.add(entry.path);
    validateImage(entry.after, entry.updatedText, entry.path);
    if (entry.before !== null) {
      validateImage(entry.before, entry.original, entry.path);
      if (entry.before.mode !== entry.after.mode)
        throw new Error("Integration intent changes a mode");
    } else if (entry.original !== null)
      throw new Error("Integration creation has an original image");
  }
  if (record.version === 2) {
    const rootStat = lstatSync(record.root, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      String(rootStat.dev) !== record.rootIdentity?.dev ||
      String(rootStat.ino) !== record.rootIdentity?.ino ||
      typeof record.integrationRunId !== "string" ||
      !/^integration-[A-Za-z0-9._-]+$/.test(record.integrationRunId)
    ) {
      throw new Error("Integration workspace identity changed");
    }
  }
  return record;
}

function inspectRecord(record) {
  const entries = record.entries.map((entry) => {
    try {
      const current = captureManifestEntry(record.root, entry.path);
      const fingerprint = manifestFingerprint(current);
      return {
        path: entry.path,
        state:
          fingerprint === manifestFingerprint(entry.before)
            ? "matches-before"
            : fingerprint === manifestFingerprint(entry.after)
              ? "matches-after"
              : "diverged",
      };
    } catch {
      return { path: entry.path, state: "uncertain" };
    }
  });
  return { root: record.root, planHash: record.planHash, entries };
}

/** Read-only inspection never asserts the provenance of matching bytes. */
export function inspectIntegrationIntent(path) {
  return inspectRecord(readIntegrationIntent(path));
}

/** Rebuild exact undo data without writing project files or resuming an approval. */
export function reconcileIntegrationIntent(path, { expectedFingerprint = null } = {}) {
  const record = readIntegrationIntent(path);
  const fingerprint = integrationIntentFingerprint(record);
  if (expectedFingerprint !== null && fingerprint !== expectedFingerprint)
    throw new Error("Integration intent differs from the saved approval");
  if (record.version !== 2)
    throw new Error("Legacy intent has no pinned workspace identity; recovery refused");
  const inspection = inspectRecord(record);
  if (inspection.entries.some((entry) => ["diverged", "uncertain"].includes(entry.state))) {
    throw new Error("Integration recovery refused: result files diverged or are uncertain");
  }
  const entries = record.entries
    .filter((entry, index) => inspection.entries[index].state === "matches-after")
    .map((entry) => ({
      file: entry.path,
      absPath: absoluteManifestPath(record.root, entry.path),
      original: entry.original ?? "",
      updatedText: entry.updatedText,
      backupPath: null,
      isCreation: entry.before === null,
      patch: "",
      stats: { adds: 0, dels: 0 },
      appliedAt: null,
    }));
  return {
    ...inspection,
    batchId: record.batchId,
    fingerprint,
    recoveryStatus:
      entries.length === 0
        ? "not-started"
        : entries.length === record.entries.length
          ? "postimages-present"
          : "partial",
    undoRun: entries.length ? { version: 1, runId: record.integrationRunId, entries } : null,
  };
}
