// ============================================================================
// Durable sessions, run logs and pre-edit backups.
//
// A workbench that edits source files needs a memory and a safety net. Every
// session is written atomically to ~/.matrix/sessions, every applied patch is
// backed up first, and semantic run events go to a JSONL log.
// ============================================================================

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { createRedactor, isSensitiveKey, REDACTED } from "./redaction.mjs";

export const SESSION_RETENTION = Object.freeze({
  historyEntries: 500,
  historyBytes: 4 * 1024 * 1024,
  stringChars: 16 * 1024,
  objectKeys: 200,
});

export const RUN_LOG_RETENTION = Object.freeze({
  maxFiles: 100,
  maxTotalBytes: 8 * 1024 * 1024,
  maxEventBytes: 64 * 1024,
  eventEntries: 500,
});

export const BACKUP_RETENTION = Object.freeze({
  maxFiles: 500,
  maxTotalBytes: 64 * 1024 * 1024,
});

const METADATA_VERSION = 1;
const METADATA_SUFFIX = ".meta.json";

export function matrixHome(home = process.env.MATRIX_HOME || join(homedir(), ".matrix")) {
  return home;
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

export function newRunId(now = Date.now()) {
  return `${new Date(now)
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

function atomicWrite(path, content, mode = 0o600) {
  ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content, { mode });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The original write/rename error is the actionable failure.
    }
    throw error;
  }
}

function boundedInteger(value, fallback, { min = 0, allowZero = true } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0)) return fallback;
  return Math.max(min, Math.floor(number));
}

function safeJson(
  value,
  depth = 0,
  arrayLimit = 500,
  {
    redactor = null,
    recovery = false,
    newest = false,
    stringChars = SESSION_RETENTION.stringChars,
    objectKeys = SESSION_RETENTION.objectKeys,
  } = {},
) {
  const options = { redactor, recovery, newest, stringChars, objectKeys };
  if (depth > 8) return "[deep]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (recovery) return value;
    return (redactor?.text(value) ?? value).slice(0, stringChars);
  }
  if (Array.isArray(value)) {
    let items;
    if (!Number.isFinite(arrayLimit)) items = value.slice();
    else if (arrayLimit <= 0) items = [];
    else items = newest ? value.slice(-arrayLimit) : value.slice(0, arrayLimit);
    return items.map((item) => safeJson(item, depth + 1, arrayLimit, options));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, objectKeys)) {
      if (typeof val === "function" || typeof val === "symbol") continue;
      const safeKey = recovery ? key : (redactor?.text(key) ?? key);
      out[safeKey] =
        !recovery && isSensitiveKey(key) ? REDACTED : safeJson(val, depth + 1, arrayLimit, options);
    }
    return out;
  }
  return null;
}

function transcriptOverflowMarker(record) {
  const marker = {
    role: typeof record?.role === "string" ? record.role.slice(0, 40) : "system",
    content: "[record truncated to fit the transcript byte budget]",
    truncated: true,
  };
  if (typeof record?.id === "string") marker.id = record.id.slice(0, 128);
  return marker;
}

/**
 * Project transcript cards into bounded JSON-safe records. Both live consumers
 * and persistence use this newest-first retention policy. The return value
 * includes accounting so callers can make truncation visible.
 * @param {*} history
 * @param {{maxEntries?: number, maxBytes?: number, stringChars?: number, redactor?: *}} [options]
 */
export function retainTranscript(
  history,
  {
    maxEntries = SESSION_RETENTION.historyEntries,
    maxBytes = SESSION_RETENTION.historyBytes,
    stringChars = SESSION_RETENTION.stringChars,
    redactor = null,
  } = {},
) {
  const source = Array.isArray(history) ? history : [];
  const entryLimit = boundedInteger(maxEntries, SESSION_RETENTION.historyEntries);
  const byteLimit = boundedInteger(maxBytes, SESSION_RETENTION.historyBytes, { min: 2 });
  const stringLimit = boundedInteger(stringChars, SESSION_RETENTION.stringChars);
  const candidates = entryLimit === 0 ? [] : source.slice(-entryLimit);
  const projected = candidates.map((record) =>
    safeJson(record, 0, entryLimit, {
      redactor,
      newest: true,
      stringChars: stringLimit,
    }),
  );

  // Walk backwards and stop at the first record that does not fit. This keeps
  // a contiguous newest suffix instead of accidentally retaining old records.
  const newestFirst = [];
  let contentBytes = 0;
  let truncatedRecords = 0;
  for (let index = projected.length - 1; index >= 0; index--) {
    const record = projected[index];
    const recordBytes = Buffer.byteLength(JSON.stringify(record));
    const additional = recordBytes + (newestFirst.length === 0 ? 0 : 1);
    if (2 + contentBytes + additional <= byteLimit) {
      newestFirst.push(record);
      contentBytes += additional;
      continue;
    }
    if (newestFirst.length === 0) {
      const marker = transcriptOverflowMarker(record);
      if (2 + Buffer.byteLength(JSON.stringify(marker)) <= byteLimit) {
        newestFirst.push(marker);
        truncatedRecords = 1;
      }
    }
    break;
  }

  const retained = newestFirst.reverse();
  const bytes = Buffer.byteLength(JSON.stringify(retained));
  return {
    history: retained,
    total: source.length,
    retained: retained.length,
    dropped: source.length - retained.length,
    bytes,
    truncatedRecords,
  };
}

export function sessionsDir(home = matrixHome()) {
  return join(home, "sessions");
}

export function backupsDir(home = matrixHome()) {
  return join(home, "backups");
}

export function runsDir(home = matrixHome()) {
  return join(home, "runs");
}

function metadataPath(dir, id) {
  return join(dir, `${id}${METADATA_SUFFIX}`);
}

function structuredWarning(operation, code, message, path = null) {
  return {
    operation,
    code,
    message,
    nonfatal: true,
    ...(path ? { path } : {}),
  };
}

function emitWarning(callback, warning) {
  if (typeof callback !== "function") return warning;
  try {
    callback(warning);
  } catch {
    // A diagnostic callback must not turn a nonfatal persistence error fatal.
  }
  return warning;
}

function sessionRecordProblem(record, expectedId) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { code: "session-malformed", message: "Session record is not a JSON object" };
  }
  if (record.version !== 1) {
    return Number.isInteger(record.version)
      ? {
          code: "session-unsupported-version",
          message: `Unsupported session version ${record.version}`,
        }
      : { code: "session-malformed", message: "Session record has no valid version" };
  }
  if (record.id !== expectedId || !/^[A-Za-z0-9._-]+$/.test(String(record.id ?? ""))) {
    return { code: "session-malformed", message: "Session id does not match its filename" };
  }
  if (!Number.isFinite(record.savedAt)) {
    return { code: "session-malformed", message: "Session savedAt is not a finite timestamp" };
  }
  if (record.cwd !== null && typeof record.cwd !== "string") {
    return { code: "session-malformed", message: "Session cwd is not a string or null" };
  }
  if (!Array.isArray(record.history)) {
    return { code: "session-malformed", message: "Session history is not an array" };
  }
  return null;
}

function metadataProblem(record, expectedId) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.version !== METADATA_VERSION
  ) {
    return "Session metadata has an unsupported or malformed version";
  }
  if (record.id !== expectedId || !Number.isFinite(record.savedAt))
    return "Session metadata identity is malformed";
  if (record.cwd !== null && typeof record.cwd !== "string")
    return "Session metadata cwd is malformed";
  if (!Number.isInteger(record.messages) || record.messages < 0)
    return "Session metadata message count is malformed";
  if (!Number.isFinite(record.historyBytes) || record.historyBytes < 0)
    return "Session metadata byte count is malformed";
  if (!Number.isInteger(record.droppedMessages) || record.droppedMessages < 0) {
    return "Session metadata dropped-message count is malformed";
  }
  return null;
}

function metadataFromRecord(record) {
  const retention = record.historyRetention ?? {
    bytes: Buffer.byteLength(JSON.stringify(record.history)),
    dropped: 0,
    truncatedRecords: 0,
  };
  return {
    version: METADATA_VERSION,
    id: record.id,
    savedAt: record.savedAt,
    cwd: record.cwd,
    project: record.project,
    messages: record.history.length,
    modelId: record.modelId,
    historyBytes: retention.bytes,
    droppedMessages: retention.dropped,
    truncatedMessages: retention.truncatedRecords ?? 0,
  };
}

function summaryFromMetadata(record, path) {
  return {
    id: record.id,
    path,
    savedAt: record.savedAt,
    cwd: record.cwd,
    project: record.project,
    messages: record.messages,
    modelId: record.modelId,
    historyBytes: record.historyBytes,
    droppedMessages: record.droppedMessages,
    truncatedMessages: record.truncatedMessages ?? 0,
  };
}

function readSessionRecord(path, expectedId, operation, onWarning) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const corrupt = error instanceof SyntaxError;
    emitWarning(
      onWarning,
      structuredWarning(
        operation,
        corrupt ? "session-corrupt" : "session-read-failed",
        `${corrupt ? "Could not parse" : "Could not read"} session ${expectedId}: ${error.message}`,
        path,
      ),
    );
    return null;
  }
  const problem = sessionRecordProblem(record, expectedId);
  if (problem) {
    emitWarning(onWarning, structuredWarning(operation, problem.code, problem.message, path));
    return null;
  }
  return record;
}

function readMetadata(path, expectedId, onWarning) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    emitWarning(
      onWarning,
      structuredWarning(
        "list",
        error instanceof SyntaxError ? "session-metadata-corrupt" : "session-metadata-read-failed",
        `Could not read session metadata ${expectedId}: ${error.message}`,
        path,
      ),
    );
    return null;
  }
  const problem = metadataProblem(record, expectedId);
  if (problem) {
    emitWarning(onWarning, structuredWarning("list", "session-metadata-malformed", problem, path));
    return null;
  }
  return record;
}

/**
 * Persist a session and its small picker-metadata sidecar. Main-record write
 * failure is returned as a structured nonfatal result instead of escaping.
 * @param {*} session
 * @param {{home?: string, now?: number, secretValues?: string[], retention?: import("./contracts.mjs").RetentionOptions, onWarning?: Function|null}} [options]
 */
export function saveSession(
  session = {},
  {
    home = matrixHome(),
    now = Date.now(),
    secretValues = [],
    retention = {},
    onWarning = null,
  } = {},
) {
  const warnings = [];
  const warn = (warning) => {
    warnings.push(warning);
    emitWarning(onWarning, warning);
    return warning;
  };
  let id = null;
  let path = null;
  let dir;
  /** @type {Record<string, any>} */
  let record;
  try {
    dir = sessionsDir(home);
    const requestedId = String(session.id || newRunId(now));
    id = /^[A-Za-z0-9._-]+$/.test(requestedId) ? requestedId : newRunId(now);
    path = join(dir, `${id}.json`);
    ensureDir(dir);
    const redactor = createRedactor({ secretValues });
    const transcript = retainTranscript(session.history ?? [], {
      maxEntries: retention.historyEntries ?? SESSION_RETENTION.historyEntries,
      maxBytes: retention.historyBytes ?? SESSION_RETENTION.historyBytes,
      stringChars: retention.stringChars ?? SESSION_RETENTION.stringChars,
      redactor,
    });
    // Keep lookup/identity fields exact: redacting cwd would make a saved session
    // impossible to resume. Free-form transcript/project payloads are projected.
    record = {
      version: 1,
      id,
      savedAt: now,
      cwd: session.cwd ?? null,
      project: safeJson(session.project, 0, SESSION_RETENTION.historyEntries, { redactor }),
      modelId: session.modelId ?? null,
      history: transcript.history,
      historyRetention: {
        total: transcript.total,
        retained: transcript.retained,
        dropped: transcript.dropped,
        bytes: transcript.bytes,
        truncatedRecords: transcript.truncatedRecords,
      },
      tokenStats: safeJson(
        session.tokenStats ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
        0,
        SESSION_RETENTION.historyEntries,
        { redactor },
      ),
      metrics: safeJson(session.metrics ?? {}, 0, SESSION_RETENTION.historyEntries, { redactor }),
      elapsedMs: session.elapsedMs ?? 0,
    };
    // Exact recovery bytes are private recovery state, not transcript/log data.
    // They bypass redaction and retention so an offered undo can never be made
    // invalid by a privacy/retention projection. Backup files remain mode 0600.
    record.lastPatch =
      session.undoRun == null
        ? safeJson(session.lastPatch ?? null, 0, Infinity, { recovery: true })
        : null;
    record.undoRun =
      session.undoRun == null ? null : safeJson(session.undoRun, 0, Infinity, { recovery: true });
    atomicWrite(path, JSON.stringify(record, null, 2));
  } catch (error) {
    warn(
      structuredWarning(
        "save",
        "session-save-failed",
        `Could not save session: ${error.message}`,
        path,
      ),
    );
    return { path, id, ok: false, warnings };
  }

  try {
    // Later listings read only this small sidecar, never the full transcript.
    atomicWrite(metadataPath(dir, id), JSON.stringify(metadataFromRecord(record), null, 2));
  } catch (error) {
    warn(
      structuredWarning(
        "save",
        "session-metadata-save-failed",
        `Session was saved but its metadata index failed: ${error.message}`,
        path,
      ),
    );
  }

  if (retention.pruneBackups !== false) {
    pruneBackups({
      home,
      maxFiles: retention.backupMaxFiles ?? BACKUP_RETENTION.maxFiles,
      maxTotalBytes: retention.backupMaxTotalBytes ?? BACKUP_RETENTION.maxTotalBytes,
      onWarning: warn,
    });
  }
  return { path, id, ok: true, warnings };
}

export function listSessions({ home = matrixHome(), onWarning = null } = {}) {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    emitWarning(
      onWarning,
      structuredWarning(
        "list",
        "session-list-failed",
        `Could not list sessions: ${error.message}`,
        dir,
      ),
    );
    return [];
  }

  const mainNames = names.filter(
    (name) => name.endsWith(".json") && !name.endsWith(METADATA_SUFFIX),
  );
  const mainSet = new Set(mainNames);
  const metadataNames = new Set(names.filter((name) => name.endsWith(METADATA_SUFFIX)));
  const out = [];
  for (const name of mainNames) {
    const id = name.slice(0, -5);
    const path = join(dir, name);
    const sidecar = metadataPath(dir, id);
    if (metadataNames.has(`${id}${METADATA_SUFFIX}`)) {
      const metadata = readMetadata(sidecar, id, onWarning);
      if (metadata) {
        out.push(summaryFromMetadata(metadata, path));
        continue;
      }
      // A missing/corrupt sidecar is recoverable from the legacy/full record.
    }
    const record = readSessionRecord(path, id, "list", onWarning);
    if (record) out.push(summaryFromMetadata(metadataFromRecord(record), path));
  }
  for (const name of metadataNames) {
    const mainName = `${name.slice(0, -METADATA_SUFFIX.length)}.json`;
    if (!mainSet.has(mainName)) {
      emitWarning(
        onWarning,
        structuredWarning(
          "list",
          "session-metadata-orphaned",
          "Session metadata has no transcript record",
          join(dir, name),
        ),
      );
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));
}

export function loadLatestSession(
  cwd = process.cwd(),
  { home = matrixHome(), onWarning = null } = {},
) {
  const sessions = listSessions({ home, onWarning });
  const match = sessions.find((session) => session.cwd === cwd) ?? null;
  if (!match) {
    emitWarning(
      onWarning,
      structuredWarning("resume", "session-not-found", "No saved session matches this workspace"),
    );
    return null;
  }
  return loadSession(match.id, { home, cwd, onWarning });
}

export function loadSession(id, { home = matrixHome(), cwd = null, onWarning = null } = {}) {
  const safeId = String(id ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(safeId)) {
    emitWarning(
      onWarning,
      structuredWarning("resume", "session-invalid-id", "Session id is invalid"),
    );
    return null;
  }
  const path = join(sessionsDir(home), `${safeId}.json`);
  if (!existsSync(path)) {
    emitWarning(
      onWarning,
      structuredWarning("resume", "session-not-found", `Session ${safeId} does not exist`, path),
    );
    return null;
  }
  const record = readSessionRecord(path, safeId, "resume", onWarning);
  if (!record) return null;
  if (cwd !== null && record.cwd !== cwd) {
    emitWarning(
      onWarning,
      structuredWarning(
        "resume",
        "session-workspace-mismatch",
        `Session ${safeId} belongs to another workspace`,
        path,
      ),
    );
    return null;
  }
  return record;
}

/**
 * Copy a file's current bytes into the backup store before it is modified.
 * Returns the backup path, or null when the file does not exist yet.
 */
export function backupFile(filePath, { home = matrixHome(), now = Date.now() } = {}) {
  if (!existsSync(filePath)) return null;
  const dir = backupsDir(home);
  ensureDir(dir);
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const safeName = basename(filePath).replace(/[^A-Za-z0-9_.-]/g, "_");
  const path = join(dir, `${stamp}-${randomBytes(2).toString("hex")}-${safeName}`);
  const content = readFileSync(filePath);
  const mode = statSync(filePath).mode & 0o777;
  writeFileSync(path, content, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort
  }
  return { path, size: content.length, mode };
}

export function readBackup(path) {
  try {
    return { ok: true, content: readFileSync(path) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export function removeBackup(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function recoveryReferences(home, onWarning, operation) {
  const references = { ok: true, backupPaths: new Set(), runIds: new Set() };
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return references;
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    emitWarning(
      onWarning,
      structuredWarning(
        operation,
        "session-retention-scan-failed",
        `Could not inspect recovery references: ${error.message}`,
        dir,
      ),
    );
    references.ok = false;
    return references;
  }

  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(METADATA_SUFFIX)) continue;
    const path = join(dir, name);
    const id = name.slice(0, -5);
    let record;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
      const problem = sessionRecordProblem(record, id);
      if (problem) throw new Error(problem.message);
    } catch (error) {
      // Retention fails closed: an unreadable record might still contain the
      // only reference to a backup needed by an offered undo.
      emitWarning(
        onWarning,
        structuredWarning(
          operation,
          "session-retention-scan-failed",
          `Retention deferred because session ${id} could not be inspected: ${error.message}`,
          path,
        ),
      );
      references.ok = false;
      continue;
    }
    const undoRun = record.undoRun;
    if (undoRun && typeof undoRun === "object" && !Array.isArray(undoRun)) {
      if (typeof undoRun.runId === "string") references.runIds.add(undoRun.runId);
      if (Array.isArray(undoRun.entries)) {
        for (const entry of undoRun.entries) {
          if (entry && typeof entry.backupPath === "string" && entry.backupPath)
            references.backupPaths.add(entry.backupPath);
        }
      }
    }
    const lastPatch = record.lastPatch;
    if (lastPatch && typeof lastPatch === "object" && !Array.isArray(lastPatch)) {
      if (typeof lastPatch.runId === "string") references.runIds.add(lastPatch.runId);
      if (typeof lastPatch.backupPath === "string" && lastPatch.backupPath)
        references.backupPaths.add(lastPatch.backupPath);
    }
  }
  return references;
}

function pruneDirectory({
  dir,
  extension = null,
  keep = null,
  maxFiles,
  maxTotalBytes,
  defaultMaxFiles,
  defaultMaxTotalBytes,
  operation,
  onWarning,
  references,
}) {
  const result = { removed: 0, bytes: 0, warnings: [] };
  const warn = (warning) => {
    result.warnings.push(warning);
    emitWarning(onWarning, warning);
  };
  if (!existsSync(dir)) return result;
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    warn(
      structuredWarning(
        operation,
        "retention-scan-failed",
        `Could not inspect retention directory: ${error.message}`,
        dir,
      ),
    );
    return result;
  }

  const files = [];
  let total = 0;
  for (const name of names) {
    if (extension && !name.endsWith(extension)) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      files.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
      total += stat.size;
    } catch (error) {
      if (error.code !== "ENOENT")
        warn(
          structuredWarning(
            operation,
            "retention-scan-failed",
            `Could not stat retained file: ${error.message}`,
            path,
          ),
        );
    }
  }
  const fileLimit = boundedInteger(maxFiles, defaultMaxFiles, { min: 1, allowZero: false });
  const byteLimit = boundedInteger(maxTotalBytes, defaultMaxTotalBytes, {
    min: 1,
    allowZero: false,
  });
  if (files.length <= fileLimit && total <= byteLimit) return result;

  const referenced = references();
  if (!referenced.ok) {
    result.deferred = true;
    return result;
  }
  const protectedPaths = new Set(referenced.paths);
  for (const path of Array.isArray(keep) ? keep : [keep]) {
    if (typeof path === "string" && path) protectedPaths.add(resolve(path));
  }
  const failed = new Set();
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  while (files.length > fileLimit || total > byteLimit) {
    const index = files.findIndex((file) => {
      const key = resolve(file.path);
      return !protectedPaths.has(key) && !failed.has(key);
    });
    if (index < 0) break;
    const oldest = files[index];
    try {
      unlinkSync(oldest.path);
      files.splice(index, 1);
      total -= oldest.size;
      result.removed += 1;
      result.bytes += oldest.size;
    } catch (error) {
      failed.add(resolve(oldest.path));
      warn(
        structuredWarning(
          operation,
          "retention-delete-failed",
          `Could not remove retained file: ${error.message}`,
          oldest.path,
        ),
      );
    }
  }
  return result;
}

/**
 * Prune old run logs while retaining active and undo-referenced run records.
 * @param {{home?: string, keep?: *, maxFiles?: number, maxTotalBytes?: number, onWarning?: Function|null}} [options]
 */
export function pruneRunLogs({
  home = matrixHome(),
  keep = null,
  maxFiles = RUN_LOG_RETENTION.maxFiles,
  maxTotalBytes = RUN_LOG_RETENTION.maxTotalBytes,
  onWarning = null,
} = {}) {
  const operation = "prune-run-logs";
  return pruneDirectory({
    dir: runsDir(home),
    extension: ".jsonl",
    keep,
    maxFiles,
    maxTotalBytes,
    defaultMaxFiles: RUN_LOG_RETENTION.maxFiles,
    defaultMaxTotalBytes: RUN_LOG_RETENTION.maxTotalBytes,
    operation,
    onWarning,
    references: () => {
      const found = recoveryReferences(home, onWarning, operation);
      const paths = new Set();
      if (found.ok) {
        for (const runId of found.runIds) {
          if (/^[A-Za-z0-9._-]+$/.test(runId))
            paths.add(resolve(join(runsDir(home), `${runId}.jsonl`)));
        }
      }
      return { ok: found.ok, paths };
    },
  });
}

/**
 * Prune old backups, never deleting bytes referenced by any saved undo state.
 * @param {{home?: string, keep?: *, maxFiles?: number, maxTotalBytes?: number, onWarning?: Function|null}} [options]
 */
export function pruneBackups({
  home = matrixHome(),
  keep = null,
  maxFiles = BACKUP_RETENTION.maxFiles,
  maxTotalBytes = BACKUP_RETENTION.maxTotalBytes,
  onWarning = null,
} = {}) {
  const operation = "prune-backups";
  return pruneDirectory({
    dir: backupsDir(home),
    keep,
    maxFiles,
    maxTotalBytes,
    defaultMaxFiles: BACKUP_RETENTION.maxFiles,
    defaultMaxTotalBytes: BACKUP_RETENTION.maxTotalBytes,
    operation,
    onWarning,
    references: () => {
      const found = recoveryReferences(home, onWarning, operation);
      const paths = new Set();
      if (found.ok) for (const path of found.backupPaths) paths.add(resolve(path));
      return { ok: found.ok, paths };
    },
  });
}

/**
 * Append one bounded, redacted semantic event to a private run log. Never throws.
 * @param {string} runId
 * @param {import("./contracts.mjs").RunEvent} event
 * @param {{home?: string, secretValues?: string[], retention?: import("./contracts.mjs").RetentionOptions, requireComplete?: boolean, onWarning?: Function|null}} [options]
 */
export function appendRunEvent(
  runId,
  event,
  {
    home = matrixHome(),
    secretValues = [],
    retention = {},
    requireComplete = false,
    onWarning = null,
  } = {},
) {
  try {
    const safeRunId = String(runId ?? "");
    if (!/^[A-Za-z0-9._-]+$/.test(safeRunId)) {
      emitWarning(
        onWarning,
        structuredWarning("run-log", "run-log-invalid-id", "Run id is invalid"),
      );
      return null;
    }
    const dir = runsDir(home);
    ensureDir(dir);
    const path = join(dir, `${safeRunId}.jsonl`);
    const redactor = createRedactor({ secretValues });
    let record = safeJson(
      {
        at: Date.now(),
        ...event,
        runId: safeRunId,
      },
      0,
      retention.eventEntries ?? RUN_LOG_RETENTION.eventEntries,
      { redactor, newest: true },
    );
    let serialized = JSON.stringify(record);
    const maxEventBytes = Math.max(
      1024,
      Math.floor(Number(retention.maxEventBytes) || RUN_LOG_RETENTION.maxEventBytes),
    );
    if (Buffer.byteLength(serialized) + 1 > maxEventBytes) {
      if (requireComplete) {
        emitWarning(
          onWarning,
          structuredWarning(
            "run-log",
            "run-event-too-large",
            "Complete run event exceeds its byte budget",
            path,
          ),
        );
        return null;
      }
      // Never cut JSON in the middle. Preserve only a minimal truthful marker
      // when an arbitrary caller supplies an oversized semantic event.
      record = {
        at: Date.now(),
        runId: safeRunId,
        type: redactor.text(String(event?.type ?? "event")).slice(0, 100),
        truncated: true,
      };
      serialized = JSON.stringify(record);
    }
    writeFileSync(path, `${serialized}\n`, { flag: "a", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
    pruneRunLogs({ ...retention, home, keep: path, onWarning });
    return path;
  } catch (error) {
    emitWarning(
      onWarning,
      structuredWarning(
        "run-log",
        "run-event-save-failed",
        `Could not append run event: ${error.message}`,
      ),
    );
    return null;
  }
}
