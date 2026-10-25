// Repository test-trust approval: show the exact executable, argv and scripts
// before allowing repository code to start. This is separate from edit approval.

import React, { useEffect, useMemo } from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { truncateToWidth, wrapCodeToWidth } from "../../lib/text.mjs";

const h = React.createElement;

export function buildTestTrustLines(request, width = 76) {
  const w = Math.max(20, width);
  const rows = [];
  const add = (text, color = forge.muted, bold = false) => {
    for (const part of wrapCodeToWidth(text, w)) rows.push({ text: part, color, bold });
  };

  add(`origin  ${request.origin ?? "unknown"}`, forge.warn);
  add(`workspace  ${request.workspace ?? "unknown"}`);
  add("");
  add(
    `command  ${request.command ?? `${request.executable ?? ""} ${(request.argv ?? []).join(" ")}`.trim()}`,
    forge.text,
  );
  const scripts = request.scripts ?? (request.script ? { test: request.script } : null);
  for (const [name, script] of Object.entries(scripts ?? {})) add(`${name}: ${script}`, forge.text);
  add(`plan hash  ${request.planHash ?? "unavailable"}`, forge.muted);
  if (request.scriptHash) add(`script hash  ${request.scriptHash}`, forge.muted);
  add("");
  add(
    "Repository tests execute code with your user permissions. Edit auto-approve does not apply.",
    forge.warn,
  );
  add("y trust exact plan · o run once · n deny · Esc cancel", forge.accent, true);
  return rows;
}

export function TestTrustScreen({
  request,
  width = 78,
  height = 20,
  scrollOffset = 0,
  onBounds = null,
}) {
  const lines = useMemo(
    () => buildTestTrustLines(request, Math.max(20, width - 4)),
    [request, width],
  );
  const innerHeight = Math.max(3, height - 3);
  const maxOffset = Math.max(0, lines.length - innerHeight);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const visible = lines.slice(offset, offset + innerHeight);
  const end = Math.min(lines.length, offset + innerHeight);
  const kind = request.kind === "workspace" ? "WORKSPACE" : "TEST PLAN";

  useEffect(() => {
    if (typeof onBounds === "function")
      onBounds({ total: lines.length, height: innerHeight, maxOffset });
  }, [lines.length, innerHeight, maxOffset, onBounds]);

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: forge.warn,
        paddingX: 1,
        flexGrow: 1,
        overflow: "hidden",
      },
      h(
        Text,
        { color: forge.warn, bold: true, wrap: "truncate" },
        truncateToWidth(
          `TEST TRUST · ${kind}  ${offset + 1}-${end}/${lines.length}`,
          Math.max(20, width - 4),
        ),
      ),
      ...visible.map((line, index) =>
        h(
          Text,
          { key: `${offset}-${index}`, color: line.color, bold: line.bold, wrap: "truncate" },
          line.text,
        ),
      ),
    ),
  );
}
