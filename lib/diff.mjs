// ============================================================================
// Real unified-diff engine.
//
// The workbench never *claims* a file changed: an edit is a line-range
// replacement, the proposed diff is generated from the actual before/after
// text, and applying it re-validates every context line before writing.
// ============================================================================

/** @typedef {import("./contracts.mjs").DiffHunk} DiffHunk */

function lineEndingInfo(source) {
  const endings = String(source ?? "").match(/\r\n|\r|\n/g) ?? [];
  return { eol: endings[0] ?? "\n", mixed: new Set(endings).size > 1 };
}

/** Split text into lines while remembering its newline style. */
export function splitLines(text) {
  const source = String(text ?? "");
  const { eol } = lineEndingInfo(source);
  const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

export function joinLines(lines, { eol = "\n", finalNewline = true } = {}) {
  const body = lines.join(eol);
  return finalNewline ? body + eol : body;
}

/** LCS line diff. Reliable, and bounded so one huge file cannot stall the UI. */
export function diffLineArrays(oldLines, newLines) {
  const a = oldLines;
  const b = newLines;
  const n = a.length;
  const m = b.length;

  // Trim the common ends first; real edits are usually local.
  let start = 0;
  while (start < n && start < m && a[start] === b[start]) start++;
  let endA = n - 1;
  let endB = m - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const before = a.slice(0, start).map((text) => ({ type: "ctx", text }));
  const after = a.slice(endA + 1).map((text) => ({ type: "ctx", text }));
  const left = a.slice(start, endA + 1);
  const right = b.slice(start, endB + 1);

  if (left.length === 0 && right.length === 0) return before.concat(after);

  // Coarse fallback for very large rewrites (still a valid unified diff).
  if (left.length * right.length > 4_000_000) {
    const middle = [
      ...left.map((text) => ({ type: "del", text })),
      ...right.map((text) => ({ type: "add", text })),
    ];
    return before.concat(middle, after);
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const middle = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      middle.push({ type: "ctx", text: left[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      middle.push({ type: "del", text: left[i] });
      i++;
    } else {
      middle.push({ type: "add", text: right[j] });
      j++;
    }
  }
  while (i < left.length) middle.push({ type: "del", text: left[i++] });
  while (j < right.length) middle.push({ type: "add", text: right[j++] });

  return before.concat(middle, after);
}

/** @returns {DiffHunk[]} */
function buildHunks(ops, context = 3) {
  const changeIndexes = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "ctx") changeIndexes.push(i);
  }
  if (changeIndexes.length === 0) return [];

  const ranges = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  // Annotate every op with its old/new line number.
  let oldLine = 1;
  let newLine = 1;
  const numbered = ops.map((op) => {
    const row = {
      ...op,
      oldLine: op.type === "add" ? null : oldLine,
      newLine: op.type === "del" ? null : newLine,
    };
    if (op.type !== "add") oldLine++;
    if (op.type !== "del") newLine++;
    return row;
  });

  return ranges.map(({ start, end }) => {
    const rows = numbered.slice(start, end);
    const oldRows = rows.filter((r) => r.type !== "add");
    const newRows = rows.filter((r) => r.type !== "del");
    return {
      oldStart: oldRows[0]?.oldLine ?? Math.max(0, (newRows[0]?.newLine ?? 1) - 1),
      oldLines: oldRows.length,
      newStart: newRows[0]?.newLine ?? Math.max(0, (oldRows[0]?.oldLine ?? 1) - 1),
      newLines: newRows.length,
      rows,
    };
  });
}

/**
 * Generate a real unified diff. Returns "" when the texts are identical.
 * `file` is used only for the optional ---/+++ header (omitted by default).
 */
export function makeUnifiedDiff(originalText, updatedText, { file = null, context = 3 } = {}) {
  const original = String(originalText ?? "");
  const updated = String(updatedText ?? "");
  if (original === updated) return "";
  if (lineEndingInfo(original).mixed || lineEndingInfo(updated).mixed) {
    throw new Error(
      "Mixed line endings are not supported; normalize the file explicitly before editing",
    );
  }

  const oldDoc = splitLines(original);
  const newDoc = splitLines(updated);
  const eolChanged = oldDoc.eol !== newDoc.eol;
  const finalChanged = oldDoc.finalNewline !== newDoc.finalNewline;
  // Encoding changes are whole-file changes. Showing every old/new row makes
  // otherwise invisible line-ending rewrites explicit at the approval gate.
  const ops =
    eolChanged || finalChanged
      ? [
          ...oldDoc.lines.map((text) => ({ type: "del", text })),
          ...newDoc.lines.map((text) => ({ type: "add", text })),
        ]
      : diffLineArrays(oldDoc.lines, newDoc.lines);
  const hunks = buildHunks(ops, context);
  if (hunks.length === 0) return "";

  const out = [];
  if (file) {
    out.push(`--- a/${file}`);
    out.push(`+++ b/${file}`);
  }
  for (const hunk of hunks) {
    if (eolChanged) hunk.eol = newDoc.eol;
    if (finalChanged) {
      hunk.oldFinalNewline = oldDoc.finalNewline;
      hunk.newFinalNewline = newDoc.finalNewline;
    }
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    if (eolChanged)
      out.push(`\\ EOL: ${newDoc.eol === "\r\n" ? "CRLF" : newDoc.eol === "\r" ? "CR" : "LF"}`);
    if (finalChanged) out.push(`\\ Final newline: ${newDoc.finalNewline ? "yes" : "no"}`);
    for (const row of hunk.rows) {
      const prefix = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
      out.push(prefix + row.text);
    }
  }

  return out.join("\n") + "\n";
}

/** Parse a unified diff into hunks with explicit line arrays. */
export function parseUnifiedDiff(text) {
  const lines = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  /** @type {DiffHunk[]} */
  const hunks = [];
  /** @type {DiffHunk|null} */
  let current = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let noNewline = false;
  let previousRowType = null;

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("\\ ")) {
      if (!current) continue;
      const eol = /^\\ EOL: (CRLF|CR|LF)$/.exec(line);
      if (eol) {
        current.eol = eol[1] === "CRLF" ? "\r\n" : eol[1] === "CR" ? "\r" : "\n";
        continue;
      }
      const final = /^\\ Final newline: (yes|no)$/.exec(line);
      if (final) {
        current.newFinalNewline = final[1] === "yes";
        if (!current.newFinalNewline) noNewline = true;
        continue;
      }
      if (line === "\\ No newline at end of file") {
        noNewline = true;
        if (previousRowType === "add") {
          current.newFinalNewline = false;
          current.oldFinalNewline ??= current.oldLines > 0;
        } else {
          current.oldFinalNewline = false;
          current.newFinalNewline ??= current.newLines > 0;
        }
      }
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (current) hunks.push(current);
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        rows: [],
      };
      oldRemaining = current.oldLines;
      newRemaining = current.newLines;
      previousRowType = null;
      continue;
    }
    if (!current) continue;
    if (line === "") continue;
    const kind = line[0];
    const body = line.slice(1);
    if (kind === " ") {
      current.rows.push({ type: "ctx", text: body, oldLine: null, newLine: null });
      oldRemaining--;
      newRemaining--;
    } else if (kind === "-") {
      current.rows.push({ type: "del", text: body, oldLine: null, newLine: null });
      oldRemaining--;
    } else if (kind === "+") {
      current.rows.push({ type: "add", text: body, oldLine: null, newLine: null });
      newRemaining--;
    } else {
      // Unknown prefix: tolerate blank separator lines, reject anything else.
      if (line.trim() !== "") {
        throw new Error(`Malformed diff line: ${JSON.stringify(line.slice(0, 80))}`);
      }
    }
    if (kind === " " || kind === "-" || kind === "+") {
      previousRowType = kind === "+" ? "add" : kind === "-" ? "del" : "ctx";
    }
    if (oldRemaining < 0 || newRemaining < 0) {
      throw new Error("Malformed diff: hunk counts exceeded");
    }
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) throw new Error("No diff hunks found");

  for (const hunk of hunks) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const row of hunk.rows) {
      if (row.type !== "add") row.oldLine = oldLine++;
      if (row.type !== "del") row.newLine = newLine++;
    }
  }

  return { hunks, noNewline };
}

/**
 * Apply hunks to text with strict context validation. On any mismatch the
 * original text is left untouched and an explicit error is returned.
 */
export function applyHunks(originalText, hunks) {
  if (lineEndingInfo(originalText).mixed) {
    return {
      ok: false,
      error:
        "Mixed line endings are not supported; normalize the file explicitly before applying a patch",
    };
  }
  const doc = splitLines(originalText);
  const lines = doc.lines;
  const updates = [];
  let previousEnd = -1;

  for (const [hi, hunk] of hunks.entries()) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < 0 || start > lines.length) {
      return {
        ok: false,
        error: `Hunk ${hi + 1}: start line ${hunk.oldStart} is outside the file`,
      };
    }
    if (start < previousEnd)
      return { ok: false, error: `Hunk ${hi + 1}: hunks overlap or are out of order` };

    let cursor = start;
    const replacement = [];
    for (const row of hunk.rows) {
      if (row.type === "ctx" || row.type === "del") {
        const actual = lines[cursor];
        if (actual !== row.text) {
          return {
            ok: false,
            error: `Hunk ${hi + 1}: context mismatch at line ${cursor + 1}\n  expected: ${JSON.stringify(row.text)}\n  actual:   ${JSON.stringify(actual)}`,
          };
        }
        if (row.type === "ctx") replacement.push(row.text);
        cursor++;
      } else {
        replacement.push(row.text);
      }
    }

    updates.push({ start, end: cursor, replacement });
    previousEnd = cursor;
  }

  // Apply back-to-front so earlier line numbers stay valid.
  updates.sort((a, b) => b.start - a.start);
  for (const update of updates) {
    lines.splice(update.start, update.end - update.start, ...update.replacement);
  }

  const eol = hunks.find((hunk) => hunk.eol)?.eol ?? doc.eol;
  const finalHunk = [...hunks].reverse().find((hunk) => typeof hunk.newFinalNewline === "boolean");
  return {
    ok: true,
    text: joinLines(lines, {
      eol,
      finalNewline: finalHunk ? finalHunk.newFinalNewline : doc.finalNewline,
    }),
    lines,
  };
}

export function applyUnifiedDiff(originalText, patchText) {
  try {
    const { hunks } = parseUnifiedDiff(patchText);
    return applyHunks(originalText, hunks);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * A line-range edit. `startLine` is 1-based inclusive, `endLine` is exclusive
 * (so replacing line 19 is {startLine:19, endLine:20}); an insertion uses
 * startLine === endLine.
 */
export function normalizeEdit(edit) {
  const startLine = Math.max(1, Math.floor(Number(edit.startLine)));
  const endLine = Math.max(startLine, Math.floor(Number(edit.endLine ?? startLine)));
  let replacement = edit.replacement ?? "";
  if (Array.isArray(replacement)) replacement = replacement.join("\n");
  replacement = String(replacement).replace(/\r\n?/g, "\n");
  const replacementLines = replacement === "" ? [] : replacement.split("\n");
  if (replacementLines.length > 0 && replacement.endsWith("\n")) replacementLines.pop();
  return {
    startLine,
    endLine,
    replacementLines,
    reason: edit.reason ?? "",
    ...(edit.label ? { label: edit.label } : {}),
  };
}

export function applyEdits(originalText, edits) {
  if (lineEndingInfo(originalText).mixed) {
    return {
      ok: false,
      error: "Mixed line endings are not supported; normalize the file explicitly before editing",
    };
  }
  const doc = splitLines(originalText);
  for (const [index, edit] of edits.entries()) {
    const start = Number(edit.startLine);
    const end = Number(edit.endLine ?? start);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return {
        ok: false,
        error: `Edit ${index + 1}: startLine and endLine must be finite numbers`,
      };
    }
  }
  const normalized = edits.map(normalizeEdit);
  const sorted = [...normalized].sort((a, b) => b.startLine - a.startLine);

  let previousStart = Infinity;
  for (const edit of sorted) {
    if (edit.endLine > doc.lines.length + 1 || edit.startLine > doc.lines.length + 1) {
      return {
        ok: false,
        error: `Edit range ${edit.startLine}-${edit.endLine} is outside the file (${doc.lines.length} lines)`,
      };
    }
    if (edit.endLine > previousStart) {
      return { ok: false, error: "Overlapping edits are not allowed" };
    }
    previousStart = edit.startLine;
  }

  const lines = [...doc.lines];
  for (const edit of sorted) {
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine, ...edit.replacementLines);
  }

  return {
    ok: true,
    text: joinLines(lines, { eol: doc.eol, finalNewline: doc.finalNewline }),
    edits: normalized,
    lines,
  };
}

/** Build {updatedText, patch, stats} from explicit edits. */
export function proposeEdits(originalText, edits, { file = null, context = 3 } = {}) {
  const applied = applyEdits(originalText, edits);
  if (!applied.ok) return applied;
  const patch = makeUnifiedDiff(originalText, applied.text, { file, context });
  return {
    ok: true,
    updatedText: applied.text,
    patch,
    edits: applied.edits,
    stats: diffStatsFromText(patch),
  };
}

export function diffStatsFromText(patchText) {
  let adds = 0;
  let dels = 0;
  let inHunk = false;
  for (const line of String(patchText ?? "").split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk && (/^--- a\//.test(line) || /^\+\+\+ b\//.test(line))) continue;
    if (line.startsWith("+")) adds++;
    else if (line.startsWith("-")) dels++;
  }
  return { adds, dels, changed: adds + dels };
}

/** Counts from hunk rows (used by the UI). */
export function hunkStats(hunks = []) {
  let adds = 0;
  let dels = 0;
  let context = 0;
  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      if (row.type === "add") adds++;
      else if (row.type === "del") dels++;
      else context++;
    }
  }
  return { adds, dels, context };
}
