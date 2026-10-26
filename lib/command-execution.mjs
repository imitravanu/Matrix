// Audited one-shot command execution. Snapshot writes are never imported back,
// and no result from this module creates an applied-edit or undo event.

import { tmpdir } from "node:os";

import {
  COMMAND_ORIGIN,
  COMMAND_POLICY_IDENTITY,
  commandPlanAudit,
  inspectCommandPlan,
} from "./command-policy.mjs";
import {
  createLinuxBwrapBackend,
  LINUX_BWRAP_BACKEND,
  LINUX_RESOURCE_LIMITS,
} from "./linux-bwrap.mjs";
import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from "./linux-snapshot.mjs";
import { classifyOutcome } from "./outcome.mjs";
import { createRedactor, secretValuesFromEnv } from "./redaction.mjs";
import { appendRunEvent, matrixHome, newRunId } from "./session.mjs";

export const COMMAND_STATUS = Object.freeze({
  SUCCEEDED: "succeeded",
  DENIED: "denied",
  FAILED: "failed",
  TIMED_OUT: "timed-out",
  ABORTED: "aborted",
  UNAVAILABLE: "unavailable",
  CLEANUP_FAILED: "cleanup-failed",
  AUDIT_FAILED: "audit-failed",
});
export const COMMAND_OUTPUT_LIMITS = Object.freeze({ lines: 400, lineChars: 16 * 1024 });

const defaultBackend = createLinuxBwrapBackend();

function redactValue(value, redactor) {
  if (typeof value === "string") return redactor.text(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, redactor));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, redactor)]),
    );
  }
  return value;
}

function emptyProcess(status = "not-started") {
  return {
    processStatus: status,
    processOk: false,
    code: null,
    signal: null,
    timedOut: false,
    aborted: status === COMMAND_STATUS.ABORTED,
    durationMs: 0,
    processError: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function outcomeFor(result, failure) {
  const denied = result.commandStatus === COMMAND_STATUS.DENIED;
  const failed = ![COMMAND_STATUS.SUCCEEDED, COMMAND_STATUS.DENIED].includes(result.commandStatus);
  const classified = classifyOutcome({
    denied,
    error: failed,
    failure: failed ? failure : null,
    timedOut: result.timedOut,
    aborted: result.aborted,
  });
  return {
    ok: classified.ok,
    status: classified.status,
    outcome: classified.outcome,
    error: classified.error,
    failure: classified.failure,
  };
}

/**
 * Approve and execute one exact command plan. Trusted embedding options are not
 * plan fields and must never be populated from model JSON.
 */
export async function runSandboxedCommand(
  input,
  {
    workspace,
    policy,
    home = matrixHome(),
    runId = newRunId(),
    executionId = newRunId(),
    signal = null,
    backend = LINUX_BWRAP_BACKEND,
    backendOptions = {},
    timeoutMs = 120_000,
    resourceLimits = {},
    snapshotLimits = {},
    scratchDir = tmpdir(),
    secretValues = [],
    retention = {},
    onWarning = null,
    onLine = null,
    hooks = {},
  } = {},
) {
  const redactor = createRedactor({
    secretValues: [...secretValuesFromEnv(process.env), ...secretValues],
  });
  const audit = {
    decision: false,
    start: false,
    end: false,
    path: null,
    runId,
    executionId,
  };
  let auditStatus = "not-started";
  let auditError = null;
  let cleanupStatus = "not-applicable";
  let cleanupError = null;
  let plan = null;
  let approvalDecision = null;
  let snapshot = null;
  let processResult = emptyProcess();
  let commandStatus;
  let reason = "not-started";
  let detail;
  let stage = "policy";
  let startRequested = false;
  let spawned = false;
  let outputLineCount = 0;
  const lines = [];
  const maxOutputChars = Number.isSafeInteger(resourceLimits.outputChars)
    ? resourceLimits.outputChars
    : LINUX_RESOURCE_LIMITS.outputChars;

  const append = (type, status, fields = {}, includePlan = true) => {
    const path = appendRunEvent(
      runId,
      {
        type: `command:${type}`,
        executionId,
        origin: COMMAND_ORIGIN,
        status,
        stage,
        reason,
        ...fields,
        ...(includePlan && plan ? { commandPlan: commandPlanAudit(plan) } : {}),
      },
      {
        home,
        secretValues: redactor.values,
        retention,
        requireComplete: true,
        onWarning,
      },
    );
    if (path) audit.path = path;
    return Boolean(path);
  };

  const captureLine = (line, stream) => {
    outputLineCount += 1;
    let safe = redactor.text(line);
    if (safe.length > COMMAND_OUTPUT_LIMITS.lineChars) {
      safe = `…${safe.slice(-COMMAND_OUTPUT_LIMITS.lineChars)}`;
    }
    if (lines.length >= COMMAND_OUTPUT_LIMITS.lines) lines.shift();
    lines.push(safe);
    onLine?.(safe, stream);
  };

  try {
    if (signal?.aborted) {
      commandStatus = COMMAND_STATUS.ABORTED;
      processResult = emptyProcess(COMMAND_STATUS.ABORTED);
      reason = "aborted";
      detail = "aborted before command inspection";
    } else {
      const inspected = inspectCommandPlan(input, {
        workspace,
        policyIdentity: policy?.policyIdentity ?? COMMAND_POLICY_IDENTITY,
      });
      if (!inspected.ok) {
        commandStatus = COMMAND_STATUS.DENIED;
        reason = inspected.code;
        detail = inspected.error;
        plan = inspected.plan;
      } else {
        plan = inspected.plan;
        if (!policy || typeof policy.authorize !== "function") {
          commandStatus = COMMAND_STATUS.DENIED;
          reason = "approval-required";
          detail = "a separate command capability and exact per-command approval are required";
        } else {
          let approval;
          try {
            approval = await policy.authorize(input, { workspace, signal });
          } catch {
            approval = {
              ok: false,
              code: "approval-failed",
              reason: "command approval failed",
              plan,
            };
          }
          plan = approval.plan ?? plan;
          if (!approval.ok) {
            commandStatus =
              approval.code === "aborted" ? COMMAND_STATUS.ABORTED : COMMAND_STATUS.DENIED;
            if (commandStatus === COMMAND_STATUS.ABORTED) {
              processResult = emptyProcess(COMMAND_STATUS.ABORTED);
            }
            reason = approval.code ?? "approval-denied";
            detail = approval.reason ?? "command approval was denied";
          } else {
            commandStatus = COMMAND_STATUS.SUCCEEDED;
            reason = "approved";
            detail = null;
            processResult.aborted = false;
            approvalDecision = approval.decision;
          }
        }
      }
    }

    const approved = commandStatus === COMMAND_STATUS.SUCCEEDED;
    audit.decision = append("decision", approved ? "approved" : commandStatus, {
      approval: approved ? approvalDecision : null,
    });
    if (!audit.decision) {
      commandStatus = COMMAND_STATUS.AUDIT_FAILED;
      reason = "decision-audit-failed";
      detail = "command decision audit could not be persisted; execution was not started";
      auditStatus = "decision-failed";
      auditError = detail;
    } else {
      auditStatus = "decision-complete";
    }

    if (audit.decision && approved) await hooks.afterDecision?.();

    if (audit.decision && approved) {
      try {
        if (signal?.aborted) {
          commandStatus = COMMAND_STATUS.ABORTED;
          processResult = emptyProcess(COMMAND_STATUS.ABORTED);
          reason = "aborted";
          detail = "aborted before backend probing";
        } else {
          let selected;
          if (backend !== LINUX_BWRAP_BACKEND) {
            commandStatus = COMMAND_STATUS.UNAVAILABLE;
            processResult = emptyProcess(COMMAND_STATUS.UNAVAILABLE);
            reason = "backend-unsupported";
            detail = `unsupported sandbox backend: ${String(backend).slice(0, 100)}; no unsandboxed fallback exists`;
          } else {
            selected =
              Object.keys(backendOptions).length > 0
                ? createLinuxBwrapBackend(backendOptions)
                : defaultBackend;
            const availability = await selected.probe();
            if (!availability.available) {
              commandStatus = COMMAND_STATUS.UNAVAILABLE;
              processResult = emptyProcess(COMMAND_STATUS.UNAVAILABLE);
              reason = "backend-unavailable";
              detail = availability.reason;
            } else if (signal?.aborted) {
              commandStatus = COMMAND_STATUS.ABORTED;
              processResult = emptyProcess(COMMAND_STATUS.ABORTED);
              reason = "aborted";
              detail = "aborted before workspace snapshot";
            } else {
              stage = "snapshot";
              snapshot = createWorkspaceSnapshot(plan.workspace, {
                scratchDir,
                matrixHome: home,
                limits: snapshotLimits,
                signal,
              });

              // Re-read every live hashed field after copying. The command can
              // subsequently observe only the already-approved private snapshot.
              const fresh = inspectCommandPlan(input, {
                workspace,
                policyIdentity: plan.policyIdentity,
              });
              if (!fresh.ok || fresh.plan.planHash !== plan.planHash) {
                commandStatus = COMMAND_STATUS.DENIED;
                reason = "approval-window-changed";
                detail = "command plan changed before execution; approve the new exact plan";
              } else {
                plan = fresh.plan;
                stage = "start-audit";
                await hooks.beforeStartAudit?.();
                if (signal?.aborted) {
                  commandStatus = COMMAND_STATUS.ABORTED;
                  processResult = emptyProcess(COMMAND_STATUS.ABORTED);
                  reason = "aborted";
                  detail = "aborted before command start audit";
                } else {
                  audit.start = append("start", "started", { backend: selected.name });
                  if (!audit.start) {
                    commandStatus = COMMAND_STATUS.AUDIT_FAILED;
                    reason = "start-audit-failed";
                    detail =
                      "command start audit could not be persisted; execution was not started";
                    auditStatus = "start-failed";
                    auditError = detail;
                  } else {
                    stage = "execution";
                    startRequested = true;
                    const run = await selected.execute(plan, snapshot, {
                      timeoutMs,
                      signal,
                      limits: resourceLimits,
                      onLine: captureLine,
                    });
                    spawned = !run.unavailable && !run.error;
                    run.stdout = redactor.text(run.stdout);
                    run.stderr = redactor.text(run.stderr);
                    run.error = run.error ? redactor.text(run.error) : null;
                    for (const stream of ["stdout", "stderr"]) {
                      if (run[stream].length > maxOutputChars) {
                        run[stream] = run[stream].slice(-maxOutputChars);
                        run[`${stream}Truncated`] = true;
                      }
                    }
                    processResult = {
                      processStatus: run.unavailable
                        ? COMMAND_STATUS.UNAVAILABLE
                        : run.aborted
                          ? COMMAND_STATUS.ABORTED
                          : run.timedOut
                            ? COMMAND_STATUS.TIMED_OUT
                            : run.code === 0 && !run.error
                              ? COMMAND_STATUS.SUCCEEDED
                              : COMMAND_STATUS.FAILED,
                      processOk:
                        !run.unavailable &&
                        !run.error &&
                        !run.aborted &&
                        !run.timedOut &&
                        run.code === 0,
                      code: run.code,
                      signal: run.signal,
                      timedOut: Boolean(run.timedOut),
                      aborted: Boolean(run.aborted),
                      durationMs: run.durationMs,
                      processError: run.error ?? (run.unavailable ? run.reason : null),
                      stdout: run.stdout,
                      stderr: run.stderr,
                      stdoutTruncated: Boolean(run.stdoutTruncated),
                      stderrTruncated: Boolean(run.stderrTruncated),
                    };
                    commandStatus = processResult.processStatus;
                    reason = run.unavailable
                      ? "backend-unavailable"
                      : run.aborted
                        ? "aborted"
                        : run.timedOut
                          ? "timeout"
                          : run.error
                            ? "spawn-failed"
                            : run.code === 0
                              ? "exit-zero"
                              : "exit-nonzero";
                    detail = run.unavailable
                      ? run.reason
                      : (run.error ??
                        (run.code === 0
                          ? null
                          : `command exited with ${run.code ?? run.signal ?? "an error"}`));
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        const wasAborted = signal?.aborted || error.code === "COMMAND_ABORTED";
        commandStatus = wasAborted ? COMMAND_STATUS.ABORTED : COMMAND_STATUS.FAILED;
        processResult = {
          ...emptyProcess(wasAborted ? COMMAND_STATUS.ABORTED : COMMAND_STATUS.FAILED),
          processError: redactor.text(error.message),
        };
        reason = wasAborted
          ? "aborted"
          : stage === "snapshot"
            ? "snapshot-failed"
            : "execution-failed";
        detail = redactor.text(error.message);
        if (error.cleanupError) {
          cleanupStatus = "failed";
          cleanupError = redactor.text(error.cleanupError);
        }
      }
    }
  } catch (error) {
    commandStatus = signal?.aborted ? COMMAND_STATUS.ABORTED : COMMAND_STATUS.FAILED;
    reason = signal?.aborted ? "aborted" : "policy-failed";
    detail = redactor.text(error?.message ?? "command policy failed");
    if (signal?.aborted) processResult = emptyProcess(COMMAND_STATUS.ABORTED);
  }

  if (snapshot) {
    stage = "cleanup";
    try {
      const clean = hooks.cleanupSnapshot ?? cleanupWorkspaceSnapshot;
      const cleaned = await clean(snapshot);
      if (!cleaned?.ok) throw new Error(cleaned?.error ?? "snapshot cleanup failed");
      if (cleanupStatus !== "failed") cleanupStatus = "complete";
    } catch (error) {
      cleanupStatus = "failed";
      cleanupError = redactor.text(error.message);
    }
  }

  if (
    [COMMAND_STATUS.SUCCEEDED, COMMAND_STATUS.DENIED].includes(commandStatus) &&
    cleanupStatus === "failed"
  ) {
    commandStatus = COMMAND_STATUS.CLEANUP_FAILED;
    reason = "cleanup-failed";
    detail = cleanupError;
  }

  if (audit.decision) {
    stage = "end-audit";
    audit.end = append("end", commandStatus, {
      backend: String(backend).slice(0, 100),
      executionRequested: startRequested,
      spawned,
      processStatus: processResult.processStatus,
      processOk: processResult.processOk,
      code: processResult.code,
      signal: processResult.signal,
      timedOut: processResult.timedOut,
      aborted: processResult.aborted,
      durationMs: processResult.durationMs,
      outputTruncated: Boolean(
        processResult.stdoutTruncated ||
        processResult.stderrTruncated ||
        outputLineCount > lines.length,
      ),
      cleanupStatus,
      cleanupError,
      liveWorkspaceChanged: false,
      writes: "discarded",
      undo: "not-applicable",
      error: detail,
    });
    if (!audit.end) {
      auditStatus = audit.start
        ? "end-failed"
        : auditStatus === "start-failed"
          ? "start-failed"
          : "end-failed";
      auditError = "command end audit could not be persisted";
      if ([COMMAND_STATUS.SUCCEEDED, COMMAND_STATUS.DENIED].includes(commandStatus)) {
        commandStatus = COMMAND_STATUS.AUDIT_FAILED;
        reason = "end-audit-failed";
        detail = auditError;
      }
    } else if (audit.start) {
      auditStatus = "complete";
    } else if (auditStatus !== "start-failed") {
      auditStatus = "decision-end-complete";
    }
  }

  if (commandStatus === COMMAND_STATUS.SUCCEEDED && auditStatus !== "complete") {
    commandStatus = COMMAND_STATUS.AUDIT_FAILED;
    reason = "audit-incomplete";
    detail = auditError ?? "command audit is incomplete";
  }

  // Preserve process failure/abort/timeout as primary statuses while exposing
  // cleanup/audit failures independently. Neither can become a clean success.
  processResult.aborted = processResult.aborted || commandStatus === COMMAND_STATUS.ABORTED;

  const safeDetail = detail == null ? null : redactor.text(detail).slice(0, 4096);
  const result = {
    commandStatus,
    reason,
    ...processResult,
    command: plan ? redactor.text(commandPlanAudit(plan).command) : null,
    commandPlan: redactValue(commandPlanAudit(plan), redactor),
    lines,
    outputLineCount,
    outputTruncated: outputLineCount > lines.length,
    liveWorkspaceChanged: false,
    writes: "discarded",
    undo: "not-applicable",
    snapshot: snapshot ? { ...snapshot.stats, cleanupStatus } : { cleanupStatus },
    cleanupStatus,
    cleanupError,
    auditStatus,
    auditError,
    audit: { ...audit, path: audit.path ? redactor.text(audit.path) : null },
  };
  return { ...result, ...outcomeFor(result, safeDetail) };
}
