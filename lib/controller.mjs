// ============================================================================
// Run controller.
//
// Bridges the agent engines to the UI: one active run, one approval promise,
// an abort path, a semantic event log, and a safety stack that can restore the
// exact bytes that were on disk before the run wrote anything.
// ============================================================================

import { readFileSync, rmSync, statSync } from "node:fs";

import { runLocalAgent } from "./local-agent.mjs";
import { runModelAgent } from "./model-agent.mjs";
import { OUTCOME, classifyOutcome } from "./outcome.mjs";
import { withTestExecutionMetadata } from "./process.mjs";
import { readBackup, appendRunEvent, matrixHome, newRunId, removeBackup } from "./session.mjs";
import {
  createTestPolicy,
  currentTestExecutionContext,
  TEST_ORIGIN,
  withTestExecutionContext,
} from "./test-policy.mjs";
import { resolveInside, writeFileAtomic } from "./workspace.mjs";

/** @typedef {import("./contracts.mjs").RunEvent} RunEvent */
/** @typedef {import("./contracts.mjs").RunController} RunController */
/** @typedef {import("./contracts.mjs").ControllerOptions} ControllerOptions */
/** @typedef {import("./contracts.mjs").ControllerStartOptions} ControllerStartOptions */
/** @typedef {import("./contracts.mjs").ControllerStartResult} ControllerStartResult */

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

function planForLog(plan) {
  return Array.isArray(plan)
    ? plan.map((step) => ({ id: step?.id, title: step?.title, status: step?.status }))
    : [];
}

function proposalForLog(proposal) {
  if (!proposal) return null;
  return {
    file: proposal.file,
    absPath: proposal.absPath,
    scope: proposal.scope,
    stats: proposal.stats,
    reason: proposal.reason,
    isCreation: proposal.isCreation,
  };
}

function verificationForLog(verification) {
  if (!verification) return null;
  return {
    command: verification.command ?? verification.cmd ?? null,
    ok: verification.ok,
    processOk: verification.processOk,
    verified: verification.verified,
    verificationStatus: verification.verificationStatus,
    trustStatus: verification.trustStatus,
    trustReason: verification.trustReason,
    auditStatus: verification.auditStatus,
    executionOrigin: verification.executionOrigin,
    skipped: verification.skipped,
    aborted: verification.aborted,
    timedOut: verification.timedOut,
    passed: verification.passed,
    failed: verification.failed,
    summary: verification.summary,
    durationMs: verification.durationMs,
    outputLineCount: verification.outputLineCount,
    outputTruncated: verification.outputTruncated,
    parseConfident: verification.parseConfident,
    error: typeof verification.error === "string" ? verification.error : null,
  };
}

function resultForLog(result) {
  if (!result) return null;
  return {
    ok: result.ok,
    status: result.status,
    outcome: result.outcome,
    error: result.error,
    failure: result.failure,
    aborted: result.aborted,
    timedOut: result.timedOut,
    budgetExhausted: result.budgetExhausted,
    summary: result.summary,
    modelName: result.modelName,
    usage: result.usage,
    cost: result.cost,
    elapsedMs: result.elapsedMs,
    metrics: result.metrics,
    plan: planForLog(result.plan),
    editFile: result.editFile
      ? {
          path: result.editFile.path,
          status: result.editFile.status,
          stats: result.editFile.stats,
          backupPath: result.editFile.backupPath,
        }
      : null,
    verifyTests: verificationForLog(result.verifyTests),
  };
}

/** Privacy-reviewed run-log projection; live/controller results are unchanged. */
function eventForLog(event) {
  const base = { type: event.type };
  switch (event.type) {
    case "run:start":
      return { ...base, mode: event.mode, model: event.model, modelName: event.modelName };
    case "phase":
      return { ...base, phase: event.phase, detail: event.detail };
    case "plan":
      return { ...base, plan: planForLog(event.plan) };
    case "plan:step":
      return { ...base, index: event.index, status: event.status, plan: planForLog(event.plan) };
    case "proposal":
      return { ...base, proposal: proposalForLog(event.proposal) };
    case "approval:request":
      return { ...base, proposal: proposalForLog(event.proposal) };
    case "approval:result":
      return { ...base, decision: event.decision };
    case "applied":
      return {
        ...base,
        file: event.file,
        absPath: event.absPath,
        stats: event.stats,
        backupPath: event.backupPath,
        isCreation: event.isCreation,
      };
    case "verify:start":
      return { ...base, command: event.command, cwd: event.cwd };
    case "verify:skipped":
      return { ...base, reason: event.reason };
    case "verify:end":
      return { ...base, result: verificationForLog(event.result) };
    case "result":
      return { ...base, result: resultForLog(event.result) };
    case "metrics":
      return { ...base, metrics: event.metrics };
    case "error":
      return { ...base, error: event.error, aborted: event.aborted };
    default:
      return base;
  }
}

function rawFileMatches(path, expectedText) {
  try {
    const expected = Buffer.from(expectedText, "utf8");
    const stat = statSync(path);
    if (!stat.isFile() || stat.size !== expected.length) return { ok: true, matches: false };
    return { ok: true, matches: readFileSync(path).equals(expected) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * @param {ControllerOptions} [options]
 * @returns {RunController}
 */
export function createRunController({
  onEvent = null,
  home = undefined,
  writeUndo = writeFileAtomic,
  testPolicy = null,
  onTestTrustRequest = null,
  headless = false,
  allowTests = false,
} = {}) {
  let listener = onEvent;
  let active = null;
  let approval = null;
  let abortController = null;
  let lastRunEdits = [];
  let lastUndoRunId = null;

  /** @param {RunEvent} event */
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
    appendRunEvent(runId, eventForLog(event), home === undefined ? {} : { home });
  };

  function resolveApproval(decision) {
    if (!approval) return false;
    const resolve = approval;
    approval = null;
    resolve(decision);
    return true;
  }

  function requestApproval(_proposal) {
    return new Promise((resolve) => {
      // A second edit cannot be approved while a previous gate is open.
      if (approval) resolve("n");
      else approval = resolve;
      // The agent emits approval:request itself; this promise is the gate.
    });
  }

  /**
   * @param {Partial<ControllerStartOptions>} [options]
   * @returns {Promise<ControllerStartResult>}
   */
  async function start({
    task,
    project,
    model,
    autoApprove = false,
    extraContext = null,
    testPolicy: runTestPolicy = null,
    requestTestApproval = null,
  } = {}) {
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
    let lastVerification = null;
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

    /** @param {RunEvent} event */
    const wrapped = (event) => {
      if (event.type === "verify:end") lastVerification = event.result ?? null;
      if (event.type === "result" && lastVerification) {
        event = { ...event, result: withTestExecutionMetadata(event.result, lastVerification) };
      }
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
          // Publish before the applied observer runs. The same coalesced array
          // is updated by later writes, so result/done and even an agent failure
          // can never expose the previous run's undo stack after this write.
          lastRunEdits = editsThisRun;
          lastUndoRunId = runId;
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
      const parentContext = currentTestExecutionContext();
      const callback = requestTestApproval ?? onTestTrustRequest;
      let policy = runTestPolicy ?? testPolicy ?? parentContext?.policy ?? null;
      if (!policy) {
        policy = createTestPolicy({
          home: home ?? parentContext?.home ?? matrixHome(),
          headless,
          allowTests,
          requestApproval: callback,
        });
      } else if (callback) {
        policy = policy.withRequestApproval(callback);
      }
      const execute = () =>
        !model || model.id === "local" || model.provider === "matrix"
          ? runLocalAgent(common)
          : runModelAgent({ ...common, model, extraContext });
      const agentResult = await withTestExecutionContext(
        {
          home: home ?? parentContext?.home ?? matrixHome(),
          runId,
          origin: TEST_ORIGIN.MODEL,
          policy,
        },
        execute,
      );
      const result = withTestExecutionMetadata(agentResult, lastVerification);

      const terminal = classifyOutcome(
        result ?? { error: true, failure: "Agent ended without a result" },
      );
      const elapsedMs = result?.elapsedMs ?? result?.metrics?.elapsedMs ?? Date.now() - startedAt;

      return {
        ok: terminal.ok,
        status: terminal.status,
        outcome: terminal.status,
        result,
        runId,
        applied: editsThisRun.length,
        elapsedMs,
      };
    } catch (error) {
      const wasAborted = Boolean(
        active?.aborted || abortController?.signal.aborted || error?.name === "AbortError",
      );
      const status = wasAborted ? OUTCOME.ABORTED : OUTCOME.FAILED;
      wrapped({ type: "error", error: error.message, aborted: wasAborted });
      return {
        ok: false,
        status,
        outcome: status,
        error: error.message,
        runId,
        elapsedMs: Date.now() - startedAt,
      };
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

  function getUndoRun() {
    if (lastRunEdits.length === 0) return null;
    return {
      version: /** @type {1} */ (1),
      runId: lastUndoRunId,
      entries: lastRunEdits.map((edit) => ({
        file: edit.file,
        absPath: edit.absPath,
        original: edit.original ?? null,
        updatedText: edit.updatedText,
        patch: edit.patch ?? "",
        stats: edit.stats ? { ...edit.stats } : { adds: 0, dels: 0 },
        backupPath: edit.backupPath ?? null,
        isCreation: Boolean(edit.isCreation),
        appliedAt: edit.appliedAt ?? null,
      })),
    };
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
      if (edit.isCreation && edit.backupPath) {
        return {
          ok: false,
          error: `Cannot undo ${edit.file}: inconsistent creation backup metadata`,
        };
      }
      const current = rawFileMatches(edit.absPath, edit.updatedText);
      if (!current.ok) {
        return { ok: false, error: `Cannot read ${edit.file}: ${current.error}` };
      }
      if (!current.matches) {
        return {
          ok: false,
          error: `${edit.file} changed after the patch was applied; refusing to overwrite it`,
        };
      }
    }

    const restored = [];
    for (let index = lastRunEdits.length - 1; index >= 0; index -= 1) {
      const edit = lastRunEdits[index];
      let original = edit.originalBytes ?? edit.original;
      if (edit.backupPath) {
        const backup = readBackup(edit.backupPath);
        if (backup.ok) original = backup.content;
      }
      try {
        if (edit.isCreation) {
          rmSync(edit.absPath, { force: true });
        } else {
          writeUndo(edit.absPath, original);
          if (edit.backupPath) removeBackup(edit.backupPath);
        }
        // Journal each success immediately. A later failure leaves only the
        // failed and unattempted entries, with their backups still pending.
        lastRunEdits.splice(index, 1);
        restored.push(edit.file);
      } catch (error) {
        const pending = lastRunEdits.map((entry) => entry.file);
        const message = `Restore failed for ${edit.file}: ${error.message}`;
        if (restored.length > 0) {
          emit({
            type: "undo",
            ok: false,
            files: restored,
            restored,
            pending,
            error: message,
            at: Date.now(),
          });
        }
        return {
          ok: false,
          partial: restored.length > 0,
          error: message,
          restored,
          pending,
        };
      }
    }

    lastUndoRunId = null;
    emit({ type: "undo", files: restored, at: Date.now() });
    return { ok: true, files: restored, restored, pending: [] };
  }

  function lastApplied() {
    return lastRunEdits.length > 0 ? lastRunEdits[lastRunEdits.length - 1] : null;
  }

  /**
   * Re-arm undo from a versioned run record, or migrate one legacy lastPatch.
   * Every target and recovery source is checked before replacing the current
   * stack. Incomplete/ambiguous metadata disables resume undo honestly.
   */
  function restoreFromSession(record, { root = null } = {}) {
    if (active || !record || typeof record !== "object") return false;
    const isRun =
      !record.absPath && (Object.hasOwn(record, "entries") || Object.hasOwn(record, "version"));
    if (
      isRun &&
      (record.version !== 1 || !Array.isArray(record.entries) || record.entries.length === 0)
    ) {
      return false;
    }
    const patches = isRun ? record.entries : [record];
    const restored = [];
    const seenPaths = new Set();

    for (const patch of patches) {
      if (
        !patch ||
        typeof patch.absPath !== "string" ||
        !patch.absPath ||
        typeof patch.updatedText !== "string"
      ) {
        return false;
      }
      if (patch.backupPath != null && typeof patch.backupPath !== "string") return false;
      if (patch.isCreation != null && typeof patch.isCreation !== "boolean") return false;
      if (isRun && typeof patch.isCreation !== "boolean") return false;
      // Old records without creation metadata cannot distinguish a newly
      // created empty-original file from a pre-existing empty file.
      if (!isRun && patch.isCreation == null && !patch.backupPath && patch.original === "")
        return false;
      const isCreation = Boolean(patch.isCreation);
      if (isCreation && patch.backupPath) return false;

      let absPath = patch.absPath;
      let resolvedRel = null;
      if (root) {
        const resolved = resolveInside(root, absPath);
        if (!resolved.ok) return false;
        absPath = resolved.path;
        resolvedRel = resolved.rel;
      }
      if (seenPaths.has(absPath)) return false;
      seenPaths.add(absPath);
      const current = rawFileMatches(absPath, patch.updatedText);
      if (!current.ok || !current.matches) return false;

      let original = typeof patch.original === "string" ? patch.original : null;
      let originalBytes = null;
      if (patch.backupPath) {
        const backup = readBackup(patch.backupPath);
        if (backup.ok) {
          originalBytes = backup.content;
          if (original === null) original = backup.content.toString("utf8");
        }
      }
      if (!isCreation && original === null) return false;
      restored.push({
        file: typeof patch.file === "string" && patch.file ? patch.file : (resolvedRel ?? absPath),
        absPath,
        original: original ?? "",
        originalBytes,
        updatedText: patch.updatedText,
        patch: patch.patch ?? "",
        stats: patch.stats ?? { adds: 0, dels: 0 },
        backupPath: patch.backupPath ?? null,
        isCreation,
        appliedAt: patch.appliedAt ?? Date.now(),
      });
    }

    lastRunEdits = restored;
    lastUndoRunId = typeof record.runId === "string" ? record.runId : null;
    return true;
  }

  function clearUndo() {
    lastRunEdits = [];
    lastUndoRunId = null;
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
    getUndoRun,
    restoreFromSession,
    isRunning,
    isWaitingForApproval,
    currentRun,
    setListener,
    dispose,
  };
}
