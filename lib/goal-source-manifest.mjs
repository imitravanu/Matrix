// ============================================================================
// Bounded source manifest for durable-goal test evidence.
//
// Test evidence only means something when it certifies the exact inputs the
// approved test ran against. The disposable snapshot exposes the whole
// workspace to the approved test, and arbitrary approved test code can open
// any path the snapshot contains: a file in a sibling directory, a path that
// is never named on the command line and that no static import mentions. A
// working-directory selection or an import heuristic therefore cannot
// establish complete coverage. This module resolves the identity from the
// filesystem boundary itself: the whole workspace, using exactly the
// exclusions of the snapshot the test runs in.
//
// For every entry it records the existence, the entry type, the content digest
// of a regular file, the target of a symbolic link and the permission bits
// that decide whether the test can list a directory or execute a file. A
// change to any of those changes the identity, so stale evidence is rejected
// instead of certifying the current bytes.
//
// Every read is bounded, never follows a symbolic link, and never leaves the
// goal workspace. The same rules are applied to the live workspace and to the
// disposable snapshot, so the two can be compared byte for byte.
// ============================================================================

import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson, GOAL_LIMITS } from "./goal-contracts.mjs";
import { hashWorkspacePaths } from "./goal-context.mjs";
import { readWorkspaceFileBounded } from "./goal-operations.mjs";
import {
  OMITTED_DIRECTORIES,
  SENSITIVE_FILES as SENSITIVE_FILES_RULE,
  SENSITIVE_SUFFIX as SENSITIVE_SUFFIX_RULE,
  WORKSPACE_SNAPSHOT_LIMITS,
} from "./linux-snapshot.mjs";

// The budgets are the disposable snapshot's own budgets. Anything the snapshot
// can copy must be hashable, so the identity covers every byte the approved
// test can execute or read. A workspace beyond them is refused instead of
// being certified without its contents.
export const SOURCE_MANIFEST_LIMITS = Object.freeze({
  files: 1024,
  roots: 32,
  rootEntries: WORKSPACE_SNAPSHOT_LIMITS.entries,
  directories: WORKSPACE_SNAPSHOT_LIMITS.directories,
  rootDepth: WORKSPACE_SNAPSHOT_LIMITS.depth,
  rootBytes: WORKSPACE_SNAPSHOT_LIMITS.totalBytes,
  fileBytes: WORKSPACE_SNAPSHOT_LIMITS.fileBytes,
  symlinkBytes: WORKSPACE_SNAPSHOT_LIMITS.symlinkBytes,
});

/**
 * The snapshot's own exclusion rules.
 *
 * The identity must cover what the snapshot exposes and nothing else, so these
 * lists are imported from the snapshot implementation instead of being
 * duplicated here. A host directory the snapshot never copies cannot be read by
 * the test and must not be able to invalidate the evidence.
 *
 * `node_modules` is deliberately not excluded: the snapshot copies installed
 * dependencies and the approved test executes them, so their bytes belong to
 * the identity. Lockfile metadata names versions, not the bytes on disk.
 */
const VENDORED_DIRECTORIES = OMITTED_DIRECTORIES;

/** Files whose names mark them as host secrets; the snapshot never copies them. */
const SENSITIVE_FILES = SENSITIVE_FILES_RULE;
const SENSITIVE_SUFFIX = SENSITIVE_SUFFIX_RULE;

/** The runner configuration that decides what the approved test runs. */
const CONFIGURATION_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

const MODULE_SUFFIXES = Object.freeze([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts"]);

const IMPORT_PATTERNS = Object.freeze([
  /\bimport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]);

/** Shell syntax that is never a plain workspace path. */
const SHELL_SYNTAX = /[<>|;&`$(){}!'"]/;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * A source-identity failure refuses verification. It never degrades into an
 * identity with missing contents.
 */
function manifestFailure(message) {
  const error = new Error(`goal source manifest: ${message}`);
  error.code = "test-inputs-unknown";
  return error;
}

/** A bounded diagnostic that never includes file bytes. */
function boundedFailure(error) {
  const message =
    error && typeof error === "object" ? String(error.message ?? error) : String(error);
  return message.slice(0, 200);
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** The workspace-relative form of an absolute path, or null when it escapes. */
function relativeToRoot(root, absolute) {
  if (!inside(root, absolute)) return null;
  const rel = relative(root, absolute);
  if (rel === "") return null;
  return rel.split(sep).join("/");
}

/**
 * The workspace-relative form of a selection root. The workspace itself is
 * the root "." so that a plan running in the workspace root still selects the
 * whole workspace.
 */
function rootRelative(root, absolute) {
  if (!inside(root, absolute)) return null;
  const rel = relative(root, absolute);
  if (rel === "") return ".";
  return rel.split(sep).join("/");
}

/**
 * The normalized workspace-relative path of one directory entry. A selection
 * root of "." must not produce "./name": that is not a normalized goal path
 * and the bounded reader rejects it.
 */
function childPath(parent, name) {
  return parent === "." ? name : `${parent}/${name}`;
}

/** Split a package script into its plain arguments. */
function tokenizeScript(script) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const character of String(script)) {
    if (quote) {
      if (character === quote) {
        quote = null;
        continue;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Classify one command token: a workspace path, a glob or nothing at all.
 * Flags, shell syntax and package subcommands are never inputs.
 * @param {string} token
 * @returns {"path"|"glob"|null}
 */
export function sourceTokenKind(token) {
  if (typeof token !== "string") return null;
  const text = token.trim();
  if (!text || text.startsWith("-")) return null;
  if (text.includes("=")) return null;
  if (SHELL_SYNTAX.test(text)) return null;
  if (text.includes("...")) return null;
  if (/[*?[\]]/.test(text)) return "glob";
  if (text.includes("/") || text.includes("\\")) return "path";
  if (/\.[A-Za-z0-9]{1,8}$/.test(text)) return "path";
  return null;
}

/** The static directory prefix of a glob token. */
function globDirectory(token) {
  const index = token.search(/[*?[\]]/);
  const head = index === -1 ? token : token.slice(0, index);
  const cut = head.lastIndexOf("/");
  return cut === -1 ? "" : head.slice(0, cut);
}

/**
 * The command tokens the approved plan actually runs: the package script for
 * an npm plan, plus the plan's own argv.
 * @param {{requestedExecutable?: string, script?: string|null, args?: string[]}} descriptor
 */
function planTokens(descriptor) {
  const isNpm = /^(?:npm|npm\.cmd)$/i.test(String(descriptor.requestedExecutable ?? ""));
  const tokens = [];
  if (isNpm) {
    // The package script is the real command; the argv only carries the npm
    // subcommand and the arguments forwarded to that script.
    const script = typeof descriptor.script === "string" ? descriptor.script : "";
    if (script.trim()) tokens.push(...tokenizeScript(script));
    const args = (descriptor.args ?? []).map(String);
    tokens.push(...args.slice(1));
    return tokens;
  }
  for (const argument of descriptor.args ?? []) tokens.push(String(argument));
  return tokens;
}

/**
 * The workspace inputs the approved plan selects: the exact files it names
 * and the directories it chooses from.
 *
 * The runner chooses from its working directory, so that whole directory is
 * always part of the identity. An added or a deleted input inside it must be
 * observed, and a file the runner never sees must not be able to invalidate
 * the evidence.
 * @param {string} root
 * @param {{cwd?: string, args?: string[], script?: string|null}} descriptor
 */
function planSelection(root, descriptor) {
  const files = new Set();
  const roots = new Set();
  const cwd = descriptor.cwd ?? root;
  const cwdRelative = rootRelative(root, cwd);
  if (cwdRelative) roots.add(cwdRelative);
  for (const token of planTokens(descriptor)) {
    const kind = sourceTokenKind(token);
    if (kind === null) continue;
    if (kind === "glob") {
      const directory = join(cwd, globDirectory(token));
      const rel = relativeToRoot(root, directory);
      if (!rel) continue;
      roots.add(rel);
      continue;
    }
    const absolute = resolve(cwd, token);
    const rel = relativeToRoot(root, absolute);
    if (!rel) continue;
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (stat && stat.isDirectory()) {
      roots.add(rel);
      continue;
    }
    files.add(rel);
  }
  return { files: [...files], roots: [...roots] };
}

function isModulePath(rel) {
  return MODULE_SUFFIXES.some((suffix) => rel.endsWith(suffix));
}

/** True when a path exists, without following a symbolic link. */
function pathExists(absolute) {
  try {
    return lstatSync(absolute, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

/** The workspace files one import specifier can resolve to. */
function moduleCandidates(root, fromAbsolute, specifier) {
  const base = resolve(dirname(fromAbsolute), specifier);
  const candidates = [base];
  if (!MODULE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
    for (const suffix of MODULE_SUFFIXES) candidates.push(`${base}${suffix}`);
  }
  for (const suffix of MODULE_SUFFIXES) candidates.push(join(base, `index${suffix}`));
  return candidates.filter((candidate) => inside(root, candidate) && pathExists(candidate));
}

/** The import specifiers of one workspace module. */
function importSpecifiers(text) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      if (match[1]) found.add(match[1]);
      if (found.size > 128) break;
      match = pattern.exec(text);
    }
  }
  return [...found];
}

/**
 * The transitive workspace modules the selected inputs import. The walk already
 * covers these bytes; naming them keeps the evidence readable and binds the
 * approved test's own dependency graph explicitly.
 * @param {string} root
 * @param {string[]} seeds
 * @param {typeof SOURCE_MANIFEST_LIMITS} limits
 */
function importClosure(root, seeds, limits) {
  const resolved = new Set();
  const visited = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (!isModulePath(rel) || visited.has(rel)) continue;
    visited.add(rel);
    let text;
    try {
      const stat = lstatSync(join(root, rel), { throwIfNoEntry: false });
      if (!stat || !stat.isFile() || stat.size > limits.fileBytes) continue;
      // A named input that is not a normalized workspace path has no
      // workspace bytes to inspect; the walk still covers the workspace.
      if (relative(root, join(root, rel)).startsWith(`..${sep}`)) continue;
      const file = readWorkspaceFileBounded(root, rel, limits.fileBytes);
      if (!file.exists) continue;
      text = file.bytes.toString("utf8");
    } catch {
      continue;
    }
    for (const specifier of importSpecifiers(text)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      for (const candidate of moduleCandidates(root, join(root, rel), specifier)) {
        const candidateRel = relativeToRoot(root, candidate);
        if (!candidateRel) continue;
        if (resolved.has(candidateRel)) continue;
        resolved.add(candidateRel);
        queue.push(candidateRel);
      }
    }
  }
  return resolved;
}

/** True when a directory entry never belongs to a goal's source identity. */
function excludedEntry(name, absolute, matrixHome) {
  if (VENDORED_DIRECTORIES.has(name)) return true;
  if (SENSITIVE_FILES.test(name) || SENSITIVE_SUFFIX.test(name)) return true;
  if (matrixHome && inside(matrixHome, absolute)) return true;
  return false;
}

/**
 * Resolve the complete set of workspace inputs one dispatch depends on.
 *
 * The disposable snapshot exposes the whole workspace to the approved test, so
 * the identity covers the whole workspace, using the snapshot's own exclusion
 * rules. The plan, its working directory and the goal's own artifact and edit
 * paths are still named: they are inputs the evidence must always bind, even
 * when an exclusion rule would have skipped them.
 *
 * @param {{
 *   workspaceRoot: string,
 *   plan?: {cwd?: string, args?: string[], script?: string|null}|null,
 *   paths?: string[],
 *   matrixHome?: string|null,
 * }} options
 * @returns {{files: string[], roots: string[], matrixHome: string|null}}
 */
export function resolveGoalSourceManifest({
  workspaceRoot,
  plan = null,
  paths = [],
  matrixHome = null,
}) {
  const root = resolve(workspaceRoot);
  const files = new Set();
  for (const value of paths) {
    if (typeof value !== "string" || value.length === 0) continue;
    files.add(value);
  }
  for (const name of CONFIGURATION_FILES) files.add(name);
  if (plan?.cwd) {
    const rel = relativeToRoot(root, plan.cwd);
    if (rel) files.add(`${rel}/package.json`);
  }
  const selection = planSelection(root, plan ?? {});
  for (const rel of selection.files) files.add(rel);
  for (const rel of importClosure(root, [...files], SOURCE_MANIFEST_LIMITS)) files.add(rel);
  // The workspace itself is the identity boundary: an approved test may open
  // any path the snapshot exposes, including a sibling of its working
  // directory that neither the command line nor a static import names.
  const roots = new Set([".", ...selection.roots]);
  return { files: [...files].sort(), roots: [...roots].sort(), matrixHome };
}

/**
 * The content digest of one workspace file. An input that cannot be read is an
 * unsupported input: verification refuses instead of certifying a null hash.
 */
function fileDigest(root, rel, limits) {
  let file;
  try {
    file = readWorkspaceFileBounded(root, rel, limits.fileBytes);
  } catch (error) {
    throw manifestFailure(
      `the selected input ${rel} could not be hashed: ${boundedFailure(error)}`,
    );
  }
  if (!file.exists || typeof file.sha256 !== "string") {
    throw manifestFailure(`the selected input ${rel} disappeared before it could be hashed`);
  }
  return file.sha256;
}

/**
 * The digest of a symbolic link's target. The link is never followed, so the
 * target bytes are exactly what the snapshot copies; changing the target
 * changes the identity.
 */
function linkDigest(absolute, rel, limits) {
  let target;
  try {
    target = readlinkSync(absolute, { encoding: "buffer" });
  } catch (error) {
    throw manifestFailure(`the symbolic link ${rel} could not be read: ${boundedFailure(error)}`);
  }
  if (target.length === 0 || target.length > limits.symlinkBytes) {
    throw manifestFailure(`the symbolic link ${rel} has an unsupported target`);
  }
  return sha256(target);
}

/**
 * The permission bits of one entry.
 *
 * The snapshot copies a file's and a directory's mode, and the mode decides
 * whether the approved test can execute a file or list a directory. It is part
 * of the identity because the identity must describe what the test could do, not
 * only which names existed.
 */
function entryMode(stat) {
  return (Number(stat.mode) & 0o777).toString(8).padStart(3, "0");
}

/**
 * The named-file state of the manifest. Symbolic links carry their target
 * digest, and with a selection root any named input that cannot be read or
 * hashed refuses verification.
 * @param {string} root
 * @param {Array<*>} files
 * @param {typeof SOURCE_MANIFEST_LIMITS} limits
 * @param {boolean} strict
 */
function namedFileState(root, files, limits, strict) {
  return files.map((file) => {
    if (file.type === "symlink") {
      return { ...file, sha256: linkDigest(join(root, file.path), file.path, limits) };
    }
    if (strict && (file.type === "unreadable" || file.type === "special")) {
      throw manifestFailure(`the named input ${file.path} cannot be read or hashed`);
    }
    return file;
  });
}

/**
 * Walk one selection root with a bounded, no-follow traversal.
 *
 * The listing carries every entry's name, type and permission bits, so an
 * added, a deleted or a chmod-ed entry changes it; every regular file's content
 * digest, so a changed file changes it; and every symbolic link's target
 * digest, so a retargeted link changes it. Every read is bounded and no read
 * follows a link.
 */
function walkRoot(root, absolute, relativePath, depth, entries, matrixHome, limits, budget) {
  if (depth > limits.rootDepth) {
    throw manifestFailure("the selection root is too deep");
  }
  let stat;
  try {
    stat = lstatSync(absolute, { throwIfNoEntry: false });
  } catch (error) {
    throw manifestFailure(
      `the selection root ${relativePath} could not be listed: ${boundedFailure(error)}`,
    );
  }
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    entries.push({
      path: relativePath,
      type: "symlink",
      mode: null,
      sha256: linkDigest(absolute, relativePath, limits),
    });
    return;
  }
  if (stat.isFile()) {
    entries.push({
      path: relativePath,
      type: "file",
      mode: entryMode(stat),
      sha256: fileDigest(root, relativePath, limits),
    });
    return;
  }
  if (!stat.isDirectory()) {
    throw manifestFailure(`the selection root ${relativePath} is not a regular file or directory`);
  }
  budget.directories += 1;
  if (budget.directories > limits.directories) {
    throw manifestFailure("the selection roots contain too many directories");
  }
  entries.push({ path: relativePath, type: "directory", mode: entryMode(stat), sha256: null });
  let directory;
  try {
    directory = opendirSync(absolute);
  } catch (error) {
    throw manifestFailure(
      `the selection root ${relativePath} could not be opened: ${boundedFailure(error)}`,
    );
  }
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      const name = entry.name;
      const childAbsolute = join(absolute, name);
      if (excludedEntry(name, childAbsolute, matrixHome)) continue;
      const childRelative = childPath(relativePath, name);
      if (budget.entries >= limits.rootEntries) {
        throw manifestFailure("the selection roots contain too many entries");
      }
      budget.entries += 1;
      const childStat = lstatSync(childAbsolute, { throwIfNoEntry: false });
      if (!childStat) continue;
      if (childStat.isSymbolicLink()) {
        entries.push({
          path: childRelative,
          type: "symlink",
          mode: null,
          sha256: linkDigest(childAbsolute, childRelative, limits),
        });
        continue;
      }
      if (childStat.isDirectory()) {
        walkRoot(
          root,
          childAbsolute,
          childRelative,
          depth + 1,
          entries,
          matrixHome,
          limits,
          budget,
        );
        continue;
      }
      // Sockets, FIFOs and device nodes are never copied into a snapshot.
      if (!childStat.isFile()) continue;
      if (childStat.size > limits.fileBytes) {
        throw manifestFailure(`the selected input ${childRelative} exceeds the supported size`);
      }
      budget.bytes += childStat.size;
      if (budget.bytes > limits.rootBytes) {
        throw manifestFailure("the selected inputs exceed the supported total size");
      }
      entries.push({
        path: childRelative,
        type: "file",
        mode: entryMode(childStat),
        sha256: fileDigest(root, childRelative, limits),
      });
    }
  } finally {
    directory.close();
  }
}

/** The hashed identity of one selection root. */
function rootEntry(root, rel, matrixHome, limits, budget) {
  const absolute = join(root, rel);
  let stat;
  try {
    stat = lstatSync(absolute, { throwIfNoEntry: false });
  } catch (error) {
    throw manifestFailure(`the selection root ${rel} could not be read: ${boundedFailure(error)}`);
  }
  if (!stat)
    return { path: rel, exists: false, entries: 0, digest: sha256(Buffer.from("", "utf8")) };
  if (budget.entries >= limits.rootEntries) {
    throw manifestFailure("the selection roots contain too many entries");
  }
  budget.entries += 1;
  const entries = [];
  walkRoot(root, absolute, rel, 0, entries, matrixHome, limits, budget);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.type);
    hash.update("\0");
    hash.update(entry.mode ?? "");
    hash.update("\0");
    hash.update(entry.sha256 ?? "");
    hash.update("\n");
  }
  return { path: rel, exists: true, entries: entries.length, digest: hash.digest("hex") };
}

/**
 * Hash a resolved source manifest against one workspace root.
 *
 * The named files always carry their bytes and, for a symbolic link, its
 * target. The selection roots cover every entry the disposable snapshot
 * exposes to the approved test — installed dependencies, data files in sibling
 * directories and every other path the test code can open — together with the
 * permission bits that decide whether it can execute or list them. A change, an
 * addition, a deletion, a permission change or a retargeted link therefore
 * changes the identity. An input that cannot be read is never represented by a
 * null hash: hashing fails and verification refuses.
 *
 * @param {string} workspaceRoot
 * @param {{files?: string[], roots?: string[], matrixHome?: string|null}} manifest
 * @returns {{sha256: string, files: *, roots: *, resolved: {files: string[], roots: string[], matrixHome: string|null}}}
 */
export function hashGoalSourceManifest(workspaceRoot, manifest) {
  const limits = SOURCE_MANIFEST_LIMITS;
  const files = [...new Set(manifest?.files ?? [])].sort();
  const roots = [...new Set(manifest?.roots ?? [])].sort();
  if (files.length > limits.files) {
    throw new Error("goal source manifest: too many named input files");
  }
  if (roots.length > limits.roots) {
    throw new Error("goal source manifest: too many selection roots");
  }
  const fileState = hashWorkspacePaths(workspaceRoot, files, { limit: limits.files });
  const namedFiles = namedFileState(workspaceRoot, fileState.files, limits, roots.length > 0);
  const budget = { entries: 0, bytes: 0, directories: 0 };
  const rootEntries = roots.map((rel) =>
    rootEntry(workspaceRoot, rel, manifest?.matrixHome ?? null, limits, budget),
  );
  const value =
    rootEntries.length === 0
      ? { schemaVersion: 1, files: namedFiles }
      : { schemaVersion: 1, files: namedFiles, roots: rootEntries };
  const bytes = Buffer.from(canonicalJson(value, { maxBytes: GOAL_LIMITS.storeBytes }), "utf8");
  return {
    sha256: sha256(bytes),
    files: namedFiles,
    roots: rootEntries,
    resolved: { files, roots, matrixHome: manifest?.matrixHome ?? null },
  };
}
