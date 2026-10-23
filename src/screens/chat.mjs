// Chat Crucible: real transcript, cards from real tool events, and a viewport
// with an actual scrollbar. Pure line building is exported for render tests.

import React, { useEffect, useMemo } from "react";
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

function assistantLines(message, width, { activeGlyph = "⠋", thoughtsExpanded = false, diffExpanded = false } = {}) {
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
        thoughtsExpanded || Boolean(message.streaming)
      )
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
        width
      )
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
        { expanded: diffExpanded }
      )
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
          maxRows: 10,
        }
      )
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
    out.push({ text: truncateToWidth(`✗ ${message.summary ?? "run failed"}`, width), color: forge.err });
    out.push({ text: "", color: forge.muted });
  }

  if (out.length === 0) {
    out.push({ text: "(no output)", color: forge.dim });
    out.push({ text: "", color: forge.muted });
  }
  return out;
}

function summaryLine(message, width) {
  if (!message.summary || message.role !== "assistant") return null;
  if (message.content && message.content.includes(message.summary)) return null;
  return {
    text: truncateToWidth(`· ${message.summary}`, width),
    color: message.error ? forge.err : forge.dim,
  };
}

/**
 * Build the complete transcript as line descriptors. Width is the card width
 * (already excluding scrollbar columns).
 */
export function buildChatLines({
  history = [],
  live = null,
  width = 76,
  frame = 0,
  thoughtsExpanded = false,
  diffExpanded = false,
  emptyMessage = "No messages yet. Describe a task below.",
} = {}) {
  const w = Math.max(20, width);
  const lines = [];

  if (history.length === 0 && !live) {
    lines.push({ text: truncateToWidth(emptyMessage, w), color: forge.muted });
    return lines;
  }

  for (const message of history) {
    if (!message) continue;
    if (message.role === "user") {
      lines.push(...userLines(message.content, w));
    } else if (message.role === "system") {
      lines.push({ text: truncateToWidth(`· ${message.content}`, w), color: forge.dim });
      lines.push({ text: "", color: forge.muted });
    } else if (message.role === "assistant") {
      lines.push(
        ...assistantLines(message, w, {
          activeGlyph: spinnerGlyph(frame),
          thoughtsExpanded,
          diffExpanded,
        })
      );
      const summary = summaryLine(message, w);
      if (summary) lines.push(summary);
      lines.push({ text: "", color: forge.muted });
    }
  }

  if (live) {
    lines.push(
      ...assistantLines(
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
        w,
        { activeGlyph: spinnerGlyph(frame), thoughtsExpanded: true, diffExpanded }
      )
    );
  }

  return lines;
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
}) {
  const showScrollbar = width >= 44;
  const cardWidth = Math.max(20, width - (showScrollbar ? 2 : 0));
  const lines = useMemo(
    () => buildChatLines({ history, live, width: cardWidth, frame, thoughtsExpanded, diffExpanded }),
    [history, live, cardWidth, frame, thoughtsExpanded, diffExpanded]
  );
  const total = lines.length;
  const needsScrollbar = showScrollbar && total > height;
  const maxOffset = Math.max(0, total - height);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const start = Math.max(0, maxOffset - offset);
  const visible = lines.slice(start, start + height);

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
        line?.text ?? ""
      )
    );
  }

  const scrollbar = [];
  if (needsScrollbar) {
    const thumbSize = Math.max(1, Math.round((height / total) * height));
    const thumbStart = Math.round((start / maxOffset) * (height - thumbSize));
    for (let i = 0; i < height; i++) {
      const isThumb = i >= thumbStart && i < thumbStart + thumbSize;
      scrollbar.push(
        h(Text, { key: `sb${i}`, color: isThumb ? forge.accent : forge.rule }, isThumb ? "┃" : "│")
      );
    }
  }

  return h(
    Box,
    { flexDirection: "row", height, overflow: "hidden", flexShrink: 0 },
    h(Box, { flexDirection: "column", width: cardWidth, height, overflow: "hidden", flexShrink: 0 }, ...rows),
    needsScrollbar ? h(Box, { flexDirection: "column", width: 1, height, marginLeft: 1, flexShrink: 0 }, ...scrollbar) : null
  );
}

/** A compact running strip used above the input while a run is active. */
export function LiveStrip({ phase = "thinking", detail = "", frame = 0, width = 78, waiting = false }) {
  const glyph = waiting ? "◈" : spinnerGlyph(frame);
  const label = phase === "tool" ? detail || "running tool" : phase === "verifying" ? detail || "running tests" : detail || phase;
  return h(
    Text,
    { color: waiting ? forge.warn : forge.muted, wrap: "truncate" },
    `${glyph} ${truncateToWidth(String(label), Math.max(8, width - 2))}`
  );
}

/** Backwards-compatible helper used by renderers/tests. */
export function chatText(options = {}) {
  return buildChatLines(options)
    .map((line) => line.text)
    .join("\n");
}

export { formatTokens, displayWidth, padToWidth };
