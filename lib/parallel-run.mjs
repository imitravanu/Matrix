// A UI-independent lifecycle for one isolated parallel run. All edit, test,
// conflict, and integration decisions remain explicit and independently scoped.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { createParallelBatch } from "./parallel-batch.mjs";
import { classifyCombinedVerification, createIntegrationCoordinator } from "./integration.mjs";
import { createIntegrationWorkspace } from "./integration-workspace.mjs";
import { writeIntegrationIntent } from "./integration-intent.mjs";
import {
  integrationPublicationTarget,
  publishIntegrationIntent,
} from "./integration-publication.mjs";
import { withOutcome } from "./outcome.mjs";
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
  let workspace = null;
  let retainWorkspace = false;
  let intentPath = null;
  let intentFingerprint = null;
  let publicationTarget = null;
  let verificationAttempted = false;

  function saveRecovery(undoRun = null) {
    recoverySaved = false;
    const saved = saveSessionImpl(
      {
        id: sessionId,
        cwd: workspace.root,
        integrationIntent: join(dirname(workspace.root), "integration-intent.json"),
        integrationIntentFingerprint: intentFingerprint,
        project: { sourceRoot: root, integrationWorkspace: workspace.root },
        undoRun,
      },
      { home },
    );
    if (!saved.ok) throw new Error(saved.warnings?.at(-1)?.message ?? "session save failed");
    recoverySaved = true;
  }

  function getCoordinator() {
    if (!coordinator) {
      coordinator = createIntegrationCoordinator({
        root: workspace.root,
        home,
        broker: batch.approvals,
        signal: cancellation.signal,
        publication: publicationTarget,
        onEvent,
        beforeWrite(plan) {
          retainWorkspace = true;
          const intent = writeIntegrationIntent(plan);
          intentPath = intent.path;
          intentFingerprint = intent.fingerprint;
          saveRecovery();
        },
        onUndo(undoRun) {
          saveRecovery(undoRun);
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
    const cleaned = await batch.discard();
    if (workspace && !retainWorkspace) {
      const result = workspace.cleanup();
      if (!result.ok) {
        return { ok: false, retryable: true, error: result.error, failures: [result.error] };
      }
      workspace = null;
    }
    return cleaned;
  }

  function analyze() {
    requireActive();
    if (integrated) throw new Error("This batch has already been integrated");
    const input = batch.getIntegrationInput();
    if (!workspace) {
      publicationTarget = integrationPublicationTarget(input.git);
      workspace = createIntegrationWorkspace({
        root,
        baseManifest: input.baseManifest,
        scratchDir: join(home, "parallel-results"),
        home,
        signal: cancellation.signal,
      });
    }
    analysis = getCoordinator().analyze({
      ...input,
      root: workspace.root,
      baseRevision: null,
      baseManifest: workspace.manifest,
    });
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
    return structuredClone({
      ...result,
      recoverySessionId: retainWorkspace && recoverySaved ? sessionId : null,
      resultWorkspace: retainWorkspace ? workspace.root : null,
      intentPath,
    });
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
      const project = detectProject(workspace.root, {
        refresh: true,
        exec: refuseParallelGitMetadata,
      });
      const verification = await runTests(project.test, {
        home,
        cwd: workspace.root,
        allowStored: false,
        requestTestApproval: requestDecision,
        signal: activeSignal,
      });
      integrated = {
        ...classifyCombinedVerification(integrated, verification),
        verificationCurrent: true,
      };
      verificationAttempted = true;
      return structuredClone({
        ...integrated,
        recoverySessionId: retainWorkspace && recoverySaved ? sessionId : null,
        resultWorkspace: workspace.root,
        intentPath,
      });
    })();
    verificationPromise = operation;
    try {
      return await operation;
    } finally {
      verificationRunning = false;
      verificationPromise = null;
    }
  }

  function publish() {
    requireActive();
    if (!integrated || integrated.integrationStatus !== "integrated" || !intentPath)
      throw new Error("Complete approved integration before publication");
    if (!verificationAttempted || verificationRunning)
      throw new Error("Complete the separate test decision before publication");
    let publicationResult;
    try {
      publicationResult = publishIntegrationIntent(intentPath, {
        signal: cancellation.signal,
        expectedFingerprint: intentFingerprint,
      });
    } catch (error) {
      const stale = error.code === "RESULT_DRIFT";
      const priorVerification = integrated.verification;
      const verification =
        stale && integrated.verification
          ? {
              ...integrated.verification,
              verified: false,
              verificationStatus: "unverified",
              summary: "Result changed after verification; previous test evidence is stale",
            }
          : integrated.verification;
      if (stale) {
        integrated = {
          ...withOutcome(integrated, {
            verification,
            verificationCurrent: false,
            status: "unverified",
            error: false,
            failure: null,
          }),
          verification,
          verificationStatus: "unverified",
          verificationCurrent: false,
          priorVerification,
        };
      }
      return {
        ...withOutcome(integrated, {
          error: true,
          failure: error.message,
          aborted: cancellation.signal.aborted,
          verification,
        }),
        ...(stale
          ? {
              verification,
              verificationStatus: "unverified",
              verificationCurrent: false,
              priorVerification,
            }
          : {}),
        publicationStatus: "failed",
        publicationError: error.message,
        resultWorkspace: workspace.root,
        intentPath,
        recoverySessionId: recoverySaved ? sessionId : null,
      };
    }
    return structuredClone({
      ...integrated,
      publication: publicationResult,
      publicationStatus: "published",
      resultWorkspace: workspace.root,
      intentPath,
      recoverySessionId: recoverySaved ? sessionId : null,
    });
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
    publish,
  };
}
