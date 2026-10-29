// Explicit, serial integration of retained isolated post-images. Conflict
// analysis and plan approval are separate from the only original-root writer.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import { OUTCOME, withOutcome } from "./outcome.mjs";
import { backupBytes, newRunId } from "./session.mjs";
import { resolveInside } from "./workspace.mjs";
import { writePinnedAtomic } from "./pinned-write.mjs";
import {
  captureManifest,
  captureManifestEntry,
  capturePinnedManifestEntry,
  compareManifestPath,
  diffManifests,
  manifestEntryMap,
  manifestFingerprint,
  readManifestText,
  absoluteManifestPath,
  withManifestParent,
} from "./isolated-manifest.mjs";
import { inspectIsolationRoot } from "./isolated-workspace.mjs";

const PLAN_VERSION = 1;
const MAX_REVIEW_BYTES = 8 * 1024 * 1024;
const ANALYSIS_STATES = new WeakMap();

function pathOrder(left, right) {
  return compareManifestPath(left.path ?? left, right.path ?? right);
}

function changeSupport(change) {
  const { before, after, kind } = change;
  if (kind === "delete" || kind === "type")
    return { supported: false, reason: `${kind} changes are not ordinary undo-compatible edits` };
  if (!after || after.type !== "file" || after.binary || after.utf8 !== true) {
    return {
      supported: false,
      reason: "only complete UTF-8 regular-file post-images can be integrated",
    };
  }
  if (before && (before.type !== "file" || before.binary || before.utf8 !== true)) {
    return {
      supported: false,
      reason: "binary, symlink, directory, and unsupported baselines are not writable edits",
    };
  }
  if (before && before.mode !== after.mode) {
    return { supported: false, reason: "mode-only changes require a separate capability" };
  }
  return { supported: true, reason: null };
}

function publicChange(change) {
  return {
    path: change.path,
    kind: change.kind,
    agentId: change.agentId,
    agentRunId: change.agentRunId,
    workspaceKind: change.workspaceKind,
    before: change.before,
    after: change.after,
    supported: change.supported,
    unsupportedReason: change.unsupportedReason,
  };
}

function validateCompleteManifest(manifest, label) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`${label} manifest is malformed`);
  }
  if (!manifest.complete || manifest.truncated) {
    throw new Error(`${label} manifest is incomplete; integration is unavailable`);
  }
}

/** Analyze all retained agents. Any shared touched path is one conflict. */
export function analyzeIntegration(input) {
  if (!input || typeof input.root !== "string" || !Array.isArray(input.agents)) {
    throw new Error("Integration input is malformed");
  }
  validateCompleteManifest(input.baseManifest, "Original base");
  if (input.agents.length < 1 || input.agents.length > 8) {
    throw new Error("Integration requires one through eight settled agents");
  }
  const original = manifestEntryMap(input.baseManifest);
  const agentIds = new Set();
  const changes = [];

  for (const agent of input.agents) {
    if (!agent?.agentId || agentIds.has(agent.agentId)) {
      throw new Error("Integration agent IDs are missing or duplicated");
    }
    agentIds.add(agent.agentId);
    validateCompleteManifest(agent.before, `${agent.agentId} before`);
    validateCompleteManifest(agent.after, `${agent.agentId} after`);
    if (typeof agent.workspaceRoot !== "string" || !agent.workspaceRoot) {
      throw new Error(`${agent.agentId} has no retained workspace`);
    }
    for (const difference of diffManifests(agent.before, agent.after)) {
      const base = original.get(difference.path) ?? null;
      if (manifestFingerprint(base) !== manifestFingerprint(difference.before)) {
        throw new Error(`Isolated base does not match the original inventory: ${difference.path}`);
      }
      const support = changeSupport(difference);
      changes.push({
        ...difference,
        ...support,
        unsupportedReason: support.reason,
        agentId: agent.agentId,
        agentRunId: agent.agentRunId ?? null,
        workspaceKind: agent.workspaceKind,
        workspaceRoot: agent.workspaceRoot,
        resultStatus: agent.result?.status ?? agent.result?.outcome ?? null,
      });
    }
  }

  const touched = new Map();
  for (const change of changes) {
    if (!touched.has(change.path)) touched.set(change.path, []);
    touched.get(change.path).push(change);
  }
  const conflicts = [];
  const candidates = [];
  const unsupported = [];
  const required = new Set();
  for (const [path, group] of touched) {
    if (group.length > 1) {
      conflicts.push({
        path,
        agents: group.map((change) => change.agentId).sort(),
        changes: group.map(publicChange),
      });
      required.add(path);
    } else if (!group[0].supported) {
      unsupported.push(publicChange(group[0]));
      required.add(path);
    } else {
      candidates.push(publicChange(group[0]));
    }
  }
  conflicts.sort(pathOrder);
  candidates.sort(pathOrder);
  unsupported.sort(pathOrder);

  const analysis = {
    version: PLAN_VERSION,
    batchId: input.batchId,
    root: input.root,
    baseRevision: input.baseRevision ?? null,
    baseManifest: input.baseManifest,
    agents: input.agents.map((agent) => ({
      agentId: agent.agentId,
      agentRunId: agent.agentRunId ?? null,
      workspaceKind: agent.workspaceKind,
      result: agent.result ?? null,
    })),
    changes,
    conflicts,
    candidates,
    unsupported,
    requiredResolutions: [...required].sort(compareManifestPath),
  };
  ANALYSIS_STATES.set(analysis, { fingerprint: JSON.stringify(analysis) });
  return analysis;
}

function stablePlanHashInput(plan) {
  const snapshot = structuredClone(plan);
  delete snapshot.planHash;
  return JSON.stringify(snapshot);
}

function planHash(plan) {
  return createHash("sha256").update(stablePlanHashInput(plan)).digest("hex");
}

function planIntegrityValid(plan, expectedHash) {
  try {
    return (
      typeof expectedHash === "string" &&
      plan?.planHash === expectedHash &&
      planHash(plan) === expectedHash
    );
  } catch {
    return false;
  }
}

function baseDrift(analysis) {
  const current = captureManifest(analysis.root, analysis.baseManifest.limits);
  if (!current.complete)
    return { ok: false, error: "Original base cannot be revalidated completely", drift: [] };
  const before = manifestEntryMap(analysis.baseManifest);
  const after = manifestEntryMap(current);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort(compareManifestPath);
  const drift = paths.filter(
    (path) =>
      manifestFingerprint(before.get(path) ?? null) !==
      manifestFingerprint(after.get(path) ?? null),
  );
  const inspected = inspectIsolationRoot(analysis.root);
  if (analysis.baseRevision) {
    if (
      !inspected.ok ||
      inspected.kind !== "worktree" ||
      inspected.git.head !== analysis.baseRevision
    ) {
      return {
        ok: false,
        error: inspected.error ?? "Original git HEAD or clean state drifted from the isolated base",
        drift,
      };
    }
  } else if (!inspected.ok || inspected.kind !== "copy") {
    return {
      ok: false,
      error: inspected.error ?? "Original non-git isolation state changed before integration",
      drift,
    };
  }
  if (drift.length > 0) {
    return { ok: false, error: `Original base drifted at ${drift[0]}`, drift };
  }
  return { ok: true, error: null, drift: [] };
}

function originalPath(root, rel) {
  const resolved = resolveInside(root, rel);
  if (!resolved.ok) throw new Error(resolved.error);
  const lexical = absoluteManifestPath(root, rel);
  if (resolved.path !== lexical || resolved.rel !== rel) {
    throw new Error(`Original path is not a direct contained entry: ${rel}`);
  }
  return lexical;
}

function assertOriginalEntry(root, expected, rel) {
  const absolute = originalPath(root, rel);
  const current = captureManifestEntry(root, rel);
  if (manifestFingerprint(current) !== manifestFingerprint(expected)) {
    throw new Error(`Original base changed immediately before integration: ${rel}`);
  }
  return { absolute, current };
}

function verificationPending() {
  return {
    verified: false,
    verificationStatus: "unverified",
    skipped: true,
    processOk: false,
    summary: "Combined verification requires a separate test approval and execution decision",
  };
}

function undoRunFor(plan, entries) {
  return {
    version: 1,
    runId: plan.integrationRunId,
    entries: entries.map((entry) => ({
      file: entry.file,
      absPath: entry.absPath,
      original: entry.original,
      updatedText: entry.updatedText,
      patch: "",
      stats: { adds: 0, dels: 0 },
      backupPath: entry.backupPath,
      isCreation: entry.isCreation,
      appliedAt: entry.appliedAt,
    })),
  };
}

/** Add independently obtained verification evidence; this never executes tests. */
export function classifyCombinedVerification(result, verification) {
  const complete = result.integrationStatus === "integrated";
  const outcome = withOutcome({
    verification,
    hasAppliedEdits: result.applied?.length > 0,
    error: complete ? false : true,
    failure: complete ? null : (result.error ?? "Integration is incomplete"),
  });
  return {
    ...result,
    ...outcome,
    verification,
    verificationStatus: verification?.verificationStatus ?? outcome.status,
  };
}

/**
 * Coordinator with no unapproved write method. `integrateApproved()` consumes a
 * resolved one-shot broker grant for the exact final plan hash.
 */
export function createIntegrationCoordinator({
  root,
  home,
  broker,
  onEvent = null,
  onUndo = null,
  beforeWrite = null,
  publication = null,
  signal = null,
  writeFile = (path, content, entry) =>
    writePinnedAtomic(path, content, entry.after.mode, { createOnly: entry.before === null }),
  backup = backupBytes,
  now = () => Date.now(),
} = {}) {
  if (typeof root !== "string" || !root) throw new Error("Integration root is required");
  if (typeof home !== "string" || !home) throw new Error("Integration MATRIX_HOME is required");
  if (!broker || typeof broker.issue !== "function" || typeof broker.consume !== "function") {
    throw new Error("Integration requires an independent approval broker");
  }
  const plans = new WeakMap();
  const publicationTarget = structuredClone(publication);

  const publish = (plan, type, fields = {}) => {
    if (typeof onEvent !== "function") return;
    try {
      onEvent(
        structuredClone({
          type,
          at: now(),
          batchId: plan.batchId,
          agentId: null,
          agentRunId: null,
          approvalId: plans.get(plan)?.approvalId ?? null,
          workspaceKind: "original",
          planHash: plan.planHash,
          ...fields,
        }),
      );
    } catch {
      // Persistence/render observers cannot authorize or roll back writes.
    }
  };

  function analyze(input) {
    if (input.root !== root) throw new Error("Integration root does not match the retained batch");
    return analyzeIntegration(input);
  }

  function createPlan(analysis, { resolutions = [] } = {}) {
    if (!ANALYSIS_STATES.has(analysis) || analysis.root !== root) {
      throw new Error("Integration analysis is foreign or has the wrong root");
    }
    try {
      if (JSON.stringify(structuredClone(analysis)) !== ANALYSIS_STATES.get(analysis).fingerprint) {
        throw new Error("Integration analysis changed after conflict detection");
      }
    } catch {
      throw new Error("Integration analysis changed after conflict detection");
    }
    if (!Array.isArray(resolutions)) throw new Error("Integration resolutions must be an array");
    const required = new Set(analysis.requiredResolutions);
    const supplied = new Map();
    for (const resolution of resolutions) {
      const path = resolution?.path;
      if (!required.has(path) || supplied.has(path)) {
        throw new Error(`Unexpected or duplicate conflict resolution: ${path}`);
      }
      if (resolution.source === "base") {
        supplied.set(path, { path, source: "base", agentId: null });
      } else if (resolution.source === "agent" && typeof resolution.agentId === "string") {
        supplied.set(path, { path, source: "agent", agentId: resolution.agentId });
      } else {
        throw new Error(`Conflict resolution must explicitly select base or agent: ${path}`);
      }
    }
    for (const path of required) {
      if (!supplied.has(path)) throw new Error(`Unresolved integration conflict: ${path}`);
    }

    const selected = analysis.candidates.map((candidate) =>
      analysis.changes.find(
        (change) => change.path === candidate.path && change.agentId === candidate.agentId,
      ),
    );
    for (const path of required) {
      const resolution = supplied.get(path);
      if (resolution.source === "base") continue;
      const candidatesForPath = analysis.changes.filter((change) => change.path === path);
      const change = candidatesForPath.find(
        (candidate) => candidate.agentId === resolution.agentId,
      );
      if (!change) throw new Error(`Resolution agent did not touch ${path}`);
      if (!change.supported) {
        throw new Error(`Unsafe ${path} change cannot be selected; resolve it to base explicitly`);
      }
      selected.push(change);
    }
    selected.sort(pathOrder);
    if (selected.length === 0)
      throw new Error("Integration plan contains no approved edit candidates");

    const plan = {
      version: PLAN_VERSION,
      batchId: analysis.batchId,
      root,
      baseRevision: analysis.baseRevision,
      baseManifest: analysis.baseManifest,
      resolutions: [...supplied.values()].sort(pathOrder),
      entries: selected.map((change) => ({
        path: change.path,
        kind: change.kind,
        agentId: change.agentId,
        agentRunId: change.agentRunId,
        workspaceKind: change.workspaceKind,
        workspaceRoot: change.workspaceRoot,
        before: change.before,
        after: change.after,
      })),
      integrationRunId: `integration-${newRunId(now())}`,
      createdAt: now(),
    };
    if (publicationTarget)
      plan.publication = {
        ...publicationTarget,
        ref: `refs/heads/matrix/parallel/${plan.integrationRunId}`,
      };
    plan.planHash = planHash(plan);
    plans.set(plan, {
      analysis,
      expectedHash: plan.planHash,
      status: "planned",
      approvalId: null,
      appliedEntries: [],
      result: null,
    });
    return plan;
  }

  function requestApproval(plan) {
    const state = plans.get(plan);
    if (!state || state.status !== "planned" || !planIntegrityValid(plan, state.expectedHash)) {
      throw new Error("Integration plan changed or is not awaiting its final approval");
    }
    const drift = baseDrift(plan);
    if (!drift.ok) throw new Error(drift.error);
    const reviewBytes = plan.entries.reduce(
      (total, entry) => total + (entry.before?.size ?? 0) + entry.after.size,
      0,
    );
    if (reviewBytes > MAX_REVIEW_BYTES) {
      throw new Error("Integration review exceeds its byte budget");
    }
    // Supply the exact before and after text for an informed final decision.
    // readManifestText validates each post-image against its captured hash.
    const changes = plan.entries.map((entry) => ({
      path: entry.path,
      agentId: entry.agentId,
      original: entry.before ? readManifestText(root, entry.before) : "",
      updatedText: readManifestText(entry.workspaceRoot, entry.after),
    }));
    const request = broker.issue({
      agentId: "integration",
      kind: "integration",
      workspaceKind: "original",
      request: {
        planHash: plan.planHash,
        batchId: plan.batchId,
        destination: root,
        publication: plan.publication ?? null,
        paths: plan.entries.map((entry) => entry.path),
        changes,
        resolutions: plan.resolutions,
      },
    });
    state.approvalId = request.approvalId;
    state.status = "waiting";
    return { approvalId: request.approvalId, planHash: plan.planHash, kind: "integration" };
  }

  function integrateApproved(plan, { approvalId } = {}) {
    const state = plans.get(plan);
    const pendingPaths = plan?.entries?.map((entry) => entry.path) ?? [];
    if (
      !state ||
      state.status !== "waiting" ||
      state.approvalId !== approvalId ||
      !planIntegrityValid(plan, state.expectedHash)
    ) {
      return {
        ok: false,
        status: OUTCOME.FAILED,
        integrationStatus: "approval-required",
        writeOk: false,
        error: "A final integration plan and explicit approval are required",
        applied: [],
        pending: pendingPaths,
        undoRun: null,
      };
    }
    const approved = broker.inspect({ agentId: "integration", approvalId, kind: "integration" });
    if (
      !approved ||
      approved.request?.planHash !== plan.planHash ||
      !broker.consume({ agentId: "integration", approvalId, kind: "integration" })
    ) {
      return {
        ok: false,
        status: OUTCOME.FAILED,
        integrationStatus: "approval-required",
        writeOk: false,
        error: "Integration approval is stale, resolved incorrectly, or already consumed",
        applied: [],
        pending: pendingPaths,
        undoRun: null,
      };
    }

    // From this point onward, callbacks cannot change the approved plan while
    // serial writes and recovery records are being produced.
    plan = structuredClone(plan);
    plans.set(plan, state);
    state.status = "applying";
    publish(plan, "integration:started", { paths: pendingPaths });
    if (signal?.aborted) return finishFailure(plan, "Integration was aborted");
    const drift = baseDrift(plan);
    if (!drift.ok) return finishFailure(plan, drift.error, [], drift);
    if (typeof beforeWrite === "function") {
      try {
        beforeWrite(structuredClone(plan));
      } catch (error) {
        return finishFailure(
          plan,
          `Recovery persistence failed before integration: ${error.message}`,
        );
      }
    }

    for (let index = 0; index < plan.entries.length; index += 1) {
      if (signal?.aborted) return finishFailure(plan, "Integration was aborted");
      const entry = plan.entries[index];
      let backupPath = null;
      let wrote = false;
      let undoEntry = null;
      let absolute = null;
      let original = "";
      let updatedText = "";
      try {
        updatedText = readManifestText(entry.workspaceRoot, entry.after);
        withManifestParent(root, entry.path, (pinnedPath) => {
          let validated = assertOriginalEntry(root, entry.before, entry.path);
          absolute = validated.absolute;
          const pinned = capturePinnedManifestEntry(pinnedPath, entry.path);
          if (manifestFingerprint(pinned) !== manifestFingerprint(entry.before)) {
            throw new Error(`Pinned original changed before integration: ${entry.path}`);
          }
          original = validated.current ? readManifestText(root, validated.current) : "";
          if (validated.current) {
            const saved = backup(entry.path, Buffer.from(original, "utf8"), {
              home,
              now: now(),
              mode: entry.before.mode,
            });
            if (!saved?.path) throw new Error(`Could not back up ${entry.path}`);
            backupPath = saved.path;
          }
          validated = assertOriginalEntry(root, entry.before, entry.path);
          const currentPinned = capturePinnedManifestEntry(pinnedPath, entry.path);
          if (manifestFingerprint(currentPinned) !== manifestFingerprint(entry.before)) {
            throw new Error(
              `Pinned original changed immediately before integration: ${entry.path}`,
            );
          }
          try {
            writeFile(pinnedPath, updatedText, entry);
            wrote = true;
          } catch (error) {
            // The writer may throw after rename. Observe the pinned post-image,
            // never a replacement parent supplied by another process.
            try {
              wrote =
                !(entry.before === null && error.code === "EEXIST") &&
                manifestFingerprint(capturePinnedManifestEntry(pinnedPath, entry.path)) ===
                  manifestFingerprint(entry.after);
            } catch {
              // Preserve the writer's failure.
            }
            if (wrote) {
              try {
                absolute = realpathSync(pinnedPath);
              } catch {
                // Preserve the last known path; the retained backup remains available.
              }
            }
            throw error;
          }
          // A directory can move after validation. Preserve the actual path of
          // any successful write rather than an unsafe replacement path.
          absolute = realpathSync(pinnedPath);
          const current = captureManifestEntry(root, entry.path);
          if (
            absolute !== validated.absolute ||
            manifestFingerprint(current) !== manifestFingerprint(entry.after)
          ) {
            throw new Error(`Integrated post-image validation failed: ${entry.path}`);
          }
          undoEntry = {
            file: entry.path,
            absPath: validated.absolute,
            original,
            updatedText,
            backupPath,
            isCreation: !entry.before,
            appliedAt: now(),
          };
        });
      } catch (error) {
        // A writer can fail after renaming. Publish recovery for that write too;
        // never silently roll it back or report an atomic batch success.
        // Only a successful write or the pinned post-image can establish that
        // this integration applied a change. A replacement path is not evidence.
        if (wrote && !undoEntry && absolute) {
          undoEntry = {
            file: entry.path,
            absPath: absolute,
            original,
            updatedText,
            backupPath,
            isCreation: !entry.before,
            appliedAt: now(),
          };
        }
        const recoveryError = undoEntry ? recordApplied(plan, undoEntry, entry, approvalId) : null;
        return finishFailure(
          plan,
          recoveryError ? `${error.message}; ${recoveryError}` : error.message,
          undoEntry ? [entry.path] : [],
        );
      }
      const recoveryError = recordApplied(plan, undoEntry, entry, approvalId);
      if (recoveryError) return finishFailure(plan, recoveryError);
      if (signal?.aborted) return finishFailure(plan, "Integration was aborted");
    }

    const undoRun = undoRunFor(plan, state.appliedEntries);
    const result = {
      ...withOutcome({
        hasAppliedEdits: state.appliedEntries.length > 0,
        verification: verificationPending(),
        editStatus: "applied",
      }),
      integrationStatus: "integrated",
      writeOk: true,
      error: null,
      planHash: plan.planHash,
      approvalId,
      applied: plan.entries.map((entry) => ({ path: entry.path, agentId: entry.agentId })),
      pending: [],
      undoRun,
      verification: verificationPending(),
      verificationStatus: "unverified",
    };
    state.status = "integrated";
    state.result = result;
    publish(plan, "integration:result", { result });
    return structuredClone(result);
  }

  function recordApplied(plan, undoEntry, entry, approvalId) {
    const state = plans.get(plan);
    state.appliedEntries.push(undoEntry);
    const undoRun = undoRunFor(plan, state.appliedEntries);
    publish(plan, "integration:applied", {
      agentId: entry.agentId,
      agentRunId: entry.agentRunId,
      workspaceKind: entry.workspaceKind,
      path: entry.path,
      absPath: undoEntry.absPath,
      approvalId,
    });
    publish(plan, "integration:undo", { undoRun, approvalId });
    if (typeof onUndo === "function") {
      try {
        const persisted = onUndo(structuredClone(undoRun));
        if (persisted === false) return "Recovery persistence failed after the write";
      } catch (error) {
        return `Recovery persistence failed after the write: ${error.message}`;
      }
    }
    return null;
  }

  function finishFailure(plan, message, extraApplied = [], drift = null) {
    const state = plans.get(plan);
    const appliedPaths = new Set(state.appliedEntries.map((entry) => entry.file));
    for (const path of extraApplied) appliedPaths.add(path);
    const applied = plan.entries
      .filter((entry) => appliedPaths.has(entry.path))
      .map((entry) => ({ path: entry.path, agentId: entry.agentId }));
    const pending = plan.entries
      .filter((entry) => !appliedPaths.has(entry.path))
      .map((entry) => entry.path);
    state.status = applied.length > 0 ? "partial" : "failed";
    const result = {
      ...withOutcome({
        error: true,
        aborted: signal?.aborted === true,
        failure: message,
        hasAppliedEdits: applied.length > 0,
        verification: applied.length > 0 ? verificationPending() : null,
      }),
      integrationStatus: state.status,
      writeOk: false,
      error: message,
      planHash: plan.planHash,
      approvalId: state.approvalId,
      applied,
      pending,
      undoRun: state.appliedEntries.length > 0 ? undoRunFor(plan, state.appliedEntries) : null,
      drift,
      verification: applied.length > 0 ? verificationPending() : null,
      verificationStatus: applied.length > 0 ? "unverified" : "not-run",
    };
    state.result = result;
    publish(plan, "integration:result", { result });
    return structuredClone(result);
  }

  return {
    analyze,
    createPlan,
    requestApproval,
    integrateApproved,
    getPlanState(plan) {
      const state = plans.get(plan);
      return state
        ? {
            status: state.status,
            approvalId: state.approvalId,
            result: structuredClone(state.result),
          }
        : null;
    },
  };
}
