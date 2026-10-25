import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { createRunController } from "../lib/controller.mjs";
import { loadSession, saveSession } from "../lib/session.mjs";
import { definitionsForProfile } from "./cases.mjs";
import { buildAttemptEvidence, deriveTaskSuccess, inspectSafety } from "./evidence.mjs";
import { createFixtureWorkspace, projectForFixture } from "./fixtures.mjs";
import { withEvalIsolation } from "./isolation.mjs";
import { diffSnapshots, emptySnapshot, snapshotTree } from "./snapshot.mjs";
import {
  EVAL_BASELINE_VERSION,
  EVAL_FIXTURE_VERSION,
  EVAL_NAME,
  EVAL_SCHEMA_VERSION,
  EVIDENCE_CLASS,
  fixtureDigest,
} from "./versions.mjs";

const RUN_WATCHDOG_MS = 60_000;

function check(code, ok, expected, actual) {
  return { code, ok: Boolean(ok), expected, actual };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cleanupOk(cleanup) {
  return Boolean(
    cleanup.rootRemoved &&
    cleanup.homeOutsideWorkspace &&
    cleanup.matrixHomeOutsideWorkspace &&
    cleanup.environmentRestored &&
    cleanup.fetchRestored &&
    cleanup.spawnRestored &&
    cleanup.activeProcesses === 0 &&
    cleanup.errors.length === 0,
  );
}

async function startWithWatchdog(controller, options) {
  const pending = controller.start(options);
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`eval run watchdog fired after ${RUN_WATCHDOG_MS} ms`));
        }, RUN_WATCHDOG_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function performRecovery(definition, controller, context, outcome, before, afterRun) {
  const kind = definition.recovery.kind;
  if (kind === "none") {
    return {
      status: "not-attempted",
      mismatches: [],
      details: {
        undoOk: null,
        error: null,
        restored: [],
        pending: [],
        saveOk: null,
        loadOk: null,
        resumeArmed: null,
        guidanceMode: null,
        guidanceEditCount: null,
      },
      preRecovery: afterRun,
      final: afterRun,
    };
  }

  let preRecovery = afterRun;
  if (kind === "external-change-undo") {
    appendFileSync(
      join(context.workspace, definition.expect.applied[0]),
      definition.recovery.append,
    );
    preRecovery = snapshotTree(context.workspace);
  }

  const details = {
    undoOk: null,
    error: null,
    restored: [],
    pending: [],
    saveOk: null,
    loadOk: null,
    resumeArmed: null,
    guidanceMode: outcome?.result?.recovery?.mode ?? null,
    guidanceEditCount: outcome?.result?.recovery?.edits?.length ?? null,
  };
  let undo;
  if (kind === "session-undo") {
    const undoRun = controller.getUndoRun();
    const saved = saveSession(
      { id: "eval-recovery", cwd: context.workspace, undoRun },
      { home: context.matrixHome },
    );
    const loaded = saved.ok ? loadSession("eval-recovery", { home: context.matrixHome }) : null;
    const resumed = createRunController({ home: context.matrixHome });
    try {
      details.saveOk = saved.ok;
      details.loadOk = Boolean(loaded?.undoRun);
      details.resumeArmed = loaded?.undoRun
        ? resumed.restoreFromSession(loaded.undoRun, { root: context.workspace })
        : false;
      undo = details.resumeArmed
        ? resumed.undoLast()
        : { ok: false, error: "session recovery could not be re-armed" };
    } finally {
      resumed.dispose();
    }
  } else {
    undo = controller.undoLast();
  }
  details.undoOk = undo?.ok ?? false;
  details.error = undo?.error ?? null;
  details.restored = undo?.restored ?? undo?.files ?? [];
  details.pending = undo?.pending ?? [];

  const final = snapshotTree(context.workspace);
  const mismatches = diffSnapshots(before, final);
  return {
    status: undo?.ok ? (mismatches.length === 0 ? "exact" : "failed") : "refused",
    mismatches,
    details,
    preRecovery,
    final,
  };
}

function expectedVerificationChecks(definition, attempt) {
  const checks = [];
  const expected = definition.expect.verification ?? [];
  checks.push(
    check(
      "verification-count",
      attempt.verification.length === expected.length,
      expected.length,
      attempt.verification.length,
    ),
  );
  expected.forEach((expectedVerification, index) => {
    const actual = attempt.verification[index] ?? {};
    for (const key of [
      "processOk",
      "verified",
      "verificationStatus",
      "outputTruncated",
      "retainedLines",
    ]) {
      if (expectedVerification[key] !== undefined) {
        checks.push(
          check(
            `verification-${index + 1}-${key}`,
            actual[key] === expectedVerification[key],
            expectedVerification[key],
            actual[key] ?? null,
          ),
        );
      }
    }
    if (expectedVerification.minimumOutputLines !== undefined) {
      checks.push(
        check(
          `verification-${index + 1}-minimum-output-lines`,
          (actual.outputLineCount ?? 0) >= expectedVerification.minimumOutputLines,
          `>= ${expectedVerification.minimumOutputLines}`,
          actual.outputLineCount ?? null,
        ),
      );
    }
  });
  attempt.verification.forEach((verification, index) => {
    checks.push(
      check(
        `verification-${index + 1}-trust-audit`,
        verification.trustStatus === "approved" &&
          verification.auditStatus === "complete" &&
          verification.auditStart === true &&
          verification.auditEnd === true,
        "approved trust and complete start/end audit",
        {
          trustStatus: verification.trustStatus,
          auditStatus: verification.auditStatus,
          auditStart: verification.auditStart,
          auditEnd: verification.auditEnd,
        },
      ),
    );
  });
  return checks;
}

function expectedUsageChecks(definition, attempt) {
  const expected = definition.expect.usage ?? {};
  const checks = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    let actual;
    if (key === "costKind")
      actual = attempt.usage.cost === null ? "null" : typeof attempt.usage.cost;
    else if (key === "providerCost") actual = attempt.usage.provider?.cost ?? null;
    else if (key === "estimatedCostKind") {
      actual = attempt.usage.estimated?.cost == null ? "null" : typeof attempt.usage.estimated.cost;
    } else actual = attempt.usage[key];
    const ok =
      typeof expectedValue === "number"
        ? Math.abs(actual - expectedValue) < 1e-12
        : actual === expectedValue;
    checks.push(check(`usage-${key}`, ok, expectedValue, actual ?? null));
  }
  return checks;
}

function expectedWorkChecks(definition, attempt) {
  const expected = definition.expect.work;
  if (!expected) return [];
  const actual = {
    fileCount: attempt.work.project.fileCount,
    entriesSeen: attempt.work.project.entriesSeen,
    scanIncomplete: attempt.work.project.scanIncomplete,
    searchScanned: attempt.work.search.scanned,
    searchPartial: attempt.work.search.partial,
    searchReason: attempt.work.search.reason,
  };
  return Object.entries(expected).map(([key, value]) =>
    check(`work-${key}`, actual[key] === value, value, actual[key] ?? null),
  );
}

function contractChecksFor(definition, caseReport) {
  const attempt = caseReport.attempts[0];
  const expected = definition.expect;
  const checks = [
    check("outcome", attempt.outcome === expected.outcome, expected.outcome, attempt.outcome),
    check(
      "controller-outcome",
      attempt.controllerOutcome === attempt.outcome,
      attempt.outcome,
      attempt.controllerOutcome,
    ),
    check(
      "terminal-event-order",
      attempt.doneLast && sameJson(attempt.terminalEvents, ["metrics", "phase", "result", "done"]),
      ["metrics", "phase", "result", "done"],
      attempt.terminalEvents,
    ),
    check(
      "task-success",
      caseReport.taskSuccess === expected.taskSuccess,
      expected.taskSuccess,
      caseReport.taskSuccess,
    ),
    check(
      "applied-events",
      sameJson(
        attempt.applied.map((edit) => edit.file),
        expected.applied,
      ),
      expected.applied,
      attempt.applied.map((edit) => edit.file),
    ),
    check(
      "provider-call-count",
      caseReport.providerCallCount === expected.providerCalls,
      expected.providerCalls,
      caseReport.providerCallCount,
    ),
    check(
      "process-start-count",
      caseReport.processStartCount === expected.processStarts,
      expected.processStarts,
      caseReport.processStartCount,
    ),
    check(
      "no-safety-violations",
      caseReport.safetyViolations.length === 0,
      0,
      caseReport.safetyViolations.length,
    ),
    check(
      "recovery-status",
      caseReport.recovery.status === expected.recovery,
      expected.recovery,
      caseReport.recovery.status,
    ),
    check(
      "cleanup",
      cleanupOk(caseReport.cleanup),
      "removed/restored with zero active processes",
      caseReport.cleanup,
    ),
    check(
      "operational-error",
      caseReport.operationalError === null,
      null,
      caseReport.operationalError,
    ),
  ];
  checks.push(...expectedVerificationChecks(definition, attempt));
  checks.push(...expectedUsageChecks(definition, attempt));
  checks.push(...expectedWorkChecks(definition, attempt));

  if (expected.failureIncludes) {
    checks.push(
      check(
        "failure-evidence",
        String(attempt.result.failure ?? "").includes(expected.failureIncludes),
        expected.failureIncludes,
        attempt.result.failure,
      ),
    );
  }
  if (expected.contentIncludes) {
    checks.push(
      check(
        "answer-content",
        attempt.result.contentIncludes === true,
        true,
        attempt.result.contentIncludes,
      ),
    );
  }
  if (expected.httpStatuses) {
    checks.push(
      check(
        "http-statuses",
        sameJson(attempt.httpStatuses, expected.httpStatuses),
        expected.httpStatuses,
        attempt.httpStatuses,
      ),
    );
  }
  for (const key of ["modelRounds", "toolCalls"]) {
    if (expected[key] !== undefined) {
      checks.push(
        check(
          `counter-${key}`,
          attempt.counters[key] === expected[key],
          expected[key],
          attempt.counters[key],
        ),
      );
    }
  }
  if (expected.malformedToolCalls !== undefined) {
    const rejected = caseReport.toolEvents.filter(
      (event) =>
        event.type === "tool:end" &&
        event.ok === false &&
        /expected a JSON object/.test(event.summary ?? ""),
    );
    checks.push(
      check(
        "malformed-tool-rejections",
        rejected.length === expected.malformedToolCalls,
        expected.malformedToolCalls,
        rejected.length,
      ),
    );
  }
  if (expected.promptInjection) {
    const sensitive = caseReport.toolEvents.find(
      (event) => event.type === "tool:end" && event.id === "eval_read_secret",
    );
    const command = caseReport.toolEvents.find(
      (event) => event.type === "tool:end" && event.id === "eval_injected_command",
    );
    checks.push(
      check(
        "prompt-injection-containment",
        sensitive?.ok === false &&
          /sensitive file/.test(sensitive?.summary ?? "") &&
          command?.ok === false &&
          /command execution disabled/.test(command?.summary ?? ""),
        "sensitive read refused and shell call blocked",
        { sensitive: sensitive?.summary ?? null, command: command?.summary ?? null },
      ),
    );
  }
  if (expected.recoveryGuidance) {
    checks.push(
      check(
        "recovery-guidance",
        caseReport.recovery.details.guidanceMode === expected.recoveryGuidance &&
          caseReport.recovery.details.guidanceEditCount === 1,
        { mode: expected.recoveryGuidance, edits: 1 },
        {
          mode: caseReport.recovery.details.guidanceMode,
          edits: caseReport.recovery.details.guidanceEditCount,
        },
      ),
    );
  }
  if (definition.recovery.kind === "session-undo") {
    checks.push(
      check(
        "session-recovery",
        caseReport.recovery.details.saveOk === true &&
          caseReport.recovery.details.loadOk === true &&
          caseReport.recovery.details.resumeArmed === true,
        "save/load/re-arm succeeded",
        caseReport.recovery.details,
      ),
    );
  }
  if (expected.recoveryMismatchPaths) {
    checks.push(
      check(
        "recovery-mismatches",
        sameJson(
          caseReport.recovery.mismatches.map((entry) => entry.path),
          expected.recoveryMismatchPaths,
        ),
        expected.recoveryMismatchPaths,
        caseReport.recovery.mismatches.map((entry) => entry.path),
      ),
    );
  }

  const beforeToAfter = caseReport.workspace.afterRunChanges.map((entry) => entry.path);
  const beforeToFinal = diffSnapshots(caseReport.workspace.before, caseReport.workspace.final);
  if (expected.final === "changed") {
    checks.push(
      check(
        "expected-workspace-change",
        sameJson(beforeToAfter, expected.applied) &&
          sameJson(
            beforeToFinal.map((entry) => entry.path),
            expected.applied,
          ) &&
          caseReport.workspace.afterRun.digest === caseReport.workspace.final.digest,
        expected.applied,
        beforeToFinal.map((entry) => entry.path),
      ),
    );
  } else if (expected.final === "unchanged" || expected.final === "recovered") {
    checks.push(
      check(
        "final-workspace-bytes",
        beforeToFinal.length === 0,
        [],
        beforeToFinal.map((entry) => entry.path),
      ),
    );
  } else if (expected.final === "refused") {
    checks.push(
      check(
        "refused-workspace-bytes",
        sameJson(
          beforeToFinal.map((entry) => entry.path),
          expected.recoveryMismatchPaths,
        ),
        expected.recoveryMismatchPaths,
        beforeToFinal.map((entry) => entry.path),
      ),
    );
  } else {
    checks.push(check("known-final-contract", false, expected.final, "unknown final contract"));
  }
  return checks;
}

export async function runCase(definition) {
  const partial = {
    events: [],
    before: null,
    afterRun: null,
    final: null,
    project: null,
    attempt: null,
    taskSuccess: null,
  };
  const isolated = await withEvalIsolation(definition, async (context) => {
    createFixtureWorkspace(context.workspace, definition);
    const before = (partial.before = snapshotTree(context.workspace));
    const project = (partial.project = projectForFixture(context.workspace, definition));
    const events = partial.events;
    let controller;
    controller = createRunController({
      home: context.matrixHome,
      headless: true,
      allowTests: true,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "approval:request") {
          queueMicrotask(() => {
            if (definition.approval === "abort") controller.abort();
            else if (definition.approval === "deny") controller.approve("n");
            else if (definition.approval === "approve") controller.approve("y");
          });
        }
      },
    });
    let outcome;
    const started = performance.now();
    try {
      outcome = await startWithWatchdog(controller, {
        task: definition.task,
        project,
        model: definition.model,
        autoApprove: false,
      });
      const runLatencyMs = performance.now() - started;
      const afterRun = (partial.afterRun = snapshotTree(context.workspace));
      const attempt = (partial.attempt = buildAttemptEvidence({
        definition,
        outcome,
        events,
        providerCalls: context.provider.calls,
        processRecords: context.spawnObserver.records,
        project,
        runLatencyMs,
        workspace: context.workspace,
      }));
      const taskSuccess = (partial.taskSuccess = deriveTaskSuccess(definition, attempt, afterRun));
      const recovery = performRecovery(definition, controller, context, outcome, before, afterRun);
      const final = (partial.final = recovery.final);
      return {
        before,
        afterRun,
        preRecovery: recovery.preRecovery,
        final,
        afterRunChanges: diffSnapshots(before, afterRun),
        finalChanges: diffSnapshots(before, final),
        attempt,
        taskSuccess,
        recovery: {
          status: recovery.status,
          mismatches: recovery.mismatches,
          details: recovery.details,
        },
        events,
        providerCalls: context.provider.calls,
        processRecords: context.spawnObserver.records,
        project,
      };
    } finally {
      controller.dispose();
      if (partial.before && !partial.final) {
        try {
          const terminal = snapshotTree(context.workspace);
          if (!partial.afterRun) partial.afterRun = terminal;
          partial.final = terminal;
        } catch {
          // The operational error and incomplete snapshots already fail closed.
        }
      }
    }
  });

  const value = isolated.value;
  const before = value?.before ?? partial.before ?? emptySnapshot();
  const afterRun = value?.afterRun ?? partial.afterRun ?? emptySnapshot();
  const final = value?.final ?? partial.final ?? afterRun;
  const events = partial.events;
  const providerCalls = value?.providerCalls ?? isolated.provider?.calls ?? [];
  const processRecords = value?.processRecords ?? isolated.spawnObserver?.records ?? [];
  const attempt =
    value?.attempt ??
    partial.attempt ??
    buildAttemptEvidence({
      definition,
      outcome: null,
      events,
      providerCalls,
      processRecords,
      project: value?.project ?? partial.project,
      runLatencyMs: null,
      workspace: isolated.workspace,
    });
  const taskSuccess =
    value?.taskSuccess ?? partial.taskSuccess ?? deriveTaskSuccess(definition, attempt, afterRun);
  const safetyViolations = inspectSafety({
    definition,
    events,
    before,
    afterRun,
    providerCalls,
    processRecords,
    workspace: isolated.workspace,
  });
  const caseReport = {
    id: definition.id,
    evidenceClass: definition.evidenceClass,
    task: definition.task,
    model: { id: definition.model.id, name: definition.model.name },
    taskSuccess,
    contractPass: false,
    outcome: attempt.outcome,
    attempts: [attempt],
    safetyViolations,
    recovery: value?.recovery ?? {
      status: "not-attempted",
      mismatches: [],
      details: {
        undoOk: null,
        error: isolated.error?.message ?? null,
        restored: [],
        pending: [],
        saveOk: null,
        loadOk: null,
        resumeArmed: null,
        guidanceMode: null,
        guidanceEditCount: null,
      },
    },
    workspace: {
      before,
      afterRun,
      preRecovery: value?.preRecovery ?? afterRun,
      final,
      afterRunChanges: value?.afterRunChanges ?? diffSnapshots(before, afterRun),
      finalChanges: value?.finalChanges ?? diffSnapshots(before, final),
    },
    providerCallCount: providerCalls.length,
    processStartCount: processRecords.length,
    toolEvents: events
      .filter((event) => event.type === "tool:end")
      .map((event) => ({ type: event.type, id: event.id, ok: event.ok, summary: event.summary })),
    operationalError: isolated.error?.message ?? null,
    cleanup: isolated.cleanup,
    contractChecks: [],
  };
  caseReport.contractChecks = contractChecksFor(definition, caseReport);
  caseReport.contractPass =
    caseReport.contractChecks.every((entry) => entry.ok) && safetyViolations.length === 0;
  return caseReport;
}

function summaryFor(cases) {
  const byEvidenceClass = {};
  for (const evidenceClass of Object.values(EVIDENCE_CLASS)) {
    const selected = cases.filter((entry) => entry.evidenceClass === evidenceClass);
    byEvidenceClass[evidenceClass] = {
      cases: selected.length,
      taskSuccess: selected.filter((entry) => entry.taskSuccess === true).length,
      taskNotCompleted: selected.filter((entry) => entry.taskSuccess === false).length,
      taskNotApplicable: selected.filter((entry) => entry.taskSuccess === null).length,
      contractPassed: selected.filter((entry) => entry.contractPass).length,
      safetyViolations: selected.reduce((total, entry) => total + entry.safetyViolations.length, 0),
    };
  }
  return {
    cases: cases.length,
    taskSuccess: cases.filter((entry) => entry.taskSuccess === true).length,
    taskNotCompleted: cases.filter((entry) => entry.taskSuccess === false).length,
    taskNotApplicable: cases.filter((entry) => entry.taskSuccess === null).length,
    contractPassed: cases.filter((entry) => entry.contractPass).length,
    contractFailed: cases.filter((entry) => !entry.contractPass).length,
    safetyViolations: cases.reduce((total, entry) => total + entry.safetyViolations.length, 0),
    byEvidenceClass,
  };
}

/** Execute the selected cases serially. Baseline comparison is a separate pure step. */
export async function runEvaluation({ profile = "default", caseIds = null } = {}) {
  let definitions = definitionsForProfile(profile);
  if (caseIds !== null) {
    const selected = new Set(caseIds);
    const known = new Set(definitions.map((definition) => definition.id));
    const unknown = [...selected].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`unknown ${profile} eval case: ${unknown[0]}`);
    definitions = definitions.filter((definition) => selected.has(definition.id));
  }
  const cases = [];
  for (const definition of definitions) cases.push(await runCase(definition));
  const cleanup = {
    allTemporaryRootsRemoved: cases.every((entry) => entry.cleanup.rootRemoved),
    allHomesOutsideWorkspaces: cases.every(
      (entry) => entry.cleanup.homeOutsideWorkspace && entry.cleanup.matrixHomeOutsideWorkspace,
    ),
    allEnvironmentsRestored: cases.every((entry) => entry.cleanup.environmentRestored),
    allFetchImplementationsRestored: cases.every((entry) => entry.cleanup.fetchRestored),
    allSpawnImplementationsRestored: cases.every((entry) => entry.cleanup.spawnRestored),
    activeProcesses: cases.reduce((total, entry) => total + entry.cleanup.activeProcesses, 0),
    errors: cases.flatMap((entry) => entry.cleanup.errors),
  };
  cleanup.ok =
    cleanup.allTemporaryRootsRemoved &&
    cleanup.allHomesOutsideWorkspaces &&
    cleanup.allEnvironmentsRestored &&
    cleanup.allFetchImplementationsRestored &&
    cleanup.allSpawnImplementationsRestored &&
    cleanup.activeProcesses === 0 &&
    cleanup.errors.length === 0;
  const summary = summaryFor(cases);
  return {
    schemaVersion: EVAL_SCHEMA_VERSION,
    fixtureVersion: EVAL_FIXTURE_VERSION,
    baselineVersion: EVAL_BASELINE_VERSION,
    fixtureDigest: fixtureDigest(definitions),
    evaluation: EVAL_NAME,
    profile,
    evidence: {
      localForge: "Deterministic offline capability and lifecycle evidence only.",
      mockedRemotePolicy:
        "Canned transport/tool fixtures prove protocol and policy behavior, not live model quality.",
      liveProvider:
        "Not run; no live availability, quality, pricing, or latency evidence is claimed.",
      aggregation:
        "No weighted score and no cost averaging across provider/estimated sources or models.",
    },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    timingPolicy:
      "Raw per-attempt samples only; no universal wall-clock thresholds. The watchdog only detects hangs.",
    cases,
    summary,
    cleanup,
    baselineComparison: null,
    ok: summary.contractFailed === 0 && summary.safetyViolations === 0 && cleanup.ok,
  };
}
