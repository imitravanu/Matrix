// ============================================================================
// Structural scope parsing (the "AST lens" without a native dependency).
//
// Python is parsed by its indentation contract; JS/TS by a brace matcher that
// runs over a masked copy of the source (comments and string contents blanked
// out, newlines preserved). This is deliberately a *structural* parser, not a
// full grammar: it answers the question the UI asks — "which class/function
// encloses line N, and what are its boundaries?" — for real files.
// ============================================================================

import { basename } from "node:path";

const PYTHON_EXT = new Set([".py", ".pyi", ".pyw"]);
const JS_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"]);

export function detectLanguage(filePath = "") {
  const lower = String(filePath).toLowerCase();
  for (const ext of PYTHON_EXT) if (lower.endsWith(ext)) return "python";
  for (const ext of JS_EXT) if (lower.endsWith(ext)) return "javascript";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rb")) return "ruby";
  return "generic";
}

const toSpaces = (line) => String(line).replace(/\t/g, "    ");
const indentOf = (line) => /^[ ]*/.exec(toSpaces(line))[0].length;
const isBlank = (line) => /^\s*$/.test(line);
const isComment = (line) => /^\s*(#|\/\/|\/\*|\*)/.test(line);

function lineStartsOf(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= index && (mid === starts.length - 1 || starts[mid + 1] > index)) {
      return mid + 1;
    }
    if (starts[mid] > index) hi = mid - 1;
    else lo = mid + 1;
  }
  return starts.length;
}

function makeNode({
  kind,
  name,
  label,
  signature,
  startLine,
  endLine,
  indent,
  language,
  meta = {},
}) {
  return {
    id: "",
    kind,
    name,
    label,
    signature,
    startLine,
    endLine,
    indent,
    language,
    depth: 0,
    parentId: null,
    children: [],
    ...meta,
  };
}

/** Python: indentation defines every boundary. */
function parsePython(source, filePath) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const candidates = [];
  const active = [];
  let decoratorStart = null;
  let lastContentLine = 0;

  const closeAtLastContent = (node) => {
    // Blank lines and comments do not extend a scope. Every active ancestor is
    // known to contain the last significant line, so one shared cursor avoids
    // rescanning the remaining suffix for every declaration.
    node.endLine = Math.max(node.declarationLine, lastContentLine);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (isBlank(trimmed) || isComment(trimmed)) continue;

    const indent = indentOf(raw);
    while (active.length > 0 && active[active.length - 1].indent >= indent) {
      closeAtLastContent(active.pop());
    }

    if (/^@\w/.test(trimmed)) {
      if (decoratorStart === null) decoratorStart = i + 1;
      lastContentLine = i + 1;
      continue;
    }

    const classMatch = /^(?:async\s+)?class\s+([A-Za-z_]\w*)\s*(\([^)]*\))?\s*:/.exec(trimmed);
    const defMatch =
      /^(async\s+def|def)\s+([A-Za-z_]\w*)\s*(\([^)]*\))?\s*(?:->\s*([^:]+))?\s*:/.exec(trimmed);

    if (classMatch || defMatch) {
      const isClass = Boolean(classMatch);
      const name = isClass ? classMatch[1] : defMatch[2];
      const args = isClass ? (classMatch[2] ?? "") : (defMatch[3] ?? "()");
      const kind = isClass ? "class" : "function";
      const prefix = isClass ? `class ${name}` : `def ${name}`;
      const label = isClass ? prefix : `${name}${args.length > 44 ? "(…)" : args}`;
      const signature = trimmed;
      const startLine = decoratorStart ?? i + 1;
      const node = makeNode({
        kind,
        name,
        label,
        signature,
        startLine,
        endLine: i + 1,
        indent,
        language: "python",
        meta: { declarationLine: i + 1, args },
      });
      candidates.push(node);
      active.push(node);
      decoratorStart = null;
    } else {
      decoratorStart = null;
    }
    lastContentLine = i + 1;
  }

  while (active.length > 0) closeAtLastContent(active.pop());

  return { language: "python", lines, roots: buildForest(candidates, lines.length, filePath) };
}

function regexCanStartAt(source, index) {
  let i = index - 1;
  while (i >= 0 && /[ \t]/.test(source[i])) i--;
  if (i < 0) return true;
  const prev = source[i];
  if ("=(,:[!&|?{};+-*%<>~^".includes(prev)) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(source.slice(Math.max(0, i - 12), i + 1));
  if (!word) return false;
  return /^(return|case|typeof|instanceof|in|of|delete|void|throw|yield|await|new)$/.test(word[1]);
}

/** Mask JS comments and string bodies while preserving offsets/newlines. */
function maskJavaScript(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      blank(start, i);
      continue;
    }
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(source.length, i + 2);
      blank(start, i);
      continue;
    }
    if (ch === "/" && next !== "/" && next !== "*" && regexCanStartAt(source, i)) {
      const start = i;
      i++;
      let inClass = false;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) {
          i++;
          while (i < source.length && /[a-z]/i.test(source[i])) i++;
          break;
        } else if (source[i] === "\n") {
          break;
        }
        i++;
      }
      blank(start, i);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const start = i;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      blank(start + 1, Math.max(start + 1, i - 1));
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Match JS braces and parens with independent stacks in one source pass. */
function matchDelimiters(masked) {
  const braces = new Int32Array(masked.length).fill(-1);
  const parens = new Int32Array(masked.length).fill(-1);
  const braceStack = [];
  const parenStack = [];

  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") braceStack.push(i);
    else if (ch === "}" && braceStack.length > 0) braces[braceStack.pop()] = i;
    else if (ch === "(") parenStack.push(i);
    else if (ch === ")" && parenStack.length > 0) parens[parenStack.pop()] = i;
  }

  return { braces, parens };
}

function findMatchingBrace(matches, openIndex) {
  if (openIndex < 0) return -1;
  return matches.braces[openIndex] ?? -1;
}

const JS_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "function",
  "return",
  "do",
  "else",
  "try",
  "finally",
  "new",
  "typeof",
  "instanceof",
  "delete",
  "void",
  "throw",
  "case",
  "default",
  "import",
  "export",
  "class",
  "extends",
  "super",
  "this",
  "yield",
  "await",
  "in",
  "of",
  "as",
  "from",
]);

function findMatchingParen(matches, openIndex) {
  if (openIndex < 0) return -1;
  return matches.parens[openIndex] ?? -1;
}

/** First `{` at paren/bracket/type-argument depth zero, scanning forward. */
function findBodyBrace(masked, matches, from, limit = 1200) {
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  const end = Math.min(masked.length, from + limit);
  for (let i = from; i < end; i++) {
    const ch = masked[i];
    if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "<") angle++;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "{" && paren === 0 && bracket === 0 && angle === 0) {
      const close = findMatchingBrace(matches, i);
      if (close >= 0) {
        // `(): { ok: boolean } {` has an object return type before the body.
        // Skip the type literal when another brace follows it.
        const next = skipSpace(masked, close + 1);
        if (masked[next] === "{") {
          i = close;
          continue;
        }
      }
      return i;
    } else if (ch === ";" && paren === 0 && bracket === 0 && angle === 0) return -1;
  }
  return -1;
}

function skipSpace(masked, from) {
  let i = from;
  while (i < masked.length && /[ \t]/.test(masked[i])) i++;
  return i;
}

function parseJavaScript(source, filePath) {
  const masked = maskJavaScript(source);
  const matches = matchDelimiters(masked);
  const starts = lineStartsOf(source);
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const candidates = [];
  const seen = new Set();

  const add = (declIndex, name, kind, openIndex) => {
    if (openIndex < 0) return;
    const close = findMatchingBrace(matches, openIndex);
    if (close < 0) return;
    const startLine = lineAt(starts, declIndex);
    const endLine = lineAt(starts, close);
    const key = `${startLine}:${endLine}:${kind}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);

    const declaration = lines[startLine - 1] ?? "";
    const signature = declaration.trim();
    const label = kind === "class" ? `class ${name}` : `${name}()`;

    candidates.push(
      makeNode({
        kind,
        name,
        label,
        signature,
        startLine,
        endLine,
        indent: indentOf(declaration),
        language: "javascript",
        meta: { declarationLine: startLine },
      }),
    );
  };

  const declarationStart = (index) => {
    // Pattern matches may begin on the preceding newline; move to first ink.
    let i = index;
    while (i < masked.length && /\s/.test(masked[i])) i++;
    return i;
  };

  // classes ---------------------------------------------------------------
  {
    const re =
      /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
    let match;
    while ((match = re.exec(masked)) !== null) {
      const decl = declarationStart(match.index);
      const open = findBodyBrace(masked, matches, match.index + match[0].length);
      add(decl, match[1], "class", open);
    }
  }

  // named functions -------------------------------------------------------
  {
    const re =
      /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
    let match;
    while ((match = re.exec(masked)) !== null) {
      const decl = declarationStart(match.index);
      const open = findBodyBrace(masked, matches, match.index + match[0].length);
      add(decl, match[1], "function", open);
    }
  }

  // const/let arrow functions and function expressions -------------------
  {
    const re =
      /(?:^|\n)[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*/g;
    let match;
    while ((match = re.exec(masked)) !== null) {
      const decl = declarationStart(match.index);
      let i = skipSpace(masked, match.index + match[0].length);
      if (masked.startsWith("async", i)) i = skipSpace(masked, i + 5);
      if (masked.startsWith("function", i)) continue; // named-function pass owns it

      let afterParams;
      if (masked[i] === "(") {
        const close = findMatchingParen(matches, i);
        if (close < 0) continue;
        afterParams = close + 1;
      } else {
        const id = /^[A-Za-z_$][\w$]*/.exec(masked.slice(i));
        if (!id) continue;
        afterParams = i + id[0].length;
      }
      afterParams = skipSpace(masked, afterParams);
      if (!masked.startsWith("=>", afterParams)) continue;
      const bodyStart = skipSpace(masked, afterParams + 2);
      const open = masked[bodyStart] === "{" ? bodyStart : -1;
      add(decl, match[1], "function", open);
    }
  }

  // class fields / object properties assigned arrow functions ------------
  {
    const re =
      /(?:^|\n)[ \t]+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
    let match;
    while ((match = re.exec(masked)) !== null) {
      const decl = declarationStart(match.index);
      const arrow = masked.indexOf("=>", match.index + match[0].length - 2);
      const bodyStart = skipSpace(masked, arrow + 2);
      const open = masked[bodyStart] === "{" ? bodyStart : -1;
      add(decl, match[1], "function", open);
    }
  }

  // class methods / object shorthand -------------------------------------
  {
    const re = /(?:^|\n)[ \t]+(?:static\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(/g;
    let match;
    while ((match = re.exec(masked)) !== null) {
      const name = match[1];
      if (!name || JS_KEYWORDS.has(name)) continue;
      const decl = declarationStart(match.index);
      const parenOpen = match.index + match[0].lastIndexOf("(");
      const parenClose = findMatchingParen(matches, parenOpen);
      if (parenClose < 0) continue;
      let after = skipSpace(masked, parenClose + 1);
      if (masked[after] === ":") {
        // Return type annotation: allow a simple type then the body brace.
        after = skipSpace(masked, findBodyBrace(masked, matches, after));
      }
      if (masked[after] !== "{") continue;
      add(decl, name, "function", after);
    }
  }

  return { language: "javascript", lines, roots: buildForest(candidates, lines.length, filePath) };
}

function parseGeneric(source, filePath) {
  const masked = maskJavaScript(source);
  const matches = matchDelimiters(masked);
  const starts = lineStartsOf(source);
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const candidates = [];
  const re =
    /(?:^|\n)\s*(?:pub\s+)?(?:export\s+)?(?:class|struct|interface|enum|function|fn|func|def|module)\s+([A-Za-z_$][\w$]*)[^{;\n]*\{/g;
  let match;
  while ((match = re.exec(masked)) !== null) {
    const open = match[0].lastIndexOf("{") + match.index;
    const close = findMatchingBrace(matches, open);
    if (close < 0) continue;
    const startLine = lineAt(starts, match.index);
    const endLine = lineAt(starts, close);
    candidates.push(
      makeNode({
        kind: /class|struct|interface|enum|module/.test(match[0]) ? "class" : "function",
        name: match[1],
        label: match[1],
        signature: (lines[startLine - 1] ?? "").trim(),
        startLine,
        endLine,
        indent: indentOf(lines[startLine - 1] ?? ""),
        language: "generic",
      }),
    );
  }
  return {
    language: detectLanguage(filePath),
    lines,
    roots: buildForest(candidates, lines.length, filePath),
  };
}

function buildForest(candidates, lineCount, filePath) {
  const sorted = [...candidates].sort(
    (a, b) => a.startLine - b.startLine || b.endLine - a.endLine || a.indent - b.indent,
  );

  const roots = [];
  const stack = [];

  for (const node of sorted) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const contains =
        top.startLine <= node.startLine && top.endLine >= node.endLine && top !== node;
      if (contains) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1] ?? null;
    if (parent) {
      parent.children.push(node);
      node.parentId = parent.id || null;
      node.depth = parent.depth + 1;
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  // Assign ids/depths with the synthetic module as the root. Parent links were
  // established by containment above; this pass only serialises the tree.
  const module = makeNode({
    kind: "module",
    name: basename(filePath),
    label: basename(filePath),
    signature: "",
    startLine: 1,
    endLine: Math.max(1, lineCount),
    indent: 0,
    language: "module",
  });
  module.id = "scope-0";
  module.depth = 0;
  module.parentId = null;
  module.children = roots;

  const all = [];
  const pending = [];
  let counter = 1;
  for (let i = roots.length - 1; i >= 0; i--) {
    pending.push({ node: roots[i], parent: module, depth: 1 });
  }
  while (pending.length > 0) {
    const { node, parent, depth } = pending.pop();
    node.id = `scope-${counter++}`;
    node.parentId = parent.id;
    node.depth = depth;
    all.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({ node: node.children[i], parent: node, depth: depth + 1 });
    }
  }

  return [module, ...all];
}

/**
 * Parse a source string. Returns:
 *   { language, lines, flat, roots, module }
 * `flat` includes the synthetic module scope first.
 */
export function parseScopes(source, filePath = "file", { truncated = false } = {}) {
  const text = String(source ?? "");
  const language = detectLanguage(filePath);
  let parsed;
  if (language === "python") parsed = parsePython(text, filePath);
  else if (language === "javascript") parsed = parseJavaScript(text, filePath);
  else parsed = parseGeneric(text, filePath);

  const module = parsed.roots[0];
  const flat = parsed.roots;
  for (const node of flat) {
    node.depth = node.depth ?? 0;
  }

  const result = {
    language: parsed.language,
    lines: parsed.lines,
    flat,
    roots: module?.children ?? [],
    module,
    lineCount: parsed.lines.length,
    truncated: Boolean(truncated),
    partial: Boolean(truncated),
  };
  Object.defineProperty(result, "byId", {
    value: new Map(flat.map((node) => [node.id, node])),
    enumerable: false,
  });
  return result;
}

/** Flatten a parsed scope tree (module included) in document order. */
export function flatten(parsed) {
  return parsed?.flat ?? [];
}

/** Deepest scope containing a 1-based line. */
export function scopeAtLine(parsed, line) {
  if (!parsed) return null;
  let best = parsed.module ?? null;
  for (const node of parsed.flat) {
    if (node.kind === "module") continue;
    if (node.startLine <= line && node.endLine >= line) {
      if (!best || best.kind === "module" || node.depth >= best.depth) best = node;
    }
  }
  return best;
}

/** Ancestor chain, outermost first, including the synthetic module. */
export function chainAtLine(parsed, line) {
  const node = scopeAtLine(parsed, line);
  const chain = [];
  const seen = new Set();
  const byId =
    parsed?.byId instanceof Map
      ? parsed.byId
      : new Map((parsed?.flat ?? []).map((entry) => [entry.id, entry]));
  let current = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.parentId === null ? null : (byId.get(current.parentId) ?? null);
  }
  chain.reverse();
  return chain;
}

/** Render a chain as `file.py › class X › def y()` with a hard width cap. */
export function formatScopeChain(chain, { maxWidth = 120, separator = " › " } = {}) {
  const parts = (chain ?? []).map((n) => n.label).filter(Boolean);
  if (parts.length === 0) return "";
  let out = parts.join(separator);
  if (out.length <= maxWidth) return out;
  // Drop the filename first, then shorten from the left.
  const withoutModule = parts.slice(1).join(separator);
  if (withoutModule.length <= maxWidth) return withoutModule;
  return "…" + withoutModule.slice(-(maxWidth - 1));
}

export function describeScope(node) {
  if (!node) return "";
  if (node.kind === "module") return `module ${node.name}`;
  return `${node.kind} ${node.name} · L${node.startLine}–${node.endLine}`;
}

/** Scope statistics used by the header, swarm and vision screens. */
export function scopeStats(parsed) {
  const real = parsed?.flat?.filter((n) => n.kind !== "module") ?? [];
  const classes = real.filter((n) => n.kind === "class").length;
  const functions = real.filter((n) => n.kind === "function").length;
  const maxDepth = real.reduce((m, n) => Math.max(m, n.depth), 0);
  return { count: real.length, classes, functions, maxDepth, lines: parsed?.lineCount ?? 0 };
}
