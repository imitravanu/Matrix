// One-shot sandboxed-command approval. Exact bytes are shown only on this
// transient permission screen; run logs/cards use commandPlanAudit projections.

import React, { useEffect, useMemo } from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { truncateToWidth, wrapCodeToWidth } from "../../lib/text.mjs";

const h = React.createElement;

export function buildCommandTrustLines(request, width = 76) {
  const w = Math.max(20, width);
  const rows = [];
  const add = (value, color = forge.muted, bold = false) => {
    for (const raw of String(value ?? "").split("\n")) {
      for (const part of wrapCodeToWidth(raw, w)) rows.push({ text: part, color, bold });
    }
  };

  add("SANDBOXED COMMAND · APPROVE ONCE", forge.warn, true);
  add(`origin  ${request.origin ?? "run_sandboxed_command"}`);
  add(`workspace  ${request.workspace ?? "unknown"}`);
  add("");
  add(`executable  ${request.executable ?? "unknown"}`, forge.text);
  const argv = Array.isArray(request.argv) ? request.argv : [];
  if (argv.length === 0) add("argv  [] (no arguments)", forge.text);
  argv.forEach((argument, index) => add(`argv[${index}]  ${JSON.stringify(argument)}`, forge.text));
  add(`cwd  ${request.cwd ?? "unknown"}`, forge.text);
  add("command (exact executable plus literal argv):", forge.text, true);
  add(request.command ?? "unavailable", forge.text);

  if (typeof request.script === "string") {
    add("--- inline script · exact ---", forge.info, true);
    add(request.script, forge.text);
    add("--- end inline script ---", forge.info);
  }
  if (request.scriptFile) {
    add(
      `scriptFile  ${request.scriptFile.path ?? request.scriptFile.relative ?? "unknown"}`,
      forge.text,
    );
    add(`scriptFile sha256  ${request.scriptFile.sha256 ?? "unavailable"}`);
    add("--- scriptFile.content · exact ---", forge.info, true);
    add(request.scriptFile.content ?? "", forge.text);
    add("--- end scriptFile.content ---", forge.info);
  }

  add("");
  add("plan hash · copy this exact one-shot value:", forge.accent, true);
  add(request.planHash ?? "unavailable", forge.accent, true);
  add("For headless reuse, use it with --allow-command and --enable-commands.");
  add("A hash authorizes one invocation only; a second command is always denied.");
  add("");
  add("network  disabled · new empty network namespace; no inherited host sockets", forge.warn);
  add("workspace  private disposable snapshot · all snapshot writes discarded", forge.warn);
  add("live workspace  unchanged · no applied edit · undo not applicable", forge.warn);
  add("No edit auto-approve, test trust, or persistent command grant applies.");
  add("y approve this exact command once · n deny · Esc deny", forge.accent, true);
  add("↑/↓ or j/k scroll · PgUp/PgDn · Home/End · Ctrl+C abort run", forge.muted);
  return rows;
}

export function CommandTrustScreen({
  request,
  width = 78,
  height = 20,
  scrollOffset = 0,
  onBounds = null,
}) {
  const lines = useMemo(
    () => buildCommandTrustLines(request, Math.max(20, width - 4)),
    [request, width],
  );
  const innerHeight = Math.max(1, height - 3);
  const maxOffset = Math.max(0, lines.length - innerHeight);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const visible = lines.slice(offset, offset + innerHeight);
  const end = Math.min(lines.length, offset + innerHeight);

  useEffect(() => {
    if (typeof onBounds === "function") {
      onBounds({ total: lines.length, height: innerHeight, maxOffset });
    }
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
          `COMMAND TRUST · ONCE  ${offset + 1}-${end}/${lines.length}`,
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
