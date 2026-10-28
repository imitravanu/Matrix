import React from "react";
import { Box, Text } from "ink";
import { forge } from "../../lib/forge.mjs";
import { truncateToWidth, sanitizeText } from "../../lib/text.mjs";

const h = React.createElement;

// Every agent has its own row. Narrow terminals retain IDs and status first.
export function parallelSwarmLines(state, width, height) {
  const lines = [{ text: "REAL PARALLEL AGENTS", color: forge.accent }];
  for (const agent of state.agents) {
    const text = `${agent.id} ${agent.status} · ${agent.detail}${agent.workspaceKind ? ` · ${agent.workspaceKind}` : ""}`;
    lines.push({
      text: truncateToWidth(sanitizeText(text), width),
      color: agent.status === "waiting" ? forge.warn : forge.text,
    });
  }
  if (lines.length > height)
    return [
      ...lines.slice(0, Math.max(1, height - 1)),
      { text: `+${lines.length - height + 1} more agents`, color: forge.muted },
    ];
  return lines;
}

export function ParallelSwarmScreen({ state, width = 78, height = 10 }) {
  const lines = parallelSwarmLines(state, Math.max(1, width), Math.max(1, height));
  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden" },
    ...lines.map((line, index) =>
      h(Text, { key: index, color: line.color, wrap: "truncate" }, line.text),
    ),
  );
}
