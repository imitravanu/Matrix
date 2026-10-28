// A UI-independent lifecycle for one isolated parallel run. All edit, test,
// conflict, and integration decisions remain explicit and independently scoped.
import { realpathSync } from "node:fs";

import { createParallelBatch } from "./parallel-batch.mjs";
import { classifyCombinedVerification, createIntegrationCoordinator } from "./integration.mjs";
import { detectProject } from "./project.mjs";
import { refuseParallelGitMetadata } from "./isolated-workspace.mjs";
import { runTests } from "./process.mjs";
import { matrixHome, saveSession } from "./session.mjs";

export function createParallelRun(options = {}) {
  const {
    root: requestedRoot,
    home = matrixHome(),
    onEvent = null,
    saveSessionImpl = saveSession,
    ...batchOptions
  } = options;
  const root = realpathSync(requestedRoot);
  const batch = createParallelBatch({ root, home, onEvent, ...batchOptions });
  const sessionId = `parallel-${batch.batchId}`;
  let integrated = null;
  let recoverySaved = false;
  let verificationRunning = false;
  let verificationPromise = null;
  const cancellation = new AbortController();
  let coordinator = null;
  let analysis = null;

  function getCoordinator() {
    if (!coordinator) {
      coordinator = createIntegrationCoordinator({
        root,
        home,
        broker: batch.approvals,
        onEvent,
        onUndo(undoRun) {
          recoverySaved = false;
          const saved = saveSessionImpl({ id: sessionId, cwd: root, undoRun }, { home });
          if (!saved.ok) throw new Error(saved.warnings.at(-1)?.message ?? "session save failed");
          recoverySaved = true;
        },
      });
    }
    return coordinator;
  }

  function requireActive() {
    if (cancellation.signal.aborted) throw new Error("Parallel run was aborted");
  }

  function abort() {
    if (cancellation.signal.aborted) return false;
    cancellation.abort();
    batch.abort();
    batch.approvals.abort("Parallel run aborted; all pending approvals denied");
    return true;
  }

  async function discard() {
    abort();
    if (verificationPromise) {
      try {
        await verificationPromise;
      } catch {
        // Cleanup still runs after a failed verification.
      }
    }
    return batch.discard();
  }

  function analyze() {
    requireActive();
    if (integrated) throw new Error("This batch has already been integrated");
    analysis = getCoordinator().analyze(batch.getIntegrationInput());
    return analysis;
  }

  function createPlan(resolutions = []) {
    requireActive();
    if (!analysis) throw new Error("Analyze the settled batch before creating a plan");
    return getCoordinator().createPlan(analysis, { resolutions });
  }

  function requestIntegrationApproval(plan) {
    requireActive();
    return getCoordinator().requestApproval(plan);
  }

  function integrate(plan, approval) {
    requireActive();
    if (integrated) throw new Error("This batch has already been integrated");
    const result = getCoordinator().integrateApproved(plan, approval);
    if (result.applied.length > 0 || result.integrationStatus === "integrated") integrated = result;
    return { ...result, recoverySessionId: result.undoRun && recoverySaved ? sessionId : null };
  }

  async function verify({ requestTestApproval, signal = null } = {}) {
    requireActive();
    if (!integrated || integrated.integrationStatus !== "integrated") {
      throw new Error("Complete integration before combined verification");
    }
    if (verificationRunning) throw new Error("Combined verification is already running");
    if (typeof requestTestApproval !== "function") {
      throw new Error("Combined verification requires an explicit test approval callback");
    }
    verificationRunning = true;
    const activeSignal = signal
      ? AbortSignal.any([signal, cancellation.signal])
      : cancellation.signal;
    const requestDecision = (request) =>
      new Promise((resolve, reject) => {
        if (activeSignal.aborted) {
          resolve("n");
          return;
        }
        const onAbort = () => {
          activeSignal.removeEventListener("abort", onAbort);
          resolve("n");
        };
        activeSignal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve()
          .then(() => (activeSignal.aborted ? "n" : requestTestApproval(request)))
          .then(
            (decision) => {
              activeSignal.removeEventListener("abort", onAbort);
              resolve(decision);
            },
            (error) => {
              activeSignal.removeEventListener("abort", onAbort);
              reject(error);
            },
          );
      });
    const operation = (async () => {
      const project = detectProject(root, { refresh: true, exec: refuseParallelGitMetadata });
      const verification = await runTests(project.test, {
        home,
        cwd: root,
        allowStored: false,
        requestTestApproval: requestDecision,
        signal: activeSignal,
      });
      integrated = classifyCombinedVerification(integrated, verification);
      return {
        ...integrated,
        recoverySessionId: integrated.undoRun && recoverySaved ? sessionId : null,
      };
    })();
    verificationPromise = operation;
    try {
      return await operation;
    } finally {
      verificationRunning = false;
      verificationPromise = null;
    }
  }

  return {
    batchId: batch.batchId,
    done: batch.done,
    getState: batch.getState,
    pendingApprovals: batch.pendingApprovals,
    decide: batch.decide,
    abort,
    discard,
    analyze,
    createPlan,
    requestIntegrationApproval,
    integrate,
    verify,
  };
}
