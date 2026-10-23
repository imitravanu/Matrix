// ============================================================================
// Chat cards.
//
// These are pure line builders: each returns [{text, color, bg?, bold?}].
// Keeping them out of Ink makes overflow and folding testable without a
// terminal. Existing positional signatures are preserved for callers/tests.
// ============================================================================

import { forge, forgeBg } from "../lib/forge.mjs";
import {
  displayWidth,
  formatDuration,
  padToWidth,
  truncateToWidth,
  wrapToWidth,
} from "../lib/text.mjs";

export const CARD_BORDER = forge.rule;

function normalizeWidth(width) {
  return Math.max(20, Math.floor(Number(width) || 20));
}

export function cardTop(title, width, { color = forge.accent } = {}) {
  const w = normalizeWidth(width);
  const inner = Math.max(1, w - 4);
  const label = truncateToWidth(String(title ?? ""), Math.max(1, inner - 3));
  const fill = Math.max(1, inner - displayWidth(label) - 1);
  return { text: `╭─ ${label} ${"─".repeat(fill)}╮`, color };
}

export function cardBottom(width) {
  const w = normalizeWidth(width);
  return { text: `╰${"─".repeat(w - 2)}╯`, color: CARD_BORDER };
}

export function cardRow(text, width, options = {}) {
  const w = normalizeWidth(width);
  const inner = w - 4;
  const safe = truncateToWidth(String(text ?? ""), inner);
  return {
    text: `│ ${padToWidth(safe, inner)} │`,
    color: options.color ?? forge.text,
    ...(options.bg ? { bg: options.bg } : {}),
    ...(options.bold ? { bold: true } : {}),
    ...(options.dim ? { dim: true } : {}),
    ...(options.italic ? { italic: true } : {}),
  };
}

/** Build a complete bordered card from body line descriptors. */
export function card(title, width, body, { titleColor = forge.accent, borderColor = CARD_BORDER } = {}) {
  const w = normalizeWidth(width);
  const lines = [{ ...cardTop(title, w, { color: titleColor }), color: titleColor }];
  for (const row of body) {
    if (row === null) {
      lines.push(cardRow("", w));
    } else if (typeof row === "string") {
      lines.push(cardRow(row, w));
    } else {
      lines.push(cardRow(row.text, w, row));
    }
  }
  lines.push({ ...cardBottom(w), color: borderColor });
  return lines;
}

// --------------------------------------------------------------------------
// Plan
// --------------------------------------------------------------------------

export function renderPlanCard(plan = [], activeIndex = 0, width = 76, options = {}) {
  const rows = Array.isArray(plan) ? plan : [];
  if (rows.length === 0) return card("AGENT PLAN", width, [{ text: "no plan yet", color: forge.muted }]);

  const done = rows.filter((step) => step.status === "done").length;
  const skipped = rows.filter((step) => step.status === "skipped").length;
  const total = rows.length;
  const percent = Math.round((done / total) * 100);
  const barWidth = Math.max(4, Math.min(18, width - 26));
  const filled = Math.round((done / total) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const lines = [
    { text: `AGENT PLAN  ${done}/${total} · ${percent}%`, color: forge.accent, bold: true },
    { text: bar, color: forge.dim },
  ];

  rows.forEach((step, index) => {
    const status = step.status ?? (index < activeIndex ? "done" : index === activeIndex ? "active" : "pending");
    let glyph = "·";
    let color = forge.muted;
    if (status === "done") {
      glyph = "✓";
      color = forge.ok;
    } else if (status === "active") {
      glyph = options.activeGlyph ?? "⠋";
      color = forge.accent;
    } else if (status === "error") {
      glyph = "✗";
      color = forge.err;
    } else if (status === "skipped") {
      glyph = "-";
      color = forge.dim;
    }
    const duration = step.durationMs ? ` (${formatDuration(step.durationMs)})` : "";
    const suffix = status === "skipped" ? " · skipped" : "";
    lines.push({
      text: `${glyph} ${index + 1}. ${step.title ?? "step"}${duration}${suffix}`,
      color,
      ...(status === "active" ? { bold: true } : {}),
    });
  });

  if (skipped > 0) lines.push({ text: `${skipped} step${skipped === 1 ? "" : "s"} skipped`, color: forge.dim });
  return card("EXECUTION PLAN", width, lines);
}

// --------------------------------------------------------------------------
// Thinking
// --------------------------------------------------------------------------

export function renderThoughtCard(reasoning = "", elapsedTime = 1, isStreaming = false, width = 76, expanded = false) {
  const w = normalizeWidth(width);
  const inner = w - 4;
  const text = String(reasoning ?? "").trim();
  if (!text) {
    return card("THINKING", w, [{ text: isStreaming ? "waiting for reasoning tokens…" : "no reasoning emitted", color: forge.muted }]);
  }

  const all = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    for (const line of wrapToWidth(paragraph, inner)) all.push(line);
    all.push("");
  }
  while (all.length > 0 && all[all.length - 1] === "") all.pop();

  let visible = all;
  let hidden = 0;
  if (!expanded && !isStreaming && all.length > 8) {
    visible = all.slice(0, 8);
    hidden = all.length - 8;
  }

  const body = visible.map((line) => ({
    text: line,
    color: line.startsWith(">") ? forge.accent : forge.muted,
  }));
  if (hidden > 0) body.push({ text: `… ${hidden} more lines (t to expand)`, color: forge.dim });

  const chars = text.length;
  const elapsed = formatDuration(Number(elapsedTime) * 1000 || 0);
  const title = isStreaming ? `THINKING · ${elapsed} · ${chars} chars` : `THINKING · ${chars} chars`;
  return card(title, w, body);
}

// --------------------------------------------------------------------------
// Read
// --------------------------------------------------------------------------

export function renderReadFileCard(filePath, scope = "", snippet = [], duration = "0.1s", width = 76) {
  // New object form: renderReadFileCard({path, scope, snippet, duration}, width)
  if (filePath && typeof filePath === "object") {
    const obj = filePath;
    width = scope && typeof scope === "number" ? scope : width;
    return renderReadFileCard(obj.path, obj.scope, obj.snippet ?? [], obj.duration, width);
  }

  const body = [];
  if (scope) body.push({ text: truncateToWidth(String(scope), width - 4), color: forge.accent });
  body.push({ text: "", color: forge.muted });
  for (const line of snippet) body.push({ text: String(line), color: forge.muted });

  const title = `READ FILE · ${filePath}${duration ? ` · ${duration}` : ""}`;
  return card(title, width, body);
}

// --------------------------------------------------------------------------
// Edit / diff
// --------------------------------------------------------------------------

export function foldDiffLines(diffLines = [], { expanded = false, context = 1 } = {}) {
  const lines = Array.isArray(diffLines) ? diffLines : [];
  if (expanded) return lines;
  const keep = new Set();
  lines.forEach((line, index) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) keep.add(i);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) keep.add(i);
    } else if (line.startsWith("@@")) {
      keep.add(index);
    }
  });
  if (keep.size === 0) return lines.slice(0, 12);
  const out = [];
  let previous = -2;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue;
    if (previous >= 0 && i > previous + 1) out.push({ fold: true, skipped: i - previous - 1 });
    out.push(lines[i]);
    previous = i;
  }
  return out;
}

export function renderEditFileCard(filePath, scope = "", diffLines = [], status = "approved", width = 76, options = {}) {
  if (filePath && typeof filePath === "object") {
    const obj = filePath;
    width = typeof scope === "number" ? scope : width;
    return renderEditFileCard(obj.path, obj.scope, obj.diff ?? [], obj.status, width, { expanded: obj.expanded });
  }

  const w = normalizeWidth(width);
  const rows = foldDiffLines(diffLines, { expanded: Boolean(options.expanded) });
  const body = [];
  if (scope) body.push({ text: truncateToWidth(String(scope), w - 4), color: forge.accent });

  const adds = (diffLines ?? []).filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const dels = (diffLines ?? []).filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  body.push({
    text: `+${adds} −${dels} · ${status}`,
    color: status === "denied" ? forge.err : status === "approved" || status === "applied" ? forge.ok : forge.warn,
  });

  for (const row of rows) {
    if (row && typeof row === "object" && row.fold) {
      body.push({ text: `… ${row.skipped} unchanged line${row.skipped === 1 ? "" : "s"}`, color: forge.dim });
      continue;
    }
    const line = String(row ?? "");
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) {
      body.push({ text: line, color: forge.info, bold: true });
    } else if (line.startsWith("+")) {
      body.push({ text: line, color: forge.text, bg: forgeBg.add });
    } else if (line.startsWith("-")) {
      body.push({ text: line, color: forge.text, bg: forgeBg.del });
    } else if (line.startsWith(" ")) {
      body.push({ text: line, color: forge.muted });
    } else {
      body.push({ text: line, color: forge.muted });
    }
  }

  return card(`EDIT · ${filePath}`, w, body);
}

// --------------------------------------------------------------------------
// Verification
// --------------------------------------------------------------------------

export function renderVerifyTestsCard(cmd, testResults = [], duration = "0.8s", width = 76, options = {}) {
  if (cmd && typeof cmd === "object") {
    const obj = cmd;
    width = typeof testResults === "number" ? testResults : width;
    return renderVerifyTestsCard(obj.cmd, obj.results ?? [], obj.duration, width, obj);
  }

  const rows = Array.isArray(testResults) ? testResults : [];
  const passed = Number.isFinite(Number(options.passed))
    ? Number(options.passed)
    : rows.filter((r) => r.pass).length;
  const failed = Number.isFinite(Number(options.failed))
    ? Number(options.failed)
    : rows.filter((r) => !r.pass).length;
  const body = [{ text: `$ ${cmd}`, color: forge.accent }];
  if (rows.length === 0) {
    body.push({
      text: options.skipped ? "no test runner detected" : "runner produced no per-test lines",
      color: options.skipped ? forge.warn : forge.muted,
    });
  }
  for (const result of rows.slice(0, options.maxRows ?? 12)) {
    const text = String(result.name ?? "");
    const clean = text
      .replace(/\s*\[[^\]]*\]\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    body.push({
      text: `${result.pass ? "✓" : "✗"} ${truncateToWidth(clean, width - 8)}`,
      color: result.pass ? forge.ok : forge.err,
    });
  }
  if (rows.length > (options.maxRows ?? 12)) {
    body.push({ text: `… ${rows.length - (options.maxRows ?? 12)} more results`, color: forge.dim });
  }
  if (rows.length > 0) {
    body.push({
      text: `${passed} passed · ${failed} failed${duration ? ` · ${duration}` : ""}`,
      color: failed > 0 ? forge.err : forge.ok,
      bold: true,
    });
  } else if (options.summary) {
    body.push({ text: String(options.summary), color: options.ok === false ? forge.err : forge.muted });
  }
  return card("VERIFICATION", width, body);
}

// --------------------------------------------------------------------------
// Content / code blocks
// --------------------------------------------------------------------------

export function formatCodeBlock(codeLines = [], lang = "", width = 76) {
  const w = normalizeWidth(width);
  const inner = w - 4;
  const lines = Array.isArray(codeLines) ? codeLines : String(codeLines).split("\n");
  const top = `┌─ ${lang || "code"} ${"─".repeat(Math.max(1, inner - (lang || "code").length - 2))}┐`;
  const out = [{ text: truncateToWidth(top, w), color: forge.dim }];
  for (const raw of lines) {
    const line = String(raw).replace(/\t/g, "    ");
    out.push({
      text: `│ ${padToWidth(truncateToWidth(line, inner), inner)} │`,
      color: line.trimStart().startsWith("#") || line.trimStart().startsWith("//") ? forge.muted : forge.text,
    });
  }
  out.push({ text: `└${"─".repeat(w - 2)}┘`, color: forge.dim });
  return out;
}

function codeBlockRuns(lines, lang, width, scrollX = 0) {
  const w = normalizeWidth(width);
  const inner = w - 4;
  const header = `┌─ ${lang || "code"} ${"─".repeat(Math.max(1, inner - (lang || "code").length - 2))}┐`;
  const out = [{ text: truncateToWidth(header, w), color: forge.dim }];
  for (const raw of lines) {
    const expanded = String(raw).replace(/\t/g, "    ");
    const chars = [...expanded];
    const shifted = scrollX > 0 ? chars.slice(scrollX).join("") : expanded;
    const text = truncateToWidth(shifted, inner);
    const trimmed = text.trimStart();
    out.push({
      text: `│ ${padToWidth(text, inner)} │`,
      color: trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("--") ? forge.muted : forge.text,
    });
  }
  out.push({ text: `└${"─".repeat(w - 2)}┘`, color: forge.dim });
  return out;
}

/**
 * Split markdown-ish content into prose and fenced code blocks. Supports
 * backtick and tilde fences, optional language, and an unterminated final fence
 * (live streaming).
 */
export function parseContentBlocks(content = "") {
  const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let prose = [];
  let code = null;
  let fence = null;
  let lang = "";

  const flushProse = () => {
    if (prose.length > 0) {
      blocks.push({ type: "text", text: prose.join("\n") });
      prose = [];
    }
  };

  for (const line of lines) {
    if (code) {
      if (line.trim().startsWith(fence)) {
        blocks.push({ type: "code", lang, lines: code });
        code = null;
        fence = null;
        lang = "";
      } else {
        code.push(line);
      }
      continue;
    }
    const match = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (match) {
      flushProse();
      fence = match[1][0].repeat(3);
      lang = match[2] ?? "";
      code = [];
      continue;
    }
    prose.push(line);
  }
  if (code) blocks.push({ type: "code", lang, lines: code, open: true });
  flushProse();
  return blocks;
}

export function renderContentWithCodeBlocks(contentStr, width = 76, options = {}) {
  const w = normalizeWidth(width);
  const inner = w - 4;
  const blocks = parseContentBlocks(contentStr);
  const out = [];

  for (const block of blocks) {
    if (block.type === "code") {
      out.push({ text: "", color: forge.muted });
      out.push(...codeBlockRuns(block.lines, block.lang, w, options.scrollX ?? 0));
      if (block.open) out.push({ text: "└─ streaming…", color: forge.dim });
      out.push({ text: "", color: forge.muted });
      continue;
    }

    const paragraphs = block.text.split(/\n{2,}/);
    for (const paragraph of paragraphs) {
      const rawLines = paragraph.split("\n");
      for (const raw of rawLines) {
        if (raw === "") {
          out.push({ text: "", color: forge.muted });
          continue;
        }
        const trimmed = raw.trim();
        const isHeading = /^#{1,3}\s+/.test(trimmed);
        const isBullet = /^[-*]\s+/.test(trimmed);
        const isQuote = trimmed.startsWith("> ");
        const text = isHeading ? trimmed.replace(/^#{1,3}\s+/, "") : raw;
        const wrapped = wrapToWidth(text, inner);
        for (const line of wrapped) {
          out.push({
            text: line,
            color: isHeading ? forge.accent : isBullet ? forge.text : isQuote ? forge.muted : forge.text,
            bold: isHeading,
            ...(isBullet ? {} : {}),
          });
        }
      }
      out.push({ text: "", color: forge.muted });
    }
  }

  while (out.length > 0 && out[out.length - 1].text === "") out.pop();
  return out;
}

export function formatTokens(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
