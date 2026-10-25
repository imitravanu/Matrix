// Controller-event reduction for the interactive live transcript. The reducer owns
// only the caller-provided mutable live aggregate and returns effect descriptors;
// React state, persistence, swarm projection, and controller calls stay in MatrixApp.

import { retainedOutput, RETAINED_OUTPUT_LIMIT } from "./session-codec.mjs";

/** @typedef {import("../lib/contracts.mjs").LiveRun} LiveRun */
/** @typedef {import("../lib/contracts.mjs").RunEvent} RunEvent */

/**
 * @param {string} task
 * @param {string} modelName
 * @returns {LiveRun}
 */
export function makeLive(task, modelName) {
  return {
    prompt: task,
    task,
    reasoning: "",
    content: "",
    plan: [],
    activePlanIdx: 0,
    readFile: null,
    editFile: null,
    verifyTests: null,
    verifyLines: [],
    toolCards: [],
    phase: "planning",
    detail: "",
    usage: null,
    metrics: null,
    modelName,
    error: false,
    summary: "",
    streaming: true,
  };
}

/** @param {LiveRun|null} live */
function unchanged(live) {
  return { live, bump: null };
}

/**
 * @param {RunEvent} event
 * @param {{live?: LiveRun|null, modelName?: string, autoApprove?: boolean}} [options]
 */
export function reduceRunEvent(
  event,
  { live = null, modelName = "MATRIX", autoApprove = false } = {},
) {
  switch (event.type) {
    case "run:start": {
      const next = makeLive(event.task ?? "", event.modelName ?? modelName);
      next.phase = "planning";
      next.plan = (event.plan ?? []).map((step) => ({ ...step }));
      next.activePlanIdx = 0;
      return { live: next, bump: "immediate", runStart: true };
    }
    case "phase": {
      if (!live) return unchanged(live);
      live.phase = event.phase ?? live.phase;
      if (event.detail) live.detail = event.detail;
      return { live, bump: "throttled" };
    }
    case "plan": {
      if (!live) return unchanged(live);
      live.plan = (event.plan ?? []).map((step) => ({ ...step }));
      live.activePlanIdx = Math.max(
        0,
        (event.plan ?? []).findIndex((step) => step.status === "active"),
      );
      return { live, bump: "immediate" };
    }
    case "plan:step": {
      if (!live) return unchanged(live);
      live.plan = (event.plan ?? live.plan).map((step) => ({ ...step }));
      live.activePlanIdx = Math.max(
        0,
        live.plan.findIndex((step) => step.status === "active"),
      );
      return { live, bump: "immediate" };
    }
    case "thought": {
      if (!live) return unchanged(live);
      live.reasoning += event.text ?? "";
      return { live, bump: "throttled" };
    }
    case "content": {
      if (!live) return unchanged(live);
      live.content += event.text ?? "";
      return { live, bump: "throttled" };
    }
    case "tool:start": {
      if (!live) return unchanged(live);
      live.toolCards.push({
        id: event.id,
        name: event.name,
        label: event.label,
        args: event.args,
        ok: true,
        summary: "running…",
        running: true,
      });
      return { live, bump: "immediate" };
    }
    case "tool:end": {
      if (!live) return unchanged(live);
      const card = live.toolCards.find((item) => item.id === event.id);
      if (card) {
        card.ok = event.ok !== false;
        card.summary = event.summary ?? "";
        card.data = event.data ?? null;
        card.running = false;
      }
      return { live, bump: "immediate" };
    }
    case "proposal": {
      if (!live) return unchanged(live);
      const proposal = event.proposal;
      live.editFile = {
        path: proposal.file,
        scope: proposal.scope,
        diff: proposal.patch?.split("\n").filter(Boolean) ?? [],
        patch: proposal.patch,
        hunks: proposal.hunks,
        stats: proposal.stats,
        status: "pending",
      };
      return { live, bump: "immediate", proposal, showPermission: !autoApprove };
    }
    case "approval:request":
      return { live, bump: null, approvalRequest: true };
    case "approval:result":
      return { live, bump: "immediate", approvalDecision: event.decision, hasApprovalResult: true };
    case "applied": {
      if (live?.editFile) {
        live.editFile = {
          ...live.editFile,
          status: "applied",
          backupPath: event.backupPath ?? null,
        };
      }
      return { live, bump: "immediate" };
    }
    case "verify:start": {
      if (!live) return unchanged(live);
      live.phase = "verifying";
      live.verifyLines = [];
      live.verifyTests = {
        cmd: event.command,
        results: [],
        running: true,
        output: [],
        outputLineCount: 0,
        outputTruncated: false,
        summary: "",
      };
      return { live, bump: "immediate" };
    }
    case "verify:line": {
      if (!live) return unchanged(live);
      live.verifyLines.push(String(event.line ?? ""));
      if (live.verifyLines.length > RETAINED_OUTPUT_LIMIT) live.verifyLines.shift();
      if (live.verifyTests) {
        live.verifyTests.output = live.verifyLines;
        live.verifyTests.outputLineCount = (live.verifyTests.outputLineCount ?? 0) + 1;
        live.verifyTests.outputTruncated =
          live.verifyTests.outputLineCount > live.verifyLines.length;
      }
      return { live, bump: "throttled" };
    }
    case "verify:skipped": {
      if (!live) return unchanged(live);
      live.verifyTests = {
        cmd: null,
        results: [],
        skipped: true,
        summary: event.reason ?? "no test runner",
        output: [],
      };
      return { live, bump: "immediate" };
    }
    case "verify:end": {
      if (!live) return unchanged(live);
      const verify = event.result ?? {};
      live.verifyTests = {
        cmd: verify.command,
        results: (verify.cases ?? []).map((item) => ({ name: item.name, pass: item.pass })),
        passed: verify.passed,
        failed: verify.failed,
        duration: verify.durationMs != null ? `${Math.round(verify.durationMs)}ms` : "",
        output: retainedOutput(verify.lines),
        summary: verify.summary,
        ok: verify.ok,
        processOk: verify.processOk ?? verify.ok,
        verified: verify.verified ?? verify.ok,
        verificationStatus: verify.verificationStatus ?? (verify.ok ? "verified" : "failed"),
        skipped: verify.skipped,
        timedOut: Boolean(verify.timedOut),
        aborted: Boolean(verify.aborted),
        outputLineCount: verify.outputLineCount ?? verify.lines?.length ?? 0,
        outputTruncated: Boolean(verify.outputTruncated),
        testPlan: verify.testPlan ?? null,
        trustStatus: verify.trustStatus ?? null,
        trustReason: verify.trustReason ?? null,
        trustDecision: verify.trustDecision ?? null,
        trustGrants: verify.trustGrants ?? [],
      };
      return { live, bump: "immediate" };
    }
    case "usage": {
      if (live) live.usage = event.usage ?? {};
      return { live, bump: "throttled", tokenSnapshot: event.usage, hasUsage: true };
    }
    case "metrics": {
      if (live) live.metrics = event.metrics;
      return { live, bump: "throttled", metrics: event.metrics ?? {}, hasMetrics: true };
    }
    case "result":
      return { live, bump: null, result: event.result, hasResult: true };
    case "error": {
      const error = event.error ?? "run failed";
      if (live) {
        live.error = true;
        live.summary = error;
      }
      return { live, bump: "immediate", error, hasError: true };
    }
    case "done":
      return { live, bump: "immediate", done: true };
    case "undo": {
      const restoredText = `restored ${event.files?.join(", ") ?? "file"}`;
      const text =
        event.ok === false
          ? `partial undo · ${restoredText} · ${event.error} · pending ${event.pending?.join(", ") ?? "unknown"}; retry /undo`
          : restoredText;
      return { live, bump: null, undoText: text, hasUndo: true };
    }
    default:
      return unchanged(live);
  }
}
