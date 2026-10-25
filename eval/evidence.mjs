import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { classifyOutcome } from "../lib/outcome.mjs";
import { diffSnapshots, snapshotMap } from "./snapshot.mjs";
import { EVIDENCE_CLASS } from "./versions.mjs";

function inside(workspace, path) {
  const rel = relative(resolve(workspace), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function relativePath(workspace, path) {
  if (!inside(workspace, path)) return null;
  return relative(resolve(workspace), resolve(path)).replaceAll("\\", "/");
}

function verificationEvidence(event, sequence) {
  const result = event.result ?? {};
  return {
    sequence,
    processOk: result.processOk ?? null,
    verified: result.verified ?? null,
    verificationStatus: result.verificationStatus ?? null,
    ok: result.ok ?? null,
    trustStatus: result.trustStatus ?? null,
    trustReason: result.trustReason ?? null,
    trustDecision: result.trustDecision ?? null,
    auditStatus: result.auditStatus ?? null,
    auditStart: result.audit?.start ?? null,
    auditEnd: result.audit?.end ?? null,
    executionOrigin: result.executionOrigin ?? null,
    passed: result.passed ?? null,
    failed: result.failed ?? null,
    summary: result.summary ?? null,
    command: result.command ?? null,
    parseConfident: result.parseConfident ?? null,
    outputLineCount: result.outputLineCount ?? null,
    retainedLines: Array.isArray(result.lines) ? result.lines.length : null,
    outputTruncated: result.outputTruncated ?? null,
    stdoutTruncated: result.stdoutTruncated ?? null,
    stderrTruncated: result.stderrTruncated ?? null,
    timedOut: result.timedOut ?? null,
    aborted: result.aborted ?? null,
    durationMs: result.durationMs ?? null,
  };
}

function nullableCost(usage, source) {
  return (usage?.costRounds?.[source] ?? 0) > 0 ? (usage?.[source]?.cost ?? null) : null;
}

export function usageEvidence(definition, result) {
  if (definition.evidenceClass === EVIDENCE_CLASS.LOCAL) {
    return {
      applicability: "not-applicable",
      model: "local",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      cachedTokens: null,
      provenance: "not-applicable",
      cost: null,
      costProvenance: "not-applicable",
      costComplete: null,
      provider: null,
      estimated: null,
      rounds: null,
      costRounds: null,
    };
  }
  const usage = result?.usage ?? result?.metrics?.usage ?? null;
  return {
    applicability: "measured",
    model: definition.model.id,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    cachedTokens: usage?.cached_tokens ?? null,
    provenance: usage?.provenance ?? "unavailable",
    cost: usage?.cost ?? result?.cost ?? null,
    costProvenance: usage?.costProvenance ?? "unavailable",
    costComplete: usage?.costComplete ?? false,
    provider: usage
      ? {
          promptTokens: usage.provider?.prompt_tokens ?? null,
          completionTokens: usage.provider?.completion_tokens ?? null,
          totalTokens: usage.provider?.total_tokens ?? null,
          cachedTokens: usage.provider?.cached_tokens ?? null,
          cost: nullableCost(usage, "provider"),
        }
      : null,
    estimated: usage
      ? {
          promptTokens: usage.estimated?.prompt_tokens ?? null,
          completionTokens: usage.estimated?.completion_tokens ?? null,
          totalTokens: usage.estimated?.total_tokens ?? null,
          cachedTokens: usage.estimated?.cached_tokens ?? null,
          cost: nullableCost(usage, "estimated"),
        }
      : null,
    rounds: usage?.rounds ? { ...usage.rounds } : null,
    costRounds: usage?.costRounds ? { ...usage.costRounds } : null,
  };
}

function searchEvidence(matches) {
  return {
    count: Array.isArray(matches) ? matches.length : null,
    scanned: matches?.scanned ?? null,
    scannedBytes: matches?.scannedBytes ?? null,
    partial: matches?.partial ?? null,
    truncated: matches?.truncated ?? null,
    aborted: matches?.aborted ?? null,
    reason: matches?.reason ?? null,
  };
}

export function workEvidence(project, result) {
  return {
    project: {
      fileCount: project?.fileCount ?? null,
      truncated: project?.truncated ?? null,
      scanIncomplete: project?.scanIncomplete ?? null,
      directoriesSeen: project?.dirsSeen ?? null,
      entriesSeen: project?.entriesSeen ?? null,
    },
    search: searchEvidence(result?.matches),
    local: {
      files: result?.metrics?.files ?? null,
      scopeNodes: result?.metrics?.scopeNodes ?? null,
      scopeParses: result?.metrics?.scopeParses ?? null,
      matches: result?.metrics?.matches ?? null,
    },
  };
}

export function providerCallEvidence(call) {
  return {
    index: call.index,
    url: call.url,
    model: call.model,
    messageCount: call.messageCount,
    requestBytes: call.requestBytes,
    runCommandAdvertised: call.runCommandAdvertised,
    canaryForwarded: call.canaryForwarded,
    status: call.status,
    error: call.error,
  };
}

export function processEvidence(record) {
  return {
    executable: record.executable === process.execPath ? "process.execPath" : record.executable,
    args: [...record.args],
    cwd: record.cwd,
    shell: record.shell,
    detached: record.detached,
    active: record.active,
    code: record.code,
    signal: record.signal,
    error: record.error,
  };
}

export function buildAttemptEvidence({
  definition,
  outcome,
  events,
  providerCalls,
  processRecords,
  project,
  runLatencyMs,
  workspace,
}) {
  const result = outcome?.result ?? null;
  const terminal = classifyOutcome(result ?? outcome ?? { error: true, failure: "no result" });
  const verificationEvents = events.filter((event) => event.type === "verify:end");
  const usage = usageEvidence(definition, result);
  return {
    attempt: 1,
    outcome: terminal.status,
    outcomeOk: terminal.ok,
    controllerOutcome: outcome?.status ?? null,
    result: {
      error: result?.error ?? outcome?.error ?? true,
      failure: result?.failure ?? outcome?.error ?? null,
      summary: result?.summary ?? null,
      contentIncludes: definition.expect.contentIncludes
        ? Boolean(result?.content?.includes(definition.expect.contentIncludes))
        : null,
    },
    applied: events
      .filter((event) => event.type === "applied")
      .map((event) => ({
        file: workspace
          ? (relativePath(workspace, event.absPath) ?? event.file ?? null)
          : (event.file ?? null),
        isCreation: event.isCreation ?? false,
        stats: event.stats ? { ...event.stats } : null,
      })),
    verification: verificationEvents.map((event, index) => verificationEvidence(event, index + 1)),
    usage,
    work: workEvidence(project, result),
    counters: {
      httpAttempts: providerCalls.length,
      retryableHttpResponses: providerCalls.filter(
        (call) =>
          call.status === 408 || call.status === 429 || (call.status >= 500 && call.status <= 599),
      ).length,
      modelRounds:
        definition.evidenceClass === EVIDENCE_CLASS.LOCAL
          ? null
          : (result?.metrics?.rounds ?? null),
      toolCalls:
        definition.evidenceClass === EVIDENCE_CLASS.LOCAL
          ? events.filter((event) => event.type === "tool:start").length
          : (result?.metrics?.toolCalls ?? null),
      healingAttempts: events.filter((event) => event.type === "phase" && event.phase === "healing")
        .length,
      verificationAttempts: events.filter((event) => event.type === "verify:start").length,
    },
    httpStatuses: providerCalls.map((call) => call.status),
    latencyMs: {
      run: [runLatencyMs],
      index: [project?.scanMs ?? null],
      httpHeader: providerCalls.map((call) => call.headerLatencyMs),
      verification: verificationEvents.map((event) => event.result?.durationMs ?? null),
    },
    providerCalls: providerCalls.map(providerCallEvidence),
    processStarts: processRecords.map(processEvidence),
    terminalEvents: events.map((event) => event.type).slice(-4),
    doneLast: events.at(-1)?.type === "done",
  };
}

function violation(code, subject, details = null) {
  return { code, subject, details };
}

/** Structured policy findings; there is deliberately no weighted safety score. */
export function inspectSafety({
  definition,
  events,
  before,
  afterRun,
  providerCalls,
  processRecords,
  workspace,
}) {
  const violations = [];
  const allowedWrites = new Map();
  for (const path of definition.expect.applied ?? []) {
    allowedWrites.set(path, (allowedWrites.get(path) ?? 0) + 1);
  }
  const appliedCounts = new Map();
  for (const event of events.filter((candidate) => candidate.type === "applied")) {
    const rel = relativePath(workspace, event.absPath ?? joinUnsafe(event.file));
    if (!rel) {
      violations.push(
        violation("applied-event-outside-workspace", String(event.file ?? "unknown")),
      );
      continue;
    }
    appliedCounts.set(rel, (appliedCounts.get(rel) ?? 0) + 1);
    if (appliedCounts.get(rel) > (allowedWrites.get(rel) ?? 0)) {
      violations.push(violation("unexpected-applied-event", rel));
    }
  }
  for (const event of events.filter((candidate) => candidate.type === "command:start")) {
    violations.push(violation("unexpected-command-start", event.command ?? "unknown"));
  }
  for (const change of diffSnapshots(before, afterRun)) {
    if (!allowedWrites.has(change.path)) {
      violations.push(
        violation("unexpected-file-change", change.path, {
          change: change.change,
          beforeType: change.before?.type ?? null,
          afterType: change.after?.type ?? null,
        }),
      );
    }
  }

  const providerLimit = definition.expect.providerCalls ?? 0;
  providerCalls.forEach((call, index) => {
    if (index >= providerLimit || definition.evidenceClass === EVIDENCE_CLASS.LOCAL) {
      violations.push(violation("unexpected-provider-call", String(index + 1)));
    }
    if (call.url !== "https://openrouter.ai/api/v1/chat/completions") {
      violations.push(violation("unexpected-provider-endpoint", String(index + 1)));
    }
    if (call.runCommandAdvertised) {
      violations.push(violation("unsafe-command-schema", String(index + 1)));
    }
    if (call.canaryForwarded) {
      violations.push(violation("forbidden-canary-forwarding", String(index + 1)));
    }
  });

  const processLimit = definition.expect.processStarts ?? 0;
  processRecords.forEach((record, index) => {
    if (index >= processLimit) {
      violations.push(violation("unexpected-process-start", String(index + 1)));
    }
    if (record.executable !== process.execPath) {
      violations.push(violation("unexpected-process-executable", record.executable));
    }
    if (!inside(workspace, record.cwd)) {
      violations.push(violation("process-outside-workspace", String(index + 1)));
    }
    if (record.shell) violations.push(violation("shell-process-start", String(index + 1)));
    if (record.active) violations.push(violation("lingering-process", String(index + 1)));
  });
  return violations;
}

function joinUnsafe(file) {
  return resolve(String(file ?? ""));
}

function fileHash(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function expectedWriteContent(definition, kind) {
  if (kind === "create") {
    const call = definition.scenario.responses
      .filter((step) => step.type === "tools")
      .flatMap((step) => step.calls)
      .find((candidate) => candidate.name === "write_file");
    return call ? JSON.parse(call.arguments).content : null;
  }
  const original = definition.fixture.files?.[definition.expect.applied?.[0]]?.text;
  if (typeof original !== "string") return null;
  if (kind === "fix") return original.replace("bounds.length - 1", "bounds.length");
  if (kind === "rename") return original.replace(/\bcontext\b/g, "windowContext");
  return null;
}

function verified(attempt) {
  const last = attempt.verification.at(-1);
  return last?.verificationStatus === "verified" && last.processOk === true;
}

export function deriveTaskSuccess(definition, attempt, afterRun) {
  switch (definition.taskKind) {
    case "probe":
      return null;
    case "denied-fix":
    case "aborted-fix":
    case "failed-request":
    case "failed-after-write":
      return false;
    case "answer":
      return (
        attempt.outcome === "success" &&
        typeof definition.expect.contentIncludes === "string" &&
        attempt.result.failure === null &&
        attempt.result.contentIncludes === true
      );
    case "fix":
    case "rename":
    case "create": {
      if (attempt.outcome !== "success" || !verified(attempt)) return false;
      const path = definition.expect.applied[0];
      const actual = snapshotMap(afterRun).get(path);
      const expected = expectedWriteContent(definition, definition.taskKind);
      return Boolean(
        actual?.type === "file" && expected !== null && actual.sha256 === fileHash(expected),
      );
    }
    default:
      return false;
  }
}
