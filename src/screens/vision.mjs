// Vision screen: an actual raster canvas, rendered as half-block truecolor.
// The same pixels can be exported as a valid PNG (`/export`).

import React, { useMemo } from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { halfBlockRuns } from "../../lib/raster.mjs";
import { buildVision, emptyVision } from "../../lib/graph.mjs";
import { formatCost } from "../../lib/models.mjs";
import { chainAtLine, formatScopeChain } from "../../lib/scope.mjs";
import { screenReaderMode } from "../../lib/term.mjs";
import { displayWidth, formatDuration, truncateToWidth, wrapToWidth } from "../../lib/text.mjs";

const h = React.createElement;

export const VISION_MODES = ["scope", "workspace", "telemetry"];

export function visionTextSummary({
  mode = "scope",
  parsed = null,
  file = "file",
  activeLine = 1,
  project = null,
  usage = null,
  metrics = {},
  testResult = null,
  modelName = "LOCAL",
} = {}) {
  if (mode === "workspace") {
    const languages = (project?.languages ?? [])
      .map((language) => `${language.name} ${language.files}`)
      .join(" · ");
    return [
      `${project?.name ?? "no workspace"} · ${project?.fileCount ?? 0} files · ${project?.branch ?? "no branch"}`,
      `languages: ${languages || "no indexed source"}`,
      `tests: ${project?.test?.display ?? "none detected"}`,
    ];
  }
  if (mode === "telemetry") {
    const input = Number(usage?.prompt_tokens ?? usage?.inputTokens ?? 0);
    const output = Number(usage?.completion_tokens ?? usage?.outputTokens ?? 0);
    const cached = Number(usage?.cached_tokens ?? usage?.cachedTokens ?? 0);
    const hasUsage = Boolean(
      usage &&
      (usage.prompt_tokens ||
        usage.completion_tokens ||
        usage.inputTokens ||
        usage.outputTokens ||
        (usage.provenance && usage.provenance !== "unavailable") ||
        Number(usage.rounds?.total ?? 0) > 0),
    );
    const elapsed = Number(metrics?.elapsedMs ?? 0);
    const rawCost = metrics?.cost ?? usage?.cost ?? null;
    const cost = Number.isFinite(rawCost) ? Number(rawCost) : null;
    const tokenProvenance = usage?.provenance ?? metrics?.usageProvenance ?? "unavailable";
    const costProvenance = metrics?.costProvenance ?? usage?.costProvenance ?? "unavailable";
    const costComplete = metrics?.costComplete ?? usage?.costComplete ?? false;
    const tokenLabel =
      {
        provider: "provider-reported",
        estimated: "estimated",
        mixed: "mixed",
        unavailable: "unavailable",
        legacy: "legacy",
      }[tokenProvenance] ?? "unavailable";
    const costLabel =
      {
        provider: "provider-reported",
        estimated: "estimated",
        mixed: "mixed",
        unavailable: "unavailable",
        legacy: "legacy",
      }[costProvenance] ?? "unavailable";
    const partial = Number.isFinite(cost) && !costComplete ? " · partial" : "";
    const tests = testResult?.skipped
      ? "skipped"
      : testResult
        ? `${Number(testResult.passed ?? 0)} passed · ${Number(testResult.failed ?? 0)} failed · ${testResult.verificationStatus ?? (testResult.ok ? "verified" : "failed")}`
        : "not run";
    return [
      `${modelName} · ${hasUsage ? `input ${input} · output ${output} · cache ${cached} · ${tokenLabel}` : "usage unavailable"}`,
      `time ${formatDuration(elapsed)} · rounds ${metrics?.rounds ?? 0} · tools ${metrics?.toolCalls ?? 0} · cost ${formatCost(cost)} (${costLabel}${partial})`,
      `tests: ${tests}`,
    ];
  }
  const scopes = (parsed?.flat ?? []).filter((node) => node.kind !== "module");
  const chain = parsed ? formatScopeChain(chainAtLine(parsed, activeLine), { maxWidth: 160 }) : "";
  return [
    `${file ?? "no file"} · ${parsed?.language ?? "unknown"} · ${parsed?.lines?.length ?? 0} lines · ${scopes.length} scopes`,
    `active: line ${activeLine} · ${chain || "module"}`,
  ];
}

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
    return emptyVision(
      canvasWidth,
      canvasHeight,
      file ? `NO PARSED SCOPES FOR ${file}` : "NO FILE TO VISUALISE",
    );
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
    [mode, parsed, file, activeLine, project, usage, metrics, testResult, modelName, width, height],
  );

  const semantic = screenReaderMode();
  const rows = useMemo(() => (semantic ? [] : halfBlockRuns(graph.canvas)), [graph, semantic]);
  const summaryRows = useMemo(
    () =>
      semantic
        ? visionTextSummary({
            mode,
            parsed,
            file,
            activeLine,
            project,
            usage,
            metrics,
            testResult,
            modelName,
          })
            .flatMap((line) => wrapToWidth(line, width))
            .map((line, index) => h(Text, { key: `summary-${index}` }, line))
        : [],
    [
      semantic,
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
    ],
  );
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
            color: item === mode ? forge.text : forge.muted,
            backgroundColor: item === mode ? forge.rule : undefined,
            bold: item === mode,
          },
          ` ${item} `,
        ),
      ),
    ),
    h(
      Text,
      { color: forge.muted, wrap: "truncate" },
      truncateToWidth(graph.title ?? "", compact ? Math.max(6, Math.floor(width / 3)) : 24),
    ),
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
          run.text,
        ),
      ),
    ),
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
        h(Text, { color: forge.muted }, `${item.label}  `),
      ),
    ),
    statusRoom >= 6
      ? h(Text, { color: forge.muted, wrap: "truncate" }, truncateToWidth(status, statusRoom))
      : null,
  );

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    header,
    ...(semantic ? summaryRows : canvasRows).slice(0, Math.max(1, height - 2)),
    legend,
  );
}
