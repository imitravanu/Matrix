// Help overlay: the actual keymap and slash commands, with a scrollable viewport.

import React, { useEffect } from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { SLASH_COMMANDS } from "../../lib/input.mjs";
import { truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

const KEYS = [
  ["Enter", "send the task / apply model selection"],
  ["Tab", "complete a slash command"],
  ["← →", "move input cursor / focus lane / cycle files"],
  ["↑ ↓ / j k", "input history / scope tree / model selection / help scroll"],
  ["PgUp/PgDn", "scroll chat, diff, test output, or help"],
  ["Alt+1/2", "empty forge / chat crucible"],
  ["Alt+3/4", "patch gate / swarm lanes"],
  ["Alt+5/6", "scope lens / pixel vision"],
  ["Alt+M", "model router (or /model)"],
  ["Alt+U", "undo last applied patch (or /undo)"],
  ["Alt+F / F", "fold while running / fold at the patch gate"],
  ["y · a · n", "apply patch / apply all this run / deny"],
  ["/export", "export the current vision canvas to PNG"],
  ["Alt+H / Esc", "open help / close the current overlay"],
  ["Ctrl+C", "abort an active run, then quit"],
];

const ENTRIES = [
  ...KEYS.map(([label, description]) => ({ key: label, label, description })),
  { key: "slash-title", section: "SLASH COMMANDS" },
  ...SLASH_COMMANDS.map((command) => ({
    key: command.name,
    label: command.name,
    description: command.description,
  })),
];

export function HelpScreen({ width = 78, height = 20, scrollOffset = 0, onBounds = null }) {
  const inner = Math.max(20, width - 4);
  const available = Math.max(2, height - 3);
  const total = ENTRIES.length;
  const maxOffset = Math.max(0, total - available);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const visible = ENTRIES.slice(offset, offset + available);
  const end = Math.min(total, offset + available);

  useEffect(() => {
    if (typeof onBounds === "function") onBounds({ total, height: available, maxOffset });
  }, [total, available, maxOffset, onBounds]);

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
      h(
        Text,
        { color: forge.accent, bold: true, wrap: "truncate" },
        truncateToWidth(`KEYMAP & COMMANDS  ${offset + 1}-${end}/${total}`, inner),
      ),
      ...visible.map((entry) => {
        if (entry.section) {
          return h(
            Text,
            { key: entry.key, color: forge.accent, bold: true, wrap: "truncate" },
            entry.section,
          );
        }
        return h(
          Text,
          { key: entry.key, wrap: "truncate" },
          h(Text, { color: forge.accent }, entry.label.padEnd(12)),
          h(
            Text,
            { color: forge.muted },
            truncateToWidth(entry.description, Math.max(4, inner - 12)),
          ),
        );
      }),
    ),
  );
}
