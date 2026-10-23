// ============================================================================
// Local Forge: the offline operator.
//
// It runs the same pipeline as the model-driven agent — plan, index, search,
// read, propose, approve, apply, verify — but every step is grounded in the
// local repository. It is the default engine because it is deterministic,
// instant and auditable. When it cannot ground an edit it says so.
// ============================================================================

import {
  proposeEdits,
  parseUnifiedDiff,
  splitLines,
} from "./diff.mjs";
import { resolveInside, writeFileAtomic } from "./workspace.mjs";
import {
  parseScopes,
  chainAtLine,
  formatScopeChain,
  scopeStats,
} from "./scope.mjs";
import { readFileSafe, searchRepo, findFile } from "./project.mjs";
import { runTests } from "./process.mjs";
import { backupFile } from "./session.mjs";
import {
  buildGroundedAnswer,
  classifyTask,
  extractKeywords,
  findIdentifier,
  findSliceOffByOne,
  targetFileForTask,
} from "./task.mjs";
import { formatBytes, formatDuration, oneLine, truncateToWidth } from "./text.mjs";

function makeReader(project, absPath) {
  const resolved = resolveInside(project.root, absPath);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const read = readFileSafe(resolved.path);
  if (!read.ok) return { ok: false, error: read.error };
  const parsed = parseScopes(read.content, resolved.path);
  return {
    ok: true,
    content: read.content,
    parsed,
    stats: scopeStats(parsed),
    path: resolved.path,
    rel: resolved.rel,
    size: read.size,
    truncated: read.truncated,
  };
}

/** A truncated view is never safe to edit: applying it would delete the tail. */
function editableRead(project, absPath) {
  const read = makeReader(project, absPath);
  if (!read.ok) throw new Error(read.error);
  if (read.truncated) {
    throw new Error(
      `refusing to edit ${read.rel}: file is ${formatBytes(read.size)} but reads are capped at ${formatBytes(Buffer.byteLength(read.content))}`
    );
  }
  return read;
}

/** Re-resolve and re-read immediately before writing; approvals can take time. */
function revalidateBeforeWrite(project, absPath, original) {
  const resolved = resolveInside(project.root, absPath);
  if (!resolved.ok) throw new Error(`refusing to write: ${resolved.error}`);
  const current = readFileSafe(resolved.path);
  if (!current.ok) throw new Error(`refusing to write ${resolved.rel}: ${current.error}`);
  if (current.truncated) {
    throw new Error(`refusing to write ${resolved.rel}: the file grew beyond the safe read limit`);
  }
  if (current.content !== original) {
    throw new Error(`refusing to write ${resolved.rel}: the file changed after it was read`);
  }
  return { path: resolved.path, rel: resolved.rel };
}

function snippetAround(content, line, radius = 3) {
  const doc = splitLines(content);
  const start = Math.max(1, line - radius);
  const end = Math.min(doc.lines.length, line + radius);
  return {
    start,
    end,
    lines: doc.lines.slice(start - 1, end).map((text, index) => ({
      number: start + index,
      text,
    })),
  };
}

function planFor(intent) {
  if (intent === "fix") {
    return [
      { id: 1, title: "Index workspace & resolve target" },
      { id: 2, title: "Find slice bound & enclosing scope" },
      { id: 3, title: "Read target lines" },
      { id: 4, title: "Synthesize validated patch" },
      { id: 5, title: "Apply on approval & run verification" },
    ];
  }
  if (intent === "rename") {
    return [
      { id: 1, title: "Index workspace & resolve target" },
      { id: 2, title: "Locate identifier occurrences" },
      { id: 3, title: "Synthesize rename patch" },
      { id: 4, title: "Apply on approval & run verification" },
    ];
  }
  if (intent === "test") {
    return [
      { id: 1, title: "Index workspace & resolve runner" },
      { id: 2, title: "Execute test suite" },
      { id: 3, title: "Report verification telemetry" },
    ];
  }
  return [
    { id: 1, title: "Index workspace" },
    { id: 2, title: "Search repository" },
    { id: 3, title: "Read grounding context" },
    { id: 4, title: "Compose grounded answer" },
  ];
}

function scoreCandidate(file, keywords, hits) {
  let score = hits * 10;
  const lowerRel = file.rel.toLowerCase();
  for (const keyword of keywords) {
    if (lowerRel.includes(keyword)) score += 8;
  }
  if (file.language === "python" || file.language === "javascript") score += 2;
  if (/(^|\/)(test|tests|spec)\//.test(file.rel)) score -= 4;
  return score;
}

function findFixCandidate(project, task, hintedFile) {
  const keywords = extractKeywords(task);

  if (hintedFile) {
    const read = editableRead(project, hintedFile.path);
    const hits = findSliceOffByOne(read.content);
    return { ...read, file: hintedFile, hits, score: 1000 };
  }

  const candidates = project.files
    .filter((file) => ["python", "javascript", "typescript"].includes(file.language))
    .filter((file) => file.size < 256 * 1024)
    .slice(0, 400);

  let best = null;
  for (const file of candidates) {
    const read = makeReader(project, file.path);
    if (!read.ok || read.truncated) continue;
    const hits = findSliceOffByOne(read.content);
    if (hits.length === 0) continue;
    const score = scoreCandidate(file, keywords, hits.length);
    if (!best || score > best.score) {
      best = { ...read, file, hits, score };
    }
  }
  return best;
}

function diffRows(patch) {
  return String(patch ?? "")
    .split("\n")
    .filter((line) => line.length > 0);
}

function readCard(reading, line, durationMs) {
  const chain = chainAtLine(reading.parsed, line);
  const scope = formatScopeChain(chain, { maxWidth: 110 });
  const snippet = snippetAround(reading.content, line, 3).lines.map(
    (row) => `${String(row.number).padStart(4)}  ${truncateToWidth(row.text, 96)}`
  );
  return {
    path: reading.rel,
    absPath: reading.path ?? reading.file?.path ?? null,
    scope,
    snippet,
    line,
    duration: formatDuration(durationMs),
    language: reading.parsed.language,
    stats: reading.stats,
  };
}

async function verify({ plan, workspaceRoot, onEvent, signal, env }) {
  if (!plan) {
    onEvent({ type: "verify:skipped", reason: "no test runner detected" });
    return {
      skipped: true,
      ok: true,
      summary: "no test runner detected · patch applied unverified",
      passed: 0,
      failed: 0,
      cases: [],
      lines: [],
      durationMs: 0,
      command: null,
    };
  }

  onEvent({ type: "verify:start", command: plan.display, cwd: plan.cwd });
  const result = await runTests(plan, {
    cwd: plan.cwd,
    signal,
    env,
    onLine: (line, stream) => onEvent({ type: "verify:line", line, stream }),
  });
  onEvent({ type: "verify:end", result });
  return result;
}

/**
 * Run the local operator. `requestApproval(proposal)` must resolve to
 * "y" | "a" | "n"; `autoApprove` skips the prompt for scripted tours.
 */
export async function runLocalAgent({
  task,
  project,
  onEvent = () => {},
  requestApproval = null,
  autoApprove = false,
  signal = null,
  env = process.env,
} = {}) {
  const started = Date.now();
  const classification = classifyTask(task);
  const plan = planFor(classification.intent).map((step) => ({ ...step, status: "pending" }));
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // UI callbacks must not break a run.
    }
  };
  const aborted = () => signal?.aborted === true;

  emit({ type: "run:start", mode: "local", task, plan });
  emit({ type: "phase", phase: "planning", detail: classification.intent });
  emit({ type: "plan", plan: plan.map((s) => ({ ...s })), activeIndex: 0 });

  const step = (index, status = "active") => {
    plan[index].status = status;
    emit({ type: "plan:step", index, status, plan: plan.map((s) => ({ ...s })) });
  };

  const thought = makeThought();
  const think = (text) => {
    thought.push(text);
    emit({ type: "thought", text });
  };
  think.text = () => thought.text();

  let metrics = { scopeNodes: 0, matches: 0, files: project.fileCount };
  let applied = null;
  let proposal = null;
  let readCardData = null;
  let verifyResult = null;
  let failure = null;

  try {
    // ---------------------------------------------------------------- index
    step(0);
    emit({ type: "phase", phase: "indexing" });
    emit({
      type: "tool:start",
      id: "index",
      name: "index",
      label: `index ${project.fileCount} files`,
      args: { root: project.root },
    });
    emit({
      type: "tool:end",
      id: "index",
      ok: true,
      summary: `${project.fileCount} files · ${project.languages.map((l) => l.name).slice(0, 3).join(", ") || "plain"}`,
      data: {
        files: project.fileCount,
        languages: project.languages,
        test: project.test?.display ?? null,
      },
    });
    step(0, "done");
    if (aborted()) throw new Error("aborted");

    // ---------------------------------------------------------------- fix
    if (classification.intent === "fix") {
      step(1);
      emit({ type: "phase", phase: "searching", detail: "slice bounds" });
      const hint = targetFileForTask(task, project);
      emit({
        type: "tool:start",
        id: "search",
        name: "search",
        label: hint.file ? `inspect ${hint.file.rel}` : "search for len(...) - 1",
        args: { query: "slice upper bound", file: hint.file?.rel ?? null },
      });

      const candidate = findFixCandidate(project, task, hint.file);
      emit({
        type: "tool:end",
        id: "search",
        ok: Boolean(candidate && candidate.hits.length),
        summary: candidate
          ? `${candidate.hits.length} suspect slice${candidate.hits.length === 1 ? "" : "s"} in ${candidate.rel}`
          : "no grounded off-by-one found",
        data: candidate
          ? { file: candidate.rel, hits: candidate.hits.map((h) => ({ line: h.line, text: h.before })) }
          : { file: null, hits: [] },
      });

      if (!candidate || candidate.hits.length === 0) {
        step(1, "error");
        failure = "No grounded off-by-one found. I will not invent a patch.";
        const keywords = extractKeywords(task);
        const matches = searchRepo(project, keywords[0] ?? task, { limit: 8 });
        const content = buildGroundedAnswer({ task, project, matches });
        emit({ type: "phase", phase: "complete" });
        emit({ type: "result", result: buildResult({ plan, think, content, failure, metrics }) });
        emit({ type: "done" });
        return buildResult({ plan, think, content, failure, metrics });
      }

      metrics.scopeNodes = candidate.stats.count;
      step(1, "done");
      step(2);
      emit({ type: "phase", phase: "reading", detail: candidate.rel });
      const first = candidate.hits[0];
      readCardData = readCard(candidate, first.line, 1);
      emit({
        type: "tool:start",
        id: "read",
        name: "read_file",
        label: `read ${candidate.rel}`,
        args: { file: candidate.rel, line: first.line },
      });
      emit({
        type: "tool:end",
        id: "read",
        ok: true,
        summary: readCardData.scope,
        data: readCardData,
      });
      think(
        `Indexed ${project.fileCount} files. ${candidate.rel} line ${first.line} contains a slice whose upper bound subtracts one:\n\n  ${first.before.trim()}\n\n` +
          `That expression drops the final element. The enclosing scope is ${readCardData.scope || "the module"}.`
      );
      step(2, "done");

      step(3);
      emit({ type: "phase", phase: "editing", detail: candidate.rel });
      const edits = candidate.hits.map((hit) => ({
        startLine: hit.line,
        endLine: hit.line + 1,
        replacement: hit.after,
        reason: hit.reason,
      }));
      const proposed = proposeEdits(candidate.content, edits, { file: candidate.rel });
      if (!proposed.ok) throw new Error(proposed.error);

      const hunks = [];
      {
        const { parseUnifiedDiff } = await import("./diff.mjs");
        const parsed = parseUnifiedDiff(proposed.patch);
        hunks.push(...parsed.hunks);
      }

      proposal = {
        file: candidate.rel,
        absPath: candidate.path,
        scope: readCardData.scope,
        original: candidate.content,
        updatedText: proposed.updatedText,
        patch: proposed.patch,
        hunks,
        edits: proposed.edits,
        stats: proposed.stats,
        reason: first.reason,
      };

      emit({ type: "tool:start", id: "propose", name: "propose_edit", label: `propose ${candidate.rel}`, args: { file: candidate.rel } });
      emit({
        type: "tool:end",
        id: "propose",
        ok: true,
        summary: `+${proposed.stats.adds} −${proposed.stats.dels} · awaiting approval`,
        data: { file: candidate.rel, stats: proposed.stats, scope: proposal.scope },
      });
      emit({ type: "proposal", proposal });
      step(3, "done");

      // ---------------------------------------------------------- approval
      let decision = autoApprove ? "y" : "n";
      if (!autoApprove && typeof requestApproval === "function") {
        emit({ type: "approval:request", proposal });
        decision = await requestApproval(proposal);
        emit({ type: "approval:result", decision });
      }
      if (aborted()) throw new Error("aborted");
      if (decision !== "y" && decision !== "a") {
        step(4, "error");
        const content = `Patch for ${candidate.rel} was not applied. The repository is unchanged.`;
        think("Approval was denied, so the proposed edit was discarded. No verification was run.");
        emit({ type: "phase", phase: "complete" });
        const result = buildResult({
          plan,
          think,
          content,
          proposal,
          readCardData,
          editStatus: "denied",
          metrics,
          failure: null,
        });
        emit({ type: "result", result });
        emit({ type: "done" });
        return result;
      }

      step(4);
      emit({ type: "phase", phase: "applying", detail: candidate.rel });
      const target = revalidateBeforeWrite(project, candidate.path, proposal.original);
      proposal.absPath = target.path;
      const backup = backupFile(target.path);
      writeFileAtomic(target.path, proposed.updatedText);
      applied = { ...proposal, backupPath: backup?.path ?? null, appliedAt: Date.now() };
      emit({
        type: "applied",
        file: candidate.rel,
        absPath: target.path,
        stats: proposed.stats,
        backupPath: backup?.path ?? null,
      });
      think(
        `Applied the validated hunk${proposed.stats.changed === 1 ? "" : "s"} to ${candidate.rel}` +
          (backup ? ` after backing up the original to ${backup.path}` : "") +
          ". Running the project's own test command now."
      );

      emit({ type: "phase", phase: "verifying", detail: project.test?.display ?? "tests" });
      verifyResult = await verify({
        plan: project.test,
        workspaceRoot: project.root,
        onEvent: emit,
        signal,
        env,
      });
      verifyResult.file = candidate.rel;
      step(4, verifyResult.ok || verifyResult.skipped ? "done" : "error");

      const testLine = verifyResult.skipped
        ? "No test runner was detected; the patch is applied but unverified."
        : verifyResult.ok
        ? `Verification passed: ${verifyResult.summary ?? `${verifyResult.passed} passed`} in ${formatDuration(verifyResult.durationMs)}.`
        : `Verification failed: ${verifyResult.summary ?? `${verifyResult.failed} failed`}. The patch is still applied; press u to restore the backup.`;

      const content = [
        `Fixed ${candidate.rel} inside ${readCardData.scope || "the module"}.`,
        "",
        "```diff",
        ...diffRows(proposed.patch).slice(1, 12),
        "```",
        "",
        testLine,
      ].join("\n");

      think(testLine);
      emit({ type: "phase", phase: verifyResult.ok || verifyResult.skipped ? "complete" : "failed" });
      const result = buildResult({
        plan,
        think,
        content,
        proposal,
        readCardData,
        verifyResult,
        applied,
        editStatus: "applied",
        metrics,
        failure: verifyResult.ok || verifyResult.skipped ? null : `tests failed: ${verifyResult.summary}`,
      });
      emit({ type: "result", result });
      emit({ type: "done" });
      return result;
    }

    // ---------------------------------------------------------------- rename
    if (classification.intent === "rename") {
      step(1);
      emit({ type: "phase", phase: "searching", detail: `${classification.from} → ${classification.to}` });
      const hint = targetFileForTask(task, project);
      const matches = searchRepo(project, classification.from, { limit: 80 });
      const file = hint.file ?? (matches[0] ? findFile(project, matches[0].rel) : null);
      const relevant = file ? matches.filter((m) => m.rel === file.rel) : [];
      emit({
        type: "tool:start",
        id: "search",
        name: "search",
        label: `find ${classification.from}`,
        args: { query: classification.from },
      });
      emit({
        type: "tool:end",
        id: "search",
        ok: relevant.length > 0,
        summary: `${relevant.length} occurrence${relevant.length === 1 ? "" : "s"}${file ? ` in ${file.rel}` : ""}`,
        data: { file: file?.rel ?? null, hits: relevant.slice(0, 20) },
      });

      if (!file || relevant.length === 0) {
        step(1, "error");
        const content = `No occurrences of \`${classification.from}\` were found connected to a concrete file. No edit was proposed.`;
        const result = buildResult({ plan, think, content, metrics, failure: "identifier not found" });
        emit({ type: "phase", phase: "complete" });
        emit({ type: "result", result });
        emit({ type: "done" });
        return result;
      }

      const reading = editableRead(project, file.path);
      const hits = findIdentifier(reading.content, classification.from);
      metrics.matches = hits.length;
      step(1, "done");
      step(2);
      readCardData = readCard(reading, hits[0].line, 1);
      emit({ type: "tool:start", id: "read", name: "read_file", label: `read ${file.rel}`, args: { file: file.rel } });
      emit({ type: "tool:end", id: "read", ok: true, summary: readCardData.scope, data: readCardData });
      think(
        `Found ${hits.length} whole-word occurrence${hits.length === 1 ? "" : "s"} of \`${classification.from}\` in ${file.rel}. ` +
          `The rename is proposed as exact line replacements; nothing else in the file is touched.`
      );
      step(2, "done");

      step(3);
      emit({ type: "phase", phase: "editing", detail: file.rel });
      const edits = hits.map((hit) => {
        const before = hit.text;
        const after = before.replace(
          new RegExp(`\\b${classification.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"),
          classification.to
        );
        return { startLine: hit.line, endLine: hit.line + 1, replacement: after, reason: "rename" };
      });
      const proposed = proposeEdits(reading.content, edits, { file: file.rel });
      if (!proposed.ok) throw new Error(proposed.error);
      const { parseUnifiedDiff } = await import("./diff.mjs");
      const parsed = parseUnifiedDiff(proposed.patch);
      proposal = {
        file: file.rel,
        absPath: reading.path,
        scope: readCardData.scope,
        original: reading.content,
        updatedText: proposed.updatedText,
        patch: proposed.patch,
        hunks: parsed.hunks,
        edits: proposed.edits,
        stats: proposed.stats,
        reason: `rename ${classification.from} → ${classification.to}`,
      };
      emit({ type: "tool:start", id: "propose", name: "propose_edit", label: `propose rename`, args: { file: file.rel } });
      emit({ type: "tool:end", id: "propose", ok: true, summary: `+${proposed.stats.adds} −${proposed.stats.dels} · awaiting approval`, data: { file: file.rel } });
      emit({ type: "proposal", proposal });
      step(3, "done");

      let decision = autoApprove ? "y" : "n";
      if (!autoApprove && typeof requestApproval === "function") {
        emit({ type: "approval:request", proposal });
        decision = await requestApproval(proposal);
        emit({ type: "approval:result", decision });
      }
      if (aborted()) throw new Error("aborted");
      if (decision !== "y" && decision !== "a") {
        const content = `Rename was not applied. ${file.rel} is unchanged.`;
        const result = buildResult({ plan, think, content, proposal, readCardData, editStatus: "denied", metrics });
        emit({ type: "phase", phase: "complete" });
        emit({ type: "result", result });
        emit({ type: "done" });
        return result;
      }

      step(4);
      const target = revalidateBeforeWrite(project, reading.path, proposal.original);
      proposal.absPath = target.path;
      const backup = backupFile(target.path);
      writeFileAtomic(target.path, proposed.updatedText);
      applied = { ...proposal, backupPath: backup?.path ?? null, appliedAt: Date.now() };
      emit({ type: "applied", file: file.rel, absPath: target.path, stats: proposed.stats, backupPath: backup?.path ?? null });
      emit({ type: "phase", phase: "verifying" });
      verifyResult = await verify({ plan: project.test, onEvent: emit, signal, env });
      step(4, verifyResult.ok || verifyResult.skipped ? "done" : "error");
      const content = [
        `Renamed \`${classification.from}\` → \`${classification.to}\` in ${file.rel} (${hits.length} occurrence${hits.length === 1 ? "" : "s"}).`,
        "",
        verifyResult.skipped
          ? "No test runner detected; the rename is applied but unverified."
          : verifyResult.ok
          ? `Verification passed: ${verifyResult.summary ?? `${verifyResult.passed} passed`}.`
          : `Verification failed: ${verifyResult.summary ?? `${verifyResult.failed} failed`}. Press u to restore the backup.`,
      ].join("\n");
      think(content);
      const result = buildResult({
        plan,
        think,
        content,
        proposal,
        readCardData,
        verifyResult,
        applied,
        editStatus: "applied",
        metrics,
        failure: verifyResult.ok || verifyResult.skipped ? null : `tests failed: ${verifyResult.summary}`,
      });
      emit({ type: "phase", phase: verifyResult.ok || verifyResult.skipped ? "complete" : "failed" });
      emit({ type: "result", result });
      emit({ type: "done" });
      return result;
    }

    // ---------------------------------------------------------------- tests
    if (classification.intent === "test") {
      step(1);
      emit({ type: "phase", phase: "verifying", detail: project.test?.display ?? "no runner" });
      verifyResult = await verify({ plan: project.test, onEvent: emit, signal, env });
      step(1, verifyResult.ok ? "done" : "error");
      step(2, "done");
      const content = verifyResult.skipped
        ? "No test runner was detected for this workspace."
        : verifyResult.ok
        ? `Tests passed: ${verifyResult.summary ?? `${verifyResult.passed} passed`} in ${formatDuration(verifyResult.durationMs)}.`
        : `Tests failed: ${verifyResult.summary ?? `${verifyResult.failed} failed`} in ${formatDuration(verifyResult.durationMs)}.`;
      const result = buildResult({ plan, think, content, verifyResult, metrics, failure: verifyResult.ok ? null : "test failure" });
      emit({ type: "phase", phase: "complete" });
      emit({ type: "result", result });
      emit({ type: "done" });
      return result;
    }

    // -------------------------------------------------------------- explain
    step(1);
    emit({ type: "phase", phase: "searching" });
    const keywords = extractKeywords(task);
    const query = keywords[0] ?? task;
    const matches = searchRepo(project, query, { limit: 20 });
    metrics.matches = matches.length;
    emit({ type: "tool:start", id: "search", name: "search", label: `search "${oneLine(query, 40)}"`, args: { query } });
    emit({
      type: "tool:end",
      id: "search",
      ok: true,
      summary: `${matches.length} match${matches.length === 1 ? "" : "es"}`,
      data: { query, matches: matches.slice(0, 12) },
    });
    step(1, "done");
    step(2);
    emit({ type: "phase", phase: "reading" });

    let reading = null;
    let file = null;
    if (matches.length > 0) {
      file = findFile(project, matches[0].rel);
      if (file) {
        const read = makeReader(project, file.path);
        if (read.ok) {
          reading = read;
          readCardData = readCard(read, matches[0].line, 1);
          emit({ type: "tool:start", id: "read", name: "read_file", label: `read ${file.rel}`, args: { file: file.rel, line: matches[0].line } });
          emit({ type: "tool:end", id: "read", ok: true, summary: readCardData.scope, data: readCardData });
        }
      }
    }

    const content = buildGroundedAnswer({
      task,
      project,
      matches,
      file,
      reading: { scopeChain: readCardData?.scope ?? "" },
    });
    think(
      `Searched ${project.fileCount} indexed files for ${keywords.map((k) => `"${k}"`).join(", ") || "the request"} and found ${matches.length} source line${matches.length === 1 ? "" : "s"}. ` +
        `The answer below is composed only from those results; no edit was proposed.`
    );
    step(2, "done");
    step(3, "done");
    emit({ type: "phase", phase: "complete" });
    const result = buildResult({ plan, think, content, readCardData, metrics, matches });
    emit({ type: "result", result });
    emit({ type: "done" });
    return result;
  } catch (error) {
    const abortedRun = aborted() || /aborted/i.test(error.message);
    const content = abortedRun
      ? "Run aborted. Any patch that was already applied remains on disk; press u to restore the backup."
      : `Local Forge could not complete the run: ${error.message}`;
    emit({ type: "error", error: content, aborted: abortedRun });
    emit({ type: "phase", phase: abortedRun ? "aborted" : "failed" });
    const result = buildResult({
      plan,
      think,
      content,
      proposal,
      readCardData,
      verifyResult,
      applied,
      editStatus: applied ? "applied" : null,
      metrics,
      failure: content,
      error: true,
    });
    emit({ type: "result", result });
    emit({ type: "done" });
    return result;
  } finally {
    emit({ type: "metrics", metrics: { ...metrics, elapsedMs: Date.now() - started } });
  }

  // Exhaustive guard: every branch above returns.
  // eslint-disable-next-line no-unreachable
  return null;
}

function buildResult({
  plan,
  think,
  content,
  proposal = null,
  readCardData = null,
  verifyResult = null,
  applied = null,
  editStatus = null,
  metrics = {},
  failure = null,
  matches = [],
  error = false,
}) {
  const reasoning = reasoningPartsLength(think) ? thinkText(think) : "";
  return {
    role: "assistant",
    mode: "local",
    id: `asst-${Date.now()}`,
    plan: plan.map((step) => ({ ...step })),
    reasoning,
    readFile: readCardData,
    editFile: proposal
      ? {
          path: proposal.file,
          scope: proposal.scope,
          diff: diffRows(proposal.patch),
          patch: proposal.patch,
          hunks: proposal.hunks,
          stats: proposal.stats,
          status: editStatus ?? "pending",
          backupPath: applied?.backupPath ?? null,
        }
      : null,
    verifyTests: verifyResult
      ? {
          cmd: verifyResult.command,
          results: verifyResult.cases?.length
            ? verifyResult.cases.map((c) => ({ name: c.name, pass: c.pass }))
            : verifyResult.lines?.slice(-8).map((line) => ({ name: line, pass: verifyResult.ok })),
          passed: verifyResult.passed,
          failed: verifyResult.failed,
          skipped: verifyResult.skipped,
          duration: formatDuration(verifyResult.durationMs),
          output: verifyResult.lines?.slice(-40) ?? [],
          summary: verifyResult.summary,
          ok: verifyResult.ok,
          timedOut: verifyResult.timedOut ?? false,
          aborted: verifyResult.aborted ?? false,
          parseConfident: verifyResult.parseConfident ?? null,
        }
      : null,
    content,
    summary: failure
      ? `Local Forge stopped: ${failure}`
      : applied
      ? `Local Forge applied ${proposal.file} (+${proposal.stats.adds} −${proposal.stats.dels})`
      : proposal && editStatus === "denied"
      ? `Local Forge proposed ${proposal.file} · patch denied · file unchanged`
      : "Local Forge completed the analysis",
    failure,
    error,
    applied,
    proposal,
    matches,
    metrics,
    elapsedTime: 0,
    timestamp: Date.now(),
  };
}

// buildResult is given the `think` accumulator; these tiny helpers keep the
// collector opaque to the result builder.
function reasoningPartsLength(think) {
  return typeof think?.text === "function" ? think.text().length > 0 : false;
}
function thinkText(think) {
  return typeof think?.text === "function" ? think.text() : "";
}

/** A mutable thought accumulator shared by every branch. */
export function makeThought() {
  const parts = [];
  return {
    push: (text) => parts.push(text),
    text: () => parts.join("\n\n"),
  };
}
