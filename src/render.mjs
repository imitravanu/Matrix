// ============================================================================
// Headless rendering helpers for `matrix dump`, `smoke`, `bench` and `tour`.
//
// Ink's `renderToString` is synchronous and does not need a TTY. Geometry is
// pinned through MATRIX_COLS/MATRIX_ROWS, the same override the interactive
// frame reads, so a dump and a live terminal share one layout source.
// ============================================================================

import React from "react";
import { renderToString } from "ink";

import { Frame } from "./frame.mjs";
import { ALL_VIEWS, SCREENS } from "./views.mjs";
import { stripAnsi, displayWidth } from "../lib/text.mjs";

const h = React.createElement;

const DEFAULTS = { columns: 100, rows: 30 };

function withLayout(columns, rows, fn) {
  const previousCols = process.env.MATRIX_COLS;
  const previousRows = process.env.MATRIX_ROWS;
  process.env.MATRIX_COLS = String(columns);
  process.env.MATRIX_ROWS = String(rows);
  try {
    return fn();
  } finally {
    if (previousCols === undefined) delete process.env.MATRIX_COLS;
    else process.env.MATRIX_COLS = previousCols;
    if (previousRows === undefined) delete process.env.MATRIX_ROWS;
    else process.env.MATRIX_ROWS = previousRows;
  }
}

/** Render an arbitrary element to ANSI text at an exact terminal geometry. */
export function renderAt(element, { columns = DEFAULTS.columns, rows = DEFAULTS.rows } = {}) {
  return withLayout(columns, rows, () =>
    renderToString(element, { columns: Math.max(20, columns) }),
  );
}

/** Render a single named screen through the shared Frame. */
export function renderScreen(screen, props = {}, size = DEFAULTS) {
  return renderAt(h(Frame, { screen, ...props }), size);
}

/** Render all six primary screens plus the model/help overlays at one geometry. */
export function renderAllScreens(props = {}, size = DEFAULTS) {
  const out = {};
  for (const screen of ALL_VIEWS) out[screen] = renderScreen(screen, props, size);
  return out;
}

/** Plain text lines (ANSI stripped, trailing empty lines preserved). */
export function visible(ansi) {
  return stripAnsi(ansi).split("\n");
}

/** Max display width across a rendered frame. */
export function maxLineWidth(ansi) {
  return visible(ansi).reduce((max, line) => Math.max(max, displayWidth(line)), 0);
}

/**
 * Verify a frame is non-empty and never exceeds `columns - 1` (Ink reserves
 * the last column to avoid wrapping). Returns a structured report.
 */
export function checkFrame(ansi, { columns, rows, minLines = 4 } = {}) {
  const lines = visible(ansi);
  const nonEmpty = lines.filter((line) => line.trim().length > 0).length;
  const width = maxLineWidth(ansi);
  const problems = [];
  if (lines.length < minLines) problems.push(`only ${lines.length} lines`);
  if (nonEmpty < 2) problems.push("frame is effectively empty");
  if (columns && width > columns - 1) problems.push(`line width ${width} > ${columns - 1}`);
  if (rows && lines.length > rows - 1) problems.push(`line count ${lines.length} > ${rows - 1}`);
  return { lines: lines.length, nonEmpty, width, problems, ok: problems.length === 0 };
}

export { SCREENS };
