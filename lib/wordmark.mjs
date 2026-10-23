// ============================================================================
// Wordmark: a 47x10 pixel grid rendered through half-block glyphs.
//
// Layout of the grid:
//   rows 0..3   the "t" ascender (x=23..24) plus the ember above the "i" (x=37..38)
//   rows 4..9   the word "matrix" at x-height
//
// Each terminal row in the output is built from TWO pixel rows, so the 10
// source rows become 5 terminal rows:
//   both set -> "█"    top only -> "▀"    bottom only -> "▄"    neither -> " "
// A cell whose two halves differ in colour uses "▀" with foreground = top
// pixel and background = bottom pixel, which is how the ember gradient
// survives a two-colour seam.
//
// Geometry note: the ember (the dot of the "i") sits at x=37..38, y=1..2,
// directly above the "i" stem (also x=37..38), with row 3 left empty as a
// deliberate gap so it reads as a tittle rather than a broken ascender.
// The "t" ascender is at x=23..24 running through rows 0..8, curving at row 9.
// Both relationships are pinned by adjacency assertions in test/wordmark.test.mjs.
// ============================================================================

import { forge, heatColor } from "./forge.mjs";

/** First row of the letter band. Above it: the ember and the "t" ascender. */
export const LETTER_TOP = 4;

/**
 * The ember: the 2x2 tittle of the "i", centred on its stem column
 * (x=37..38). One blank row (y=3) of daylight above the letter band keeps
 * it reading as a tittle, not a broken ascender.
 */
export const SPARK_X = [37, 38];
export const SPARK_Y = [1, 2];

/**
 * Matrix Wordmark bitmap.
 * Rows 0..3 carry the "t" ascender at x=23..24 plus the ember at x=37..38, y=1..2.
 * Rows 4..9 carry the lowercase letter band: m, a, t, r, i, x.
 */
export const WORDMARK = [
  ".......................##......................", // t ascender
  ".......................##............##........", // t ascender + ember
  ".......................##............##........", // t ascender + ember
  ".......................##......................", // t ascender
  "#####.#####...####...######..#####...##..##..##",
  "###########......##....##....######..##..##..##",
  "##..##..##....#####....##....##..##..##...####.",
  "##..##..##...##..##....##....##......##....##..",
  "##..##..##...##..##....##....##......##...####.",
  "##..##..##....#####.....###..##......##..##..##",
];

/** Grid width is derived from the data, never hardcoded. */
export const WIDTH = Math.max(...WORDMARK.map((r) => r.length));
export const HEIGHT = WORDMARK.length;

/** Terminal rows produced by the half-block packing. */
export const OUT_ROWS = Math.ceil(HEIGHT / 2);

const isSpark = (x, y) => SPARK_X.includes(x) && SPARK_Y.includes(y);

// --- animation timing -------------------------------------------------------

/** Spark centre, in grid coords. The reveal radiates from here. */
const SPARK_CX = 37.5;
const SPARK_CY = 1.5;

const SPARK_DELAY = 250; // ms before the grid starts lighting up
const SPARK_FLASH_END = 80; // ember flashes white, then dims
const SPARK_FLASH = forge.spark.flash;
const COOL_MS = 700; // ms to cool from white-hot to resting steel
const INTRO_MS = 1800; // full intro duration before the wordmark rests

/**
 * The first ms at which the whole mark shows its resting colours. Equal to
 * the intro duration: the farthest pixel finishes cooling at ~1.71s, well
 * inside the window, and the driver clears its timer on the first tick
 * past INTRO_MS.
 */
export const REST_TIME = INTRO_MS;

/** ms after which each pixel arrives: radiating out from the ember. */
export const arrival = (x, y) => SPARK_DELAY + 20 * Math.hypot(x - SPARK_CX, y - SPARK_CY);

/** Heat at time t: 1 = white-hot, 0 = cooled to steel. */
export const heatAt = (t, x, y) => Math.max(0, 1 - (t - arrival(x, y)) / COOL_MS);

/** True once the intro has fully settled, so callers can skip animating. */
export const isSettled = (t) => t >= INTRO_MS;

/**
 * Colour of a single pixel at time t, or null when the cell is empty or has
 * not arrived yet. Returns "#RRGGBB" or null -- never anything else.
 */
export function getPixelColor(t, x, y) {
  const row = WORDMARK[y];
  if (!row || x < 0 || x >= WIDTH) return null;
  if (row[x] !== "#") return null;

  if (isSpark(x, y)) {
    if (t < SPARK_FLASH_END) return null;
    if (t < SPARK_DELAY) return SPARK_FLASH.toLowerCase();
    return (x === SPARK_X[0] && y === SPARK_Y[0] ? forge.spark.core : forge.accent).toLowerCase();
  }

  if (t < arrival(x, y)) return null;
  return heatColor(heatAt(t, x, y));
}

/**
 * The whole wordmark as an array (one entry per terminal row) of style runs:
 *   [{ text: "▀▀█▄ ", fg: "#RRGGBB"|null, bg: "#RRGGBB"|null }, ...]
 * Adjacent cells with identical fg+bg are merged so Ink emits as few Text
 * nodes as possible. Pure -- same (t) always yields the same output.
 */
export function renderWordmarkRuns(t) {
  const rows = [];
  for (let r = 0; r < OUT_ROWS; r++) {
    const yTop = r * 2;
    const yBottom = yTop + 1;
    const cells = [];
    for (let x = 0; x < WIDTH; x++) {
      const top = getPixelColor(t, x, yTop);
      const bottom = yBottom < HEIGHT ? getPixelColor(t, x, yBottom) : null;
      if (!top && !bottom) cells.push({ ch: " ", fg: null, bg: null });
      else if (top && !bottom) cells.push({ ch: "▀", fg: top, bg: null });
      else if (!top && bottom) cells.push({ ch: "▄", fg: bottom, bg: null });
      else if (top === bottom) cells.push({ ch: "█", fg: top, bg: null });
      else cells.push({ ch: "▀", fg: top, bg: bottom });
    }
    rows.push(groupRuns(cells));
  }
  return rows;
}

/** Merge a row of styled cells into runs of identical fg+bg. */
function groupRuns(cells) {
  const runs = [];
  let cur = null;
  for (const c of cells) {
    if (cur && cur.fg === c.fg && cur.bg === c.bg) cur.text += c.ch;
    else {
      if (cur) runs.push(cur);
      cur = { fg: c.fg, bg: c.bg, text: c.ch };
    }
  }
  if (cur) runs.push(cur);
  return runs;
}

/** Flatten rendered rows to plain strings. Handy for tests and --dump. */
export function renderWordmarkText(t) {
  return renderWordmarkRuns(t).map((runs) => runs.map((r) => r.text).join(""));
}

/** Grid occupancy helper, exported for the geometry tests. */
export const pixelAt = (x, y) => (WORDMARK[y] ? WORDMARK[y][x] === "#" : false);
