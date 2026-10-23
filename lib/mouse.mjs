// ============================================================================
// Terminal Mouse & Trackpad Parser (SGR 1006 standard)
//
// Converts raw ANSI SGR mouse sequences into structured wheel and pointer
// events, filtering raw mouse telemetry so it never leaks into the prompt.
// ============================================================================

/**
 * Parse SGR 1006 mouse input sequences:
 *   \x1b[<button;col;row[M|m] or [<button;col;row[M|m]
 *
 * @param {string} input - Raw input chunk from stdin
 * @returns {{ direction: "up"|"down"|null, col: number, row: number, button: number, isWheel: boolean, isRelease: boolean }|null}
 */
export function parseTerminalMouse(input) {
  if (!input || typeof input !== "string") return null;
  const match = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!match) return null;

  const button = Number(match[1]);
  const col = Number(match[2]);
  const row = Number(match[3]);

  if (!Number.isSafeInteger(button) || !Number.isSafeInteger(col) || !Number.isSafeInteger(row)) {
    return { direction: null, col: 0, row: 0, button: -1, isWheel: false, isRelease: false };
  }

  // Mask out modifiers: Shift (4), Meta (8), Ctrl (16)
  const unmodified = button & ~(4 | 8 | 16);

  if (unmodified === 64) {
    return { direction: "up", col, row, button: unmodified, isWheel: true, isRelease: false };
  }
  if (unmodified === 65) {
    return { direction: "down", col, row, button: unmodified, isWheel: true, isRelease: false };
  }

  return {
    direction: null,
    col,
    row,
    button: unmodified,
    isWheel: false,
    isRelease: match[4] === "m",
  };
}

/** Check if an incoming stdin chunk is an SGR mouse escape sequence. */
export function isMouseSequence(input) {
  return Boolean(parseTerminalMouse(input));
}
