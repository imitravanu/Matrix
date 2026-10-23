// ============================================================================
// Graphs for the Vision screen.
//
// Every graph is derived from live run data: a file's parsed scope ranges, the
// workspace inventory, or the token/test telemetry from the active session.
// The same canvas is shown as half-block truecolor and can be exported as PNG.
// ============================================================================

import {
  createCanvas,
  drawDashedLine,
  drawLine,
  drawText,
  drawTextRight,
  fillRect,
  measureText,
  mixColor,
  strokeRect,
} from "./raster.mjs";
import { formatDuration } from "./text.mjs";

export const GRAPH_COLORS = {
  bg: "#0b0c0e",
  panel: "#0e1b14",
  grid: "#1b382b",
  accent: "#00ff41",
  text: "#e6f8ee",
  muted: "#84a98c",
  dim: "#2e593f",
  class: "#00c853",
  function: "#4ade80",
  active: "#e6f8ee",
  warn: "#fbbf24",
  error: "#f87171",
  bar: "#22c55e",
};

const ascii = (value) =>
  String(value ?? "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00b7\u2022]/g, "-")
    .replace(/[\u2192]/g, "->")
    .replace(/[\u00d7]/g, "x")
    .replace(/[^\x20-\x7e]/g, "?");

const maxChars = (pixels) => Math.max(0, Math.floor((pixels + 1) / 4));

function truncateLabel(label, pixels) {
  const limit = maxChars(pixels);
  const text = ascii(label);
  if (text.length <= limit) return text;
  return limit <= 1 ? "" : text.slice(0, limit - 1) + "~";
}

function panel(canvas, x, y, w, h, fill = GRAPH_COLORS.panel, stroke = GRAPH_COLORS.grid) {
  fillRect(canvas, x, y, w, h, fill);
  strokeRect(canvas, x, y, w, h, stroke);
}

function header(canvas, title, subtitle = "") {
  const room = Math.max(12, canvas.width - 8);
  const titleText = truncateLabel(ascii(title).toUpperCase(), room);
  const subtitleText = ascii(subtitle).toUpperCase();
  const titleW = measureText(titleText);
  const subtitleW = measureText(subtitleText);
  drawText(canvas, titleText, 4, 3, GRAPH_COLORS.accent, { scale: 1 });
  // A 58px canvas cannot fit "RUN TELEMETRY" and "LOCAL FORGE" side by side;
  // silently overlapping them looked like corrupted pixels.
  if (subtitleText && titleW + subtitleW + 10 <= room) {
    drawTextRight(canvas, subtitleText, canvas.width - 4, 3, GRAPH_COLORS.muted);
  }
  drawDashedLine(canvas, 4, 10, canvas.width - 5, 10, GRAPH_COLORS.grid, 4, 2);
}

/**
 * Icicle/flame graph over a file's line range. Nested scopes become rows; the
 * horizontal position is the real line range, not a decorative packing.
 */
export function buildScopeGraph(parsed, {
  file = "file",
  width = 120,
  height = 44,
  activeLine = 1,
} = {}) {
  const canvas = createCanvas(width, height, GRAPH_COLORS.bg);
  const scopes = (parsed?.flat ?? []).filter((n) => n.kind !== "module");
  const lineCount = Math.max(1, parsed?.lineCount ?? 1);
  const active =
    [...scopes]
      .filter((n) => n.startLine <= activeLine && n.endLine >= activeLine)
      .sort((a, b) => b.depth - a.depth)[0] ?? null;

  const fileName = file.split("/").pop();
  header(
    canvas,
    canvas.width >= 110
      ? `SCOPE FLAME · ${fileName}`
      : canvas.width >= 70
      ? `SCOPE · ${fileName}`
      : "SCOPE",
    `${scopes.length} SCOPES · ${lineCount} LINES`
  );

  const left = 5;
  const right = canvas.width - 6;
  const chartW = Math.max(20, right - left);
  const footerY = canvas.height - 5;
  const showAxis = canvas.height >= 38;
  const axisY = showAxis ? canvas.height - 12 : null;
  const top = 10;
  const bottom = showAxis ? axisY - 3 : footerY - 3;
  const available = Math.max(6, bottom - top);

  // A 24-row canvas cannot show three 5px-font rows. Collapse the deepest
  // levels instead of silently drawing nothing, and promote the active scope
  // to its nearest visible ancestor so the focus line is never lost.
  const maxDisplayDepth = scopes.reduce((m, n) => Math.max(m, Math.max(0, n.depth - 1)), 0);
  const visibleLevels = Math.min(maxDisplayDepth + 1, Math.max(1, Math.floor(available / 6)));
  const rowH = Math.max(6, Math.min(12, Math.floor(available / Math.max(1, visibleLevels))));
  let activeBar = active;
  while (activeBar && Math.max(0, activeBar.depth - 1) >= visibleLevels) {
    const parent = (parsed.flat ?? []).find((n) => n.id === activeBar.parentId);
    activeBar = parent && parent.kind !== "module" ? parent : null;
  }

  // Line grid at 0/25/50/75/100%. Axis labels are dropped on short canvases
  // where they would collide with the footer.
  for (let i = 0; i <= 4; i++) {
    const x = left + (chartW * i) / 4;
    drawDashedLine(canvas, x, top - 1, bottom, GRAPH_COLORS.grid, 2, 4);
    if (showAxis) {
      drawText(canvas, String(Math.round((lineCount * i) / 4) + 1), x + 1, axisY, GRAPH_COLORS.dim);
    }
  }

  const displayDepth = (node) => Math.max(0, node.depth - 1);
  // Parent links first so bars sit on top.
  for (const node of scopes) {
    if (!node.parentId) continue;
    const depth = displayDepth(node);
    if (depth >= visibleLevels) continue;
    const parent = (parsed.flat ?? []).find((n) => n.id === node.parentId);
    if (!parent || parent.kind === "module") continue;
    const parentDepth = displayDepth(parent);
    if (parentDepth >= visibleLevels) continue;
    const px = left + ((parent.startLine - 1) / lineCount) * chartW;
    const py = top + parentDepth * rowH + rowH - 1;
    const cx = left + ((node.startLine - 1) / lineCount) * chartW;
    const cy = top + depth * rowH;
    drawLine(canvas, px + 2, py, cx + 2, cy, GRAPH_COLORS.grid);
  }

  let drawn = 0;
  for (const node of scopes) {
    const depth = displayDepth(node);
    if (depth >= visibleLevels) continue;
    const x = left + ((node.startLine - 1) / lineCount) * chartW;
    let w = Math.max(10, ((node.endLine - node.startLine + 1) / lineCount) * chartW);
    if (x + w > right) w = right - x;
    if (w < 4) continue;
    const y = top + depth * rowH;
    if (y + rowH > bottom) continue;
    const isActive = activeBar?.id === node.id;
    const fill = node.kind === "class" ? "#123d27" : depth === 0 ? "#0e2a1c" : "#0d2418";
    panel(
      canvas,
      Math.round(x),
      y,
      Math.round(w),
      rowH,
      fill,
      isActive ? GRAPH_COLORS.active : mixColor(GRAPH_COLORS.grid, GRAPH_COLORS.function, 0.25)
    );
    const label = truncateLabel(isActive ? `> ${node.label}` : node.label, w - 2);
    if (label) {
      drawText(
        canvas,
        label,
        Math.round(x) + 1,
        y + Math.max(1, Math.floor((rowH - 5) / 2)),
        isActive ? GRAPH_COLORS.active : node.kind === "class" ? GRAPH_COLORS.class : GRAPH_COLORS.muted
      );
    }
    drawn++;
  }

  const footer = active
    ? `ACTIVE L${active.startLine}-${active.endLine} · ${active.kind} ${active.name}`
    : "NO ACTIVE SCOPE";
  drawText(canvas, ascii(footer).toUpperCase(), 4, footerY, active ? GRAPH_COLORS.text : GRAPH_COLORS.muted);

  return {
    canvas,
    title: "Scope flame",
    legend: [
      { label: "class", color: GRAPH_COLORS.class },
      { label: "function", color: GRAPH_COLORS.function },
      { label: "active line", color: GRAPH_COLORS.active },
    ],
    meta: { scopes: scopes.length, lines: lineCount, drawn },
  };
}

/** Workspace language/file bar chart, built from the real index. */
export function buildWorkspaceGraph(project, { width = 120, height = 44 } = {}) {
  const canvas = createCanvas(width, height, GRAPH_COLORS.bg);
  header(
    canvas,
    `WORKSPACE · ${project?.name ?? "UNKNOWN"}`,
    `${project?.fileCount ?? 0} FILES${project?.branch ? ` · ${project.branch}` : ""}`
  );

  const languages = (project?.languages ?? []).slice(0, 7);
  const max = Math.max(1, ...languages.map((l) => l.files));
  const left = Math.min(16, Math.max(10, Math.floor(canvas.width * 0.22)));
  const right = canvas.width - 8;
  const footerY = canvas.height - 5;
  const top = 12;
  const available = Math.max(5, footerY - top - 2);
  const rowH = Math.max(5, Math.min(7, Math.floor(available / Math.max(1, languages.length))));

  if (languages.length === 0) {
    drawText(canvas, "NO INDEXED SOURCE FILES", 5, top, GRAPH_COLORS.muted);
  }

  languages.forEach((language, index) => {
    const y = top + index * rowH;
    if (y + 4 > footerY - 1) return;
    drawText(canvas, truncateLabel(language.name, Math.max(8, left - 3)), 4, y, GRAPH_COLORS.muted);
    const widthAvail = right - left;
    const bar = Math.max(1, Math.round((language.files / max) * widthAvail));
    fillRect(canvas, left, y, bar, Math.max(2, rowH - 2), mixColor(GRAPH_COLORS.bar, GRAPH_COLORS.accent, index / Math.max(1, languages.length)));
    drawTextRight(canvas, String(language.files), right + 2, y, GRAPH_COLORS.text);
  });

  const testLine = project?.test ? `TESTS · ${project.test.display}` : "TESTS · NONE DETECTED";
  drawText(canvas, ascii(testLine).toUpperCase(), 4, footerY, project?.test ? GRAPH_COLORS.accent : GRAPH_COLORS.warn);
  return {
    canvas,
    title: "Workspace inventory",
    legend: [{ label: "file count", color: GRAPH_COLORS.bar }],
    meta: { languages: languages.length, files: project?.fileCount ?? 0 },
  };
}


/** Token/test telemetry for the active run. Real values only; empty otherwise. */
export function buildTelemetryGraph({
  usage = null,
  metrics = {},
  testResult = null,
  modelName = "LOCAL",
  width = 120,
  height = 44,
} = {}) {
  const canvas = createCanvas(width, height, GRAPH_COLORS.bg);
  header(canvas, canvas.width >= 70 ? "RUN TELEMETRY" : "TELEMETRY", modelName);

  const hasUsage = Boolean(usage && (usage.prompt_tokens || usage.completion_tokens || usage.inputTokens || usage.outputTokens));
  const input = Number(usage?.prompt_tokens ?? usage?.inputTokens ?? 0);
  const output = Number(usage?.completion_tokens ?? usage?.outputTokens ?? 0);
  const cached = Number(usage?.cached_tokens ?? usage?.cachedTokens ?? 0);
  const cost = Number(metrics?.cost ?? usage?.cost ?? 0);
  const elapsed = Number(metrics?.elapsedMs ?? 0);
  const footerY = canvas.height - 6;
  const footer = (left, right) => {
    drawText(canvas, ascii(left).toUpperCase(), 5, footerY, GRAPH_COLORS.muted);
    if (canvas.width >= 84) {
      drawTextRight(canvas, ascii(right).toUpperCase(), canvas.width - 5, footerY, GRAPH_COLORS.muted);
    }
  };

  const compactNum = (value) => {
    const n = Number(value) || 0;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
    return String(n);
  };

  // At 100×30 the pixel canvas is only ~40px tall. Two fixed 24px panels
  // collided with the footer and each other, so use a compact text report
  // unless there is genuinely room for labelled charts.
  const full = canvas.width >= 116 && canvas.height >= 52;
  if (!full) {
    const maxChars = Math.max(6, Math.floor((canvas.width - 10) / 4));
    const lines = [];
    if (!hasUsage) {
      lines.push("NO MODEL USAGE YET");
    } else if (maxChars >= 22) {
      lines.push(`TOKENS ${compactNum(input)} IN · ${compactNum(output)} OUT`);
    } else {
      lines.push(`TOK ${compactNum(input)}/${compactNum(output)}`);
    }
    // Verification is the thing an operator needs most; put it before cache.
    if (testResult?.skipped) {
      lines.push("TESTS SKIPPED");
    } else if (testResult) {
      const passed = Number(testResult.passed ?? 0);
      const failed = Number(testResult.failed ?? 0);
      lines.push(maxChars >= 20 ? `TESTS ${passed} PASS · ${failed} FAIL` : `TEST ${passed}P/${failed}F`);
    } else {
      lines.push("TESTS NOT RUN");
    }
    if (hasUsage && (maxChars >= 13 || canvas.height >= 34)) {
      lines.push(`CACHE ${compactNum(cached)}`);
    }

    let y = 12;
    const bottom = canvas.height - 1;
    for (const line of lines) {
      if (y + 4 > bottom) break;
      drawText(canvas, truncateLabel(line, canvas.width - 10), 5, y, line === "TESTS NOT RUN" || line === "NO MODEL USAGE YET" ? GRAPH_COLORS.muted : GRAPH_COLORS.text);
      y += 6;
    }
    // Never draw the footer over the last summary line on short canvases.
    if (y <= footerY - 1) {
      footer(
        `ROUNDS ${metrics?.rounds ?? 0} · TOOLS ${metrics?.toolCalls ?? 0}`,
        `${formatDuration(elapsed)} · $${cost.toFixed(4)}`
      );
    }

    return {
      canvas,
      title: "Run telemetry",
      legend: [
        { label: "input", color: GRAPH_COLORS.function },
        { label: "output", color: GRAPH_COLORS.accent },
        { label: "cache", color: GRAPH_COLORS.muted },
        { label: "passed", color: GRAPH_COLORS.accent },
        { label: "failed", color: GRAPH_COLORS.error },
      ],
      meta: { usage, elapsed, cost },
    };
  }

  const baseTop = 13;
  const panelW = Math.floor((canvas.width - 16) / 2);
  const panelH = Math.min(31, footerY - baseTop - 2);
  const top = baseTop + Math.max(0, Math.floor((footerY - baseTop - 2 - panelH) / 2));
  const x1 = 5;
  const x2 = 11 + panelW;
  panel(canvas, x1, top, panelW, panelH, GRAPH_COLORS.panel, GRAPH_COLORS.grid);
  panel(canvas, x2, top, panelW, panelH, GRAPH_COLORS.panel, GRAPH_COLORS.grid);

  const barX1 = x1 + 3;
  const barX2 = x2 + 3;
  const barW = panelW - 6;
  const barY = top + 8;
  const barH = 6;
  const labelY = barY + barH + 3;
  const valueY = labelY + 6;
  const passed = Number(testResult?.passed ?? 0);
  const failed = Number(testResult?.failed ?? 0);

  drawText(canvas, "TOKENS", x1 + 3, top + 2, GRAPH_COLORS.accent);
  if (!hasUsage) {
    drawText(canvas, "NO MODEL USAGE YET", x1 + 3, top + 11, GRAPH_COLORS.muted);
  } else {
    const total = Math.max(1, input + output + cached);
    let cursor = barX1;
    for (const [value, color] of [
      [input, GRAPH_COLORS.function],
      [output, GRAPH_COLORS.accent],
      [cached, GRAPH_COLORS.muted],
    ]) {
      let segment = Math.round((value / total) * barW);
      if (value > 0 && segment === 0) segment = 1;
      segment = Math.min(segment, barX1 + barW - cursor);
      if (segment > 0) {
        fillRect(canvas, cursor, barY, segment, barH, color);
        cursor += segment;
      }
    }
    if (cursor < barX1 + barW) fillRect(canvas, cursor, barY, barX1 + barW - cursor, barH, GRAPH_COLORS.dim);
    const colW = Math.floor(barW / 3);
    const columns = [
      ["IN", compactNum(input), GRAPH_COLORS.muted],
      ["OUT", compactNum(output), GRAPH_COLORS.muted],
      ["CACHE", compactNum(cached), GRAPH_COLORS.muted],
    ];
    columns.forEach(([label, value], index) => {
      const x = barX1 + index * colW;
      drawText(canvas, label, x, labelY, GRAPH_COLORS.muted);
      drawTextRight(canvas, value, x + colW - 2, valueY, GRAPH_COLORS.text);
    });
  }

  drawText(canvas, "VERIFICATION", x2 + 3, top + 2, GRAPH_COLORS.accent);
  if (!testResult) {
    drawText(canvas, "NOT RUN YET", x2 + 3, top + 11, GRAPH_COLORS.muted);
  } else if (testResult.skipped) {
    drawText(canvas, "NO TEST RUNNER", x2 + 3, top + 11, GRAPH_COLORS.warn);
  } else {
    const total = Math.max(1, passed + failed);
    const passedW = Math.round((passed / total) * barW);
    fillRect(canvas, barX2, barY, passedW, barH, GRAPH_COLORS.accent);
    fillRect(canvas, barX2 + passedW, barY, barW - passedW, barH, GRAPH_COLORS.error);
    const colW = Math.floor(barW / 2);
    drawText(canvas, "PASS", barX2, labelY, GRAPH_COLORS.muted);
    drawTextRight(canvas, String(passed), barX2 + colW - 2, valueY, GRAPH_COLORS.accent);
    drawText(canvas, "FAIL", barX2 + colW, labelY, GRAPH_COLORS.muted);
    drawTextRight(canvas, String(failed), barX2 + barW, valueY, failed > 0 ? GRAPH_COLORS.error : GRAPH_COLORS.muted);
  }

  footer(
    `ROUNDS ${metrics?.rounds ?? 0} · TOOLS ${metrics?.toolCalls ?? 0}`,
    `${formatDuration(elapsed)} · $${cost.toFixed(4)}`
  );

  return {
    canvas,
    title: "Run telemetry",
    legend: [
      { label: "input", color: GRAPH_COLORS.function },
      { label: "output", color: GRAPH_COLORS.accent },
      { label: "cache", color: GRAPH_COLORS.muted },
      { label: "passed", color: GRAPH_COLORS.accent },
      { label: "failed", color: GRAPH_COLORS.error },
    ],
    meta: { usage, elapsed, cost },
  };
}

/**
 * Build one of the three Vision views. `mode` is scope|workspace|telemetry.
 */
export function buildVision({
  mode = "scope",
  parsed = null,
  file = "file",
  activeLine = 1,
  project = null,
  usage = null,
  metrics = {},
  testResult = null,
  modelName = "LOCAL",
  width = 120,
  height = 44,
}) {
  if (mode === "workspace") return buildWorkspaceGraph(project, { width, height });
  if (mode === "telemetry") {
    return buildTelemetryGraph({ usage, metrics, testResult, modelName, width, height });
  }
  return buildScopeGraph(parsed, { file, width, height, activeLine });
}

/** Text fallback used when no parsed file is available. */
export function emptyVision(width = 120, height = 44, message = "NO FILE TO VISUALISE") {
  const canvas = createCanvas(width, height, GRAPH_COLORS.bg);
  header(canvas, "VISION", "PIXEL CANVAS");
  drawText(canvas, ascii(message).toUpperCase(), 5, Math.floor(height / 2) - 2, GRAPH_COLORS.muted);
  drawText(canvas, "OPEN A FILE OR RUN A TASK TO POPULATE THIS VIEW", 5, Math.floor(height / 2) + 5, GRAPH_COLORS.dim);
  return { canvas, title: "Vision", legend: [], meta: {} };
}

export function graphTextWidth(canvas) {
  return measureText("M", 1);
}
