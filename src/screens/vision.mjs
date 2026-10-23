// Vision screen: an actual raster canvas, rendered as half-block truecolor.
// The same pixels can be exported as a valid PNG (`e`).

import React, { useMemo } from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { halfBlockRuns } from "../../lib/raster.mjs";
import { buildVision, emptyVision, GRAPH_COLORS } from "../../lib/graph.mjs";
import { displayWidth, truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

export const VISION_MODES = ["scope", "workspace", "telemetry"];

export function buildVisionCanvas({
  mode = "scope",
  parsed = null,
  file = "file",
  activeLine = 1,
  project = null,
  usage = null,
  metrics = {},
  testResult = null,
  modelName = "LOCAL",
  width = 78,
  rows = 20,
}) {
  const canvasWidth = Math.max(20, width);
  const canvasHeight = Math.max(12, (Math.max(6, rows) - 2) * 2);
  if (mode === "scope" && !parsed) {
    return emptyVision(canvasWidth, canvasHeight, file ? `NO PARSED SCOPES FOR ${file}` : "NO FILE TO VISUALISE");
  }
  return buildVision({
    mode,
    parsed,
    file,
    activeLine,
    project,
    usage,
    metrics,
    testResult,
    modelName,
    width: canvasWidth,
    height: canvasHeight,
  });
}

export function VisionScreen({
  mode = "scope",
  parsed = null,
  file = "file",
  activeLine = 1,
  project = null,
  usage = null,
  metrics = {},
  testResult = null,
  modelName = "LOCAL",
  width = 78,
  height = 20,
  status = "",
}) {
  const graph = useMemo(
    () =>
      buildVisionCanvas({
        mode,
        parsed,
        file,
        activeLine,
        project,
        usage,
        metrics,
        testResult,
        modelName,
        width,
        rows: height,
      }),
    [mode, parsed, file, activeLine, project, usage, metrics, testResult, modelName, width, height]
  );

  const rows = useMemo(() => halfBlockRuns(graph.canvas), [graph]);
  const compact = width < 56;
  const header = h(
    Box,
    { justifyContent: "space-between", height: 1, width, flexShrink: 0, overflow: "hidden" },
    h(
      Text,
      { wrap: "truncate" },
      h(Text, { color: forge.accent, bold: true }, "VISION "),
      h(Text, { color: forge.muted }, "· "),
      ...(compact ? [mode] : VISION_MODES).map((item) =>
        h(
          Text,
          {
            key: item,
            color: item === mode ? forge.text : forge.dim,
            backgroundColor: item === mode ? forge.rule : undefined,
            bold: item === mode,
          },
          ` ${item} `
        )
      )
    ),
    h(
      Text,
      { color: forge.dim, wrap: "truncate" },
      truncateToWidth(graph.title ?? "", compact ? Math.max(6, Math.floor(width / 3)) : 24)
    )
  );

  const canvasRows = rows.map((runs, index) =>
    h(
      Text,
      { key: index },
      ...runs.map((run, j) =>
        h(
          Text,
          {
            key: j,
            color: run.fg || undefined,
            backgroundColor: run.bg || undefined,
          },
          run.text
        )
      )
    )
  );

  const legendItems = [];
  let legendUsed = 0;
  for (const item of (graph.legend ?? []).slice(0, 5)) {
    const itemWidth = displayWidth(item.label) + 4;
    if (legendUsed + itemWidth > width - 2) break;
    legendItems.push({ ...item, width: itemWidth });
    legendUsed += itemWidth;
  }
  const statusRoom = Math.max(0, width - legendUsed - 2);
  const legend = h(
    Box,
    { height: 1, width, flexShrink: 0, overflow: "hidden" },
    ...legendItems.map((item) =>
      h(
        Text,
        { key: item.label, color: item.color },
        "■ ",
        h(Text, { color: forge.muted }, `${item.label}  `)
      )
    ),
    statusRoom >= 6
      ? h(Text, { color: forge.dim, wrap: "truncate" }, truncateToWidth(status, statusRoom))
      : null
  );

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    header,
    ...canvasRows.slice(0, Math.max(1, height - 2)),
    legend
  );
}
