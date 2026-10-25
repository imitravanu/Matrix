// Scope lens: a two-pane structural view over a real file. The left pane is a
// parsed scope tree (Python indentation / masked JS braces), the right pane is
// the actual source around the selected scope.

import React, { useMemo } from "react";
import { Box, Text } from "ink";

import { forge, forgeBg } from "../../lib/forge.mjs";
import { parseScopes, scopeStats } from "../../lib/scope.mjs";
import { sanitizeText, truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

function kindGlyph(kind) {
  return kind === "class" ? "◆" : kind === "function" ? "ƒ" : "·";
}

function kindColor(kind) {
  return kind === "class" ? forge.ok : kind === "function" ? forge.info : forge.muted;
}

function codeLineColor(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("*"))
    return forge.muted;
  if (/^(def|class|async def|function|export|import|from|const|let|var)\b/.test(trimmed))
    return forge.accent;
  if (/^\s*@/.test(line)) return forge.warn;
  return forge.text;
}

function codeRows(parsed, startLine, height, width) {
  const rows = [];
  const lines = parsed?.lines ?? [];
  const start = Math.max(0, Math.min(lines.length - 1, startLine - 1));
  for (let i = 0; i < height; i++) {
    const index = start + i;
    if (index >= lines.length) break;
    const line = sanitizeText(lines[index]).replace(/\t/g, "    ");
    const number = String(index + 1).padStart(4);
    const available = Math.max(4, width - 7);
    rows.push({
      text: `${number} │ ${truncateToWidth(line, available)}`,
      color: codeLineColor(line),
      line: index + 1,
    });
  }
  return rows;
}

function scopeRows(parsed, selectedIndex, height) {
  const scopes = (parsed?.flat ?? []).filter((node) => node.kind !== "module");
  if (scopes.length === 0) return [{ text: "no named scopes", color: forge.muted }];
  const rows = [];
  const visible = Math.max(1, height);
  let start = 0;
  if (selectedIndex >= visible) start = selectedIndex - Math.floor(visible / 2);
  if (start > scopes.length - visible) start = Math.max(0, scopes.length - visible);
  const showPrevious = start > 0 && visible > 1;
  const count = Math.max(1, visible - (showPrevious ? 1 : 0));
  if (selectedIndex >= start + count) start = selectedIndex - count + 1;
  const slice = scopes.slice(start, start + count);
  if (showPrevious) rows.push({ text: `↑ ${start} more`, color: forge.muted });
  slice.forEach((scope, offset) => {
    const index = start + offset;
    const selected = index === selectedIndex;
    const indent = "  ".repeat(Math.min(6, Math.max(0, scope.depth - 1)));
    rows.push({
      text: `${indent}${kindGlyph(scope.kind)} ${scope.label}  L${scope.startLine}-${scope.endLine}`,
      color: selected ? forge.text : kindColor(scope.kind),
      bg: selected ? forgeBg.add : undefined,
      bold: selected,
    });
  });
  return rows;
}

export function ScopeScreen({
  file = null,
  source = "",
  parsed: parsedProp = null,
  selectedScopeIndex = 0,
  width = 78,
  height = 20,
  files: _files = [],
  filesOffset: _filesOffset = 0,
}) {
  const parsed = useMemo(
    () => parsedProp ?? parseScopes(source, file ?? "file"),
    [parsedProp, source, file],
  );
  const stats = useMemo(() => scopeStats(parsed), [parsed]);
  const scopes = (parsed?.flat ?? []).filter((node) => node.kind !== "module");
  const selected =
    scopes[Math.min(Math.max(0, selectedScopeIndex), Math.max(0, scopes.length - 1))] ?? null;
  const narrow = width < 88;
  const leftWidth = narrow ? width : Math.max(30, Math.min(46, Math.floor(width * 0.38)));
  const rightWidth = narrow ? width : width - leftWidth - 2;
  const paneHeight = height;
  const treeHeight = narrow ? Math.max(4, Math.floor(height * 0.38)) : paneHeight - 1;
  const codeHeight = narrow ? Math.max(4, paneHeight - treeHeight - 2) : paneHeight - 1;

  const header = h(
    Text,
    { color: forge.accent, bold: true, wrap: "truncate" },
    truncateToWidth(
      `${file ?? "no file"}  ·  ${parsed?.language ?? "unknown"}  ·  ${stats.lines} lines  ·  ${stats.classes} classes  ·  ${stats.functions} functions${parsed?.partial ? "  ·  PARTIAL" : ""}`,
      width,
    ),
  );

  const tree = h(
    Box,
    {
      flexDirection: "column",
      width: leftWidth,
      height: treeHeight,
      overflow: "hidden",
      flexShrink: 0,
    },
    h(
      Text,
      { color: forge.muted, wrap: "truncate" },
      truncateToWidth(`SCOPES  ${scopes.length}  ·  ←/→ file  ↑/↓ scope`, leftWidth),
    ),
    ...scopeRows(parsed, selectedScopeIndex, treeHeight - 1).map((row, index) =>
      h(
        Text,
        {
          key: index,
          color: row.color,
          backgroundColor: row.bg ?? undefined,
          bold: row.bold ?? false,
          wrap: "truncate",
        },
        truncateToWidth(row.text, leftWidth),
      ),
    ),
  );

  const codeStart = selected ? selected.startLine : 1;
  const code = h(
    Box,
    {
      flexDirection: "column",
      width: rightWidth,
      height: codeHeight,
      overflow: "hidden",
      flexShrink: 0,
    },
    h(
      Text,
      { color: forge.muted, wrap: "truncate" },
      truncateToWidth(
        selected
          ? `${selected.kind} ${selected.name}  L${selected.startLine}-${selected.endLine}`
          : "SOURCE",
        rightWidth,
      ),
    ),
    ...codeRows(parsed, codeStart, codeHeight - 2, rightWidth).map((row, index) =>
      h(
        Text,
        {
          key: index,
          color: row.color,
          backgroundColor: selected && row.line === selected.startLine ? forgeBg.add : undefined,
          wrap: "truncate",
        },
        truncateToWidth(row.text, rightWidth),
      ),
    ),
  );

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    header,
    narrow
      ? h(
          Box,
          { flexDirection: "column", height: paneHeight - 1, overflow: "hidden" },
          tree,
          h(Text, { color: forge.rule }, "─".repeat(width)),
          code,
        )
      : h(
          Box,
          { flexDirection: "row", height: paneHeight - 1, overflow: "hidden" },
          tree,
          h(Text, { color: forge.rule }, "│"),
          h(Box, { marginLeft: 1 }, code),
        ),
  );
}
