// ============================================================================
// Terminal geometry, in one place.
//
// The prototype computed widths inline in three components, each doing its own
// `columns - 2`. That silently lets the header rule, the input rule and the
// panel borders disagree by a column once padding differs. Every screen now
// derives from the single source of truth below, so the frame can never drift.
// ============================================================================

import { useStdout } from "ink";

/** Smallest terminal we bother drawing for at all. */
export const MIN_COLS = 20;
export const MIN_ROWS = 10;

/** Content width between the frame's left/right padding. */
export const FRAME_PAD_X = 1;

/** Fallbacks used when stdout is absent (tests, piped output). */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 30;

const envInt = (name) => {
  const raw = process.env[name] ?? "";
  if (raw.trim() === "") return undefined;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return v;
};

/**
 * Terminal size, overridable via MATRIX_COLS / MATRIX_ROWS.
 *
 * Ink's `useStdout()` is deliberately NOT the source of truth here: under
 * `renderToString` (tests, docs generation) it returns no-op defaults, so
 * trusting it silently laid the frame out at 80 columns regardless of the
 * requested width. Reading the process env first, then the live stdout, and
 * only then the fallback, keeps one source of truth for every screen.
 */
export function terminalSize() {
  const { stdout } = process;
  let liveCols;
  let liveRows;
  try {
    if (typeof stdout?.getWindowSize === "function") {
      const [c, r] = stdout.getWindowSize();
      if (Number.isFinite(c) && c > 0) liveCols = c;
      if (Number.isFinite(r) && r > 0) liveRows = r;
    } else {
      if (Number.isFinite(stdout?.columns) && stdout.columns > 0) liveCols = stdout.columns;
      if (Number.isFinite(stdout?.rows) && stdout.rows > 0) liveRows = stdout.rows;
    }
  } catch {
    // Headless / piped stdout: fall through to env + defaults
  }
  return {
    cols: envInt("MATRIX_COLS") ?? liveCols ?? DEFAULT_COLS,
    rows: envInt("MATRIX_ROWS") ?? liveRows ?? DEFAULT_ROWS,
  };
}

/**
 * All geometry the frame needs, derived once per render.
 * `content` is the usable width inside the frame padding; every rule and
 * border is sized from it, so they always line up.
 */
export function layout({ cols, rows } = terminalSize()) {
  const content = Math.max(MIN_COLS - FRAME_PAD_X, cols - FRAME_PAD_X * 2);
  return {
    cols,
    rows,
    content,
    /** Full frame height, leaving one row so Ink never scrolls. */
    height: Math.max(MIN_ROWS, rows - 1),
    rule: "─".repeat(content),
  };
}

export function screenReaderMode(env = process.env) {
  return ["1", "true"].includes(String(env.INK_SCREEN_READER ?? "").toLowerCase());
}

export function reducedMotion(env = process.env) {
  return (
    screenReaderMode(env) ||
    ["1", "true"].includes(String(env.MATRIX_REDUCED_MOTION ?? "").toLowerCase())
  );
}

/** True when the wordmark is worth drawing; otherwise use the text fallback. */
export const canDrawWordmark = ({ cols, rows }) =>
  process.env.MATRIX_ASCII !== "1" && cols >= 49 && rows >= 16;

/**
 * Reusable hook: current layout.
 *
 * `useStdout` is still called so Ink re-renders us on terminal resize, but its
 * value is only a fallback -- `terminalSize()` is authoritative. This is safe
 * under `renderToString`, where the hook returns `{ stdout: undefined }`.
 */
export function useLayout() {
  const ctx = useStdout();
  const live = ctx?.stdout;
  return layout({
    cols: envInt("MATRIX_COLS") ?? live?.columns ?? DEFAULT_COLS,
    rows: envInt("MATRIX_ROWS") ?? live?.rows ?? DEFAULT_ROWS,
  });
}
