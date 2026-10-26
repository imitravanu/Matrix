// ============================================================================
// Model agent: a real tool-calling loop over OpenRouter.
//
// The default surface is six audited tools: list, search, read, propose an edit,
// write a gated file, and run the project's tests. An explicitly enabled exact
// command plan uses a separate one-shot sandbox gate; its writes are discarded.
// Live file edits still require approval, containment, validated diffs and atomic writes.
// ============================================================================

import { lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { isBinaryPath, readFileSafe, searchRepo } from "./project.mjs";
import { parseScopes, chainAtLine, formatScopeChain } from "./scope.mjs";
import { proposeEdits, parseUnifiedDiff, diffStatsFromText, makeUnifiedDiff } from "./diff.mjs";
import { runTests } from "./process.mjs";
import { OUTCOME, classifyOutcome, withOutcome } from "./outcome.mjs";
import { backupFile, matrixHome, newRunId } from "./session.mjs";
import { resolveInside, writeFileAtomic } from "./workspace.mjs";
import { estimateCost } from "./models.mjs";
import { formatBytes, formatDuration, oneLine, truncateToWidth } from "./text.mjs";
import { getOpenRouterKey, streamOpenRouter } from "./openrouter.mjs";

const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;
const MAX_RESPONSE_TOOL_CALLS = 24;
const MAX_TOOL_ARGUMENT_BYTES = 32 * 1024;
const MAX_RESPONSE_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOTAL_ARGUMENT_BYTES = 256 * 1024;
const MAX_RESPONSE_CONTEXT_BYTES = 128 * 1024;
const MAX_COMPLETION_TOKENS = 4096;
const DEFAULT_CONTEXT_TOKENS = 32_768;
const MAX_READ_LINES = 160;
const MAX_TOOL_RESULT_BYTES = 24_000;
const MAX_FOLLOW_UP_MESSAGES = 12;
const MAX_FOLLOW_UP_BYTES = 32 * 1024;
const MAX_FOLLOW_UP_MESSAGE_BYTES = 4 * 1024;
const COMMAND_ORIGIN = "run_sandboxed_command";
const COMMAND_EXECUTION_MODULE = "./command-execution.mjs";

/** Parse model arguments without repairing or otherwise rewriting their source. */
export function parseToolArgs(raw) {
  if (raw === null || raw === undefined || raw === "") return {};
  if (typeof raw !== "string") throw new TypeError("tool arguments must be a JSON string");
  const text = raw.trim();
  return text ? JSON.parse(text) : {};
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSensitiveReadPath(path) {
  const parts = String(path ?? "")
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const base = parts.at(-1) ?? "";
  if (parts.some((part) => [".git", ".matrix", ".ssh"].includes(part))) return true;
  if (/^\.env(?:\.|$)/.test(base)) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(?:\.|$)/.test(base)) return true;
  return /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(base);
}

function isDefinitelyMissing(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

/** Revalidate containment and contents after the approval gate, before writing. */
function revalidateBeforeWrite(project, proposal) {
  const resolved = resolveInside(project.root, proposal.absPath);
  if (!resolved.ok) throw new Error(`refusing to write: ${resolved.error}`);
  if (proposal.isCreation) {
    if (!isDefinitelyMissing(resolved.path)) {
      throw new Error(`refusing to create ${resolved.rel}: file already exists on disk`);
    }
    return { path: resolved.path, rel: resolved.rel };
  }
  const current = readFileSafe(resolved.path);
  if (!current.ok) throw new Error(`refusing to write ${resolved.rel}: ${current.error}`);
  if (current.truncated) {
    throw new Error(
      `refusing to write ${resolved.rel}: the file is larger than the safe read limit`,
    );
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
      description:
        "List files in the workspace, optionally filtered by a substring or glob-ish pattern.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            description: "Substring of the relative path, e.g. 'src/' or '.py'.",
          },
          limit: { type: "number", description: "Maximum results (default 80)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_repo",
      description:
        "Search real repository file contents for a literal string. Returns file paths and line numbers.",
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
      description:
        "Read a real file by workspace-relative path, with line numbers and the enclosing scope chain.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          start_line: { type: "number", description: "First line (1-based). Defaults to 1." },
          end_line: {
            type: "number",
            description: "Last line (inclusive). Defaults to start + 120.",
          },
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
          start_line: {
            type: "number",
            description: "First line to replace (1-based, inclusive).",
          },
          end_line: {
            type: "number",
            description: "Line after the last replaced line (exclusive).",
          },
          replacement: {
            type: "string",
            description: "Exact replacement text. Do not include line numbers.",
          },
          rationale: {
            type: "string",
            description: "One sentence explaining why this edit is correct.",
          },
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
          rationale: {
            type: "string",
            description: "One sentence explaining why this file is created or written.",
          },
        },
        required: ["path", "content"],
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

export const RUN_SANDBOXED_COMMAND_TOOL_SCHEMA = Object.freeze({
  type: "function",
  function: {
    name: COMMAND_ORIGIN,
    description:
      "Run one exact executable-plus-literal-argv plan in a disposable, no-network OS sandbox. " +
      "Requires separate command capability enablement and one-shot approval. Writes are discarded; undo is not applicable.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        executable: {
          type: "string",
          description: "Absolute executable path resolving inside /usr or the workspace.",
        },
        argv: {
          type: "array",
          items: { type: "string" },
          description: "Literal arguments only; never a shell command string.",
        },
        cwd: { type: "string", description: "Working directory inside the workspace." },
        script: {
          type: "string",
          description: "Exact inline script bytes when an interpreter eval argument requires them.",
        },
        scriptFile: {
          type: "string",
          description: "Workspace script path referenced by one literal argv element.",
        },
      },
      required: ["executable", "argv", "cwd"],
    },
  },
});

/** Keep the legacy six-tool export unchanged; capability is per trusted run. */
export function toolSchemasFor(commandCapability = null) {
  return commandCapability?.enabled === true &&
    (typeof commandCapability.policyFactory === "function" ||
      typeof commandCapability.policy?.authorize === "function")
    ? [...TOOL_SCHEMAS, RUN_SANDBOXED_COMMAND_TOOL_SCHEMA]
    : TOOL_SCHEMAS;
}

function systemPromptFor(project, commandsEnabled = false) {
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
    "5. If approval is denied, do not retry the same edit; explain and stop.",
    "6. If you cannot ground a change, say so instead of inventing one.",
    "7. Final answers are concise. Mention paths, line numbers and verification results.",
    ...(commandsEnabled
      ? [
          "8. run_sandboxed_command takes only executable/argv/cwd/script/scriptFile. It needs fresh approval per command; snapshot writes are discarded and are never applied edits. A denied, failed, timed-out, aborted, unavailable, cleanup-failed, or audit-failed command is not execution success.",
        ]
      : []),
  ].join("\n");
}

function boundedUtf8(value, maximumBytes, { tail = false } = {}) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text) <= maximumBytes) return { text, truncated: false };
  const marker = "…";
  const budget = Math.max(0, maximumBytes - Buffer.byteLength(marker));
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let candidate = tail ? (middle === 0 ? "" : text.slice(-middle)) : text.slice(0, middle);
    if (tail && middle > 0 && middle < text.length && /^[\uDC00-\uDFFF]/.test(candidate)) {
      candidate = candidate.slice(1);
    }
    if (!tail && middle > 0 && /[\uD800-\uDBFF]$/.test(candidate)) {
      candidate = candidate.slice(0, -1);
    }
    if (Buffer.byteLength(candidate) <= budget) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { text: tail ? `${marker}${best}` : `${best}${marker}`, truncated: true };
}

/** Raw model arguments stay private to the provider/core; projections hash inline bytes. */
function commandArgsForProjection(args) {
  const inline = typeof args.script === "string" ? args.script : null;
  const digest = inline === null ? null : createHash("sha256").update(inline).digest("hex");
  const placeholder = digest === null ? null : `[inline-script sha256:${digest}]`;
  const projected = {
    executable: typeof args.executable === "string" ? args.executable : null,
    argv: Array.isArray(args.argv)
      ? args.argv.map((argument) =>
          inline !== null && argument === inline
            ? placeholder
            : typeof argument === "string"
              ? boundedUtf8(argument, 1024).text
              : null,
        )
      : [],
    cwd: typeof args.cwd === "string" ? args.cwd : null,
  };
  if (inline !== null) projected.script = placeholder;
  if (typeof args.scriptFile === "string") projected.scriptFile = args.scriptFile;
  return projected;
}

function commandPlanForProjection(plan) {
  if (!plan) return { plan: null, truncated: false };
  let truncated = false;
  const text = (value, maximum, tail = false) => {
    const bounded = boundedUtf8(value, maximum, { tail });
    truncated ||= bounded.truncated;
    return bounded.text;
  };
  const argv = Array.isArray(plan.argv) ? plan.argv : [];
  if (argv.length > 24) truncated = true;
  return {
    plan: {
      version: plan.version,
      executable: text(plan.executable, 1024),
      executableFile: plan.executableFile ?? null,
      argv: argv.slice(0, 24).map((argument) => text(argument, 512)),
      cwd: text(plan.cwd, 1024),
      workspace: text(plan.workspace, 1024),
      workspaceHash: plan.workspaceHash ?? null,
      policyIdentity: plan.policyIdentity ?? null,
      command: text(plan.command, 2048),
      scripts: (plan.scripts ?? []).map((script) => ({
        kind: script.kind,
        path: script.path ? text(script.path, 1024) : undefined,
        relative: script.relative ? text(script.relative, 1024) : undefined,
        bytes: script.bytes,
        sha256: script.sha256,
      })),
      scriptsHash: plan.scriptsHash ?? null,
      planHash: plan.planHash ?? null,
    },
    truncated,
  };
}

function commandExecutionOk(result) {
  return Boolean(
    result.commandStatus === "succeeded" &&
    result.processStatus === "succeeded" &&
    result.processOk === true &&
    result.code === 0 &&
    !result.signal &&
    !result.timedOut &&
    !result.aborted &&
    result.auditStatus === "complete" &&
    result.audit?.decision === true &&
    result.audit?.start === true &&
    result.audit?.end === true &&
    !result.auditError &&
    result.cleanupStatus === "complete" &&
    !result.cleanupError &&
    result.liveWorkspaceChanged === false &&
    result.writes === "discarded" &&
    result.undo === "not-applicable",
  );
}

/** A bounded, redacted command projection that never discards terminal semantics. */
function commandResultForTool(result) {
  const stdout = boundedUtf8(result.stdout, 1024, { tail: true });
  const stderr = boundedUtf8(result.stderr, 1024, { tail: true });
  const sourceLines = Array.isArray(result.lines) ? result.lines : [];
  const lines = sourceLines.slice(-24).map((line) => boundedUtf8(line, 256, { tail: true }));
  const projectedPlan = commandPlanForProjection(result.commandPlan);
  const lineTruncated = lines.some((line) => line.truncated);
  const auditError = boundedUtf8(result.auditError, 1024);
  const cleanupError = boundedUtf8(result.cleanupError, 1024);
  const processError = boundedUtf8(result.processError, 1024);
  const failure = boundedUtf8(result.failure, 2048);
  return {
    ok: result.ok,
    status: result.status,
    outcome: result.outcome,
    error: result.error,
    failure: result.failure == null ? null : failure.text,
    executionOk: commandExecutionOk(result),
    commandStatus: result.commandStatus,
    reason: result.reason,
    processStatus: result.processStatus,
    processOk: result.processOk,
    code: result.code,
    signal: result.signal,
    timedOut: Boolean(result.timedOut),
    aborted: Boolean(result.aborted),
    durationMs: result.durationMs,
    processError: result.processError == null ? null : processError.text,
    command: result.command == null ? null : boundedUtf8(result.command, 2048).text,
    commandPlan: projectedPlan.plan,
    commandPlanTruncated: projectedPlan.truncated,
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: Boolean(result.stdoutTruncated || stdout.truncated),
    stderrTruncated: Boolean(result.stderrTruncated || stderr.truncated),
    lines: lines.map((line) => line.text),
    outputLineCount: result.outputLineCount,
    outputTruncated: Boolean(
      result.outputTruncated || sourceLines.length > lines.length || lineTruncated,
    ),
    liveWorkspaceChanged: result.liveWorkspaceChanged ?? false,
    writes: result.writes ?? "discarded",
    undo: result.undo ?? "not-applicable",
    snapshot: result.snapshot ?? null,
    cleanupStatus: result.cleanupStatus,
    cleanupError: result.cleanupError == null ? null : cleanupError.text,
    auditStatus: result.auditStatus,
    auditError: result.auditError == null ? null : auditError.text,
    audit: {
      decision: Boolean(result.audit?.decision),
      start: Boolean(result.audit?.start),
      end: Boolean(result.audit?.end),
      path: result.audit?.path ? boundedUtf8(result.audit.path, 1024).text : null,
      runId: result.audit?.runId ?? null,
      executionId: result.audit?.executionId ?? null,
    },
  };
}

function unavailableCommandResult(reason) {
  return commandResultForTool({
    ok: true,
    status: "denied",
    outcome: "denied",
    error: false,
    failure: null,
    commandStatus: "denied",
    reason,
    processStatus: "not-started",
    processOk: false,
    code: null,
    signal: null,
    timedOut: false,
    aborted: false,
    durationMs: 0,
    processError: null,
    command: null,
    commandPlan: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    lines: [],
    outputLineCount: 0,
    outputTruncated: false,
    liveWorkspaceChanged: false,
    writes: "discarded",
    undo: "not-applicable",
    cleanupStatus: "not-applicable",
    cleanupError: null,
    auditStatus: "not-started",
    auditError: null,
    audit: { decision: false, start: false, end: false },
  });
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ status: "error", error: "result not serialisable" });
  }
}

function serializeToolResult(result) {
  const serialised = safeJson(result);
  const originalBytes = Buffer.byteLength(serialised);
  if (originalBytes <= MAX_TOOL_RESULT_BYTES) return serialised;

  const status = isPlainObject(result) && typeof result.status === "string" ? result.status : "ok";
  const commandSemantics =
    isPlainObject(result) && typeof result.commandStatus === "string"
      ? {
          ok: result.ok,
          executionOk: result.executionOk,
          outcome: result.outcome,
          error: result.error,
          failure: result.failure,
          commandStatus: result.commandStatus,
          reason: result.reason,
          processStatus: result.processStatus,
          processOk: result.processOk,
          code: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
          aborted: result.aborted,
          outputLineCount: result.outputLineCount,
          outputTruncated: result.outputTruncated,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
          auditStatus: result.auditStatus,
          auditError: result.auditError,
          audit: result.audit,
          cleanupStatus: result.cleanupStatus,
          cleanupError: result.cleanupError,
          liveWorkspaceChanged: result.liveWorkspaceChanged,
          writes: result.writes,
          undo: result.undo,
        }
      : {};
  const wrap = (preview) => {
    const previewBytes = Buffer.byteLength(preview);
    return {
      ...commandSemantics,
      status,
      truncated: true,
      truncation: {
        original_bytes: originalBytes,
        limit_bytes: MAX_TOOL_RESULT_BYTES,
        preview_bytes: previewBytes,
        omitted_bytes: Math.max(0, originalBytes - previewBytes),
        preview_format: "json-prefix",
      },
      preview,
    };
  };

  // JSON escaping can expand the preview, so fit the complete envelope rather
  // than slicing the serialized result into invalid JSON.
  let low = 0;
  let high = serialised.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let preview = serialised.slice(0, middle);
    if (middle > 0 && middle < serialised.length && /[\uD800-\uDBFF]$/.test(preview)) {
      preview = preview.slice(0, -1);
    }
    if (Buffer.byteLength(safeJson(wrap(preview))) <= MAX_TOOL_RESULT_BYTES) {
      best = preview;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return safeJson(wrap(best));
}

function contextTokenLimit(model) {
  const context = Number(model?.context);
  return Number.isFinite(context) && context > 0 ? Math.floor(context) : DEFAULT_CONTEXT_TOKENS;
}

function estimatePromptTokens(systemPrompt, messages, toolSchemas) {
  const payload = safeJson({
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    tools: toolSchemas,
    tool_choice: "auto",
  });
  return Math.ceil(Buffer.byteLength(payload) / 4) + (messages.length + 1) * 4;
}

function boundedUtf8Prefix(value, maxBytes) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = "\n…[context truncated]";
  const budget = maxBytes - Buffer.byteLength(marker);
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    let prefix = text.slice(0, middle);
    if (middle > 0 && middle < text.length && /[\uD800-\uDBFF]$/.test(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (Buffer.byteLength(prefix) <= budget) {
      best = prefix;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${best}${marker}`;
}

/**
 * Conversation contract: runs are stateless unless the caller supplies previous
 * completed turns in `extraContext` (an array or `{ messages }`). Only textual
 * user/assistant turns cross the run boundary; tool transcripts stay private to
 * the run that created them. Keep the newest 12 messages and 32 KiB, with an
 * explicit marker on individually truncated messages. The current task is
 * appended once, so a UI may pass history that already ends with that task.
 */
function followUpHistory(extraContext, currentTask) {
  const source = Array.isArray(extraContext) ? extraContext : extraContext?.messages;
  if (!Array.isArray(source)) return [];
  const candidates = [];
  for (const message of source) {
    if (!message || !["user", "assistant"].includes(message.role)) continue;
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    candidates.push({ role: message.role, content: message.content });
  }
  const last = candidates.at(-1);
  if (last?.role === "user" && last.content === String(currentTask ?? "")) candidates.pop();

  const selected = [];
  let bytes = 0;
  for (
    let index = candidates.length - 1;
    index >= 0 && selected.length < MAX_FOLLOW_UP_MESSAGES;
    index--
  ) {
    const candidate = candidates[index];
    const message = {
      role: candidate.role,
      content: boundedUtf8Prefix(candidate.content, MAX_FOLLOW_UP_MESSAGE_BYTES),
    };
    const messageBytes = Buffer.byteLength(message.content) + 16;
    if (bytes + messageBytes > MAX_FOLLOW_UP_BYTES) break;
    bytes += messageBytes;
    selected.unshift(message);
  }
  // Do not begin a bounded window with an orphaned answer when its question
  // fell outside the count/byte budget.
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

function emptyUsagePart() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, cost: 0 };
}

/**
 * Cumulative usage for one run. `provenance` describes token totals while
 * `costProvenance` independently describes charges. Nested provider/estimated
 * objects retain token and dollar subtotals, rounds retain source counts, and
 * costComplete=false warns that a numeric cost is only a known subtotal.
 */
function createUsageAccounting() {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    cost: null,
    provenance: "unavailable",
    costProvenance: "unavailable",
    costComplete: false,
    provider: emptyUsagePart(),
    estimated: emptyUsagePart(),
    rounds: { total: 0, provider: 0, estimated: 0, unavailable: 0 },
    costRounds: { provider: 0, estimated: 0, unavailable: 0 },
  };
}

function usageSnapshot(usage) {
  return {
    ...usage,
    provider: { ...usage.provider },
    estimated: { ...usage.estimated },
    rounds: { ...usage.rounds },
    costRounds: { ...usage.costRounds },
  };
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean")
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function providerTokenUsage(roundUsage) {
  if (!roundUsage || typeof roundUsage !== "object") return null;
  const prompt = finiteNonNegative(roundUsage.prompt_tokens ?? roundUsage.input_tokens);
  const completion = finiteNonNegative(roundUsage.completion_tokens ?? roundUsage.output_tokens);
  const total = finiteNonNegative(roundUsage.total_tokens);
  const cached = finiteNonNegative(
    roundUsage.prompt_tokens_details?.cached_tokens ??
      roundUsage.cache_read_input_tokens ??
      roundUsage.cached_tokens,
  );
  if ([prompt, completion, total, cached].every((value) => value === null)) return null;
  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    total_tokens: total ?? (prompt ?? 0) + (completion ?? 0),
    cached_tokens: cached ?? 0,
  };
}

/** OpenRouter's `usage.cost` is a charge, not a registry estimate. Zero is real. */
function providerReportedCost(roundUsage) {
  return finiteNonNegative(roundUsage?.cost);
}

function addTokenTotals(target, tokens) {
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens"]) {
    target[key] += tokens[key];
  }
}

function provenanceFor(counts) {
  const sources = ["provider", "estimated", "unavailable"].filter((source) => counts[source] > 0);
  if (sources.length === 0) return "unavailable";
  return sources.length === 1 ? sources[0] : "mixed";
}

function recordUsageRound(usage, { providerTokens, estimatedTokens, providerCost, estimatedCost }) {
  usage.rounds.total++;
  if (providerTokens) {
    usage.rounds.provider++;
    addTokenTotals(usage.provider, providerTokens);
    addTokenTotals(usage, providerTokens);
  } else if (estimatedTokens) {
    usage.rounds.estimated++;
    addTokenTotals(usage.estimated, estimatedTokens);
    addTokenTotals(usage, estimatedTokens);
  } else {
    usage.rounds.unavailable++;
  }

  // A provider charge wins for its round. Registry pricing is used only when
  // that round has no charge; mixed run totals always retain both breakdowns.
  if (providerCost !== null) {
    usage.costRounds.provider++;
    usage.provider.cost += providerCost;
  } else if (estimatedCost !== null) {
    usage.costRounds.estimated++;
    usage.estimated.cost += estimatedCost;
  } else {
    usage.costRounds.unavailable++;
  }
  const knownCostRounds = usage.costRounds.provider + usage.costRounds.estimated;
  usage.cost = knownCostRounds > 0 ? usage.provider.cost + usage.estimated.cost : null;
  usage.provenance = provenanceFor(usage.rounds);
  usage.costProvenance = provenanceFor(usage.costRounds);
  usage.costComplete =
    knownCostRounds > 0 &&
    usage.costRounds.unavailable === 0 &&
    knownCostRounds === usage.rounds.total;
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
    case COMMAND_ORIGIN:
      return `sandbox ${truncateToWidth(oneLine(args.executable ?? "?"), 48)}`;
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
 * `recoveryMode: "auto"` uses the TTY contract; embedders may explicitly select
 * "interactive" (controller undo) or "headless" (concrete backup actions).
 * @param {Partial<import("./contracts.mjs").AgentOptions>} [options]
 * @returns {Promise<import("./contracts.mjs").RunResult>}
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
  testTimeoutMs = undefined,
  extraContext = null,
  recoveryMode = "auto",
  commandCapability = null,
} = {}) {
  const started = Date.now();
  /** @param {import("./contracts.mjs").RunEvent} event */
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      // UI callbacks are not allowed to break a run.
    }
  };
  const aborted = () => signal?.aborted === true;
  const plan = planForRemote();
  const toolCards = [];
  const appliedEdits = [];

  /** @type {import("./contracts.mjs").ProviderMessage[]} */
  let messages = [...followUpHistory(extraContext, task), { role: "user", content: task }];
  let content = "";
  let reasoning = "";
  let lastRead = null;
  let lastProposal = null;
  /** @type {import("./contracts.mjs").VerificationResult|null} */
  let lastVerify = null;
  let lastVerifiedEditCount = -1;
  const usage = createUsageAccounting();
  let rounds = 0;
  let toolCallCount = 0;
  let totalArgumentBytes = 0;
  let finishReason = null;
  let autoApproveNow = Boolean(autoApprove);
  let failure = null;
  let budgetFailure = null;
  /** @type {import("./contracts.mjs").OutcomeClassification|null} */
  let terminalOutcome = null;
  let selfHealAttempts = 0;
  const maxSelfHeals = 2;
  const interactiveRecovery =
    recoveryMode === "interactive" ||
    (recoveryMode === "auto" && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const toolSchemas = toolSchemasFor(commandCapability);
  const commandsEnabled = toolSchemas.includes(RUN_SANDBOXED_COMMAND_TOOL_SCHEMA);
  if (commandCapability?.enabled === true && !commandsEnabled) {
    throw new Error("enabled command capability requires a trusted policy or per-command factory");
  }
  if (commandsEnabled && commandCapability.headless === true) {
    if (
      typeof commandCapability.policy?.authorize !== "function" ||
      commandCapability.policyFactory != null
    ) {
      throw new Error("headless command capability requires exactly one policy instance");
    }
  } else if (
    commandsEnabled &&
    (typeof commandCapability.policyFactory !== "function" || commandCapability.policy != null)
  ) {
    throw new Error("interactive command capability requires a fresh policy per command");
  }
  const commandHome = commandsEnabled ? (commandCapability.home ?? matrixHome()) : null;
  const commandRunId = commandsEnabled ? (commandCapability.runId ?? newRunId()) : null;
  const providerSecret = commandsEnabled ? getOpenRouterKey(model.id) : null;
  const commandSecretValues = providerSecret ? [providerSecret] : [];
  let lastCommand = null;

  const emitUsage = () => {
    emit({ type: "usage", usage: usageSnapshot(usage) });
  };

  const makeMetrics = () => {
    const currentUsage = usageSnapshot(usage);
    return {
      rounds: Math.min(rounds, maxRounds),
      toolCalls: toolCallCount,
      elapsedMs: Date.now() - started,
      usage: currentUsage,
      cost: currentUsage.cost,
      usageProvenance: currentUsage.provenance,
      costProvenance: currentUsage.costProvenance,
      costComplete: currentUsage.costComplete,
      providerCost: currentUsage.provider.cost,
      estimatedCost: currentUsage.estimated.cost,
    };
  };

  const attachRecoveryGuidance = (result) => {
    if (result.ok || appliedEdits.length === 0) return result;
    const mode = interactiveRecovery ? "interactive" : "headless";
    const subject =
      appliedEdits.length === 1 ? "The applied edit remains" : "The applied edits remain";
    // One recovery entry per file points to the pre-run bytes. Later backups of
    // the same file are intermediate states and must not be the final restore.
    const recoveryEdits = [
      ...appliedEdits
        .reduce((entries, edit) => {
          if (!entries.has(edit.file)) {
            entries.set(edit.file, {
              file: edit.file,
              backupPath: edit.backupPath ?? null,
              isCreation: Boolean(edit.isCreation),
            });
          }
          return entries;
        }, new Map())
        .values(),
    ];
    const recoverySteps = recoveryEdits.map((edit) =>
      edit.isCreation
        ? `delete newly created ${edit.file}`
        : edit.backupPath
          ? `restore ${edit.file} from ${edit.backupPath}`
          : `restore ${edit.file} from its pre-run bytes (no backup path was recorded)`,
    );
    const instructions = interactiveRecovery
      ? `${subject} on disk; use Alt+U or /undo to restore the pre-run state.`
      : `${subject} on disk. This headless run has no interactive undo; use these backup paths/actions: ${recoverySteps.join("; ")}.`;
    result.recovery = {
      mode,
      instructions,
      edits: recoveryEdits,
    };
    if (!result.content.includes(instructions)) {
      result.content = `${result.content}${result.content ? "\n\n" : ""}${instructions}`;
    }
    return result;
  };

  const verifyOnce = async (reason = "auto") => {
    if (!project.test) {
      /** @type {import("./contracts.mjs").VerificationResult} */
      const skipped = {
        skipped: true,
        ok: false,
        processOk: false,
        verified: false,
        verificationStatus: "skipped",
        summary: "no test runner detected",
        passed: 0,
        failed: 0,
        cases: [],
        lines: [],
        durationMs: 0,
        command: null,
      };
      emit({ type: "verify:skipped", reason: "no test runner detected" });
      lastVerify = skipped;
      lastVerifiedEditCount = appliedEdits.length;
      terminalOutcome = classifyOutcome({ verification: skipped });
      return skipped;
    }
    emit({ type: "phase", phase: "verifying", detail: reason });
    emit({ type: "verify:start", command: project.test.display, cwd: project.test.cwd });
    const result = await runTests(project.test, {
      cwd: project.test.cwd,
      signal,
      env,
      timeoutMs: testTimeoutMs,
      onLine: (line, stream) => emit({ type: "verify:line", line, stream }),
    });
    result.file = lastProposal?.file ?? null;
    emit({ type: "verify:end", result });
    lastVerify = result;
    lastVerifiedEditCount = appliedEdits.length;

    // Classify every completed child before any caller can start another model
    // round or process. Failures remain available to existing recovery paths;
    // aborts, timeouts, and unrecognized output are terminal.
    const outcome = classifyOutcome({
      verification: result,
      aborted: result.timedOut ? false : aborted(),
    });
    if (outcome.status === OUTCOME.ABORTED) throw new Error("aborted");
    if (outcome.status === OUTCOME.TIMED_OUT || outcome.status === OUTCOME.UNVERIFIED) {
      terminalOutcome = outcome;
    }
    return result;
  };

  const offerHealing = (verified, { automatic }) => {
    if (selfHealAttempts >= maxSelfHeals || rounds >= maxRounds) return false;
    selfHealAttempts++;
    emit({
      type: "phase",
      phase: "healing",
      detail: `Self-healing attempt ${selfHealAttempts}/${maxSelfHeals}: tests failed`,
    });
    if (automatic) {
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
    }
    // Explicit run_tests already has a protocol-ordered tool response containing
    // the same failure output. Count one bounded follow-up opportunity without
    // inserting a user message between an assistant call and its tool replies.
    return true;
  };

  const rejectToolCall = (call, message, { status = "error", suffix = "invalid args" } = {}) => {
    const label = `${call.name || "tool"} (${suffix})`;
    const result = { status, error: message };
    messages.push({ role: "tool", tool_call_id: call.id, content: safeJson(result) });
    emit({ type: "tool:start", id: call.id, name: call.name, label, args: {} });
    emit({
      type: "tool:end",
      id: call.id,
      name: call.name,
      ok: false,
      summary: message,
      data: { status },
    });
    toolCards.push({
      name: call.name,
      label,
      args: {},
      ok: false,
      summary: message,
      data: { status },
      id: call.id,
    });
  };

  emit({ type: "run:start", mode: "remote", model: model.id, modelName: model.name, task, plan });
  emit({ type: "phase", phase: "thinking", detail: model.name });
  emit({ type: "plan", plan: plan.map((s) => ({ ...s })), activeIndex: 0 });

  try {
    for (rounds = 1; rounds <= maxRounds; rounds++) {
      if (aborted()) throw new Error("aborted");
      if (toolCallCount >= MAX_TOOL_CALLS) {
        budgetFailure = `tool-call budget exhausted (${MAX_TOOL_CALLS})`;
        throw new Error(budgetFailure);
      }

      const systemPrompt = systemPromptFor(project, commandsEnabled);
      const contextLimit = contextTokenLimit(model);
      const promptTokens = estimatePromptTokens(systemPrompt, messages, toolSchemas);
      const completionTokens = Math.min(MAX_COMPLETION_TOKENS, contextLimit - promptTokens);
      if (completionTokens < 1) {
        budgetFailure = `context budget exhausted (${contextLimit} tokens; prompt requires ${promptTokens})`;
        throw new Error(budgetFailure);
      }

      emit({
        type: "phase",
        phase: rounds === 1 ? "thinking" : "continuing",
        detail: `round ${rounds}`,
      });
      let roundContent = "";
      let roundReasoning = "";
      let roundUsage = null;
      let responseArgumentBytes = 0;
      let responseContextBytes = 0;
      let responseContextExceeded = false;
      let callOrder = 0;
      let anonymousCall = 0;
      let lastAnonymousKey = null;
      const callMap = new Map();

      for await (const event of streamOpenRouter({
        model: model.id,
        messages,
        systemPrompt,
        maxTokens: completionTokens,
        signal,
        reasoning: { exclude: false },
        tools: toolSchemas,
        toolChoice: "auto",
      })) {
        if (aborted()) throw new Error("aborted");
        if (event.type === "reasoning" || event.type === "content") {
          const text = typeof event.text === "string" ? event.text : "";
          responseContextBytes += Buffer.byteLength(text);
          if (responseContextBytes > MAX_RESPONSE_CONTEXT_BYTES) responseContextExceeded = true;
          if (!responseContextExceeded && text) {
            if (event.type === "reasoning") {
              roundReasoning += text;
              reasoning += text;
              emit({ type: "thought", text });
            } else {
              roundContent += text;
              content += text;
              emit({ type: "content", text });
            }
          }
        } else if (event.type === "tool_call") {
          let key = event.key;
          if (!key) {
            if (event.index !== null && event.index !== undefined) {
              key = `index:${typeof event.index}:${String(event.index)}`;
            } else if (event.id) {
              key = `id:${event.id}`;
            } else if (event.name || !lastAnonymousKey) {
              key = `anonymous:${++anonymousCall}`;
            } else {
              key = lastAnonymousKey;
            }
          }
          // Retain one overflow call for a matching protocol error; further
          // excess calls cannot execute once the 24-call run cap is reached.
          if (!callMap.has(key) && callMap.size >= MAX_RESPONSE_TOOL_CALLS + 1) continue;
          if (event.index === null || event.index === undefined) lastAnonymousKey = key;

          const identityBytes =
            Buffer.byteLength(typeof event.id === "string" ? event.id : "") +
            Buffer.byteLength(typeof event.name === "string" ? event.name : "");
          responseContextBytes += identityBytes;
          if (responseContextBytes > MAX_RESPONSE_CONTEXT_BYTES) responseContextExceeded = true;

          if (!callMap.has(key)) {
            const order = callOrder++;
            callMap.set(key, {
              index: event.index ?? null,
              order,
              responseCallExcess: order >= MAX_RESPONSE_TOOL_CALLS,
              id: null,
              name: "",
              arguments: "",
              argumentBytes: 0,
              argumentErrors: new Set(),
            });
          }
          const call = callMap.get(key);
          if (event.id) call.id = event.id;
          if (event.name) call.name = event.name;
          if (
            event.arguments !== null &&
            event.arguments !== undefined &&
            typeof event.arguments !== "string"
          ) {
            call.argumentErrors.add("invalid tool arguments: expected a JSON string");
          }
          const fragment = typeof event.arguments === "string" ? event.arguments : "";
          const argumentBytes = Buffer.byteLength(fragment);
          call.argumentBytes += argumentBytes;
          responseArgumentBytes += argumentBytes;
          totalArgumentBytes += argumentBytes;
          responseContextBytes += argumentBytes;

          if (call.argumentBytes > MAX_TOOL_ARGUMENT_BYTES) {
            call.argumentErrors.add(
              `tool argument budget exhausted (${MAX_TOOL_ARGUMENT_BYTES} bytes per call)`,
            );
          }
          if (responseArgumentBytes > MAX_RESPONSE_ARGUMENT_BYTES) {
            call.argumentErrors.add(
              `per-response argument budget exhausted (${MAX_RESPONSE_ARGUMENT_BYTES} bytes)`,
            );
          }
          if (totalArgumentBytes > MAX_TOTAL_ARGUMENT_BYTES) {
            call.argumentErrors.add(
              `total tool argument budget exhausted (${MAX_TOTAL_ARGUMENT_BYTES} bytes)`,
            );
          }
          if (responseContextBytes > MAX_RESPONSE_CONTEXT_BYTES) responseContextExceeded = true;

          if (
            !call.responseCallExcess &&
            call.argumentBytes <= MAX_TOOL_ARGUMENT_BYTES &&
            responseArgumentBytes <= MAX_RESPONSE_ARGUMENT_BYTES &&
            totalArgumentBytes <= MAX_TOTAL_ARGUMENT_BYTES &&
            !responseContextExceeded
          ) {
            call.arguments += fragment;
          }
        } else if (event.type === "finish") {
          finishReason = event.reason;
        } else if (event.type === "done") {
          if (event.usage) roundUsage = event.usage;
        } else if (event.type === "error") {
          throw new Error(event.error);
        }
      }

      const actualTokens = providerTokenUsage(roundUsage);
      const approxOut = Math.ceil(Buffer.byteLength(`${roundContent}${roundReasoning}`) / 4);
      const estimatedTokens = actualTokens
        ? null
        : {
            prompt_tokens: promptTokens,
            completion_tokens: approxOut,
            total_tokens: promptTokens + approxOut,
            cached_tokens: 0,
          };
      const actualCost = providerReportedCost(roundUsage);
      const estimatedCost =
        actualCost === null
          ? finiteNonNegative(estimateCost(model, actualTokens ?? estimatedTokens))
          : null;
      recordUsageRound(usage, {
        providerTokens: actualTokens,
        estimatedTokens,
        providerCost: actualCost,
        estimatedCost,
      });
      // Usage events are cumulative snapshots, not deltas. Emit estimates too so
      // a missing-usage round cannot leave stale provider-only totals on screen.
      emitUsage();

      const usedIds = new Set();
      const calls = [...callMap.values()]
        .filter((call) => call.name)
        .sort((a, b) => a.order - b.order)
        .map((call, i) => {
          let id = call.id || `call_${rounds}_${i}`;
          for (let suffix = i; usedIds.has(id); suffix += 1) id = `call_${rounds}_${suffix}`;
          usedIds.add(id);
          return { ...call, id, arguments: call.arguments || "{}" };
        });

      setPlanStep(plan, 0, "done", emit);
      if (responseContextExceeded && calls.length === 0) {
        failure = `per-response context budget exhausted (${MAX_RESPONSE_CONTEXT_BYTES} bytes)`;
        budgetFailure = failure;
        content += (content ? "\n\n" : "") + `(Stopped: ${failure}.)`;
        break;
      }
      if (calls.length === 0) {
        setPlanStep(plan, 1, "done", emit);
        if (
          autoVerify &&
          appliedEdits.length > 0 &&
          lastVerifiedEditCount !== appliedEdits.length
        ) {
          setPlanStep(plan, 3, "active", emit);
          const verified = await verifyOnce("automatic after edit");
          if (terminalOutcome) {
            setPlanStep(plan, 3, verified.skipped ? "skipped" : "error", emit);
            break;
          }
          if (!verified.skipped) {
            if (verified.ok) {
              const line = `Automatic verification: ${verified.summary ?? `${verified.passed} passed`} in ${formatDuration(verified.durationMs)}.`;
              content += (content ? "\n\n" : "") + line;
              setPlanStep(plan, 3, "done", emit);
              break;
            }
            if (offerHealing(verified, { automatic: true })) continue;
            const line = `Automatic verification failed: ${verified.summary ?? `${verified.failed} failed`}.`;
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
          function: {
            name: call.name,
            arguments: call.argumentErrors.size > 0 ? "{}" : call.arguments,
          },
        })),
      });

      let budgetExhausted = false;
      let responseCallBudgetExhausted = false;
      let explicitVerificationFailure = null;
      for (const call of calls) {
        if (toolCallCount >= MAX_TOOL_CALLS || call.responseCallExcess) {
          const totalExhausted = toolCallCount >= MAX_TOOL_CALLS;
          if (totalExhausted) budgetExhausted = true;
          else responseCallBudgetExhausted = true;
          const message = totalExhausted
            ? `tool call budget exhausted (${MAX_TOOL_CALLS})`
            : `per-response tool call budget exhausted (${MAX_RESPONSE_TOOL_CALLS})`;
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: safeJson({ status: "blocked", error: message }),
          });
          emit({
            type: "tool:end",
            id: call.id,
            name: call.name,
            ok: false,
            summary: message,
            data: { status: "blocked" },
          });
          toolCards.push({
            name: call.name,
            label: `${call.name} (budget)`,
            args: {},
            ok: false,
            summary: message,
            data: { status: "blocked" },
            id: call.id,
          });
          continue;
        }
        toolCallCount++;
        if (responseContextExceeded) {
          rejectToolCall(
            call,
            `per-response context budget exhausted (${MAX_RESPONSE_CONTEXT_BYTES} bytes)`,
            {
              status: "blocked",
              suffix: "budget",
            },
          );
          continue;
        }
        if (call.argumentErrors.size > 0) {
          rejectToolCall(call, [...call.argumentErrors][0], {
            status: "blocked",
            suffix: "budget",
          });
          continue;
        }

        let args;
        try {
          args = parseToolArgs(call.arguments);
          if (!isPlainObject(args))
            throw new Error("invalid tool arguments: expected a JSON object");
        } catch (error) {
          const message = error.message.startsWith("invalid tool arguments:")
            ? error.message
            : `invalid JSON arguments: ${error.message}`;
          rejectToolCall(call, message);
          continue;
        }

        const displayArgs = call.name === COMMAND_ORIGIN ? commandArgsForProjection(args) : args;
        const label = toolLabel(call.name, displayArgs);
        emit({ type: "tool:start", id: call.id, name: call.name, label, args: displayArgs });
        emit({ type: "phase", phase: "tool", detail: label });
        if (["search_repo", "read_file", "list_files"].includes(call.name)) {
          setPlanStep(plan, 1, "active", emit);
        }
        if (call.name === "propose_edit" || call.name === "write_file") {
          setPlanStep(plan, 1, "done", emit);
          setPlanStep(plan, 2, "active", emit);
        }
        if (call.name === "run_tests") setPlanStep(plan, 3, "active", emit);

        /** @type {Record<string, any>} */
        let result;
        let ok = true;
        let card = {
          name: call.name,
          label,
          args: displayArgs,
          ok: true,
          summary: "",
          data: null,
          id: call.id,
        };

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
              matches: matches.map((m) => ({
                file: m.rel,
                line: m.line,
                text: m.text.trim().slice(0, 200),
              })),
            };
            card.summary = `${matches.length} match${matches.length === 1 ? "" : "es"}`;
            card.data = { query, matches: result.matches.slice(0, 40) };
          } else if (call.name === "read_file") {
            const rawPath = args.path ?? args.file ?? args.filename;
            if (!rawPath) throw new Error("path is required");
            const resolved = resolveInside(project.root, rawPath);
            if (!resolved.ok) throw new Error(resolved.error);
            if (isSensitiveReadPath(resolved.rel))
              throw new Error(`refusing to read sensitive file ${resolved.rel}`);
            const read = readFileSafe(resolved.path);
            if (!read.ok) throw new Error(read.error);
            const lines = read.content.split("\n");
            const start = Math.max(1, Math.floor(Number(args.start_line ?? args.start ?? 1)));
            const end = Math.min(
              lines.length,
              Math.max(start, Math.floor(Number(args.end_line ?? args.end ?? start + 119))),
            );
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
              snippet: lines
                .slice(start - 1, Math.min(cappedEnd, start + 7))
                .map(
                  (text, index) =>
                    `${String(start + index).padStart(4)}  ${truncateToWidth(text, 96)}`,
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
                `refusing to edit ${resolved.rel}: file is ${formatBytes(read.size)} but reads are capped at ${formatBytes(Buffer.byteLength(read.content))}`,
              );
            }
            if (read.utf8 === false) {
              throw new Error(`refusing to edit ${resolved.rel}: file is not valid UTF-8`);
            }
            const startLine = Math.floor(Number(args.start_line ?? args.start ?? args.line));
            const endLine = Math.floor(Number(args.end_line ?? args.end ?? startLine + 1));
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
              { file: resolved.rel },
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
              decision =
                typeof requestApproval === "function" ? await requestApproval(proposal) : "n";
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
              result = {
                status: "denied",
                file: resolved.rel,
                message: "The user denied this edit. Do not retry it.",
              };
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
            const newContent =
              typeof args.content === "string" ? args.content : String(args.content ?? "");
            const resolved = resolveInside(project.root, rawPath);
            if (!resolved.ok) throw new Error(resolved.error);
            if (isBinaryPath(resolved.path))
              throw new Error(`refusing to write ${resolved.rel}: binary paths are unsupported`);
            if (newContent.includes("\u0000"))
              throw new Error(`refusing to write ${resolved.rel}: content is not text`);
            const isCreation = isDefinitelyMissing(resolved.path);
            const current = readFileSafe(resolved.path);
            if (!isCreation && !current.ok) {
              throw new Error(
                `refusing to edit ${resolved.rel}: ${current.error ?? "file cannot be read safely"}`,
              );
            }
            if (current.ok) {
              if (current.truncated) {
                throw new Error(
                  `refusing to edit ${resolved.rel}: file is ${formatBytes(current.size)} but reads are capped at ${formatBytes(Buffer.byteLength(current.content))}`,
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
              decision =
                typeof requestApproval === "function" ? await requestApproval(proposal) : "n";
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
              result = {
                status: "denied",
                file: resolved.rel,
                message: "The user denied this write. Do not retry it.",
              };
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
          } else if (call.name === COMMAND_ORIGIN) {
            if (!commandsEnabled) {
              result = unavailableCommandResult("capability-disabled");
            } else {
              const policy = commandCapability.headless
                ? commandCapability.policy
                : await commandCapability.policyFactory();
              if (!policy || typeof policy.authorize !== "function") {
                throw new Error("command policy factory returned no authorizer");
              }
              // Only trusted embedding state crosses this boundary. Model JSON can
              // never select environment, network, backend, resources, audits,
              // MATRIX_HOME, retention, hooks, or an unsandboxed process runner.
              // Load the optional core only after a trusted capability and exact
              // tool call exist; the default six-tool runtime stays sandbox-free.
              const { runSandboxedCommand } = await import(COMMAND_EXECUTION_MODULE);
              const executed = await runSandboxedCommand(args, {
                workspace: project.root,
                policy,
                home: commandHome,
                runId: commandRunId,
                signal,
                secretValues: commandSecretValues,
              });
              result = commandResultForTool(executed);
            }
            lastCommand = result;
            ok = result.executionOk === true;
            card.ok = ok;
            card.summary = `${result.commandStatus} · ${
              result.processOk ? "exit 0" : (result.reason ?? "not executed")
            } · writes discarded · audit ${result.auditStatus}`;
            card.data = result;
          } else if (call.name === "run_command") {
            // Arbitrary shell effects cannot be diffed, contained, or undone.
            // Keep a hard runtime denial as well as removing the tool schema.
            ok = false;
            result = {
              status: "blocked",
              error:
                "run_command is disabled: arbitrary commands are not approval-gated or undoable",
            };
            card.ok = false;
            card.summary = "blocked · command execution disabled";
            card.data = { ok: false, status: "blocked" };
          } else if (call.name === "run_tests") {
            const verified = await verifyOnce("model requested");
            explicitVerificationFailure = !verified.skipped && !verified.ok ? verified : null;
            if (verified.skipped) {
              result = {
                status: "skipped",
                message: "No test runner was detected in this workspace.",
              };
              card.ok = false;
              card.summary = "no test runner";
            } else {
              const outcome = classifyOutcome({ verification: verified });
              result = {
                status: verified.ok ? "passed" : outcome.status,
                command: verified.command,
                passed: verified.passed,
                failed: verified.failed,
                duration_ms: verified.durationMs,
                summary: verified.summary,
                output: verified.lines.slice(-40),
              };
              card.ok = verified.ok;
              card.summary =
                verified.summary ?? `${verified.passed} passed · ${verified.failed} failed`;
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
              processOk: verified.processOk ?? verified.ok,
              verified: verified.verified ?? verified.ok,
              verificationStatus:
                verified.verificationStatus ?? (verified.ok ? "verified" : "failed"),
              timedOut: verified.timedOut ?? false,
              aborted: verified.aborted ?? false,
              parseConfident: verified.parseConfident ?? null,
            };
          } else {
            throw new Error(`unknown tool: ${call.name}`);
          }
        } catch (error) {
          // Cancellation is a run-terminal control flow, not a tool error that
          // may be fed into another model round.
          if (aborted() || lastVerify?.aborted === true) throw error;
          ok = false;
          failure = error.message;
          result = { status: "error", error: error.message };
          card.ok = false;
          card.summary = error.message;
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: serializeToolResult(result),
        });
        const toolOk = ok && card.ok !== false;
        emit({
          type: "tool:end",
          id: call.id,
          name: call.name,
          ok: toolOk,
          summary: card.summary,
          data: card.data,
        });
        toolCards.push({ ...card, ok: toolOk, summary: card.summary });
        if (terminalOutcome || (call.name === COMMAND_ORIGIN && result.aborted)) break;
        emit({ type: "phase", phase: "thinking", detail: `${model.name} is reasoning` });
      }

      if (terminalOutcome) break;
      if (budgetExhausted) {
        failure = `model reached the ${MAX_TOOL_CALLS}-call tool budget`;
        budgetFailure = failure;
        content += `\n\n(Stopped after ${MAX_TOOL_CALLS} tool calls. Anything applied above is real; review it before continuing.)`;
        break;
      }
      if (responseCallBudgetExhausted) {
        failure = `model reached the ${MAX_RESPONSE_TOOL_CALLS}-call per-response tool budget`;
        budgetFailure = failure;
        content += (content ? "\n\n" : "") + `(Stopped: ${failure}.)`;
        break;
      }
      if (responseContextExceeded) {
        failure = `per-response context budget exhausted (${MAX_RESPONSE_CONTEXT_BYTES} bytes)`;
        budgetFailure = failure;
        content += (content ? "\n\n" : "") + `(Stopped: ${failure}.)`;
        break;
      }
      if (totalArgumentBytes > MAX_TOTAL_ARGUMENT_BYTES) {
        failure = `total tool argument budget exhausted (${MAX_TOTAL_ARGUMENT_BYTES} bytes)`;
        budgetFailure = failure;
        content += (content ? "\n\n" : "") + `(Stopped: ${failure}.)`;
        break;
      }
      if (aborted()) throw new Error("aborted");
      if (explicitVerificationFailure && lastVerify === explicitVerificationFailure) {
        if (
          !offerHealing(explicitVerificationFailure, { automatic: false }) &&
          selfHealAttempts >= maxSelfHeals
        ) {
          const summary =
            explicitVerificationFailure.summary ?? `${explicitVerificationFailure.failed} failed`;
          content +=
            (content ? "\n\n" : "") +
            `Model-requested verification still fails after ${maxSelfHeals} bounded healing attempts: ${summary}.`;
          break;
        }
      }
    }

    if (rounds > maxRounds) {
      failure = `model reached the ${maxRounds}-round tool limit`;
      budgetFailure = failure;
      content += `\n\n(Stopped after ${maxRounds} tool rounds. Anything applied above is real; review it before continuing.)`;
    }

    if (aborted()) throw new Error("aborted");

    // If the model edited but forgot to verify, verify anyway. A workbench
    // should not hand back an unverified write when a test command exists.
    // A terminal explicit/timeout/unrecognized result never starts another
    // process here.
    if (
      !terminalOutcome &&
      autoVerify &&
      appliedEdits.length > 0 &&
      lastVerifiedEditCount !== appliedEdits.length
    ) {
      setPlanStep(plan, 3, "active", emit);
      const verified = await verifyOnce("automatic after edit");
      if (!terminalOutcome && !verified.skipped) {
        const line = verified.ok
          ? `Automatic verification: ${verified.summary ?? `${verified.passed} passed`} in ${formatDuration(verified.durationMs)}.`
          : `Automatic verification failed: ${verified.summary ?? `${verified.failed} failed`}.`;
        content += (content ? "\n\n" : "") + line;
      }
    }

    if (terminalOutcome) {
      const summary = lastVerify?.summary ?? terminalOutcome.failure;
      const line =
        terminalOutcome.status === OUTCOME.TIMED_OUT
          ? `Verification timed out: ${summary}.`
          : terminalOutcome.status === OUTCOME.UNVERIFIED
            ? `Verification unavailable: ${summary}.`
            : `Verification failed: ${summary}.`;
      content += (content ? "\n\n" : "") + line;
    }

    if (!content.trim()) {
      if (appliedEdits.length > 0) {
        const files = [...new Set(appliedEdits.map((edit) => edit.file))];
        content = `Applied ${appliedEdits.length} edit${appliedEdits.length === 1 ? "" : "s"} to ${files.join(", ")}.`;
      } else if (lastCommand) {
        content = `Sandboxed command ${lastCommand.commandStatus}: ${lastCommand.reason}. Live workspace unchanged; snapshot writes discarded; undo not applicable.`;
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
      setPlanStep(plan, 3, lastVerify.ok ? "done" : lastVerify.skipped ? "skipped" : "error", emit);
    } else {
      setPlanStep(plan, 3, "skipped", emit);
    }

    const metrics = makeMetrics();
    const cost = metrics.cost;
    const result = buildModelResult({
      content,
      reasoning,
      plan,
      toolCards,
      lastRead,
      lastProposal,
      appliedEdits,
      lastVerify,
      lastCommand,
      usage: metrics.usage,
      cost,
      metrics,
      failure,
      model,
      finishReason,
      error: Boolean(failure),
      budgetExhausted: Boolean(budgetFailure),
      verificationCurrent:
        appliedEdits.length === 0 || lastVerifiedEditCount === appliedEdits.length,
    });
    attachRecoveryGuidance(result);
    emit({ type: "metrics", metrics });
    emit({ type: "phase", phase: classifyOutcome(result).phase });
    emit({ type: "result", result });
    emit({ type: "done" });
    return result;
  } catch (error) {
    const wasAborted = aborted() || /aborted/i.test(error.message);
    const message = wasAborted ? "Model run aborted." : `Model run failed: ${error.message}`;
    const metrics = makeMetrics();
    emit({ type: "error", error: message, aborted: wasAborted });
    emit({ type: "metrics", metrics });
    emit({ type: "phase", phase: wasAborted ? "aborted" : "failed" });
    const result = buildModelResult({
      content: message,
      reasoning,
      plan,
      toolCards,
      lastRead,
      lastProposal,
      appliedEdits,
      lastVerify,
      lastCommand,
      usage: metrics.usage,
      cost: metrics.cost,
      metrics,
      failure: message,
      model,
      finishReason,
      error: true,
      aborted: wasAborted,
      budgetExhausted: Boolean(budgetFailure),
      verificationCurrent:
        appliedEdits.length === 0 || lastVerifiedEditCount === appliedEdits.length,
    });
    attachRecoveryGuidance(result);
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
  lastCommand = null,
  usage,
  cost,
  metrics,
  failure,
  model,
  finishReason,
  error,
  aborted = false,
  budgetExhausted = false,
  verificationCurrent = true,
}) {
  // A later denied proposal on the same file must not inherit the status of an
  // earlier applied one. Match the exact patch, not just the path.
  const lastProposalApplied = lastProposal
    ? appliedEdits.find(
        (edit) => edit.file === lastProposal.file && edit.patch === lastProposal.patch,
      )
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
        processOk: lastVerify.processOk ?? lastVerify.ok,
        verified: lastVerify.verified ?? lastVerify.ok,
        verificationStatus:
          lastVerify.verificationStatus ?? (lastVerify.ok ? "verified" : "failed"),
        timedOut: lastVerify.timedOut ?? false,
        aborted: lastVerify.aborted ?? false,
        parseConfident: lastVerify.parseConfident ?? null,
      }
    : null;

  const files = [...new Set(appliedEdits.map((edit) => edit.file))];
  const commands = toolCards
    .filter((card) => card.name === COMMAND_ORIGIN && card.data)
    .map((card) => card.data);
  const commandFailed = lastCommand && !lastCommand.executionOk;
  const commandDenied = commandFailed && lastCommand.commandStatus === "denied";
  const commandFailure = commandFailed
    ? (lastCommand.failure ??
      `Sandboxed command ${lastCommand.commandStatus}: ${lastCommand.reason}`)
    : null;
  const result = withOutcome(
    {
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
      commands,
      content,
      summary: "",
      failure,
      error: Boolean(error),
      applied: appliedEdits.at(-1) ?? null,
      proposal: lastProposal,
      usage,
      cost,
      usageProvenance: usage.provenance,
      costProvenance: usage.costProvenance,
      costComplete: usage.costComplete,
      metrics,
      finishReason,
      verificationCurrent,
      elapsedMs: metrics?.elapsedMs ?? 0,
      elapsedTime: Math.round((metrics?.elapsedMs ?? 0) / 1000),
      timestamp: Date.now(),
    },
    {
      verification: lastVerify,
      editStatus: editFile?.status ?? null,
      hasAppliedEdits: appliedEdits.length > 0,
      verificationCurrent,
      aborted,
      budgetExhausted,
      timedOut: Boolean(lastCommand?.timedOut),
      denied: Boolean(commandDenied && appliedEdits.length === 0),
      failure: failure ?? (commandDenied ? null : commandFailure),
      error: Boolean(error || (commandFailed && !commandDenied)),
    },
  );
  const usageSummary =
    usage.provenance === "unavailable"
      ? "usage unavailable"
      : `${usage.total_tokens} tokens (${usage.provenance})`;
  const costSummary =
    cost === null || cost === undefined
      ? "cost unavailable"
      : `$${cost.toFixed(4)} (${usage.costProvenance}${usage.costComplete ? "" : ", partial"})`;
  result.summary = result.failure
    ? result.failure
    : appliedEdits.length > 0
      ? `Applied ${appliedEdits.length} edit${appliedEdits.length === 1 ? "" : "s"} to ${files.join(", ")}${
          lastVerify ? ` · ${lastVerify.summary ?? `${lastVerify.passed} passed`}` : ""
        }`
      : lastCommand
        ? `Sandboxed command ${lastCommand.commandStatus} · ${lastCommand.reason} · writes discarded · undo not applicable`
        : `Model response · ${usageSummary} · ${costSummary}`;
  return result;
}
