// Pure transcript/session projections. No React, controller, provider, or filesystem
// work belongs here; lib/session.mjs remains responsible for persistence.

import { retainTranscript, SESSION_RETENTION } from "../lib/session.mjs";

export const RETAINED_OUTPUT_LIMIT = 400;

export function historyFromSession(session) {
  if (!session || !Array.isArray(session.history)) return [];
  return session.history
    .filter((message) => message && typeof message === "object" && message.role)
    .slice(-60)
    .map((message, index) => ({
      ...message,
      id: message.id ?? `resumed-${index}`,
      content: String(message.content ?? ""),
    }));
}

export function promptHistoryFrom(history) {
  return history
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .slice(-60);
}

function usagePart(value = {}) {
  return {
    prompt_tokens: Number(value.prompt_tokens ?? 0),
    completion_tokens: Number(value.completion_tokens ?? 0),
    total_tokens: Number(value.total_tokens ?? 0),
    cached_tokens: Number(value.cached_tokens ?? 0),
    cost: Number(value.cost ?? 0),
  };
}

function usageCounts(value = {}) {
  return {
    total: Number(value.total ?? 0),
    provider: Number(value.provider ?? 0),
    estimated: Number(value.estimated ?? 0),
    unavailable: Number(value.unavailable ?? 0),
    legacy: Number(value.legacy ?? 0),
  };
}

export function normalizeUsage(value = {}) {
  const hasLegacyShape =
    !value.provenance && !value.costProvenance && !value.rounds && !value.costRounds;
  const rounds = usageCounts(value.rounds);
  const costRounds = usageCounts(value.costRounds);
  if (hasLegacyShape) {
    const hasActivity =
      Number(value.inputTokens ?? value.prompt_tokens ?? 0) > 0 ||
      Number(value.outputTokens ?? value.completion_tokens ?? 0) > 0 ||
      Number(value.cachedTokens ?? value.cached_tokens ?? 0) > 0 ||
      (Object.hasOwn(value, "cost") && value.cost !== 0 && value.cost !== null);
    if (hasActivity) {
      rounds.legacy = 1;
      costRounds.legacy = 1;
    }
  }
  const legacy = hasLegacyShape && (rounds.legacy > 0 || costRounds.legacy > 0);
  return {
    inputTokens: Number(value.inputTokens ?? value.prompt_tokens ?? 0),
    outputTokens: Number(value.outputTokens ?? value.completion_tokens ?? 0),
    cachedTokens: Number(value.cachedTokens ?? value.cached_tokens ?? 0),
    cost: Object.hasOwn(value, "cost") ? value.cost : null,
    provenance: value.provenance ?? (legacy ? "legacy" : "unavailable"),
    usageProvenance:
      value.usageProvenance ?? value.provenance ?? (legacy ? "legacy" : "unavailable"),
    costProvenance: value.costProvenance ?? (legacy ? "legacy" : "unavailable"),
    costComplete:
      value.costComplete ??
      (hasLegacyShape ? rounds.legacy === 0 && costRounds.legacy === 0 : false),
    provider: usagePart(value.provider),
    estimated: usagePart(value.estimated),
    rounds,
    costRounds,
  };
}

function mergeUsagePart(left, right) {
  return {
    prompt_tokens: left.prompt_tokens + right.prompt_tokens,
    completion_tokens: left.completion_tokens + right.completion_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    cached_tokens: left.cached_tokens + right.cached_tokens,
    cost: left.cost + right.cost,
  };
}

function mergeUsageCounts(left, right) {
  return {
    total: left.total + right.total,
    provider: left.provider + right.provider,
    estimated: left.estimated + right.estimated,
    unavailable: left.unavailable + right.unavailable,
    legacy: left.legacy + right.legacy,
  };
}

function usageProvenanceFor(counts) {
  const sources = ["provider", "estimated", "unavailable", "legacy"].filter(
    (source) => counts[source] > 0,
  );
  if (sources.length === 0) return "unavailable";
  return sources.length === 1 ? sources[0] : "mixed";
}

export function accumulateTokenStats(base, snapshot) {
  const left = normalizeUsage(base);
  const right = normalizeUsage(snapshot);
  const rounds = mergeUsageCounts(left.rounds, right.rounds);
  const costRounds = mergeUsageCounts(left.costRounds, right.costRounds);
  const knownCost = left.cost !== null || right.cost !== null;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    cost: knownCost ? (left.cost ?? 0) + (right.cost ?? 0) : null,
    provenance: usageProvenanceFor(rounds),
    usageProvenance: usageProvenanceFor(rounds),
    costProvenance: usageProvenanceFor(costRounds),
    costComplete: left.costComplete && right.costComplete,
    provider: mergeUsagePart(left.provider, right.provider),
    estimated: mergeUsagePart(left.estimated, right.estimated),
    rounds,
    costRounds,
  };
}

export function appendHistory(previous, message) {
  // Existing live records were projected when appended (or loaded from a saved
  // session). Preserve their identity for the transcript layout cache and only
  // project the new card on the ordinary under-budget path.
  const source = [...previous, message];
  const projected = retainTranscript([message]);
  if (projected.dropped > 0 || projected.truncatedRecords > 0)
    return retainTranscript(source).history;
  const combined = [...previous, ...projected.history];
  const next =
    combined.length > SESSION_RETENTION.historyEntries
      ? combined.slice(-SESSION_RETENTION.historyEntries)
      : combined;
  if (Buffer.byteLength(JSON.stringify(next)) <= SESSION_RETENTION.historyBytes) return next;
  return retainTranscript(source).history;
}

function undoRunSnapshot(undoRun) {
  if (
    !undoRun ||
    undoRun.version !== 1 ||
    !Array.isArray(undoRun.entries) ||
    undoRun.entries.length === 0
  ) {
    return null;
  }
  return {
    version: 1,
    runId: undoRun.runId ?? null,
    entries: undoRun.entries.map((entry) => ({
      file: entry.file,
      absPath: entry.absPath,
      patch: entry.patch ?? "",
      stats: entry.stats ?? { adds: 0, dels: 0 },
      backupPath: entry.backupPath ?? null,
      original: entry.original ?? null,
      updatedText: entry.updatedText,
      isCreation: Boolean(entry.isCreation),
      appliedAt: entry.appliedAt ?? null,
    })),
  };
}

export function retainedOutput(lines) {
  return Array.isArray(lines) ? lines.slice(-RETAINED_OUTPUT_LIMIT) : [];
}

export function verificationForTranscript(resultVerification, liveVerification = null) {
  if (!resultVerification && !liveVerification) return null;
  const result = resultVerification ?? {};
  const sameVerification =
    liveVerification &&
    (!resultVerification ||
      (liveVerification.cmd ?? liveVerification.command ?? null) ===
        (result.cmd ?? result.command ?? null));
  const live = sameVerification ? liveVerification : {};
  const resultSource = Array.isArray(result.output)
    ? result.output
    : Array.isArray(result.lines)
      ? result.lines
      : [];
  const liveSource = Array.isArray(live.output)
    ? live.output
    : Array.isArray(live.lines)
      ? live.lines
      : [];
  const resultOutput = retainedOutput(resultSource);
  const liveOutput = retainedOutput(liveSource);
  const output =
    sameVerification && liveOutput.length >= resultOutput.length ? liveOutput : resultOutput;
  const resultCount = Number(result.outputLineCount);
  const liveCount = Number(live.outputLineCount);
  const outputLineCount = Math.max(
    output.length,
    resultSource.length,
    sameVerification ? liveSource.length : 0,
    Number.isFinite(resultCount) ? Math.max(0, Math.floor(resultCount)) : 0,
    Number.isFinite(liveCount) ? Math.max(0, Math.floor(liveCount)) : 0,
  );
  return {
    ...live,
    ...result,
    output,
    outputLineCount,
    outputTruncated:
      Boolean(result.outputTruncated || live.outputTruncated) || outputLineCount > output.length,
  };
}

export function sessionSnapshot({
  project,
  history,
  model,
  tokenStats,
  metrics,
  undoRun,
  cwd,
  sessionId,
  elapsedMs,
}) {
  return {
    id: sessionId,
    cwd,
    project: project
      ? {
          name: project.name,
          root: project.root,
          branch: project.branch,
          fileCount: project.fileCount,
          languages: project.languages?.slice(0, 8) ?? [],
          test: project.test?.display ?? null,
        }
      : null,
    modelId: model?.id ?? "local",
    history: history.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      summary: message.summary,
      ok: message.ok,
      status: message.status,
      outcome: message.outcome,
      failure: message.failure,
      aborted: message.aborted,
      timedOut: message.timedOut,
      budgetExhausted: message.budgetExhausted,
      metrics: message.metrics,
      elapsedMs: message.elapsedMs,
      mode: message.mode,
      reasoning: message.reasoning,
      plan: message.plan,
      readFile: message.readFile ? { ...message.readFile, absPath: undefined } : null,
      editFile: message.editFile
        ? {
            path: message.editFile.path,
            scope: message.editFile.scope,
            diff: message.editFile.diff,
            stats: message.editFile.stats,
            status: message.editFile.status,
            backupPath: message.editFile.backupPath,
          }
        : null,
      verifyTests: verificationForTranscript(message.verifyTests),
      toolCards: message.toolCards,
      usage: message.usage,
      cost: message.cost ?? null,
      usageProvenance: message.usageProvenance,
      costProvenance: message.costProvenance,
      costComplete: message.costComplete,
      recovery: message.recovery ?? null,
      modelName: message.modelName,
      error: message.error,
      timestamp: message.timestamp,
    })),
    tokenStats,
    metrics,
    undoRun: undoRunSnapshot(undoRun),
    // lastPatch is read only for migration from older session records.
    lastPatch: null,
    elapsedMs,
  };
}

export function lastContext(history, live) {
  const messages = live ? [...history, live] : history;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.editFile?.path) {
      const line =
        message.editFile.hunks?.[0]?.oldStart ?? message.editFile.edits?.[0]?.startLine ?? 1;
      return { file: message.editFile.path, line, kind: "edit" };
    }
    if (message.readFile?.path) {
      return { file: message.readFile.path, line: message.readFile.line ?? 1, kind: "read" };
    }
  }
  return null;
}

export function lastVerification(history, live) {
  const messages = live ? [...history, live] : history;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.verifyTests) return messages[i].verifyTests;
  }
  return null;
}

export function hasRetainedVerificationOutput(history, live) {
  const messages = live ? [...history, live] : history;
  return messages.some((message) => {
    const verification = message?.verifyTests;
    return (
      (Array.isArray(verification?.output) && verification.output.length > 0) ||
      (Array.isArray(verification?.lines) && verification.lines.length > 0)
    );
  });
}
