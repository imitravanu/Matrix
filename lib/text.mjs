// ============================================================================
// Text primitives.
//
// Terminal layout is width, not length. A single emoji or CJK glyph in a
// user prompt must not push a border out by one column, so every padding,
// truncation and wrap decision in the UI goes through this module.
// ============================================================================

/** Remove CSI/OSC/kitty/DEC sequences. Used before measuring anything. */
export function stripAnsi(input) {
  let s = String(input ?? "");
  // Terminal sanitization deliberately matches ANSI escape/control bytes.
  /* eslint-disable no-control-regex */
  s = s.replace(/\x1b_G[\s\S]*?\x1b\\/g, "");
  s = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  s = s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  s = s.replace(/\x1b[()][AB0]/g, "");
  /* eslint-enable no-control-regex */
  s = s.replace(/\r/g, "");
  return s;
}

/** Zero-width: combining marks, joiners, variation selectors. */
function isZeroWidth(cp) {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060
  );
}

/** Double-width: CJK, Hangul, fullwidth forms, emoji. */
function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Columns occupied by one code point (0, 1 or 2). */
export function codePointWidth(cp) {
  if (cp === 0) return 0;
  if (isZeroWidth(cp)) return 0;
  if (isWide(cp)) return 2;
  return 1;
}

/** Columns occupied by one user-perceived char (basic grapheme handling). */
export function charWidth(char) {
  const cps = [...String(char ?? "")].map((c) => c.codePointAt(0));
  if (cps.length === 0) return 0;
  // A ZWJ sequence (emoji family, etc.) keeps the width of its first glyph.
  return Math.max(...cps.map(codePointWidth));
}

/** Visible width of a string, ignoring ANSI and accounting for wide glyphs. */
export function displayWidth(input) {
  const s = stripAnsi(input);
  let width = 0;
  for (const char of [...s]) width += charWidth(char);
  return width;
}

/**
 * Truncate to at most `width` columns. Never splits a wide glyph in half.
 * Adds `ellipsis` only when something was actually removed and it fits.
 */
export function truncateToWidth(input, width, ellipsis = "…") {
  const s = stripAnsi(input);
  const max = Math.max(0, Math.floor(width));
  if (displayWidth(s) <= max) return s;
  const ell = displayWidth(ellipsis) <= max ? ellipsis : "";
  const target = max - displayWidth(ell);
  let out = "";
  let used = 0;
  for (const char of [...s]) {
    const w = charWidth(char);
    if (used + w > target) break;
    out += char;
    used += w;
  }
  return out + ell;
}

/** Pad with spaces to exactly `width` columns, truncating if needed. */
export function padToWidth(input, width, align = "left") {
  const max = Math.max(0, Math.floor(width));
  let s = truncateToWidth(input, max, "");
  const missing = Math.max(0, max - displayWidth(s));
  if (align === "right") return " ".repeat(missing) + s;
  if (align === "center") {
    const left = Math.floor(missing / 2);
    return " ".repeat(left) + s + " ".repeat(missing - left);
  }
  return s + " ".repeat(missing);
}

/**
 * Wrap a plain string to `width` columns.
 * - Explicit newlines are preserved.
 * - Blank lines are preserved (paragraph spacing in thought cards).
 * - Leading indentation of each source line is preserved on continuation.
 * - Long unbreakable tokens are hard-split so borders cannot overflow.
 */
export function wrapToWidth(input, width) {
  const max = Math.max(1, Math.floor(width));
  const source = String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];

  for (const raw of source) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    const indentMatch = /^[ \t]*/.exec(raw);
    const indent = (indentMatch?.[0] ?? "").replace(/\t/g, "    ");
    const indentW = displayWidth(indent);
    const body = raw.slice(indentMatch?.[0]?.length ?? 0);
    if (displayWidth(body) <= max) {
      out.push(raw.replace(/\t/g, "    "));
      continue;
    }

    const contIndent = indentW + 8 <= max ? indent : "";
    const available = Math.max(1, max - displayWidth(contIndent));
    const words = body.split(/(\s+)/);
    let line = "";
    let used = 0;
    let first = true;

    const push = () => {
      const prefix = first ? indent : contIndent;
      out.push((prefix + line).replace(/\s+$/, ""));
      first = false;
      line = "";
      used = 0;
    };

    for (const token of words) {
      if (!token) continue;
      const isSpace = /^\s+$/.test(token);
      const tokenW = displayWidth(token);
      const currentMax = first ? available : Math.max(1, max - displayWidth(contIndent));

      if (isSpace) {
        if (used > 0 && used + 1 < currentMax) {
          line += " ";
          used += 1;
        }
        continue;
      }

      if (used + tokenW <= currentMax) {
        line += token;
        used += tokenW;
        continue;
      }

      if (used > 0) push();

      if (tokenW <= currentMax) {
        line = token;
        used = tokenW;
        continue;
      }

      // Hard split an unbreakable token (URL, minified code, long identifier).
      let chunk = "";
      let chunkW = 0;
      for (const char of [...token]) {
        const w = charWidth(char);
        if (chunkW + w > currentMax && chunkW > 0) {
          line = chunk;
          push();
          chunk = "";
          chunkW = 0;
        }
        chunk += char;
        chunkW += w;
      }
      line = chunk;
      used = chunkW;
    }

    if (line.length > 0 || first) push();
  }

  return out;
}

/**
 * Hard-wrap code without changing whitespace or dropping content. Unlike
 * wrapToWidth, this preserves repeated/trailing spaces and never word-wraps.
 * Tabs are expanded to four spaces so terminal cells stay deterministic.
 */
export function wrapCodeToWidth(input, width) {
  const max = Math.max(2, Math.floor(Number(width) || 2));
  const source = stripAnsi(String(input ?? ""))
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  for (const raw of source) {
    const expanded = raw.replace(/\t/g, "    ");
    if (expanded.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const char of expanded) {
      const width = charWidth(char);
      if (lineWidth > 0 && lineWidth + width > max) {
        out.push(line);
        line = "";
        lineWidth = 0;
      }
      line += char;
      lineWidth += width;
    }
    out.push(line);
  }
  return out;
}

/** Strip control characters that would corrupt a frame, keeping \n and \t. */
export function sanitizeText(input) {
  // Frame sanitization deliberately removes terminal control bytes.
  // eslint-disable-next-line no-control-regex
  return String(input ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** Collapse newlines/whitespace for a one-line header. */
export function oneLine(input, max = Infinity) {
  const s = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return Number.isFinite(max) ? truncateToWidth(s, max) : s;
}

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)}s`;
  }
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
