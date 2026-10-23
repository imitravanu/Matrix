// Permission gate: the one screen where a write becomes real. It shows the
// parsed hunks with old/new line numbers, the enclosing scope, and exactly what
// approving will do. Nothing here is simulated.

import React, { useEffect, useMemo } from "react";
import { Box, Text } from "ink";

import { forge, forgeBg } from "../../lib/forge.mjs";
import { displayWidth, padToWidth, truncateToWidth } from "../../lib/text.mjs";
import { foldDiffLines } from "../cards.mjs";

const h = React.createElement;

function lineNo(value, width = 5) {
  return String(value ?? "").padStart(width);
}

export function buildPermissionLines({ proposal = null, width = 76, expanded = false } = {}) {
  const w = Math.max(30, width);
  if (!proposal) {
    return [
      { text: truncateToWidth("PATCH GATE", w), color: forge.accent, bold: true },
      { text: "", color: forge.muted },
      { text: truncateToWidth("No patch is waiting for approval.", w), color: forge.muted },
      { text: truncateToWidth("Run a task and the first real write will stop here.", w), color: forge.dim },
    ];
  }

  const stats = proposal.stats ?? { adds: 0, dels: 0 };
  const status = proposal.status ?? "pending";
  const lines = [
    { text: truncateToWidth(`PATCH GATE · ${proposal.file}`, w), color: forge.accent, bold: true },
    { text: truncateToWidth(proposal.scope ? `scope  ${proposal.scope}` : "scope  (module)", w), color: forge.muted },
    { text: truncateToWidth(`reason ${proposal.reason ?? proposal.edits?.[0]?.reason ?? "unspecified"}`, w), color: forge.muted },
    {
      text: truncateToWidth(
        `+${stats.adds} −${stats.dels} · ${status} · backup before write · tests after write`,
        w
      ),
      color: status === "denied" ? forge.err : status === "approved" || status === "applied" ? forge.ok : forge.warn,
      bold: true,
    },
    { text: "", color: forge.muted },
  ];

  const hunks = proposal.hunks ?? [];
  if (hunks.length === 0) {
    for (const line of String(proposal.patch ?? "").split("\n")) {
      if (!line) continue;
      lines.push({ text: truncateToWidth(line, w), color: line.startsWith("+") ? forge.ok : line.startsWith("-") ? forge.err : forge.muted });
    }
    return lines;
  }

  for (const hunk of hunks) {
    lines.push({
      text: truncateToWidth(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, w),
      color: forge.info,
      bold: true,
    });

    let rows = hunk.rows.map((row) => ({
      type: row.type,
      text: row.text,
      oldLine: row.oldLine,
      newLine: row.newLine,
    }));

    if (!expanded) {
      // Collapse long runs of context, but always keep the changed rows and
      // one neighbour. The line numbers make the skipped range explicit.
      const keep = new Set();
      rows.forEach((row, index) => {
        if (row.type !== "ctx") {
          keep.add(Math.max(0, index - 1));
          keep.add(index);
          keep.add(Math.min(rows.length - 1, index + 1));
        }
      });
      if (keep.size === 0) {
        rows = rows.slice(0, 8);
      } else {
        const kept = [];
        let previous = -2;
        rows.forEach((row, index) => {
          if (!keep.has(index)) return;
          if (previous >= 0 && index > previous + 1) {
            kept.push({ type: "fold", skipped: index - previous - 1 });
          }
          kept.push(row);
          previous = index;
        });
        rows = kept;
      }
    }

    for (const row of rows) {
      if (row.type === "fold") {
        lines.push({
          text: truncateToWidth(`${" ".repeat(5)} ${" ".repeat(5)}   … ${row.skipped} unchanged lines`, w),
          color: forge.dim,
        });
        continue;
      }
      const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
      const gutter =
        row.type === "add"
          ? `${" ".repeat(5)} ${lineNo(row.newLine)} `
          : row.type === "del"
          ? `${lineNo(row.oldLine)} ${" ".repeat(5)} `
          : `${lineNo(row.oldLine)} ${lineNo(row.newLine)} `;
      const text = `${gutter}${marker} ${row.text}`;
      lines.push({
        text: truncateToWidth(text, w),
        color: row.type === "add" ? forge.text : row.type === "del" ? forge.text : forge.muted,
        bg: row.type === "add" ? forgeBg.add : row.type === "del" ? forgeBg.del : undefined,
      });
    }
    lines.push({ text: "", color: forge.muted });
  }

  lines.push({
    text: truncateToWidth("y apply · a apply all · n deny · f fold · PgUp/PgDn scroll", w),
    color: forge.dim,
  });
  return lines;
}

export function PermissionScreen({
  proposal = null,
  width = 78,
  height = 20,
  expanded = false,
  scrollOffset = 0,
  onBounds = null,
  frame = 0,
}) {
  const innerWidth = Math.max(20, width - 4);
  const innerHeight = Math.max(3, height - 2);
  const lines = useMemo(
    () => buildPermissionLines({ proposal, width: innerWidth, expanded }),
    [proposal, innerWidth, expanded]
  );
  const total = lines.length;
  const maxOffset = Math.max(0, total - innerHeight);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const visible = lines.slice(offset, offset + innerHeight);

  useEffect(() => {
    if (typeof onBounds === "function") onBounds({ total, height: innerHeight });
  }, [total, innerHeight, onBounds]);

  const rows = [];
  for (let i = 0; i < innerHeight; i++) {
    const line = visible[i];
    rows.push(
      h(
        Text,
        {
          key: i,
          color: line?.color ?? forge.text,
          backgroundColor: line?.bg ?? undefined,
          bold: line?.bold ?? false,
          wrap: "truncate",
        },
        line?.text ?? ""
      )
    );
  }

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: proposal?.status === "denied" ? forge.err : forge.accent,
        paddingX: 1,
        flexGrow: 1,
        overflow: "hidden",
      },
      ...rows
    )
  );
}
