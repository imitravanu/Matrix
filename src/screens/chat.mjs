// Chat Crucible: real transcript, cards from real tool events, and a viewport
// with an actual scrollbar. Pure line building is exported for render tests.

import React, { useEffect, useRef } from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { displayWidth, padToWidth, truncateToWidth, wrapToWidth } from "../../lib/text.mjs";
import {
  formatTokens,
  renderContentWithCodeBlocks,
  renderEditFileCard,
  renderPlanCard,
  renderReadFileCard,
  renderThoughtCard,
  renderVerifyTestsCard,
} from "../cards.mjs";

const h = React.createElement;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinnerGlyph = (frame = 0) => SPINNER[Math.abs(frame) % SPINNER.length];

function userLines(text, width) {
  const inner = Math.max(8, width - 4);
  const wrapped = wrapToWidth(String(text ?? ""), inner);
  const out = [];
  wrapped.forEach((line, index) => {
    out.push({
      text: index === 0 ? `❯ ${line}` : `  ${line}`,
      color: forge.text,
      bold: index === 0,
    });
  });
  out.push({ text: "", color: forge.muted });
  return out;
}

function toolLines(message, width) {
  const out = [];
  for (const card of message.toolCards ?? []) {
    if (card.name === "propose_edit" || card.name === "run_tests") continue;
    const glyph = card.ok === false ? "✗" : "✓";
    const color = card.ok === false ? forge.err : forge.muted;
    out.push({
      text: truncateToWidth(`${glyph} ${card.name} · ${card.summary ?? ""}`, width),
      color,
    });
  }
  if (out.length > 0) out.push({ text: "", color: forge.muted });
  return out;
}

function assistantLines(
  message,
  width,
  {
    activeGlyph = "⠋",
    thoughtsExpanded = false,
    diffExpanded = false,
    outputExpanded = false,
  } = {},
) {
  const out = [];
  const hasReasoning = Boolean(message.reasoning && message.reasoning.trim());
  const hasContent = Boolean(message.content && message.content.trim());

  if (message.plan?.length) {
    out.push(...renderPlanCard(message.plan, message.activePlanIdx ?? 0, width, { activeGlyph }));
    out.push({ text: "", color: forge.muted });
  }

  if (hasReasoning) {
    out.push(
      ...renderThoughtCard(
        message.reasoning,
        message.elapsedTime ?? 0,
        Boolean(message.streaming),
        width,
        thoughtsExpanded || Boolean(message.streaming),
      ),
    );
    out.push({ text: "", color: forge.muted });
  }

  if (message.readFile) {
    out.push(
      ...renderReadFileCard(
        message.readFile.path,
        message.readFile.scope,
        message.readFile.snippet ?? [],
        message.readFile.duration ?? "",
        width,
      ),
    );
    out.push({ text: "", color: forge.muted });
  }

  out.push(...toolLines(message, width));

  if (message.editFile) {
    const edit = message.editFile;
    out.push(
      ...renderEditFileCard(
        edit.path,
        edit.scope,
        edit.diff ?? edit.patch?.split("\n").filter(Boolean) ?? [],
        edit.status ?? "pending",
        width,
        { expanded: diffExpanded },
      ),
    );
    out.push({ text: "", color: forge.muted });
  }

  if (message.verifyTests) {
    const verify = message.verifyTests;
    out.push(
      ...renderVerifyTestsCard(
        verify.cmd ?? "tests",
        verify.results ?? [],
        verify.duration ?? "",
        width,
        {
          skipped: verify.skipped,
          summary: verify.summary,
          ok: verify.ok,
          passed: verify.passed,
          failed: verify.failed,
          output: verify.output ?? verify.lines ?? [],
          outputLineCount: verify.outputLineCount,
          outputTruncated: verify.outputTruncated,
          verificationStatus: verify.verificationStatus,
          running: verify.running,
          expanded: outputExpanded,
          maxRows: 10,
        },
      ),
    );
    out.push({ text: "", color: forge.muted });
  }

  if (hasContent) {
    out.push({
      text: truncateToWidth(`◈ ${message.modelName ?? "MATRIX"}`, width),
      color: message.error ? forge.err : forge.accent,
      bold: true,
    });
    out.push(...renderContentWithCodeBlocks(message.content, width));
    out.push({ text: "", color: forge.muted });
  }

  if (message.error && !hasContent) {
    out.push({
      text: truncateToWidth(`✗ ${message.summary ?? "run failed"}`, width),
      color: forge.err,
    });
    out.push({ text: "", color: forge.muted });
  }

  if (out.length === 0) {
    out.push({ text: "(no output)", color: forge.muted });
    out.push({ text: "", color: forge.muted });
  }
  return out;
}

function summaryLine(message, width) {
  if (!message.summary || message.role !== "assistant") return null;
  if (message.content && message.content.includes(message.summary)) return null;
  return {
    text: truncateToWidth(`· ${message.summary}`, width),
    color: message.error ? forge.err : forge.muted,
  };
}

function appendLines(target, addition) {
  for (const line of addition) target.push(line);
}

function messageLines(message, width, options) {
  if (!message) return [];
  if (message.role === "user") return userLines(message.content, width);
  if (message.role === "system") {
    return [
      { text: truncateToWidth(`· ${message.content}`, width), color: forge.muted },
      { text: "", color: forge.muted },
    ];
  }
  if (message.role !== "assistant") return [];

  const lines = assistantLines(message, width, options);
  const summary = summaryLine(message, width);
  if (summary) lines.push(summary);
  lines.push({ text: "", color: forge.muted });
  return lines;
}

function liveLines(live, width, { activeGlyph, diffExpanded, outputExpanded }) {
  return assistantLines(
    {
      role: "assistant",
      streaming: true,
      plan: live.plan,
      activePlanIdx: live.activePlanIdx,
      reasoning: live.reasoning,
      readFile: live.readFile,
      editFile: live.editFile,
      verifyTests: live.verifyTests,
      toolCards: live.toolCards,
      content: live.content,
      summary: live.summary,
      error: live.error,
      modelName: live.modelName,
    },
    width,
    { activeGlyph, thoughtsExpanded: true, diffExpanded, outputExpanded },
  );
}

/**
 * Build the complete transcript as line descriptors. Width is the card width
 * (already excluding scrollbar columns). This remains the uncached pure
 * reference for renderers and tests; ChatScreen uses a bounded stateful view.
 */
export function buildChatLines({
  history = [],
  live = null,
  width = 76,
  frame = 0,
  thoughtsExpanded = false,
  diffExpanded = false,
  outputExpanded = false,
  emptyMessage = "No messages yet. Describe a task below.",
} = {}) {
  const w = Math.max(20, width);
  if (history.length === 0 && !live) {
    return [{ text: truncateToWidth(emptyMessage, w), color: forge.muted }];
  }

  const lines = [];
  const options = {
    activeGlyph: spinnerGlyph(frame),
    thoughtsExpanded,
    diffExpanded,
    outputExpanded,
  };
  for (const message of history) appendLines(lines, messageLines(message, w, options));
  if (live) appendLines(lines, liveLines(live, w, options));
  return lines;
}

function identityPart(value) {
  if (value == null) return "";
  const type = typeof value;
  if (!["string", "number", "bigint", "boolean"].includes(type)) return "";
  const text = String(value);
  return `${type}:${text.length}:${text}`;
}

function messageIdentity(message) {
  const id = identityPart(message.id ?? message.messageId);
  const version = identityPart(message.version ?? message.revision);
  return id || version ? `${id}|${version}` : null;
}

function messageSignature(message, isLive) {
  if (!isLive && message.role === "user") return ["user", message.content];
  if (!isLive && message.role === "system") return ["system", message.content];
  if (!isLive && message.role !== "assistant") return [message.role];
  return [
    isLive ? "live" : "assistant",
    message.content,
    message.summary,
    message.error,
    message.plan,
    message.activePlanIdx,
    message.reasoning,
    message.elapsedTime,
    isLive ? true : message.streaming,
    message.readFile,
    message.editFile,
    message.verifyTests,
    message.toolCards,
    message.modelName,
  ];
}

function sameSignature(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]) || value === right[index])
  );
}

function cacheBudget(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function planUsesActiveGlyph(message) {
  if (!Array.isArray(message.plan)) return false;
  const activeIndex = message.activePlanIdx ?? 0;
  return message.plan.some(
    (step, index) => step.status === "active" || (step.status == null && index === activeIndex),
  );
}

class CachedChatLayout {
  constructor({ maxEntries = 1024, maxLines = 100_000, maxCodeUnits = 4 * 1024 * 1024 } = {}) {
    this.maxEntries = cacheBudget(maxEntries, 1024);
    this.maxLines = cacheBudget(maxLines, 100_000);
    this.maxCodeUnits = cacheBudget(maxCodeUnits, 4 * 1024 * 1024);
    this.objectCache = new Map();
    this.identityCache = new Map();
    this.records = new Map();
    this.nextToken = 0;
    this.lineCount = 0;
    this.codeUnits = 0;
  }

  clear() {
    this.objectCache.clear();
    this.identityCache.clear();
    this.records.clear();
    this.lineCount = 0;
    this.codeUnits = 0;
  }

  remove(token) {
    const record = this.records.get(token);
    if (!record) return;
    this.records.delete(token);
    if (this.objectCache.get(record.source) === record) this.objectCache.delete(record.source);
    if (record.identity !== null && this.identityCache.get(record.identity) === record) {
      this.identityCache.delete(record.identity);
    }
    this.lineCount -= record.lines.length;
    this.codeUnits -= record.codeUnits;
  }

  touch(record) {
    this.records.delete(record.token);
    this.records.set(record.token, record);
  }

  valid(record, identity, key, signature) {
    return (
      record &&
      record.identity === identity &&
      record.key === key &&
      sameSignature(record.signature, signature)
    );
  }

  store({ source, identity, key, signature, lines }) {
    const codeUnits = lines.reduce((sum, line) => sum + line.text.length, 0);
    if (
      this.maxEntries === 0 ||
      this.maxLines === 0 ||
      this.maxCodeUnits === 0 ||
      lines.length > this.maxLines ||
      codeUnits > this.maxCodeUnits
    ) {
      return { lines };
    }

    const record = {
      token: ++this.nextToken,
      source,
      identity,
      key,
      signature,
      lines,
      codeUnits,
    };
    this.records.set(record.token, record);
    this.objectCache.set(source, record);
    if (identity !== null) this.identityCache.set(identity, record);
    this.lineCount += lines.length;
    this.codeUnits += codeUnits;
    while (
      this.records.size > this.maxEntries ||
      this.lineCount > this.maxLines ||
      this.codeUnits > this.maxCodeUnits
    ) {
      this.remove(this.records.keys().next().value);
    }
    return record;
  }

  entryFor(message, isLive, width, folds, frame, work) {
    const identity = messageIdentity(message);
    const signature = messageSignature(message, isLive);
    const assistant = isLive || message.role === "assistant";
    const foldKey = assistant
      ? `${isLive || folds.thoughtsExpanded ? 1 : 0}/${folds.diffExpanded ? 1 : 0}/${folds.outputExpanded ? 1 : 0}`
      : "";
    const animated = assistant && planUsesActiveGlyph(message);
    const key = `${width}/${isLive ? 1 : 0}/${foldKey}/${animated ? spinnerGlyph(frame) : ""}`;
    const direct = this.objectCache.get(message);
    const identified = identity === null ? null : this.identityCache.get(identity);
    for (const candidate of [direct, identified]) {
      if (!this.valid(candidate, identity, key, signature)) continue;
      this.touch(candidate);
      work.cacheHits++;
      return candidate;
    }

    work.messageBuilds++;
    const options = { activeGlyph: spinnerGlyph(frame), ...folds };
    const lines = isLive
      ? liveLines(message, width, options)
      : messageLines(message, width, options);
    return this.store({ source: message, identity, key, signature, lines });
  }

  viewport({
    history = [],
    live = null,
    width = 76,
    height = 20,
    frame = 0,
    scrollOffset = 0,
    thoughtsExpanded = false,
    diffExpanded = false,
    outputExpanded = false,
    emptyMessage = "No messages yet. Describe a task below.",
  } = {}) {
    const w = Math.max(20, width);
    const h = Math.max(0, Math.floor(Number(height) || 0));
    const work = { messageBuilds: 0, cacheHits: 0 };
    if (history.length === 0 && !live) {
      const lines = [{ text: truncateToWidth(emptyMessage, w), color: forge.muted }];
      return {
        lines: h > 0 ? lines : [],
        total: 1,
        height: h,
        maxOffset: 0,
        offset: 0,
        start: 0,
        stats: {
          ...work,
          messages: 0,
          visibleLines: Math.min(1, h),
          cacheEntries: this.records.size,
          cacheLines: this.lineCount,
          cacheCodeUnits: this.codeUnits,
        },
      };
    }

    const entries = [];
    const folds = { thoughtsExpanded, diffExpanded, outputExpanded };
    let total = 0;
    for (const message of history) {
      if (!message) continue;
      const entry = this.entryFor(message, false, w, folds, frame, work);
      entries.push({ start: total, lines: entry.lines });
      total += entry.lines.length;
    }
    if (live) {
      const entry = this.entryFor(live, true, w, folds, frame, work);
      entries.push({ start: total, lines: entry.lines });
      total += entry.lines.length;
    }

    const maxOffset = Math.max(0, total - h);
    const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
    const start = Math.max(0, maxOffset - offset);
    const end = Math.min(total, start + h);
    const lines = [];
    for (const entry of entries) {
      const entryEnd = entry.start + entry.lines.length;
      if (entryEnd <= start) continue;
      if (entry.start >= end) break;
      const from = Math.max(0, start - entry.start);
      const to = Math.min(entry.lines.length, end - entry.start);
      for (let index = from; index < to; index++) lines.push(entry.lines[index]);
    }

    return {
      lines,
      total,
      height: h,
      maxOffset,
      offset,
      start,
      stats: {
        ...work,
        messages: history.length + (live ? 1 : 0),
        visibleLines: lines.length,
        cacheEntries: this.records.size,
        cacheLines: this.lineCount,
        cacheCodeUnits: this.codeUnits,
      },
    };
  }
}

/** Create an isolated, bounded transcript layout cache for one ChatScreen. */
export function createChatLayout(options = {}) {
  return new CachedChatLayout(options);
}

export function ChatScreen({
  history = [],
  live = null,
  width = 78,
  height = 20,
  frame = 0,
  scrollOffset = 0,
  onBounds = null,
  thoughtsExpanded = false,
  diffExpanded = false,
  outputExpanded = false,
}) {
  const showScrollbar = width >= 44;
  const cardWidth = Math.max(20, width - (showScrollbar ? 2 : 0));
  const layoutRef = useRef(null);
  if (layoutRef.current === null) layoutRef.current = createChatLayout();
  const viewport = layoutRef.current.viewport({
    history,
    live,
    width: cardWidth,
    height,
    frame,
    scrollOffset,
    thoughtsExpanded,
    diffExpanded,
    outputExpanded,
  });
  const { total, maxOffset, start } = viewport;
  const visible = viewport.lines;
  const needsScrollbar = showScrollbar && total > height;

  useEffect(() => {
    if (typeof onBounds === "function") onBounds({ total, height });
  }, [total, height, onBounds]);

  const rows = [];
  for (let i = 0; i < height; i++) {
    const line = visible[i];
    rows.push(
      h(
        Text,
        {
          key: i,
          color: line?.color ?? forge.text,
          backgroundColor: line?.bg ?? undefined,
          bold: line?.bold ?? false,
          dim: line?.dim ?? false,
          italic: line?.italic ?? false,
          wrap: "truncate",
        },
        line?.text ?? "",
      ),
    );
  }

  const scrollbar = [];
  if (needsScrollbar) {
    const thumbSize = Math.max(1, Math.round((height / total) * height));
    const thumbStart = Math.round((start / maxOffset) * (height - thumbSize));
    for (let i = 0; i < height; i++) {
      const isThumb = i >= thumbStart && i < thumbStart + thumbSize;
      scrollbar.push(
        h(Text, { key: `sb${i}`, color: isThumb ? forge.accent : forge.rule }, isThumb ? "┃" : "│"),
      );
    }
  }

  return h(
    Box,
    { flexDirection: "row", height, overflow: "hidden", flexShrink: 0 },
    h(
      Box,
      { flexDirection: "column", width: cardWidth, height, overflow: "hidden", flexShrink: 0 },
      ...rows,
    ),
    needsScrollbar
      ? h(
          Box,
          { flexDirection: "column", width: 1, height, marginLeft: 1, flexShrink: 0 },
          ...scrollbar,
        )
      : null,
  );
}

/** A compact running strip used above the input while a run is active. */
export function LiveStrip({
  phase = "thinking",
  detail = "",
  frame = 0,
  width = 78,
  waiting = false,
}) {
  const glyph = waiting ? "◈" : spinnerGlyph(frame);
  const label =
    phase === "tool"
      ? detail || "running tool"
      : phase === "verifying"
        ? detail || "running tests"
        : detail || phase;
  return h(
    Text,
    { color: waiting ? forge.warn : forge.muted, wrap: "truncate" },
    `${glyph} ${truncateToWidth(String(label), Math.max(8, width - 2))}`,
  );
}

/** Backwards-compatible helper used by renderers/tests. */
export function chatText(options = {}) {
  return buildChatLines(options)
    .map((line) => line.text)
    .join("\n");
}

export { formatTokens, displayWidth, padToWidth };
