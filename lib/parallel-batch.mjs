// Core isolated fixed-batch orchestration. Each agent gets a fresh project, a
// private lease, and one existing RunController. Original-root integration is
// deliberately implemented only in integration.mjs.

import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { createRunController } from "./controller.mjs";
import { captureManifest, MANIFEST_LIMITS } from "./isolated-manifest.mjs";
import {
  createIsolatedWorkspaceLease,
  inspectIsolationRoot,
  refuseParallelGitMetadata,
  WORKSPACE_SNAPSHOT_LIMITS,
} from "./isolated-workspace.mjs";
import { withOutcome } from "./outcome.mjs";
import { createApprovalBroker } from "./parallel-approvals.mjs";
import {
  createFixedBatchScheduler,
  DEFAULT_MAX_ACTIVE,
  MAX_PARALLEL_AGENTS,
} from "./parallel-scheduler.mjs";
import { detectProject } from "./project.mjs";
import { backupsDir, ensureDir, matrixHome, newRunId } from "./session.mjs";
import { createTestPolicy } from "./test-policy.mjs";

const FORBIDDEN_BATCH_AUTHORITIES = [
  "autoApprove",
  "allowTests",
  "enableCommands",
  "approvedCommandPlanHash",
];

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateJob(job, index) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new Error(`Job ${index + 1} must be an object`);
  }
  if (!String(job.task ?? "").trim()) throw new Error(`Job ${index + 1} has an empty task`);
  for (const key of ["autoApprove", "allowTests", "enableCommands"]) {
    if (job[key] !== undefined && typeof job[key] !== "boolean") {
      throw new Error(`Job ${index + 1} ${key} must be an explicit boolean`);
    }
  }
  if (job.approvedCommandPlanHash != null && typeof job.approvedCommandPlanHash !== "string") {
    throw new Error(`Job ${index + 1} approvedCommandPlanHash must be a string or null`);
  }
  if (!job.enableCommands && job.approvedCommandPlanHash != null) {
    throw new Error(`Job ${index + 1} has command approval without the command capability`);
  }
}

function validateLimits(limits, defaults, label) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new Error(`${label} limits must be an object`);
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in defaults) || !Number.isSafeInteger(value) || value < 1 || value > defaults[key]) {
      throw new Error(`${label} limit ${key} is invalid or exceeds its cap`);
    }
  }
}

function failedExecution(error, signal) {
  return withOutcome({
    error: true,
    failure: error?.message ?? String(error),
    aborted: signal.aborted,
  });
}

/**
 * Start one validated fixed batch. The returned handle has no original-write or
 * integration method. Call `decide()` for exact approvals, `abort()` to cancel,
 * `getIntegrationInput()` after settlement, and `discard()` to release leases.
 */
export function createParallelBatch(options = {}) {
  for (const key of FORBIDDEN_BATCH_AUTHORITIES) {
    if (Object.hasOwn(options, key)) {
      throw new Error(`${key} is per-agent only; batch-wide authority is not inferred`);
    }
  }
  const {
    root,
    jobs,
    batchId = `batch-${newRunId()}`,
    maxActive = DEFAULT_MAX_ACTIVE,
    scratchDir = tmpdir(),
    home = matrixHome(),
    headless = false,
    controllerFactory = createRunController,
    detectProjectImpl = detectProject,
    onEvent = null,
    snapshotLimits = {},
    manifestLimits = {},
  } = options;
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > MAX_PARALLEL_AGENTS) {
    throw new Error(`jobs must contain from 1 through ${MAX_PARALLEL_AGENTS} entries`);
  }
  jobs.forEach(validateJob);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(batchId))) {
    throw new Error("batchId is missing or invalid");
  }
  if (
    !Number.isSafeInteger(Number(maxActive)) ||
    Number(maxActive) < 1 ||
    Number(maxActive) > MAX_PARALLEL_AGENTS
  ) {
    throw new Error(`maxActive must be an integer from 1 through ${MAX_PARALLEL_AGENTS}`);
  }
  validateLimits(snapshotLimits, WORKSPACE_SNAPSHOT_LIMITS, "snapshot");
  validateLimits(manifestLimits, MANIFEST_LIMITS, "manifest");
  if (typeof controllerFactory !== "function" || typeof detectProjectImpl !== "function") {
    throw new Error("Batch controller and project factories are required");
  }
  if (typeof home !== "string" || !home) throw new Error("A parent MATRIX_HOME is required");

  if (process.platform !== "linux") {
    throw new Error("Parallel workspace isolation currently requires Linux");
  }
  const inspection = inspectIsolationRoot(root);
  if (!inspection.ok) throw new Error(inspection.error);
  const sourceRoot = inspection.root;
  const recoveryHome = resolve(home);
  const ambientHome = resolve(matrixHome());
  if (inside(sourceRoot, recoveryHome) || inside(sourceRoot, ambientHome)) {
    throw new Error("Parent and child MATRIX_HOME locations must be outside the original root");
  }
  if (inside(sourceRoot, scratchDir)) {
    throw new Error("Isolation scratch must be outside the original root");
  }
  if (inside(recoveryHome, scratchDir) || inside(scratchDir, recoveryHome)) {
    throw new Error("Batch scratch and parent MATRIX_HOME must be independent");
  }
  const baseManifest = captureManifest(sourceRoot, manifestLimits);
  if (!baseManifest.complete) {
    throw new Error(`Original base manifest is incomplete: ${baseManifest.reasons.join(", ")}`);
  }

  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(scratchDir);
  if (inside(sourceRoot, scratch))
    throw new Error("Isolation scratch escaped its validated location");
  const container = join(scratch, `matrix-${batchId}-${process.pid}-${Date.now()}`);
  mkdirSync(container, { mode: 0o700, recursive: false });
  const leaseScratch = join(container, "leases");
  const homeScratch = join(container, "homes");
  mkdirSync(leaseScratch, { mode: 0o700 });
  mkdirSync(homeScratch, { mode: 0o700 });
  if (inside(recoveryHome, container) || inside(container, recoveryHome)) {
    rmSync(container, { recursive: true, force: true });
    throw new Error("Batch scratch and parent MATRIX_HOME must be independent");
  }

  const runtime = new Map();
  const controllers = new Set();
  let aborted = false;
  let discarding = false;
  let cleanupPromise = null;
  let cleanupResult = null;
  let schedulerDone = null;

  const publish = (event) => {
    if (typeof onEvent !== "function") return;
    try {
      onEvent({
        approvalId: null,
        agentId: null,
        agentRunId: null,
        workspaceKind: null,
        ...event,
        batchId,
        at: event.at ?? Date.now(),
      });
    } catch {
      // Rendering and persistence observers cannot affect child safety gates.
    }
  };

  const broker = createApprovalBroker({ batchId, onEvent: publish });
  const scheduler = createFixedBatchScheduler({ batchId, maxActive, onEvent: publish });

  async function execute(job, context) {
    const state = {
      agentId: context.agentId,
      agentRunId: null,
      workspaceKind: null,
      workspaceRoot: null,
      childHome: null,
      lease: null,
      controller: null,
      before: null,
      after: null,
      result: null,
      recoveryPaths: [],
      currentEditApprovalId: null,
    };
    runtime.set(context.agentId, state);
    const removeAbort = () => context.signal.removeEventListener("abort", abortChild);
    const abortChild = () => state.controller?.abort();
    context.signal.addEventListener("abort", abortChild, { once: true });

    try {
      if (context.signal.aborted) {
        return withOutcome({ aborted: true, failure: "Agent aborted before lease setup" });
      }
      state.childHome = join(homeScratch, context.agentId);
      ensureDir(state.childHome);
      const lease = await createIsolatedWorkspaceLease(sourceRoot, {
        kind: inspection.kind,
        scratchDir: leaseScratch,
        matrixHome: state.childHome,
        limits: snapshotLimits,
        signal: context.signal,
      });
      state.lease = lease;
      state.workspaceKind = lease.kind;
      state.workspaceRoot = lease.root;
      context.setWorkspaceKind(lease.kind);
      if (inside(lease.root, state.childHome) || inside(lease.root, ambientHome)) {
        throw new Error("Child MATRIX_HOME escaped outside the isolated workspace");
      }
      state.before = captureManifest(lease.root, manifestLimits);
      if (!state.before.complete) throw new Error("Isolated base manifest is incomplete");

      // Never reuse the original project index or its absolute test cwd.
      const project = await detectProjectImpl(lease.root, {
        refresh: true,
        exec: refuseParallelGitMetadata,
      });
      if (realpathSync(project.root) !== realpathSync(lease.root)) {
        throw new Error("Fresh isolated project detection selected the wrong root");
      }
      publish({
        type: "workspace:ready",
        agentId: context.agentId,
        agentRunId: null,
        workspaceKind: lease.kind,
        workspaceRoot: lease.root,
        setup: lease.setup,
        project,
      });

      const requestTestApproval = (request) => {
        const approval = broker.issue({
          agentId: context.agentId,
          agentRunId: state.agentRunId,
          workspaceKind: lease.kind,
          kind: "test",
          request,
        });
        return broker.wait({
          agentId: context.agentId,
          approvalId: approval.approvalId,
          kind: "test",
        });
      };
      const requestCommandApproval = (request) => {
        const approval = broker.issue({
          agentId: context.agentId,
          agentRunId: state.agentRunId,
          workspaceKind: lease.kind,
          kind: "command",
          request,
        });
        return broker.wait({
          agentId: context.agentId,
          approvalId: approval.approvalId,
          kind: "command",
        });
      };
      const testPolicy = createTestPolicy({
        home: state.childHome,
        headless,
        allowTests: job.allowTests === true,
        allowStored: false,
      });

      const childEvent = (event) => {
        if (event.runId) {
          state.agentRunId = event.runId;
          context.setAgentRunId(event.runId);
        }
        let approvalId = null;
        if (event.type === "approval:request") {
          const approval = broker.issue({
            agentId: context.agentId,
            agentRunId: state.agentRunId,
            workspaceKind: lease.kind,
            kind: "edit",
            request: { proposal: event.proposal ?? null },
            emit: false,
          });
          approvalId = approval.approvalId;
          state.currentEditApprovalId = approvalId;
          void broker
            .wait({ agentId: context.agentId, approvalId, kind: "edit" })
            .then((decision) => state.controller?.approve(decision));
        } else if (event.type === "approval:result") {
          approvalId = state.currentEditApprovalId;
          state.currentEditApprovalId = null;
        }
        publish({
          ...event,
          agentId: context.agentId,
          agentRunId: event.runId ?? state.agentRunId,
          workspaceKind: lease.kind,
          approvalId,
        });
      };

      const controller = controllerFactory({
        home: state.childHome,
        headless,
        onEvent: childEvent,
        testPolicy,
        onTestTrustRequest: requestTestApproval,
        enableCommands: job.enableCommands === true,
        approvedCommandPlanHash: job.approvedCommandPlanHash ?? null,
        onCommandTrustRequest: requestCommandApproval,
      });
      if (
        !controller ||
        typeof controller.start !== "function" ||
        typeof controller.abort !== "function" ||
        typeof controller.approve !== "function" ||
        controllers.has(controller)
      ) {
        throw new Error("Each agent requires one independent RunController");
      }
      controllers.add(controller);
      state.controller = controller;
      if (context.signal.aborted) {
        controller.abort();
        return withOutcome({ aborted: true, failure: "Agent aborted before controller start" });
      }

      const starting = controller.start({
        task: String(job.task),
        project,
        model: job.model ?? { id: "local" },
        autoApprove: job.autoApprove === true,
        extraContext: job.extraContext ?? null,
      });
      state.agentRunId = controller.currentRun()?.runId ?? state.agentRunId;
      context.setAgentRunId(state.agentRunId);
      const outcome = await starting;
      state.agentRunId = outcome.runId ?? state.agentRunId;
      context.setAgentRunId(state.agentRunId);
      state.result = outcome;
      return {
        ...outcome,
        batchId,
        agentId: context.agentId,
        agentRunId: outcome.runId ?? state.agentRunId,
        workspaceKind: lease.kind,
      };
    } catch (error) {
      state.result = failedExecution(error, context.signal);
      return {
        ...state.result,
        batchId,
        agentId: context.agentId,
        agentRunId: state.agentRunId,
        runId: state.agentRunId,
        workspaceKind: state.workspaceKind,
      };
    } finally {
      if (state.lease) state.after = captureManifest(state.lease.root, manifestLimits);
      const undo = state.controller?.getUndoRun?.();
      state.recoveryPaths = (undo?.entries ?? [])
        .map((entry) => entry.backupPath)
        .filter((path) => typeof path === "string" && path);
      state.controller?.clearUndo?.();
      state.controller?.dispose?.();
      removeAbort();
    }
  }

  async function cleanup() {
    if (cleanupResult?.ok) return cleanupResult;
    if (cleanupPromise) return cleanupPromise;
    const operation = (async () => {
      const failures = [];
      for (const agentId of [...runtime.keys()].sort()) {
        const state = runtime.get(agentId);
        if (state.lease) {
          const result = await state.lease.cleanup();
          if (!result.ok) failures.push(`${agentId}: ${result.error}`);
        }
        for (const path of state.recoveryPaths) {
          const allowed = [backupsDir(state.childHome)];
          if (!allowed.some((directory) => inside(directory, path))) {
            failures.push(`${agentId}: refused to clean an unsafe isolated recovery path`);
            continue;
          }
          try {
            rmSync(path, { force: true });
          } catch (error) {
            failures.push(`${agentId}: recovery cleanup failed: ${error.message}`);
          }
        }
      }
      if (failures.length === 0) {
        try {
          rmSync(container, { recursive: true, force: true });
        } catch (error) {
          failures.push(`batch cleanup failed: ${error.message}`);
        }
      }
      cleanupResult = failures.length
        ? { ok: false, retryable: true, error: failures.join("; "), failures }
        : { ok: true, retryable: false, error: null, failures: [] };
      publish({ type: "workspace:cleanup", ...cleanupResult });
      return cleanupResult;
    })();
    cleanupPromise = operation;
    void operation.then(() => {
      if (cleanupPromise === operation) cleanupPromise = null;
    });
    return operation;
  }

  try {
    schedulerDone = scheduler.start(jobs, execute);
  } catch (error) {
    broker.abort();
    rmSync(container, { recursive: true, force: true });
    throw error;
  }

  const done = (async () => {
    const result = await schedulerDone;
    if (aborted) {
      const cleaned = await cleanup();
      return { ...result, cleanup: cleaned, integrationAvailable: false };
    }
    return { ...result, cleanup: null, integrationAvailable: true };
  })();

  function abort() {
    if (aborted) return false;
    const changed = scheduler.abort();
    if (!changed) return false;
    aborted = true;
    broker.abort("Batch aborted; all pending approvals denied");
    publish({ type: "batch:abort:requested" });
    return true;
  }

  async function discard() {
    const state = scheduler.getState();
    if (state.status !== "settled" && !aborted) abort();
    discarding = true;
    broker.abort("Batch discarded; all pending approvals denied");
    await done;
    return cleanup();
  }

  function getIntegrationInput() {
    const state = scheduler.getState();
    if (state.status !== "settled" || aborted || discarding || cleanupResult) {
      throw new Error(
        "Retained integration snapshots are unavailable until an active batch settles",
      );
    }
    return {
      version: 1,
      batchId,
      root: sourceRoot,
      baseRevision: inspection.git?.head ?? null,
      baseManifest,
      agents: state.agents.map((agent) => {
        const child = runtime.get(agent.agentId);
        if (!child?.before || !child?.after || !child.workspaceRoot) {
          throw new Error(`${agent.agentId} has no complete retained before/after snapshots`);
        }
        return {
          agentId: agent.agentId,
          agentRunId: agent.agentRunId,
          workspaceKind: agent.workspaceKind,
          workspaceRoot: child.workspaceRoot,
          before: child.before,
          after: child.after,
          setup: child.lease.setup,
          result: agent.result,
        };
      }),
    };
  }

  return {
    batchId,
    approvals: broker,
    done,
    abort,
    discard,
    decide: broker.decide,
    pendingApprovals: broker.pending,
    getState: scheduler.getState,
    getIntegrationInput,
    getCleanupResult: () => cleanupResult,
  };
}
