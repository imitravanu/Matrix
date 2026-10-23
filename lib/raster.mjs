// ============================================================================
// A tiny real raster engine for the Vision screen.
//
// No canvas package, no image dependency: an RGBA byte buffer, a 3x5 pixel
// font, Bresenham lines, half-block truecolor output, and a real PNG encoder
// (zlib + CRC32). The same pixels feed the terminal and an exported .png, so
// what you see is actually what was rendered.
// ============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";

// 3x5 glyphs. Lowercase is rendered as uppercase: a pixel font at this size
// needs every column it can get. Spacing is one pixel between glyphs.
const FONT = {
  " ": ["   ", "   ", "   ", "   ", "   "],
  A: ["###", "# #", "###", "# #", "# #"],
  B: ["## ", "# #", "## ", "# #", "## "],
  C: ["###", "#  ", "#  ", "#  ", "###"],
  D: ["## ", "# #", "# #", "# #", "## "],
  E: ["###", "#  ", "## ", "#  ", "###"],
  F: ["###", "#  ", "## ", "#  ", "#  "],
  G: ["###", "#  ", "# #", "# #", "###"],
  H: ["# #", "# #", "###", "# #", "# #"],
  I: ["###", " # ", " # ", " # ", "###"],
  J: ["  #", "  #", "  #", "# #", "###"],
  K: ["# #", "# #", "## ", "# #", "# #"],
  L: ["#  ", "#  ", "#  ", "#  ", "###"],
  M: ["# #", "###", "###", "# #", "# #"],
  N: ["# #", "## ", "###", " ##", "# #"],
  O: ["###", "# #", "# #", "# #", "###"],
  P: ["###", "# #", "###", "#  ", "#  "],
  Q: ["###", "# #", "# #", "###", "  #"],
  R: ["###", "# #", "###", "# #", "# #"],
  S: ["###", "#  ", "###", "  #", "###"],
  T: ["###", " # ", " # ", " # ", " # "],
  U: ["# #", "# #", "# #", "# #", "###"],
  V: ["# #", "# #", "# #", "# #", " # "],
  W: ["# #", "# #", "###", "###", "# #"],
  X: ["# #", "# #", " # ", "# #", "# #"],
  Y: ["# #", "# #", " # ", " # ", " # "],
  Z: ["###", "  #", " # ", "#  ", "###"],
  0: ["###", "# #", "# #", "# #", "###"],
  1: [" # ", "## ", " # ", " # ", "###"],
  2: ["###", "  #", "###", "#  ", "###"],
  3: ["###", "  #", "###", "  #", "###"],
  4: ["# #", "# #", "###", "  #", "  #"],
  5: ["###", "#  ", "###", "  #", "###"],
  6: ["###", "#  ", "###", "# #", "###"],
  7: ["###", "  #", " # ", " # ", " # "],
  8: ["###", "# #", "###", "# #", "###"],
  9: ["###", "# #", "###", "  #", "###"],
  _: ["   ", "   ", "   ", "   ", "###"],
  "-": ["   ", "   ", "###", "   ", "   "],
  ".": ["   ", "   ", "   ", "   ", " # "],
  ",": ["   ", "   ", "   ", " # ", "#  "],
  ":": ["   ", " # ", "   ", " # ", "   "],
  ";": ["   ", " # ", "   ", " # ", "#  "],
  "/": ["  #", "  #", " # ", "#  ", "#  "],
  "\\": ["#  ", "#  ", " # ", "  #", "  #"],
  "(": [" # ", "#  ", "#  ", "#  ", " # "],
  ")": [" # ", "  #", "  #", "  #", " # "],
  "[": ["## ", "#  ", "#  ", "#  ", "## "],
  "]": [" ##", "  #", "  #", "  #", " ##"],
  "{": [" # ", "#  ", " # ", "#  ", " # "],
  "}": [" # ", "  #", " # ", "  #", " # "],
  "<": ["  #", " # ", "#  ", " # ", "  #"],
  ">": ["#  ", " # ", "  #", " # ", "#  "],
  "+": ["   ", " # ", "###", " # ", "   "],
  "=": ["   ", "###", "   ", "###", "   "],
  "*": ["# #", " # ", "# #", "   ", "   "],
  "%": ["# #", "  #", " # ", "#  ", "# #"],
  "#": ["# #", "###", "# #", "###", "# #"],
  "!": [" # ", " # ", " # ", "   ", " # "],
  "?": ["###", "  #", " ##", "   ", " # "],
  "'": [" # ", " # ", "   ", "   ", "   "],
  '"': ["# #", "# #", "   ", "   ", "   "],
  "|": [" # ", " # ", " # ", " # ", " # "],
  "&": ["## ", "## ", "###", "# #", "###"],
  "$": ["###", "## ", "###", " ##", "###"],
  "@": ["###", "# #", "###", "#  ", "###"],
  "^": [" # ", "# #", "   ", "   ", "   "],
  "~": ["   ", " ##", "# #", "   ", "   "],
  "`": ["#  ", " # ", "   ", "   ", "   "],
};

const COLOR_CACHE = new Map();

export function parseColor(input) {
  if (Array.isArray(input)) {
    const [r = 0, g = 0, b = 0, a = 255] = input;
    return [r, g, b, a];
  }
  if (typeof input !== "string") return [0, 0, 0, 255];
  const key = input.trim().toLowerCase();
  if (COLOR_CACHE.has(key)) return COLOR_CACHE.get(key);
  let out = [0, 0, 0, 255];
  if (key === "transparent" || key === "none") out = [0, 0, 0, 0];
  else if (/^#[0-9a-f]{3}$/.test(key)) {
    out = [
      parseInt(key[1] + key[1], 16),
      parseInt(key[2] + key[2], 16),
      parseInt(key[3] + key[3], 16),
      255,
    ];
  } else if (/^#[0-9a-f]{6}$/.test(key)) {
    out = [
      parseInt(key.slice(1, 3), 16),
      parseInt(key.slice(3, 5), 16),
      parseInt(key.slice(5, 7), 16),
      255,
    ];
  } else if (/^#[0-9a-f]{8}$/.test(key)) {
    out = [
      parseInt(key.slice(1, 3), 16),
      parseInt(key.slice(3, 5), 16),
      parseInt(key.slice(5, 7), 16),
      parseInt(key.slice(7, 9), 16),
    ];
  }
  COLOR_CACHE.set(key, out);
  return out;
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

export function mixColor(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex(
    ca[0] + (cb[0] - ca[0]) * k,
    ca[1] + (cb[1] - ca[1]) * k,
    ca[2] + (cb[2] - ca[2]) * k
  );
}

export function createCanvas(width, height, background = "#0b0c0e") {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const canvas = {
    width: w,
    height: h,
    background,
    data: new Uint8ClampedArray(w * h * 4),
  };
  fillRect(canvas, 0, 0, w, h, background);
  return canvas;
}

function indexFor(canvas, x, y) {
  return (y * canvas.width + x) * 4;
}

export function getPixel(canvas, x, y) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return [0, 0, 0, 0];
  const i = indexFor(canvas, x, y);
  return [canvas.data[i], canvas.data[i + 1], canvas.data[i + 2], canvas.data[i + 3]];
}

export function setPixel(canvas, x, y, color) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return;
  const [r, g, b, a] = parseColor(color);
  const i = indexFor(canvas, px, py);
  if (a >= 255) {
    canvas.data[i] = r;
    canvas.data[i + 1] = g;
    canvas.data[i + 2] = b;
    canvas.data[i + 3] = 255;
    return;
  }
  if (a <= 0) return;
  const alpha = a / 255;
  canvas.data[i] = canvas.data[i] * (1 - alpha) + r * alpha;
  canvas.data[i + 1] = canvas.data[i + 1] * (1 - alpha) + g * alpha;
  canvas.data[i + 2] = canvas.data[i + 2] * (1 - alpha) + b * alpha;
  canvas.data[i + 3] = Math.max(canvas.data[i + 3], a);
}

export function fillRect(canvas, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(canvas.width, Math.round(x + w));
  const y1 = Math.min(canvas.height, Math.round(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) setPixel(canvas, px, py, color);
  }
}

export function strokeRect(canvas, x, y, w, h, color) {
  if (w <= 0 || h <= 0) return;
  drawLine(canvas, x, y, x + w - 1, y, color);
  drawLine(canvas, x, y + h - 1, x + w - 1, y + h - 1, color);
  drawLine(canvas, x, y, x, y + h - 1, color);
  drawLine(canvas, x + w - 1, y, x + w - 1, y + h - 1, color);
}

export function drawLine(canvas, x0, y0, x1, y1, color) {
  let xa = Math.round(x0);
  let ya = Math.round(y0);
  const xb = Math.round(x1);
  const yb = Math.round(y1);
  const dx = Math.abs(xb - xa);
  const dy = -Math.abs(yb - ya);
  const sx = xa < xb ? 1 : -1;
  const sy = ya < yb ? 1 : -1;
  let err = dx + dy;
  while (true) {
    setPixel(canvas, xa, ya, color);
    if (xa === xb && ya === yb) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      xa += sx;
    }
    if (e2 <= dx) {
      err += dx;
      ya += sy;
    }
  }
}

export function drawDashedLine(canvas, x0, y0, x1, y1, color, dash = 3, gap = 3) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    if (Math.floor(i / dash) % 2 === 1) continue;
    const t = steps === 0 ? 0 : i / steps;
    setPixel(canvas, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, color);
  }
}

export function measureText(text, scale = 1) {
  const clean = String(text ?? "");
  return clean.length === 0 ? 0 : (clean.length * 4 - 1) * scale;
}

export function drawText(canvas, text, x, y, color, { scale = 1, maxWidth = Infinity } = {}) {
  const source = String(text ?? "").replace(/\t/g, "    ");
  let cursor = Math.round(x);
  const top = Math.round(y);
  const step = 4 * scale;
  for (const raw of [...source]) {
    if (cursor + 3 * scale > x + maxWidth) break;
    const char = raw.toUpperCase();
    const glyph = FONT[char] ?? FONT[raw] ?? FONT["?"];
    for (let gy = 0; gy < 5; gy++) {
      const row = glyph[gy];
      for (let gx = 0; gx < 3; gx++) {
        if (row[gx] !== "#") continue;
        const px = cursor + gx * scale;
        const py = top + gy * scale;
        if (scale === 1) setPixel(canvas, px, py, color);
        else fillRect(canvas, px, py, scale, scale, color);
      }
    }
    cursor += step;
  }
  return cursor - x;
}

export function drawTextCentered(canvas, text, centerX, y, color, options = {}) {
  const width = measureText(text, options.scale ?? 1);
  return drawText(canvas, text, centerX - width / 2, y, color, options);
}

export function drawTextRight(canvas, text, rightX, y, color, options = {}) {
  const width = measureText(text, options.scale ?? 1);
  return drawText(canvas, text, rightX - width, y, color, options);
}

/** Alpha-blended filled vertical bar, used by charts. */
export function fillColumn(canvas, x, y, w, h, color) {
  fillRect(canvas, x, y, w, h, color);
}

export const HALF_BLOCK = { TOP: "▀", BOTTOM: "▄", FULL: "█", EMPTY: " " };

/**
 * Convert a raster to grouped half-block runs.
 * returns rows: Array<Array<{text, fg, bg}>>
 */
export function halfBlockRuns(canvas, { background = canvas.background } = {}) {
  const bg = parseColor(background);
  const bgKey = rgbToHex(bg[0], bg[1], bg[2]);
  const rows = [];
  for (let y = 0; y < canvas.height; y += 2) {
    const runs = [];
    let current = null;
    for (let x = 0; x < canvas.width; x++) {
      const top = getPixel(canvas, x, y);
      const bottom = y + 1 < canvas.height ? getPixel(canvas, x, y + 1) : bg;
      const topKey = rgbToHex(top[0], top[1], top[2]);
      const bottomKey = rgbToHex(bottom[0], bottom[1], bottom[2]);
      const topBg = topKey === bgKey || top[3] === 0;
      const bottomBg = bottomKey === bgKey || bottom[3] === 0;

      let char = HALF_BLOCK.EMPTY;
      let fg = null;
      let bgColor = null;
      if (topBg && bottomBg) {
        char = HALF_BLOCK.EMPTY;
      } else if (topBg) {
        char = HALF_BLOCK.BOTTOM;
        fg = bottomKey;
      } else if (bottomBg) {
        char = HALF_BLOCK.TOP;
        fg = topKey;
      } else if (topKey === bottomKey) {
        char = HALF_BLOCK.FULL;
        fg = topKey;
      } else {
        char = HALF_BLOCK.TOP;
        fg = topKey;
        bgColor = bottomKey;
      }

      if (current && current.fg === fg && current.bg === bgColor) {
        current.text += char;
      } else {
        if (current) runs.push(current);
        current = { text: char, fg, bg: bgColor };
      }
    }
    if (current) runs.push(current);
    rows.push(runs);
  }
  return rows;
}

export function halfBlockText(canvas) {
  return halfBlockRuns(canvas)
    .map((row) => row.map((run) => run.text).join(""))
    .join("\n");
}

/** ANSI truecolor dump, used by `matrix --vision` and render tests. */
export function halfBlockAnsi(canvas) {
  const lines = [];
  for (const row of halfBlockRuns(canvas)) {
    let line = "";
    for (const run of row) {
      if (!run.fg && !run.bg) {
        line += run.text;
        continue;
      }
      const codes = [];
      if (run.fg) {
        const [r, g, b] = parseColor(run.fg);
        codes.push(`38;2;${r};${g};${b}`);
      }
      if (run.bg) {
        const [r, g, b] = parseColor(run.bg);
        codes.push(`48;2;${r};${g};${b}`);
      }
      line += `\x1b[${codes.join(";")}m${run.text}\x1b[0m`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// PNG encoding
// --------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Encode an RGBA canvas as a valid PNG. Returns a Buffer.
 */
export function encodePNG(canvas) {
  const width = canvas.width;
  const height = canvas.height;
  const stride = width * 4;

  // Raw scanlines: filter byte 0 followed by RGBA.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (stride + 1) + 1 + x * 4;
      raw[di] = canvas.data[si];
      raw[di + 1] = canvas.data[si + 1];
      raw[di + 2] = canvas.data[si + 2];
      raw[di + 3] = canvas.data[si + 3];
    }
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writePng(canvas, path) {
  const buffer = encodePNG(canvas);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, buffer);
  return { path, bytes: buffer.length, width: canvas.width, height: canvas.height };
}

/** ASCII fallback for monochrome terminals, preserving the canvas layout. */
export function toAscii(canvas, { width = canvas.width } = {}) {
  const ramp = " .:-=+*#%@";
  const stepX = canvas.width / width;
  const rows = [];
  for (let y = 0; y < canvas.height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = getPixel(canvas, Math.floor(x * stepX), y);
      const bottom = getPixel(canvas, Math.floor(x * stepX), Math.min(canvas.height - 1, y + 1));
      const lum = (0.2126 * Math.max(top[0], bottom[0]) + 0.7152 * Math.max(top[1], bottom[1]) + 0.0722 * Math.max(top[2], bottom[2])) / 255;
      line += ramp[Math.min(ramp.length - 1, Math.floor(lum * (ramp.length - 1)))];
    }
    rows.push(line);
  }
  return rows.join("\n");
}
