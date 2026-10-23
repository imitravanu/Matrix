// ============================================================================
// Model agent: a real tool-calling loop over OpenRouter.
//
// The model can only act through five audited tools: list, search, read,
// propose an edit, and run the project's tests. Every write goes through an
// approval gate; every path is contained in the workspace; every claim about a
// change is backed by a validated diff and an atomic write.
// ============================================================================

import { readFileSafe, searchRepo } from "./project.mjs";
import { parseScopes, chainAtLine, formatScopeChain } from "./scope.mjs";
import { proposeEdits, parseUnifiedDiff, diffStatsFromText, makeUnifiedDiff } from "./diff.mjs";
import { runTests, runProcess } from "./process.mjs";
import { backupFile } from "./session.mjs";
import { resolveInside, writeFileAtomic } from "./workspace.mjs";
import { estimateCost } from "./models.mjs";
import { formatBytes, formatDuration, oneLine, truncateToWidth } from "./text.mjs";
import { streamOpenRouter } from "./openrouter.mjs";

const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;
const MAX_READ_LINES = 160;
const MAX_TOOL_RESULT = 24_000;

/**
 * Resilient JSON parser for model tool arguments.
 * Tolerates markdown code fences, leading/trailing noise, and trailing commas.
 */
export function parseToolArgs(raw) {
  if (!raw || typeof raw !== "string") return {};
  let text = raw.trim();
  if (!text || text === "{}") return {};

  try {
    return JSON.parse(text);
  } catch {}

  // Strip markdown code fences if wrapped: ```json ... ```
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
    try {
      return JSON.parse(text);
    } catch {}
  }

  // Find outermost curly braces
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const sliced = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(sliced);
    } catch {}

    // Clean trailing commas before closing braces/brackets
    const sanitized = sliced
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, (c) => (c === "\n" || c === "\r" || c === "\t" ? c : ""));
    try {
      return JSON.parse(sanitized);
    } catch {}
  }

  return JSON.parse(raw);
}

/** Revalidate containment and contents after the approval gate, before writing. */
function revalidateBeforeWrite(project, proposal) {
  const resolved = resolveInside(project.root, proposal.absPath);
  if (!resolved.ok) throw new Error(`refusing to write: ${resolved.error}`);
  if (proposal.isCreation) {
    const current = readFileSafe(resolved.path);
    if (current.ok && proposal.original === "") {
      throw new Error(`refusing to create ${resolved.rel}: file already exists on disk`);
    }
    return { path: resolved.path, rel: resolved.rel };
  }
  const current = readFileSafe(resolved.path);
  if (!current.ok) throw new Error(`refusing to write ${resolved.rel}: ${current.error}`);
  if (current.truncated) {
    throw new Error(`refusing to write ${resolved.rel}: the file is larger than the safe read limit`);
  }
  if (current.utf8 === false) {
    throw new Error(`refusing to write ${resolved.rel}: file is not valid UTF-8`);
  }
  if (current.content !== proposal.original) {
    throw new Error(`refusing to write ${resolved.rel}: the file changed after it was read`);
  }
  return { path: resolved.path, rel: resolved.rel };
}

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the workspace, optionally filtered by a substring or glob-ish pattern.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Substring of the relative path, e.g. 'src/' or '.py'." },
          limit: { type: "number", description: "Maximum results (default 80)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_repo",
      description: "Search real repository file contents for a literal string. Returns file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal text to find (case-insensitive)." },
          limit: { type: "number", description: "Maximum matches (default 30)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a real file by workspace-relative path, with line numbers and the enclosing scope chain.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start_line: { type: "number", description: "First line (1-based). Defaults to 1." },
          end_line: { type: "number", description: "Last line (inclusive). Defaults to start + 120." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_edit",
      description:
        "Propose a line-range edit. start_line is inclusive, end_line is exclusive. The user must approve; " +
        "the file is only written after approval. Always read the file first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start_line: { type: "number", description: "First line to replace (1-based, inclusive)." },
          end_line: { type: "number", description: "Line after the last replaced line (exclusive)." },
          replacement: { type: "string", description: "Exact replacement text. Do not include line numbers." },
          rationale: { type: "string", description: "One sentence explaining why this edit is correct." },
        },
        required: ["path", "start_line", "end_line", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or write complete content to a file in the workspace. " +
        "The edit goes through the user approval gate with a unified diff before being written to disk.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "The full file content to write." },
          rationale: { type: "string", description: "One sentence explaining why this file is created or written." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run an audited command in the workspace (e.g. linter, typechecker, or custom script). " +
        "Dangerous destructive commands are blocked.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute in the workspace." },
          rationale: { type: "string", description: "Why this command needs to be executed." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tests",
      description: "Run the project's detected test command and return real pass/fail results.",
      parameters: { type: "object", properties: {} },
    },
  },
];

function systemPromptFor(project) {
  const languages = project.languages
    .slice(0, 5)
    .map((l) => `${l.name} (${l.files})`)
    .join(", ");
  return [
    "You are Matrix Forge, the autonomous coding operator inside Matrix, a spatial terminal workbench.",
    "You act on a real repository through tools. Ground every claim in tool output.",
    "",
    `Workspace: ${project.name}`,
    `Root: ${project.root}`,
    `Branch: ${project.branch ?? "(not a git repository)"}`,
    `Files indexed: ${project.fileCount}`,
    `Languages: ${languages || "unknown"}`,
    `Test runner: ${project.test ? project.test.display : "none detected"}`,
    "",
    "Rules:",
    "1. Never claim a file changed unless propose_edit or write_file returned status=applied.",
    "2. Search and read before editing. Keep edits minimal and preserve surrounding code.",
    "3. Use propose_edit for line replacements; use write_file for creating new files or complete overwrites.",
    "4. Call run_tests after any applied edit to verify changes. Report the real counts.",
    "5. Use run_command to execute linters, typecheckers, or custom project build commands.",
    "6. If approval is denied, do not retry the same edit; explain and stop.",
    "7. If you cannot ground a change, say so instead of inventing one.",
    "8. Final answers are concise. Mention paths, line numbers and verification results.",
  ].join("\n");
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "result not serialisable" });
  }
}

function toolLabel(name, args) {
  switch (name) {
    case "search_repo":
      return `search "${truncateToWidth(oneLine(args.query ?? ""), 32)}"`;
    case "read_file":
      return `read ${args.path ?? "?"}:${args.start_line ?? 1}–${args.end_line ?? "…"}`;
    case "propose_edit":
      return `propose ${args.path ?? "?"}:${args.start_line ?? "?"}`;
    case "write_file":
      return `write ${args.path ?? "?"}`;
    case "run_command":
      return `run "${truncateToWidth(oneLine(args.command ?? args.cmd ?? ""), 32)}"`;
    case "run_tests":
      return "run tests";
    case "list_files":
      return `list ${args.filter ?? "files"}`;
    default:
      return name;
  }
}

function planForRemote() {
  return [
    { id: 1, title: "Understand request & workspace", status: "active" },
    { id: 2, title: "Gather repository context", status: "pending" },
    { id: 3, title: "Propose & apply edit", status: "pending" },
    { id: 4, title: "Verify with real tests", status: "pending" },
  ];
}

function setPlanStep(plan, index, status, emit) {
  if (!plan[index]) return;
  plan[index].status = status;
  emit({ type: "plan:step", index, status, plan: plan.map((s) => ({ ...s })) });
}

/**
 * Run a model with tools. Resolves to the same assistant-message shape the
 * local operator produces, so the chat renderer is engine-agnostic.
 */
export async function runModelAgent({
  task,
  project,
  model,
  onEvent = () => {},
  requestApproval = null,
  autoApprove = false,
  signal = null,
  env = process.env,
  maxRounds = MAX_ROUNDS,
  autoVerify = true,
} = {}) {
  const started = Date.now();
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // UI callbacks are not allowed to break a run.
    }
  };
  const aborted = () => signal?.aborted === true;
  const plan = planForRemote();
  const thought = [];
  const toolCards = [];
  const appliedEdits = [];

  let messages = [{ role: "user", content: task }];
  let content = "";
  let reasoning = "";
  let lastRead = null;
  let lastProposal = null;
  let lastVerify = null;
  let lastVerifiedEditCount = -1;
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };
  let rounds = 0;
  let toolCallCount = 0;
  let finishReason = null;
  let autoApproveNow = Boolean(autoApprove);
  let failure = null;
  let selfHealAttempts = 0;
  const maxSelfHeals = 2;

  const emitUsage = () => {
    const cached = Number(usage.cached_tokens ?? 0);
    emit({
      type: "usage",
      usage: {
        ...usage,
        cached_tokens: cached,
        cost: estimateCost(model, {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          prompt_tokens_details: { cached_tokens: cached },
        }),
      },
    });
  };

  const verifyOnce = async (reason = "auto") => {
    if (!project.test) {
      const skipped = {
        skipped: true,
        ok: true,
        summary: "no test runner detected",
        passed: 0,
        failed: 0,
        cases: [],
        lines: [],
        durationMs: 0,
        command: null,
      };
      emit({ type: "verify:skipped", reason: "no test runner detected" });
      return skipped;
    }
    emit({ type: "phase", phase: "verifying", detail: reason });
    emit({ type: "verify:start", command: project.test.display, cwd: project.test.cwd });
    const result = await runTests(project.test, {
      cwd: project.test.cwd,
      signal,
      env,
      onLine: (line, stream) => emit({ type: "verify:line", line, stream }),
    });
    result.file = lastProposal?.file ?? null;
    emit({ type: "verify:end", result });
    lastVerify = result;
    lastVerifiedEditCount = appliedEdits.length;
    return result;
  };

  emit({ type: "run:start", mode: "remote", model: model.id, modelName: model.name, task, plan });
  emit({ type: "phase", phase: "thinking", detail: model.name });
  emit({ type: "plan", plan: plan.map((s) => ({ ...s })), activeIndex: 0 });

  try {
    for (rounds = 1; rounds <= maxRounds; rounds++) {
      if (aborted()) throw new Error("aborted");
      if (toolCallCount >= MAX_TOOL_CALLS) {
        throw new Error(`tool-call budget exhausted (${MAX_TOOL_CALLS})`);
      }

      emit({ type: "phase", phase: rounds === 1 ? "thinking" : "continuing", detail: `round ${rounds}` });
      let roundContent = "";
      let roundReasoning = "";
      const callMap = new Map();
      let roundUsage = null;

      for await (const event of streamOpenRouter({
        model: model.id,
        messages,
        systemPrompt: systemPromptFor(project),
        maxTokens: 4096,
        signal,
        reasoning: { exclude: false },
        tools: TOOL_SCHEMAS,
        toolChoice: "auto",
      })) {
        if (aborted()) throw new Error("aborted");
        if (event.type === "reasoning") {
          roundReasoning += event.text;
          reasoning += event.text;
          emit({ type: "thought", text: event.text });
        } else if (event.type === "content") {
          roundContent += event.text;
          content += event.text;
          emit({ type: "content", text: event.text });
        } else if (event.type === "tool_call") {
          const index = Number(event.index ?? 0);
          const call = callMap.get(index) ?? { id: null, name: "", arguments: "" };
          if (event.id) call.id = event.id;
          if (event.name) call.name = event.name;
          call.arguments += event.arguments ?? "";
          callMap.set(index, call);
        } else if (event.type === "finish") {
          finishReason = event.reason;
        } else if (event.type === "done") {
          if (event.usage) roundUsage = event.usage;
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      }

      if (roundUsage) {
        usage.prompt_tokens += Number(roundUsage.prompt_tokens ?? 0);
        usage.completion_tokens += Number(roundUsage.completion_tokens ?? 0);
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        usage.cached_tokens += Number(roundUsage.prompt_tokens_details?.cached_tokens ?? 0);
        emitUsage();
      } else {
        // Providers that omit usage: keep an estimate visible, clearly labelled.
        const approxIn = Math.ceil(messages.map((m) => String(m.content ?? "").length).reduce((a, b) => a + b, 0) / 4);
        const approxOut = Math.ceil((roundContent.length + roundReasoning.length) / 4);
        if (rounds === 1) {
          usage.prompt_tokens += approxIn;
        }
        usage.completion_tokens += approxOut;
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      }

      const calls = [...callMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, call], i) => ({
          index,
          id: call.id || `call_${rounds}_${i}`,
          name: call.name,
          arguments: call.arguments || "{}",
        }))
        .filter((call) => call.name);

      setPlanStep(plan, 0, "done", emit);
      if (calls.length === 0) {
        setPlanStep(plan, 1, "done", emit);
        if (autoVerify && appliedEdits.length > 0 && lastVerifiedEditCount !== appliedEdits.length) {
          setPlanStep(plan, 3, "active", emit);
          const verified = await verifyOnce("automatic after edit");
          if (!verified.skipped) {
            if (verified.ok) {
              const line = `Automatic verification: ${verified.summary ?? `${verified.passed} passed`} in ${formatDuration(verified.durationMs)}.`;
              content += (content ? "\n\n" : "") + line;
              setPlanStep(plan, 3, "done", emit);
              break;
            }
            if (selfHealAttempts < maxSelfHeals && rounds < maxRounds) {
              selfHealAttempts++;
              emit({
                type: "phase",
                phase: "healing",
                detail: `Self-healing attempt ${selfHealAttempts}/${maxSelfHeals}: tests failed`,
              });
              const failExcerpt = (verified.lines || []).slice(-30).join("\n");
              messages.push({
                role: "user",
                content: [
                  `AUTOMATIC VERIFICATION FAILED (${verified.summary ?? `${verified.failed} failed`}).`,
                  "Recent test output:",
                  "```",
                  failExcerpt,
                  "```",
                  "Please analyze the failure traceback above, locate the regression or bug, and propose an edit to fix it.",
                ].join("\n"),
              });
              continue;
            }
            const line = `Automatic verification failed: ${verified.summary ?? `${verified.failed} failed`}. The edit is applied; press u to restore the backup.`;
            content += (content ? "\n\n" : "") + line;
            setPlanStep(plan, 3, "error", emit);
            break;
          }
        }
        break;
      }

      messages.push({
        role: "assistant",
        content: roundContent || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      for (const call of calls) {
        toolCallCount++;
        let args = {};
        try {
          args = parseToolArgs(call.arguments);
        } catch (error) {
          const result = { status: "error", error: `invalid JSON arguments: ${error.message}` };
          messages.push({ role: "tool", tool_call_id: call.id, content: safeJson(result) });
          emit({
            type: "tool:start",
            id: call.id,
            name: call.name,
            label: `${call.name} (invalid args)`,
            args: {},
          });
          emit({ type: "tool:end", id: call.id, ok: false, summary: result.error, data: null });
          continue;
        }

        const label = toolLabel(call.name, args);
        emit({ type: "tool:start", id: call.id, name: call.name, label, args });
        emit({ type: "phase", phase: "tool", detail: label });
        if (["search_repo", "read_file", "list_files"].includes(call.name)) {
          setPlanStep(plan, 1, "active", emit);
        }
        if (call.name === "propose_edit" || call.name === "write_file") {
          setPlanStep(plan, 1, "done", emit);
          setPlanStep(plan, 2, "active", emit);
        }
        if (call.name === "run_tests" || call.name === "run_command") setPlanStep(plan, 3, "active", emit);

        let result;
        let ok = true;
        let card = { name: call.name, label, args, ok: true, summary: "", data: null, id: call.id };

        try {
          if (call.name === "list_files") {
            const filter = String(args.filter ?? args.pattern ?? args.query ?? "").toLowerCase();
            const limit = Math.max(1, Math.min(200, Number(args.limit ?? 80)));
            const files = project.files
              .filter((file) => !filter || file.rel.toLowerCase().includes(filter))
              .slice(0, limit)
              .map((file) => ({ path: file.rel, language: file.language, bytes: file.size }));
            result = { status: "ok", count: files.length, files };
            card.summary = `${files.length} file${files.length === 1 ? "" : "s"}`;
            card.data = { files: files.slice(0, 60) };
          } else if (call.name === "search_repo") {
            const query = String(args.query ?? args.text ?? args.term ?? "");
            if (!query.trim()) throw new Error("query is required");
            const limit = Math.max(1, Math.min(80, Number(args.limit ?? 30)));
            const matches = searchRepo(project, query, { limit });
            result = {
              status: "ok",
              query,
              count: matches.length,
              matches: matches.map((m) => ({ file: m.rel, line: m.line, text: m.text.trim().slice(0, 200) })),
            };
            card.summary = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
            card.data = { query, matches: result.matches.slice(0, 40) };
          } else if (call.name === "read_file") {
            const rawPath = args.path ?? args.file ?? args.filename;
            if (!rawPath) throw new Error("path is required");
            const resolved = resolveInside(project.root, rawPath);
            if (!resolved.ok) throw new Error(resolved.error);
            const read = readFileSafe(resolved.path);
            if (!read.ok) throw new Error(read.error);
            const lines = read.content.split("\n");
            const start = Math.max(1, Math.floor(Number(args.start_line ?? args.start ?? 1)));
            const end = Math.min(lines.length, Math.max(start, Math.floor(Number(args.end_line ?? args.end ?? start + 119))));
            const cappedEnd = Math.min(end, start + MAX_READ_LINES - 1);
            const excerpt = lines
              .slice(start - 1, cappedEnd)
              .map((text, index) => `${String(start + index).padStart(5)}  ${text}`)
              .join("\n");
            const parsed = parseScopes(read.content, resolved.rel);
            const chain = formatScopeChain(chainAtLine(parsed, start), { maxWidth: 120 });
            result = {
              status: "ok",
              file: resolved.rel,
              language: parsed.language,
              start,
              end: cappedEnd,
              total_lines: lines.length,
              total_bytes: read.size,
              truncated: read.truncated,
              scope: chain,
              content: excerpt,
            };
            if (read.truncated) {
              result.note = "This is a truncated view. propose_edit will refuse this file.";
            }
            lastRead = {
              path: resolved.rel,
              absPath: resolved.path,
              scope: chain,
              snippet: lines.slice(start - 1, Math.min(cappedEnd, start + 7)).map(
                (text, index) => `${String(start + index).padStart(4)}  ${truncateToWidth(text, 96)}`
              ),
              line: start,
              duration: "—",
              language: parsed.language,
            };
            card.summary = `${resolved.rel}:${start}–${cappedEnd} · ${chain || parsed.language}${read.truncated ? " · truncated" : ""}`;
            card.data = lastRead;
          } else if (call.name === "propose_edit") {
            const rawPath = args.path ?? args.file ?? args.filename;
            if (!rawPath) throw new Error("path is required");
            const resolved = resolveInside(project.root, rawPath);
            if (!resolved.ok) throw new Error(resolved.error);
            const read = readFileSafe(resolved.path);
            if (!read.ok) throw new Error(read.error);
            if (read.truncated) {
              throw new Error(
                `refusing to edit ${resolved.rel}: file is ${formatBytes(read.size)} but reads are capped at ${formatBytes(Buffer.byteLength(read.content))}`
              );
            }
            if (read.utf8 === false) {
              throw new Error(`refusing to edit ${resolved.rel}: file is not valid UTF-8`);
            }
            const startLine = Math.floor(Number(args.start_line ?? args.start ?? args.line));
            const endLine = Math.floor(Number(args.end_line ?? args.end ?? (startLine + 1)));
            if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1) {
              throw new Error("start_line and end_line are required positive integers");
            }
            const proposed = proposeEdits(
              read.content,
              [
                {
                  startLine,
                  endLine,
                  replacement: String(args.replacement ?? ""),
                  reason: String(args.rationale ?? "model edit"),
                },
              ],
              { file: resolved.rel }
            );
            if (!proposed.ok) throw new Error(proposed.error);
            if (!proposed.patch) throw new Error("the proposed edit is a no-op");

            const parsed = parseScopes(read.content, resolved.rel);
            const chain = formatScopeChain(chainAtLine(parsed, startLine), { maxWidth: 120 });
            const parsedPatch = parseUnifiedDiff(proposed.patch);
            const proposal = {
              file: resolved.rel,
              absPath: resolved.path,
              scope: chain,
              original: read.content,
              updatedText: proposed.updatedText,
              patch: proposed.patch,
              hunks: parsedPatch.hunks,
              edits: proposed.edits,
              stats: proposed.stats,
              reason: String(args.rationale ?? "model edit"),
              model: model.id,
            };
            lastProposal = proposal;
            emit({ type: "proposal", proposal });

            let decision = autoApproveNow ? "y" : "n";
            if (!autoApproveNow) {
              emit({ type: "approval:request", proposal });
              decision = typeof requestApproval === "function" ? await requestApproval(proposal) : "n";
              emit({ type: "approval:result", decision });
            }
            if (aborted()) throw new Error("aborted");

            if (decision === "a") autoApproveNow = true;
            if (decision === "y" || decision === "a") {
              const target = revalidateBeforeWrite(project, proposal);
              proposal.absPath = target.path;
              const backup = backupFile(target.path);
              writeFileAtomic(target.path, proposed.updatedText);
              const applied = {
                ...proposal,
                backupPath: backup?.path ?? null,
                appliedAt: Date.now(),
              };
              appliedEdits.push(applied);
              emit({
                type: "applied",
                file: target.rel,
                absPath: target.path,
                stats: proposed.stats,
                backupPath: backup?.path ?? null,
              });
              result = {
                status: "applied",
                file: target.rel,
                stats: proposed.stats,
                patch: proposed.patch.slice(0, 4000),
                note: "The file was written. Call run_tests to verify.",
              };
              card.summary = `applied +${proposed.stats.adds} −${proposed.stats.dels}`;
            } else {
              result = { status: "denied", file: resolved.rel, message: "The user denied this edit. Do not retry it." };
              card.ok = false;
              card.summary = "denied by user";
            }
            card.data = {
              file: resolved.rel,
              scope: chain,
              diff: proposed.patch.split("\n").filter(Boolean),
              patch: proposed.patch,
              stats: proposed.stats,
              status: result.status,
            };
          } else if (call.name === "write_file") {
            const rawPath = args.path ?? args.file ?? args.filename;
            if (!rawPath) throw new Error("path is required");
            const newContent = typeof args.content === "string" ? args.content : String(args.content ?? "");
            const resolved = resolveInside(project.root, rawPath);
            if (!resolved.ok) throw new Error(resolved.error);
            const current = readFileSafe(resolved.path);
            const isCreation = !current.ok;
            if (current.ok) {
              if (current.truncated) {
                throw new Error(
                  `refusing to edit ${resolved.rel}: file is ${formatBytes(current.size)} but reads are capped at ${formatBytes(Buffer.byteLength(current.content))}`
                );
              }
              if (current.utf8 === false) {
                throw new Error(`refusing to edit ${resolved.rel}: file is not valid UTF-8`);
              }
              if (current.content === newContent) {
                throw new Error("the proposed write is a no-op");
              }
            }
            const originalText = current.ok ? current.content : "";
            const patch = makeUnifiedDiff(originalText, newContent, { file: resolved.rel });
            const stats = diffStatsFromText(patch);
            const parsedPatch = parseUnifiedDiff(patch);
            const parsed = parseScopes(newContent, resolved.rel);
            const chain = formatScopeChain(chainAtLine(parsed, 1), { maxWidth: 120 });
            const proposal = {
              file: resolved.rel,
              absPath: resolved.path,
              scope: chain,
              original: originalText,
              updatedText: newContent,
              patch,
              hunks: parsedPatch.hunks,
              edits: [
                {
                  startLine: 1,
                  endLine: (current.ok ? current.content.split("\n").length : 0) + 1,
                  replacement: newContent,
                  reason: String(args.rationale ?? (isCreation ? "create file" : "overwrite file")),
                },
              ],
              stats,
              reason: String(args.rationale ?? (isCreation ? "create file" : "overwrite file")),
              model: model.id,
              isCreation,
            };
            lastProposal = proposal;
            emit({ type: "proposal", proposal });

            let decision = autoApproveNow ? "y" : "n";
            if (!autoApproveNow) {
              emit({ type: "approval:request", proposal });
              decision = typeof requestApproval === "function" ? await requestApproval(proposal) : "n";
              emit({ type: "approval:result", decision });
            }
            if (aborted()) throw new Error("aborted");

            if (decision === "a") autoApproveNow = true;
            if (decision === "y" || decision === "a") {
              const target = revalidateBeforeWrite(project, proposal);
              proposal.absPath = target.path;
              const backup = backupFile(target.path);
              writeFileAtomic(target.path, newContent);
              if (isCreation) {
                const existingIndex = project.files.findIndex((f) => f.rel === target.rel);
                const fileEntry = {
                  rel: target.rel,
                  path: target.path,
                  language: parsed.language,
                  size: Buffer.byteLength(newContent),
                };
                if (existingIndex >= 0) project.files[existingIndex] = fileEntry;
                else project.files.push(fileEntry);
                project.fileCount = project.files.length;
              }
              const applied = {
                ...proposal,
                backupPath: backup?.path ?? null,
                appliedAt: Date.now(),
              };
              appliedEdits.push(applied);
              emit({
                type: "applied",
                file: target.rel,
                absPath: target.path,
                stats,
                backupPath: backup?.path ?? null,
                isCreation,
              });
              result = {
                status: "applied",
                file: target.rel,
                created: isCreation,
                stats,
                patch: patch.slice(0, 4000),
                note: isCreation
                  ? "The new file was created. Call run_tests to verify."
                  : "The file was written. Call run_tests to verify.",
              };
              card.summary = `${isCreation ? "created" : "applied"} +${stats.adds} −${stats.dels}`;
            } else {
              result = { status: "denied", file: resolved.rel, message: "The user denied this write. Do not retry it." };
              card.ok = false;
              card.summary = "denied by user";
            }
            card.data = {
              file: resolved.rel,
              scope: chain,
              diff: patch.split("\n").filter(Boolean),
              patch,
              stats,
              status: result.status,
            };
          } else if (call.name === "run_command") {
            const command = String(args.command ?? args.cmd ?? "").trim();
            if (!command) throw new Error("command is required");
            const BLOCKED_COMMAND_PATTERNS = [
              /\brm\s+-[rf]{1,2}\s+[\/\~]/i,
              /\bmkfs\b/i,
              /\bshred\b/i,
              /\bdd\s+if=/i,
              /:(){ :|:& };:/,
              />\s*\/dev\/sd[a-z]/i,
            ];
            for (const pattern of BLOCKED_COMMAND_PATTERNS) {
              if (pattern.test(command)) {
                throw new Error("command blocked: dangerous destructive pattern detected");
              }
            }
            emit({ type: "command:start", command });
            const procRes = await runProcess({
              file: "/bin/sh",
              args: ["-c", command],
              cwd: project.root,
              timeoutMs: 30_000,
              signal,
              env,
              onLine: (line, stream) => emit({ type: "command:line", command, line, stream }),
            });
            emit({ type: "command:end", result: procRes });
            result = {
              status: procRes.ok ? "ok" : "failed",
              exit_code: procRes.code,
              stdout: procRes.stdout.slice(-4000),
              stderr: procRes.stderr.slice(-4000),
              duration_ms: procRes.durationMs,
            };
            card.ok = procRes.ok;
            card.summary = procRes.ok
              ? `exit 0 (${formatDuration(procRes.durationMs)})`
              : `exit ${procRes.code ?? "err"} (${formatDuration(procRes.durationMs)})`;
            card.data = {
              command,
              ok: procRes.ok,
              code: procRes.code,
              duration: formatDuration(procRes.durationMs),
              stdout: procRes.stdout.slice(-2000),
              stderr: procRes.stderr.slice(-2000),
            };
          } else if (call.name === "run_tests") {
            const verified = await verifyOnce("model requested");
            if (verified.skipped) {
              result = { status: "skipped", message: "No test runner was detected in this workspace." };
              card.ok = false;
              card.summary = "no test runner";
            } else {
              result = {
                status: verified.ok ? "passed" : "failed",
                command: verified.command,
                passed: verified.passed,
                failed: verified.failed,
                duration_ms: verified.durationMs,
                summary: verified.summary,
                output: verified.lines.slice(-40),
              };
              card.ok = verified.ok;
              card.summary = verified.summary ?? `${verified.passed} passed · ${verified.failed} failed`;
            }
            card.data = {
              command: verified.command,
              passed: verified.passed,
              failed: verified.failed,
              skipped: verified.skipped,
              summary: verified.summary,
              lines: verified.lines?.slice(-40) ?? [],
              duration: formatDuration(verified.durationMs),
              ok: verified.ok,
            };
          } else {
            throw new Error(`unknown tool: ${call.name}`);
          }
        } catch (error) {
          ok = false;
          failure = error.message;
          result = { status: "error", error: error.message };
          card.ok = false;
          card.summary = error.message;
        }

        const serialised = safeJson(result);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: serialised.length > MAX_TOOL_RESULT ? serialised.slice(0, MAX_TOOL_RESULT) + "…" : serialised,
        });
        emit({ type: "tool:end", id: call.id, name: call.name, ok, summary: card.summary, data: card.data });
        toolCards.push({ ...card, ok, summary: card.summary });
        emit({ type: "phase", phase: "thinking", detail: `${model.name} is reasoning` });
      }

      if (aborted()) throw new Error("aborted");
    }

    if (rounds > maxRounds) {
      failure = `model reached the ${maxRounds}-round tool limit`;
      content += `\n\n(Stopped after ${maxRounds} tool rounds. Anything applied above is real; review it before continuing.)`;
    }

    // If the model edited but forgot to verify, verify anyway. A workbench
    // should not hand back an unverified write when a test command exists.
    if (autoVerify && appliedEdits.length > 0 && lastVerifiedEditCount !== appliedEdits.length) {
      setPlanStep(plan, 3, "active", emit);
      const verified = await verifyOnce("automatic after edit");
      if (!verified.skipped) {
        const line = verified.ok
          ? `Automatic verification: ${verified.summary ?? `${verified.passed} passed`} in ${formatDuration(verified.durationMs)}.`
          : `Automatic verification failed: ${verified.summary ?? `${verified.failed} failed`}. The edit is applied; press u to restore the backup.`;
        content += (content ? "\n\n" : "") + line;
      }
    }

    if (!content.trim()) {
      if (appliedEdits.length > 0) {
        const files = [...new Set(appliedEdits.map((edit) => edit.file))];
        content = `Applied ${appliedEdits.length} edit${appliedEdits.length === 1 ? "" : "s"} to ${files.join(", ")}.`;
      } else if (lastVerify) {
        content = lastVerify.ok
          ? `Tests passed: ${lastVerify.summary ?? `${lastVerify.passed} passed`}.`
          : `Tests failed: ${lastVerify.summary ?? `${lastVerify.failed} failed`}.`;
      } else {
        content = "The model finished without issuing a tool call or producing an answer.";
        failure = failure ?? "empty model response";
      }
    }

    setPlanStep(plan, 0, "done", emit);
    if (!toolCards.some((c) => ["search_repo", "read_file", "list_files"].includes(c.name))) {
      setPlanStep(plan, 1, "skipped", emit);
    } else {
      setPlanStep(plan, 1, "done", emit);
    }
    if (appliedEdits.length > 0) {
      setPlanStep(plan, 2, "done", emit);
    } else {
      setPlanStep(plan, 2, "skipped", emit);
    }
    if (lastVerify) {
      setPlanStep(plan, 3, lastVerify.ok || lastVerify.skipped ? "done" : "error", emit);
    } else {
      setPlanStep(plan, 3, "skipped", emit);
    }

    const cost = estimateCost(model, {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      prompt_tokens_details: { cached_tokens: usage.cached_tokens },
    });
    const metrics = {
      rounds,
      toolCalls: toolCallCount,
      elapsedMs: Date.now() - started,
      usage,
      cost,
    };
    emit({ type: "metrics", metrics });
    emit({ type: "phase", phase: lastVerify && !lastVerify.ok && !lastVerify.skipped ? "failed" : "complete" });

    const result = buildModelResult({
      content,
      reasoning,
      plan,
      toolCards,
      lastRead,
      lastProposal,
      appliedEdits,
      lastVerify,
      usage,
      cost,
      metrics,
      failure,
      model,
      finishReason,
      error: false,
    });
    emit({ type: "result", result });
    emit({ type: "done" });
    return result;
  } catch (error) {
    const wasAborted = aborted() || /aborted/i.test(error.message);
    const message = wasAborted
      ? "Model run aborted. Any edit that was already applied remains on disk; press u to restore the backup."
      : `Model run failed: ${error.message}`;
    const metrics = {
      rounds,
      toolCalls: toolCallCount,
      elapsedMs: Date.now() - started,
      usage,
      cost: estimateCost(model, {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        prompt_tokens_details: { cached_tokens: usage.cached_tokens },
      }),
    };
    emit({ type: "error", error: message, aborted: wasAborted });
    emit({ type: "phase", phase: wasAborted ? "aborted" : "failed" });
    emit({ type: "metrics", metrics });
    const result = buildModelResult({
      content: message,
      reasoning,
      plan,
      toolCards,
      lastRead,
      lastProposal,
      appliedEdits,
      lastVerify,
      usage,
      cost: metrics.cost,
      metrics,
      failure: message,
      model,
      finishReason,
      error: true,
    });
    emit({ type: "result", result });
    emit({ type: "done" });
    return result;
  }
}

function buildModelResult({
  content,
  reasoning,
  plan,
  toolCards,
  lastRead,
  lastProposal,
  appliedEdits,
  lastVerify,
  usage,
  cost,
  metrics,
  failure,
  model,
  finishReason,
  error,
}) {
  // A later denied proposal on the same file must not inherit the status of an
  // earlier applied one. Match the exact patch, not just the path.
  const lastProposalApplied = lastProposal
    ? appliedEdits.find((edit) => edit.file === lastProposal.file && edit.patch === lastProposal.patch)
    : null;
  const editFile = lastProposal
    ? {
        path: lastProposal.file,
        scope: lastProposal.scope,
        diff: lastProposal.patch.split("\n").filter(Boolean),
        patch: lastProposal.patch,
        hunks: lastProposal.hunks,
        stats: lastProposal.stats,
        status: lastProposalApplied ? "applied" : "denied",
        backupPath: lastProposalApplied?.backupPath ?? null,
      }
    : null;

  const verifyTests = lastVerify
    ? {
        cmd: lastVerify.command,
        results: lastVerify.cases?.length
          ? lastVerify.cases.map((c) => ({ name: c.name, pass: c.pass }))
          : lastVerify.lines?.slice(-8).map((line) => ({ name: line, pass: lastVerify.ok })),
        passed: lastVerify.passed,
        failed: lastVerify.failed,
        skipped: lastVerify.skipped,
        duration: formatDuration(lastVerify.durationMs),
        output: lastVerify.lines?.slice(-40) ?? [],
        summary: lastVerify.summary,
        ok: lastVerify.ok,
        timedOut: lastVerify.timedOut ?? false,
        aborted: lastVerify.aborted ?? false,
        parseConfident: lastVerify.parseConfident ?? null,
      }
    : null;

  const files = [...new Set(appliedEdits.map((edit) => edit.file))];
  const summary = error
    ? failure
    : appliedEdits.length > 0
    ? `Applied ${appliedEdits.length} edit${appliedEdits.length === 1 ? "" : "s"} to ${files.join(", ")}${
        lastVerify ? ` · ${lastVerify.summary ?? `${lastVerify.passed} passed`}` : ""
      }`
    : `Model response · ${usage.total_tokens ?? 0} tokens · $${(cost ?? 0).toFixed(4)}`;

  return {
    role: "assistant",
    mode: "remote",
    model: model.id,
    modelName: model.name,
    id: `asst-${Date.now()}`,
    plan: plan.map((step) => ({ ...step })),
    reasoning,
    readFile: lastRead,
    editFile,
    verifyTests,
    toolCards,
    content,
    summary,
    failure: error ? failure : null,
    error: Boolean(error),
    applied: appliedEdits.at(-1) ?? null,
    proposal: lastProposal,
    usage,
    cost,
    metrics,
    finishReason,
    elapsedTime: Math.round((metrics?.elapsedMs ?? 0) / 1000),
    timestamp: Date.now(),
  };
}
