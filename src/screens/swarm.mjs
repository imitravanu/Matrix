// Multi-agent swarm: three lanes over one real event stream. Layout is
// responsive by usable columns, not a decorative animation.

import React from "react";
import { Box, Text } from "ink";

import { forge, forgeBg } from "../../lib/forge.mjs";
import { getSwarmLayout, laneList } from "../../lib/swarm.mjs";
import { sanitizeText, truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

const STATUS_COLOR = {
  idle: forge.dim,
  active: forge.accent,
  waiting: forge.warn,
  done: forge.ok,
  applied: forge.ok,
  error: forge.err,
  denied: forge.err,
  skipped: forge.dim,
};

const STATUS_GLYPH = {
  idle: "○",
  active: "◐",
  waiting: "◈",
  done: "✓",
  applied: "●",
  error: "✗",
  denied: "×",
  skipped: "-",
};

function logColor(kind) {
  if (kind === "error") return forge.err;
  if (kind === "ok") return forge.ok;
  if (kind === "tool") return forge.info;
  if (kind === "thought") return forge.muted;
  if (kind === "waiting") return forge.warn;
  if (kind === "accent") return forge.accent;
  return forge.muted;
}

export function laneBodyLines(lane, width = 30, height = 12) {
  const w = Math.max(8, width);
  const lines = [];
  if (!lane) return lines;

  if (lane.id === "planner") {
    if (lane.steps.length === 0) {
      lines.push({ text: "no plan yet", color: forge.dim });
    } else {
      for (const step of lane.steps.slice(0, 8)) {
        const glyph =
          step.status === "done" ? "✓" : step.status === "active" ? "◐" : step.status === "skipped" ? "-" : step.status === "error" ? "✗" : "·";
        const color = step.status === "active" ? forge.accent : step.status === "done" ? forge.muted : forge.dim;
        lines.push({ text: truncateToWidth(`${glyph} ${step.title}`, w), color });
      }
    }
    lines.push({ text: "", color: forge.muted });
    lines.push({ text: truncateToWidth("LOG", w), color: forge.dim, dim: true });
    for (const log of lane.logs.slice(-Math.max(2, height - lines.length - 1))) {
      lines.push({ text: truncateToWidth(sanitizeText(log.text), w), color: logColor(log.kind) });
    }
  } else if (lane.id === "forge") {
    lines.push({ text: truncateToWidth(lane.file ?? "no proposal", w), color: lane.file ? forge.text : forge.dim });
    if (lane.scope) lines.push({ text: truncateToWidth(lane.scope, w), color: forge.muted });
    lines.push({
      text: truncateToWidth(
        lane.stats ? `+${lane.stats.adds} −${lane.stats.dels} · ${lane.statusText}` : lane.statusText,
        w
      ),
      color: lane.status === "waiting" ? forge.warn : lane.status === "denied" ? forge.err : forge.accent,
    });
    lines.push({ text: "", color: forge.muted });
    if (lane.diffLines.length > 0) {
      for (const line of lane.diffLines.slice(-Math.max(3, height - lines.length - 1))) {
        if (line.startsWith("@@")) lines.push({ text: truncateToWidth(line, w), color: forge.info });
        else if (line.startsWith("+")) lines.push({ text: truncateToWidth(line, w), color: forge.text, bg: forgeBg.add });
        else if (line.startsWith("-")) lines.push({ text: truncateToWidth(line, w), color: forge.text, bg: forgeBg.del });
        else lines.push({ text: truncateToWidth(line, w), color: forge.muted });
      }
    } else {
      for (const log of lane.logs.slice(-Math.max(2, height - lines.length - 1))) {
        lines.push({ text: truncateToWidth(sanitizeText(log.text), w), color: logColor(log.kind) });
      }
    }
  } else {
    lines.push({
      text: truncateToWidth(lane.command ? `$ ${lane.command}` : "tests not run", w),
      color: lane.command ? forge.text : forge.dim,
    });
    lines.push({
      text: truncateToWidth(
        lane.passed != null
          ? `${lane.passed} passed · ${lane.failed ?? 0} failed${lane.duration ? ` · ${lane.duration}` : ""}`
          : lane.summary ?? "waiting for verification",
        w
      ),
      color: lane.failed > 0 ? forge.err : lane.passed != null ? forge.ok : forge.muted,
      bold: lane.passed != null,
    });
    lines.push({ text: "", color: forge.muted });
    for (const log of lane.logs.slice(-Math.max(2, height - lines.length))) {
      lines.push({ text: truncateToWidth(sanitizeText(log.text), w), color: logColor(log.kind) });
    }
  }

  while (lines.length > height) lines.shift();
  return lines;
}

function Panel({ lane, width, height, focused, frame = 0 }) {
  const color = STATUS_COLOR[lane.status] ?? forge.dim;
  const glyph = STATUS_GLYPH[lane.status] ?? "·";
  const innerWidth = Math.max(8, width - 4);
  const innerHeight = Math.max(2, height - 4);
  const body = laneBodyLines(lane, innerWidth, innerHeight - 2);
  const rows = [
    h(
      Text,
      { key: "title", color, bold: true, wrap: "truncate" },
      `${glyph} ${lane.title}`
    ),
    h(
      Text,
      { key: "agent", color: forge.dim, wrap: "truncate" },
      truncateToWidth(lane.subtitle || lane.agent || "", innerWidth)
    ),
    ...body.map((line, index) =>
      h(
        Text,
        {
          key: index,
          color: line.color,
          backgroundColor: line.bg ?? undefined,
          dim: line.dim ?? false,
          wrap: "truncate",
        },
        line.text
      )
    ),
  ];
  return h(
    Box,
    {
      flexDirection: "column",
      width,
      height,
      borderStyle: focused ? "double" : "round",
      borderColor: focused ? forge.accent : forge.rule,
      paddingX: 1,
      overflow: "hidden",
      flexShrink: 0,
    },
    ...rows.slice(0, Math.max(1, height - 2))
  );
}

export function buildSwarmScreen(state, width, height) {
  const layout = getSwarmLayout(width, state?.focusedLane ?? 0);
  const lanes = laneList(state);
  const tabsHeight = layout.mode === "triple" ? 0 : 1;
  const panelHeight = Math.max(5, height - tabsHeight);
  const panels = layout.lanes.map((laneIndex, i) => ({
    lane: lanes[laneIndex],
    width: layout.widths[i] ?? layout.laneWidth,
    index: laneIndex,
  }));
  return { layout, tabsHeight, panelHeight, panels };
}

export function SwarmScreen({ state, width = 78, height = 20, frame = 0 }) {
  if (!state) {
    return h(Text, { color: forge.muted }, "No swarm state. Run a task to populate real lanes.");
  }
  const { layout, tabsHeight, panelHeight, panels } = buildSwarmScreen(state, width, height);
  const tabs =
    tabsHeight > 0
      ? h(
          Box,
          { height: 1, width, flexShrink: 0, overflow: "hidden" },
          ...laneList(state).map((lane, index) =>
            h(
              Text,
              {
                key: lane.id,
                color: index === layout.focusedLane ? forge.accent : forge.dim,
                backgroundColor: index === layout.focusedLane ? forge.rule : undefined,
                bold: index === layout.focusedLane,
                wrap: "truncate",
              },
              ` ${index + 1}:${lane.title} `
            )
          ),
          width >= 52 ? h(Text, { color: forge.dim, wrap: "truncate" }, "  ←/→ focus") : null
        )
      : null;

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    tabs,
    h(
      Box,
      { flexDirection: "row", height: panelHeight, overflow: "hidden" },
      ...panels.map(({ lane, width: laneWidth, index }, i) =>
        h(
          Box,
          { key: lane.id, flexShrink: 0, marginRight: i < panels.length - 1 ? layout.gap : 0 },
          h(Panel, {
            lane,
            width: laneWidth,
            height: panelHeight,
            focused: index === layout.focusedLane,
            frame,
          })
        )
      )
    )
  );
}
