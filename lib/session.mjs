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
import { basename, dirname, join } from "node:path";

export function matrixHome(home = process.env.MATRIX_HOME || join(homedir(), ".matrix")) {
  return home;
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function newRunId(now = Date.now()) {
  return `${new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

function atomicWrite(path, content, mode = 0o600) {
  ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
}

function safeJson(value, depth = 0) {
  if (depth > 8) return "[deep]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => safeJson(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === "function" || typeof val === "symbol") continue;
      out[key] = safeJson(val, depth + 1);
    }
    return out;
  }
  return null;
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

/**
 * Persist a session. Returns the path. The write is atomic so a crash cannot
 * leave a half-written transcript behind.
 */
export function saveSession(session, { home = matrixHome(), now = Date.now() } = {}) {
  const dir = sessionsDir(home);
  ensureDir(dir);
  const id = session.id || newRunId(now);
  const record = safeJson({
    version: 1,
    id,
    savedAt: now,
    cwd: session.cwd,
    project: session.project,
    modelId: session.modelId ?? null,
    history: session.history ?? [],
    tokenStats: session.tokenStats ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    metrics: session.metrics ?? {},
    lastPatch: session.lastPatch ?? null,
    elapsedMs: session.elapsedMs ?? 0,
  });
  const path = join(dir, `${id}.json`);
  atomicWrite(path, JSON.stringify(record, null, 2));
  return { path, id };
}

export function listSessions({ home = matrixHome() } = {}) {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const record = JSON.parse(readFileSync(path, "utf8"));
      out.push({
        id: record.id,
        path,
        savedAt: record.savedAt,
        cwd: record.cwd,
        project: record.project,
        messages: record.history?.length ?? 0,
        modelId: record.modelId,
      });
    } catch {
      // A corrupt session must not take the picker down.
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function loadLatestSession(cwd = process.cwd(), { home = matrixHome() } = {}) {
  const sessions = listSessions({ home });
  const match = sessions.find((s) => s.cwd === cwd) ?? null;
  if (!match) return null;
  try {
    const record = JSON.parse(readFileSync(match.path, "utf8"));
    if (record.version !== 1) return null;
    return record;
  } catch {
    return null;
  }
}

export function loadSession(id, { home = matrixHome(), cwd = null } = {}) {
  const safeId = String(id ?? "");
  if (!/^[A-Za-z0-9._-]+$/.test(safeId)) return null;
  const path = join(sessionsDir(home), `${safeId}.json`);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (record.version !== 1) return null;
    if (cwd !== null && record.cwd !== cwd) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Copy a file's current bytes into the backup store before it is modified.
 * Returns the backup path, or null when the file does not exist yet.
 */
export function backupFile(filePath, { home = matrixHome(), now = Date.now() } = {}) {
  if (!existsSync(filePath)) return null;
  const dir = backupsDir(home);
  ensureDir(dir);
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
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

/** Append one semantic event to a run log. Never throws. */
export function appendRunEvent(runId, event, { home = matrixHome() } = {}) {
  try {
    const dir = runsDir(home);
    ensureDir(dir);
    const path = join(dir, `${runId}.jsonl`);
    const record = safeJson({
      at: Date.now(),
      ...event,
      runId,
    });
    writeFileSync(path, JSON.stringify(record) + "\n", { flag: "a", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}
