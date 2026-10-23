// Help overlay: the actual keymap of the workbench.

import React from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { SLASH_COMMANDS } from "../../lib/input.mjs";
import { truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

const KEYS = [
  ["Enter", "send the task / apply model selection"],
  ["Tab", "complete a slash command"],
  ["← →", "move the input cursor · Ctrl+←/→ jumps words"],
  ["↑ ↓", "input history · model picker selection"],
  ["PgUp/PgDn", "scroll chat, diff or test output"],
  ["1 · 2", "empty forge / chat crucible"],
  ["3 · 4", "patch gate / swarm lanes"],
  ["5 · 6", "scope lens / pixel vision"],
  ["m · v", "model router / cycle vision view"],
  ["f · u", "fold diff or reasoning / undo last applied patch"],
  ["y · a · n", "apply patch / apply all this run / deny"],
  ["[ ]", "previous / next file in the scope lens"],
  ["j k", "previous / next scope in the scope lens"],
  ["e", "export the current vision canvas to PNG"],
  ["? · Esc", "toggle help / close the current overlay"],
  ["Ctrl+C", "abort an active run, then quit"],
];

export function HelpScreen({ width = 78, height = 20 }) {
  const inner = Math.max(20, width - 4);
  const rows = [];
  rows.push(h(Text, { key: "title", color: forge.accent, bold: true }, "KEYMAP & COMMANDS"));
  rows.push(h(Text, { key: "blank", color: forge.muted }, ""));
  for (const [key, description] of KEYS) {
    if (rows.length >= height - 4) break;
    rows.push(
      h(
        Text,
        { key, wrap: "truncate" },
        h(Text, { color: forge.accent }, key.padEnd(12)),
        h(Text, { color: forge.muted }, truncateToWidth(description, inner - 12))
      )
    );
  }
  rows.push(h(Text, { key: "blank2", color: forge.muted }, ""));
  rows.push(
    h(
      Text,
      { key: "slash", color: forge.dim, wrap: "truncate" },
      truncateToWidth("/ " + SLASH_COMMANDS.map((command) => command.name).join("  "), inner)
    )
  );

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: forge.accent,
        paddingX: 1,
        flexGrow: 1,
        overflow: "hidden",
      },
      ...rows.slice(0, Math.max(2, height - 2))
    )
  );
}
