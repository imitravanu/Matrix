// ============================================================================
// Run controller.
//
// Bridges the agent engines to the UI: one active run, one approval promise,
// an abort path, a semantic event log, and a safety stack that can restore the
// exact bytes that were on disk before the run wrote anything.
// ============================================================================

import { readFileSync, rmSync } from "node:fs";

import { runLocalAgent } from "./local-agent.mjs";
import { runModelAgent } from "./model-agent.mjs";
import { readFileSafe } from "./project.mjs";
import { readBackup, appendRunEvent, newRunId, removeBackup } from "./session.mjs";
import { resolveInside, writeFileAtomic } from "./workspace.mjs";

const LOGGED_EVENTS = new Set([
  "run:start",
  "phase",
  "plan",
  "plan:step",
  "proposal",
  "approval:request",
  "approval:result",
  "applied",
  "verify:start",
  "verify:skipped",
  "verify:end",
  "result",
  "error",
  "done",
  "metrics",
]);

export function createRunController({ onEvent = null, home = undefined } = {}) {
  let listener = onEvent;
  let active = null;
  let approval = null;
  let abortController = null;
  let lastRunEdits = [];
  let lastRun = null;

  const emit = (event) => {
    if (!listener) return;
    try {
      listener(event);
    } catch {
      // A render callback must not take down a run.
    }
  };

  const log = (runId, event) => {
    if (!runId || !LOGGED_EVENTS.has(event.type)) return;
    appendRunEvent(runId, event,home === undefined ? {} : { home });
  };

  function resolveApproval(decision) {
    if (!approval) return false;
    const resolve = approval;
    approval = null;
    resolve(decision);
    return true;
  }

  function requestApproval(proposal) {
    return new Promise((resolve) => {
      // A second edit cannot be approved while a previous gate is open.
      if (approval) resolve("n");
      else approval = resolve;
      // The agent emits approval:request itself; this promise is the gate.
    });
  }

  async function start({ task, project, model, autoApprove = false, extraContext = null } = {}) {
    if (active) {
      return { ok: false, error: "A run is already active" };
    }
    if (!task || !String(task).trim()) {
      return { ok: false, error: "Task is empty" };
    }

    const runId = newRunId();
    abortController = new AbortController();
    const editsThisRun = [];
    const proposals = new Map();
    const startedAt = Date.now();

    active = {
      runId,
      task,
      project,
      model,
      startedAt,
      autoApprove,
      aborted: false,
    };

    const wrapped = (event) => {
      const enriched = { ...event, runId, at: Date.now() };
      if (event.type === "proposal" && event.proposal?.absPath) {
        proposals.set(event.proposal.absPath, event.proposal);
      }
      if (event.type === "applied") {
        const proposal = proposals.get(event.absPath);
        if (proposal) {
          const existing = editsThisRun.find((edit) => edit.absPath === proposal.absPath);
          if (existing) {
            // The same file can be edited more than once in one run. Keep the
            // first original/backup (the only pre-run bytes) and the final
            // text so undo restores the file exactly once.
            existing.updatedText = proposal.updatedText;
            existing.patch = proposal.patch;
            existing.stats = proposal.stats;
            existing.appliedAt = Date.now();
          } else {
            editsThisRun.push({
              file: proposal.file,
              absPath: proposal.absPath,
              original: proposal.original,
              updatedText: proposal.updatedText,
              patch: proposal.patch,
              stats: proposal.stats,
              backupPath: event.backupPath ?? proposal.backupPath ?? null,
              isCreation: Boolean(proposal.isCreation),
              appliedAt: Date.now(),
            });
          }
        }
      }
      log(runId, event);
      emit(enriched);
    };

    const common = {
      task: String(task),
      project,
      onEvent: wrapped,
      requestApproval,
      autoApprove,
      signal: abortController.signal,
    };

    try {
      let result;
      if (!model || model.id === "local" || model.provider === "matrix") {
        result = await runLocalAgent(common);
      } else {
        result = await runModelAgent({ ...common, model, extraContext });
      }

      // A run that made no write must not erase the ability to undo the last
      // patch that did. The denied/no-edit run is still recorded in lastRun,
      // but the undo stack only advances when this run actually applied edits.
      if (editsThisRun.length > 0) lastRunEdits = editsThisRun;
      lastRun = {
        runId,
        task,
        model: model?.id ?? "local",
        result,
        startedAt,
        elapsedMs: Date.now() - startedAt,
      };

      return {
        ok: !result?.error,
        result,
        runId,
        applied: editsThisRun.length,
        elapsedMs: lastRun.elapsedMs,
      };
    } catch (error) {
      wrapped({ type: "error", error: error.message });
      return { ok: false, error: error.message, runId };
    } finally {
      active = null;
      abortController = null;
      if (approval) {
        const resolve = approval;
        approval = null;
        resolve("n");
      }
    }
  }

  function approve(decision) {
    return resolveApproval(decision);
  }

  function abort() {
    if (!active) return false;
    active.aborted = true;
    if (approval) {
      const resolve = approval;
      approval = null;
      resolve("n");
    }
    abortController?.abort();
    emit({ type: "abort:requested", runId: active.runId, at: Date.now() });
    return true;
  }

  function isRunning() {
    return Boolean(active);
  }

  function isWaitingForApproval() {
    return Boolean(approval);
  }

  function currentRun() {
    return active ? { ...active } : null;
  }

  function canUndo() {
    return lastRunEdits.length > 0;
  }

  function undoLast() {
    if (active) return { ok: false, error: "Cannot undo while a run is active" };
    if (lastRunEdits.length === 0) return { ok: false, error: "No applied edits to undo" };

    // Validate every target before touching any, so one changed file blocks
    // the whole multi-file undo before it starts writing.
    for (const edit of lastRunEdits) {
      const current = readFileSafe(edit.absPath);
      if (!current.ok) {
        return { ok: false, error: `Cannot read ${edit.file}: ${current.error}` };
      }
      if (current.content !== edit.updatedText) {
        return {
          ok: false,
          error: `${edit.file} changed after the patch was applied; refusing to overwrite it`,
        };
      }
    }

    const restored = [];
    for (const edit of [...lastRunEdits].reverse()) {
      let original = edit.originalBytes ?? edit.original;
      if (edit.backupPath) {
        const backup = readBackup(edit.backupPath);
        if (backup.ok) original = backup.content;
      }
      try {
        if (edit.isCreation) {
          rmSync(edit.absPath, { force: true });
        } else {
          writeFileAtomic(edit.absPath, original);
          if (edit.backupPath) removeBackup(edit.backupPath);
        }
        restored.push(edit.file);
      } catch (error) {
        return { ok: false, error: `Restore failed for ${edit.file}: ${error.message}`, restored };
      }
    }

    lastRunEdits = [];
    emit({ type: "undo", files: restored, at: Date.now() });
    return { ok: true, files: restored };
  }

  function lastApplied() {
    return lastRunEdits.length > 0 ? lastRunEdits[lastRunEdits.length - 1] : null;
  }

  /**
   * Re-arm undo for a patch restored from a saved session. The stored
   * updatedText is a fingerprint of the file as this workbench left it, so a
   * later external edit is refused instead of silently overwritten.
   */
  function restoreFromSession(patch, { root = null } = {}) {
    if (active) return false;
    if (!patch?.absPath || typeof patch.updatedText !== "string") return false;
    let absPath = patch.absPath;
    if (root) {
      const resolved = resolveInside(root, patch.absPath);
      if (!resolved.ok) return false;
      absPath = resolved.path;
    }
    const current = readFileSafe(absPath);
    if (!current.ok || current.content !== patch.updatedText) return false;
    let original = typeof patch.original === "string" ? patch.original : null;
    let originalBytes = null;
    if (patch.backupPath) {
      const backup = readBackup(patch.backupPath);
      if (backup.ok) {
        originalBytes = backup.content;
        if (original === null) original = backup.content.toString("utf8");
      }
    }
    if (original === null) return false;
    lastRunEdits = [
      {
        file: patch.file,
        absPath,
        original,
        originalBytes,
        updatedText: patch.updatedText,
        patch: patch.patch ?? "",
        stats: patch.stats ?? { adds: 0, dels: 0 },
        backupPath: patch.backupPath ?? null,
        isCreation: Boolean(patch.isCreation),
        appliedAt: Date.now(),
      },
    ];
    return true;
  }

  function clearUndo() {
    lastRunEdits = [];
    lastRun = null;
  }

  function setListener(fn) {
    listener = fn;
  }

  function dispose() {
    if (active) abort();
    listener = null;
  }

  return {
    start,
    approve,
    abort,
    undoLast,
    canUndo,
    clearUndo,
    lastApplied,
    restoreFromSession,
    isRunning,
    isWaitingForApproval,
    currentRun,
    setListener,
    dispose,
  };
}
