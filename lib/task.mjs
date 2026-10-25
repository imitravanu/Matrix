// ============================================================================
// Task understanding for the offline operator.
//
// This is intentionally small and honest: it recognises intents it can act on
// deterministically (off-by-one slice fixes, renames, test runs, repository
// questions) and refuses to invent an edit when it cannot ground one.
// ============================================================================

import { fileMentionedIn, findFile } from "./project.mjs";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "from",
  "by",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "as",
  "into",
  "about",
  "please",
  "can",
  "could",
  "would",
  "should",
  "you",
  "your",
  "we",
  "our",
  "i",
  "me",
  "my",
  "fix",
  "fixes",
  "fixed",
  "bug",
  "issue",
  "error",
  "problem",
  "code",
  "file",
  "function",
  "method",
  "class",
  "project",
  "repo",
  "repository",
  "run",
  "runs",
  "make",
  "add",
  "update",
  "change",
  "find",
  "locate",
  "show",
  "what",
  "where",
  "how",
  "why",
  "explain",
  "analyze",
  "analyse",
  "there",
  "here",
  "something",
  "thing",
  "need",
  "want",
  "help",
  "using",
  "use",
]);

export function extractKeywords(task, { limit = 10 } = {}) {
  const words = String(task ?? "")
    .toLowerCase()
    .replace(/[`"'(){}[\],;:!?]/g, " ")
    .split(/[\s/]+/)
    .map((word) => word.replace(/^[._-]+|[._-]+$/g, ""))
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word));

  const seen = new Set();
  const out = [];
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

export function classifyTask(task) {
  const text = String(task ?? "").trim();
  const lower = text.toLowerCase();

  const rename =
    /rename\s+[`"']?([A-Za-z_$][\w$]*)[`"']?\s+(?:to|->|as)\s+[`"']?([A-Za-z_$][\w$]*)/i.exec(text);
  if (rename) {
    return { intent: "rename", from: rename[1], to: rename[2], text };
  }

  if (
    /^(?:\/test|test|run tests?|run the tests?|pytest|npm test)\b/i.test(text) ||
    /\b(?:run|execute)\s+(?:the\s+)?(?:test|tests|suite|pytest)\b/i.test(text)
  ) {
    return { intent: "test", text };
  }

  if (
    /\b(?:fix|repair|resolve|patch|correct|off[- ]by[- ]one|out[- ]of[- ]bounds)\b/i.test(lower)
  ) {
    return { intent: "fix", text };
  }

  return { intent: "explain", text };
}

function findMatchingChar(text, openIndex, openChar, closeChar) {
  if (text[openIndex] !== openChar) return -1;
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(text, separator) {
  const parts = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "{") brace++;
    else if (ch === "}") brace = Math.max(0, brace - 1);
    else if (ch === separator && paren === 0 && bracket === 0 && brace === 0) {
      parts.push({ value: text.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  parts.push({ value: text.slice(start), start, end: text.length });
  return parts;
}

/**
 * Blank string and comment contents while preserving every byte offset. Slice
 * detection then only sees executable code, and the returned replacement is
 * rebuilt from the original line so surrounding literals are never touched.
 */
function maskNonCode(source, language = null) {
  const text = String(source ?? "");
  const out = text.split("");
  const python = language === "python";
  const javascript = language === "javascript" || language === "typescript";
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (!python && ch === "/" && next === "/") {
      let end = text.indexOf("\n", i + 2);
      if (end < 0) end = text.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (!python && ch === "/" && next === "*") {
      let end = text.indexOf("*/", i + 2);
      end = end < 0 ? text.length : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if ((python || (!javascript && language === null)) && ch === "#") {
      let end = text.indexOf("\n", i + 1);
      if (end < 0) end = text.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const marker = ch.repeat(3);
      if (text.startsWith(marker, i)) {
        let end = text.indexOf(marker, i + 3);
        end = end < 0 ? text.length : end + 3;
        blank(i, end);
        i = end;
        continue;
      }
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === ch) {
          end++;
          break;
        }
        if (python && text[end] === "\n") break;
        end++;
      }
      blank(i, end);
      i = end;
      continue;
    }
    if (!python && ch === "`") {
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === "`") {
          end++;
          break;
        }
        end++;
      }
      blank(i, end);
      i = end;
      continue;
    }
    i++;
  }
  return out.join("");
}

function replaceLenMinusOne(text) {
  const leading = /^\s*/.exec(text)?.[0].length ?? 0;
  if (!text.startsWith("len", leading)) return null;
  let i = leading + 3;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "(") return null;
  const close = findMatchingChar(text, i, "(", ")");
  if (close < 0) return null;
  const tail = text.slice(close + 1);
  if (!/^\s*-\s*1\s*$/.test(tail)) return null;
  return text.slice(0, close + 1) + tail.replace(/^\s*-\s*1\s*$/, "");
}

function replaceLengthMinusOne(text) {
  const match = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:length|size))\s*-\s*1\s*$/.exec(
    text,
  );
  if (!match) return null;
  return text.replace(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:length|size))\s*-\s*1/, "$1");
}

function findPythonSliceFix(line, end, outputLine = line) {
  for (let i = 0; i < end; i++) {
    if (line[i] !== "[") continue;
    const close = findMatchingChar(line, i, "[", "]");
    if (close < 0 || close > end) break;
    const content = line.slice(i + 1, close);
    const parts = splitTopLevel(content, ":");
    if (parts.length >= 2) {
      const replacement = replaceLenMinusOne(parts[1].value);
      if (replacement !== null) {
        const rawContent = outputLine.slice(i + 1, close);
        const nextContent =
          rawContent.slice(0, parts[1].start) + replacement + rawContent.slice(parts[1].end);
        return {
          index: i,
          after: `${outputLine.slice(0, i + 1)}${nextContent}${outputLine.slice(close)}`,
          reason: "slice upper bound uses len(x) - 1, excluding the last element",
        };
      }
    }
    i = close;
  }
  return null;
}

function findJavaScriptSliceFix(line, end, outputLine = line) {
  const re = /\.(?:slice|subarray|substring|substr)\s*\(/g;
  let match;
  while ((match = re.exec(line)) !== null) {
    if (match.index >= end) break;
    const open = match.index + match[0].length - 1;
    const close = findMatchingChar(line, open, "(", ")");
    if (close < 0 || close > end) break;
    const inner = line.slice(open + 1, close);
    const args = splitTopLevel(inner, ",");
    if (args.length >= 2) {
      const replacement = replaceLengthMinusOne(args[1].value);
      if (replacement !== null) {
        const rawInner = outputLine.slice(open + 1, close);
        const nextInner =
          rawInner.slice(0, args[1].start) + replacement + rawInner.slice(args[1].end);
        return {
          index: match.index,
          after: `${outputLine.slice(0, open + 1)}${nextInner}${outputLine.slice(close)}`,
          reason: args[1].value.includes(".size")
            ? "slice upper bound uses .size - 1, excluding the last element"
            : "slice upper bound uses .length - 1, excluding the last element",
        };
      }
    }
    re.lastIndex = open + 1;
  }
  return null;
}

/**
 * Find real slice expressions that exclude the final element. This deliberately
 * does not match ordinary indexing such as `items[items.length - 1]`: that is a
 * valid last-element read, not an off-by-one slice.
 */
export function findSliceOffByOne(content, { language = null } = {}) {
  const source = String(content ?? "");
  const lines = source.split("\n");
  const maskedLines = maskNonCode(source, language).split("\n");
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const masked = maskedLines[i] ?? "";
    const end = masked.length;
    const python = findPythonSliceFix(masked, end, line);
    const javascript = findJavaScriptSliceFix(masked, end, line);
    const fix =
      python && javascript
        ? python.index <= javascript.index
          ? python
          : javascript
        : (python ?? javascript);

    if (fix) {
      found.push({
        line: i + 1,
        before: line,
        after: fix.after,
        reason: fix.reason,
        indentation: /^\s*/.exec(line)?.[0] ?? "",
      });
    }
  }

  return found;
}

/** All whole-word occurrences of an identifier. */
export function findIdentifier(content, identifier) {
  const escaped = String(identifier).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "g");
  const lines = String(content ?? "").split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(lines[i])) !== null) {
      hits.push({ line: i + 1, column: match.index + 1, text: lines[i] });
      if (match[0].length === 0) re.lastIndex++;
    }
  }
  return hits;
}

/** Pick the file a task is talking about, without pretending to be certain. */
export function targetFileForTask(task, project) {
  const mentioned = fileMentionedIn(task, project);
  if (mentioned)
    return { file: mentioned, confidence: "explicit", reason: "path mentioned in the request" };

  const keywords = extractKeywords(task);
  for (const keyword of keywords) {
    const file = findFile(project, keyword);
    if (file && file.language !== "markdown") {
      return { file, confidence: "name", reason: `filename matched "${keyword}"` };
    }
  }
  return { file: null, confidence: "none", reason: "no target file found" };
}

/**
 * A grounded one-paragraph answer for repository questions. No invented facts:
 * every path and line in the answer was returned by a real search.
 */
export function buildGroundedAnswer({ task, project, matches, file = null, reading = null }) {
  const keywords = extractKeywords(task);
  const lines = [];
  lines.push(
    `Workspace: ${project.name}${project.branch ? ` · ⎇ ${project.branch}` : ""} · ${project.fileCount} indexed files`,
  );
  if (project.test) lines.push(`Detected runner: ${project.test.display}`);
  if (project.languages.length > 0) {
    lines.push(
      `Languages: ${project.languages
        .slice(0, 4)
        .map((lang) => `${lang.name} (${lang.files})`)
        .join(" · ")}`,
    );
  }

  if (keywords.length > 0) {
    lines.push("");
    lines.push(`Search: ${keywords.map((k) => `"${k}"`).join(", ")}`);
  }

  if (matches.length > 0) {
    lines.push(
      ...matches.slice(0, 10).map((m) => `  ${m.rel}:${m.line}  ${m.text.trim().slice(0, 120)}`),
    );
    if (matches.length > 10) lines.push(`  … ${matches.length - 10} more`);
  } else {
    lines.push("");
    lines.push("No matching source lines found.");
  }

  if (file) {
    lines.push("");
    lines.push(`Nearest target: ${file.rel}`);
    if (reading?.scopeChain) lines.push(`Scope: ${reading.scopeChain}`);
  }

  lines.push("");
  lines.push(
    "No files were modified. I can only propose an edit when I can ground it in the repository; ask for a specific fix, or switch to a model for open-ended synthesis.",
  );

  return lines.join("\n");
}
