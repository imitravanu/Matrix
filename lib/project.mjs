// ============================================================================
// Project intelligence: what repository are we actually standing in?
//
// Everything the workbench claims to know about the workspace is derived here:
// the git branch, the file inventory, the dominant languages and the test
// command. No hard-coded paths, no invented file counts.
// ============================================================================

import { execFile, execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  lstat as lstatAsync,
  open as openAsync,
  opendir as opendirAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "dist",
  "build",
  "out",
  "coverage",
  ".nyc_output",
  "target",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".idea",
  ".vscode",
  ".DS_Store",
]);

const LANGUAGE_BY_EXT = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".lua": "lua",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".sql": "sql",
  ".md": "markdown",
  ".mdx": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".html": "html",
  ".css": "css",
  ".scss": "css",
  ".vue": "vue",
  ".svelte": "svelte",
};

const BINARY_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".xz",
  ".7z",
  ".mp3",
  ".mp4",
  ".mov",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".sqlite",
  ".db",
  ".pyc",
  ".class",
]);

const MAX_READ_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const DEFAULT_SEARCH_MAX_FILES = 400;
const DEFAULT_SEARCH_MAX_BYTES = 16 * 1024 * 1024;
const MAX_CACHED_READ_BYTES = 128 * 1024;
const MAX_PROJECT_CACHE_ENTRIES = 64;
const MAX_PROJECT_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROJECT_SNAPSHOT_MS = 1000;
const MAX_PROJECT_SNAPSHOT_MS = 60_000;
const MAX_PROJECT_SNAPSHOTS = 16;
const MAX_MANIFEST_CACHE_ENTRIES = 64;
const PROJECT_READ_CACHES = new WeakMap();
const PROJECT_SNAPSHOTS = new Map();
const PROJECT_IN_FLIGHT = new Map();
const PROJECT_GENERATIONS = new Map();
const MANIFEST_CACHE = new Map();
const CACHE_HOOK_IDS = new WeakMap();
let manifestCacheBytes = 0;
let nextCacheHookId = 1;

// Process-local counters make work visible without putting timers or scans in
// render components. Current map sizes are added by getProjectScanMetrics().
const PROJECT_METRICS = {
  requests: 0,
  refreshRequests: 0,
  scansStarted: 0,
  scansCompleted: 0,
  scansFailed: 0,
  cacheHits: 0,
  cacheMisses: 0,
  inFlightHits: 0,
  queuedRequests: 0,
  invalidations: 0,
  snapshotsInvalidated: 0,
  snapshotExpirations: 0,
  snapshotEvictions: 0,
  entriesSeen: 0,
  directoriesSeen: 0,
  filesSeen: 0,
  gitCalls: 0,
  manifestReads: 0,
  manifestCacheHits: 0,
  manifestCacheMisses: 0,
  manifestCacheEvictions: 0,
  readCacheHits: 0,
  readCacheMisses: 0,
  readCacheEvictions: 0,
};

/** Cumulative scan/cache work plus current bounded cache and request counts. */
export function getProjectScanMetrics() {
  return {
    ...PROJECT_METRICS,
    snapshots: PROJECT_SNAPSHOTS.size,
    inFlight: PROJECT_IN_FLIGHT.size,
    manifestSnapshots: MANIFEST_CACHE.size,
    manifestBytes: manifestCacheBytes,
  };
}

function readCache(project) {
  if ((typeof project !== "object" && typeof project !== "function") || project === null)
    return null;
  let cache = PROJECT_READ_CACHES.get(project);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    PROJECT_READ_CACHES.set(project, cache);
  }
  return cache;
}

function sameFileIdentity(stat, read) {
  return (
    read.size === stat.size &&
    read.mtimeMs === stat.mtimeMs &&
    read.ctimeMs === stat.ctimeMs &&
    read.dev === stat.dev &&
    read.ino === stat.ino
  );
}

function cachedRead(cache, key, stat) {
  if (!cache) return null;
  const cached = cache.entries.get(key);
  if (!cached) {
    PROJECT_METRICS.readCacheMisses++;
    return null;
  }
  if (!sameFileIdentity(stat, cached)) {
    cache.bytes -= Buffer.byteLength(cached.content);
    cache.entries.delete(key);
    PROJECT_METRICS.readCacheMisses++;
    PROJECT_METRICS.readCacheEvictions++;
    return null;
  }
  PROJECT_METRICS.readCacheHits++;
  // Refresh LRU position without trusting the index's potentially stale stat.
  cache.entries.delete(key);
  cache.entries.set(key, cached);
  return cached;
}

function storeCachedRead(cache, key, read) {
  if (!cache || !read.ok) return;
  const bytes = Buffer.byteLength(read.content);
  if (bytes > MAX_CACHED_READ_BYTES) return;
  const previous = cache.entries.get(key);
  if (previous) cache.bytes -= Buffer.byteLength(previous.content);
  cache.entries.delete(key);
  while (
    cache.entries.size >= MAX_PROJECT_CACHE_ENTRIES ||
    cache.bytes + bytes > MAX_PROJECT_CACHE_BYTES
  ) {
    const oldestKey = cache.entries.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = cache.entries.get(oldestKey);
    cache.bytes -= Buffer.byteLength(oldest.content);
    cache.entries.delete(oldestKey);
    PROJECT_METRICS.readCacheEvictions++;
  }
  cache.entries.set(key, read);
  cache.bytes += bytes;
}

function readDirectoryEntries(path, limit) {
  const handle = opendirSync(path);
  const entries = [];
  try {
    while (entries.length < limit) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return entries;
}

export function languageForPath(path) {
  return LANGUAGE_BY_EXT[extname(path).toLowerCase()] ?? "text";
}

export function isBinaryPath(path) {
  return BINARY_EXT.has(extname(path).toLowerCase());
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function safeRealpathAsync(path) {
  try {
    return await realpathAsync(path);
  } catch {
    return resolve(path);
  }
}

/** Bounded, deterministic directory walk. Never follows symlinks. */
export function walkFiles(root, options = {}) {
  const {
    maxFiles = 2500,
    maxDepth = 10,
    maxBytes = 2 * 1024 * 1024,
    maxDirectories = 5000,
    maxEntries = 50_000,
    ignore = IGNORED_DIRS,
  } = options;

  const base = resolve(root);
  const files = [];
  let truncated = false;
  let scanIncomplete = false;
  let dirsSeen = 0;
  let entriesSeen = 0;

  const stack = [{ dir: base, depth: 0 }];

  while (stack.length > 0) {
    if (dirsSeen >= maxDirectories || entriesSeen >= maxEntries) {
      truncated = true;
      scanIncomplete = true;
      break;
    }
    const { dir, depth } = stack.pop();
    dirsSeen++;
    const remaining = Math.max(0, maxEntries - entriesSeen);

    let entries;
    try {
      // Read at most one extra entry to prove truncation without materializing
      // an entire huge directory or continuing after the work budget.
      entries = readDirectoryEntries(dir, remaining + 1);
    } catch {
      continue;
    }
    const count = Math.min(entries.length, remaining);
    const overflow = entries.length > count;
    entriesSeen += count;
    entries = entries.slice(0, count);

    // Stable alphabetical order keeps tests and screenshots reproducible.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (ignore.has(entry.name)) continue;

      const full = join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }

      // lstat (not stat) keeps symlinks out of the inventory entirely. A link
      // inside the workspace can otherwise point a read or write outside it.
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > maxBytes) continue;

      if (files.length >= maxFiles) {
        truncated = true;
        continue;
      }

      files.push({
        path: full,
        rel: relative(base, full).split("\\").join("/"),
        name: entry.name,
        size: stat.size,
        ext: extname(entry.name).toLowerCase(),
        language: languageForPath(entry.name),
        mtimeMs: stat.mtimeMs,
      });
    }
    if (overflow) {
      truncated = true;
      scanIncomplete = true;
      break;
    }
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, truncated, dirsSeen, entriesSeen, scanIncomplete };
}

async function readDirectoryEntriesAsync(path, limit) {
  const handle = await opendirAsync(path);
  const entries = [];
  try {
    while (entries.length < limit) {
      const entry = await handle.read();
      if (!entry) break;
      entries.push(entry);
    }
  } finally {
    await handle.close();
  }
  return entries;
}

/**
 * Yielding counterpart to walkFiles for event-driven consumers. It uses the
 * same deterministic budgets and never follows symlinks. Entries are still
 * processed serially so asynchronous I/O cannot amplify the work budget.
 */
export async function walkFilesAsync(root, options = {}) {
  const {
    maxFiles = 2500,
    maxDepth = 10,
    maxBytes = 2 * 1024 * 1024,
    maxDirectories = 5000,
    maxEntries = 50_000,
    ignore = IGNORED_DIRS,
  } = options;

  const base = resolve(root);
  const files = [];
  let truncated = false;
  let scanIncomplete = false;
  let dirsSeen = 0;
  let entriesSeen = 0;
  const stack = [{ dir: base, depth: 0 }];

  while (stack.length > 0) {
    if (dirsSeen >= maxDirectories || entriesSeen >= maxEntries) {
      truncated = true;
      scanIncomplete = true;
      break;
    }
    const { dir, depth } = stack.pop();
    dirsSeen++;
    const remaining = Math.max(0, maxEntries - entriesSeen);

    let entries;
    try {
      entries = await readDirectoryEntriesAsync(dir, remaining + 1);
    } catch {
      continue;
    }
    const count = Math.min(entries.length, remaining);
    const overflow = entries.length > count;
    entriesSeen += count;
    entries = entries.slice(0, count);
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      if (ignore.has(entry.name)) continue;

      const full = join(dir, entry.name);
      let stat;
      try {
        stat = await lstatAsync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth + 1 <= maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > maxBytes) continue;

      if (files.length >= maxFiles) {
        truncated = true;
        continue;
      }
      files.push({
        path: full,
        rel: relative(base, full).split("\\").join("/"),
        name: entry.name,
        size: stat.size,
        ext: extname(entry.name).toLowerCase(),
        language: languageForPath(entry.name),
        mtimeMs: stat.mtimeMs,
      });
    }
    if (overflow) {
      truncated = true;
      scanIncomplete = true;
      break;
    }
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, truncated, dirsSeen, entriesSeen, scanIncomplete };
}

function gitOutputWasTruncated(error) {
  return (
    error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /max\s*buffer/i.test(error?.message ?? "")
  );
}

function gitRootFailure(result) {
  const unavailable = result.truncated || result.error?.code === "ENOENT";
  return {
    isGit: false,
    repoRoot: null,
    branch: null,
    dirtyFiles: [],
    status: unavailable ? "unavailable" : "not-a-repo",
    dirty: unavailable ? null : 0,
    dirtyAvailable: !unavailable,
    dirtyFilesTruncated: false,
  };
}

function gitStatusDetails(result) {
  if (!result.ok) {
    return {
      status: result.truncated ? "truncated" : "unavailable",
      dirtyFiles: [],
      dirty: null,
      dirtyAvailable: false,
      dirtyFilesTruncated: false,
    };
  }
  const lines = result.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    status: lines.length > 0 ? "dirty" : "clean",
    dirtyFiles: lines.slice(0, 200),
    dirty: lines.length,
    dirtyAvailable: true,
    dirtyFilesTruncated: lines.length > 200,
  };
}

function gitInfo(root, { exec = execFileSync } = {}) {
  const git = (args) => {
    try {
      const output = String(
        exec("git", ["-C", root, ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
        }) ?? "",
      );
      if (Buffer.byteLength(output) > MAX_GIT_OUTPUT_BYTES) {
        return { ok: false, text: null, truncated: true, error: null };
      }
      return { ok: true, text: output.trim(), truncated: false, error: null };
    } catch (error) {
      return { ok: false, text: null, truncated: gitOutputWasTruncated(error), error };
    }
  };

  const rootResult = git(["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok || !rootResult.text) return gitRootFailure(rootResult);

  const branchResult = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = (branchResult.ok && branchResult.text) || "detached";
  const statusResult = git(["status", "--porcelain", "--", root]);

  return {
    isGit: true,
    repoRoot: safeRealpath(rootResult.text),
    nested: safeRealpath(rootResult.text) !== safeRealpath(root),
    branch: branch === "HEAD" ? "detached" : branch,
    ...gitStatusDetails(statusResult),
  };
}

function execFileText(exec, file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const callback = (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(String(stdout ?? ""));
    };
    try {
      const result = exec(file, args, options, callback);
      // Small promise-returning adapters are convenient for embedders/tests;
      // node:child_process.execFile itself uses the callback above.
      if (result && typeof result.then === "function") {
        result.then((value) => {
          if (value && typeof value === "object" && "stdout" in value) {
            resolvePromise(String(value.stdout ?? ""));
          } else {
            resolvePromise(String(value ?? ""));
          }
        }, rejectPromise);
      } else if (typeof result === "string" || Buffer.isBuffer(result)) {
        resolvePromise(String(result));
      }
    } catch (error) {
      rejectPromise(error);
    }
  });
}

async function gitInfoAsync(root, { execFile: exec = execFile } = {}, metrics = {}) {
  const git = async (args) => {
    PROJECT_METRICS.gitCalls++;
    metrics.gitCalls = (metrics.gitCalls ?? 0) + 1;
    try {
      const output = await execFileText(exec, "git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
      });
      if (Buffer.byteLength(output) > MAX_GIT_OUTPUT_BYTES) {
        return { ok: false, text: null, truncated: true, error: null };
      }
      return { ok: true, text: output.trim(), truncated: false, error: null };
    } catch (error) {
      return { ok: false, text: null, truncated: gitOutputWasTruncated(error), error };
    }
  };

  const rootResult = await git(["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok || !rootResult.text) return gitRootFailure(rootResult);

  const branchResult = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = (branchResult.ok && branchResult.text) || "detached";
  const statusResult = await git(["status", "--porcelain", "--", root]);
  const [repoRoot, base] = await Promise.all([
    safeRealpathAsync(rootResult.text),
    safeRealpathAsync(root),
  ]);

  return {
    isGit: true,
    repoRoot,
    nested: repoRoot !== base,
    branch: branch === "HEAD" ? "detached" : branch,
    ...gitStatusDetails(statusResult),
  };
}

function readTextCapped(path) {
  const result = readFileSafe(path, { maxBytes: MAX_MANIFEST_BYTES });
  return result.ok && !result.truncated ? result.content : null;
}

function readJson(path) {
  const text = readTextCapped(path);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function manifestName(root) {
  const pkg = readJson(join(root, "package.json"));
  if (pkg?.name) return pkg.name;

  for (const file of ["pyproject.toml", "Cargo.toml", "go.mod"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readTextCapped(path);
    if (!text) continue;
    const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text) || /^module\s+(\S+)/m.exec(text);
    if (match) return match[1];
  }
  return basename(root);
}

function hasPythonTests(root, files) {
  if (existsSync(join(root, "pytest.ini"))) return true;
  if (existsSync(join(root, "conftest.py"))) return true;
  if (files.some((f) => /(^|\/)(tests?|testing)\/.*\.py$/i.test(f.rel))) return true;
  if (files.some((f) => /(^|\/)test_[^/]+\.py$/i.test(f.rel))) return true;
  if (files.some((f) => /[^/]+_test\.py$/i.test(f.rel))) return true;
  const pyproject = join(root, "pyproject.toml");
  if (existsSync(pyproject)) {
    const text = readTextCapped(pyproject);
    return text ? /\[tool\.pytest/i.test(text) : false;
  }
  return false;
}

/**
 * Best test command for a directory, based only on files that exist.
 * Returns { file, args, display, cwd, framework } or null.
 */
export function inferTestPlan(root, files = null) {
  const base = resolve(root);
  const inventory = files ?? walkFiles(base, { maxFiles: 3000 }).files;

  const pkgPath = join(base, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (pkg?.scripts?.test) {
      const runner = String(pkg.scripts.test);
      return {
        file: "npm",
        args: ["test", "--silent"],
        display: "npm test",
        cwd: base,
        framework: /node --test|tap|jest|vitest|mocha/.exec(runner)?.[0] ?? "npm",
        script: runner,
      };
    }
  }

  if (hasPythonTests(base, inventory)) {
    return {
      file: "python3",
      args: ["-m", "pytest", "-q"],
      display: "python3 -m pytest -q",
      cwd: base,
      framework: "pytest",
    };
  }

  if (existsSync(join(base, "Cargo.toml"))) {
    return {
      file: "cargo",
      args: ["test", "--quiet"],
      display: "cargo test",
      cwd: base,
      framework: "cargo",
    };
  }
  if (existsSync(join(base, "go.mod"))) {
    return {
      file: "go",
      args: ["test", "./..."],
      display: "go test ./...",
      cwd: base,
      framework: "go",
    };
  }
  if (existsSync(join(base, "pom.xml"))) {
    return {
      file: "mvn",
      args: ["-q", "test"],
      display: "mvn -q test",
      cwd: base,
      framework: "maven",
    };
  }
  if (existsSync(join(base, "build.gradle")) || existsSync(join(base, "build.gradle.kts"))) {
    return {
      file: "gradle",
      args: ["test", "--quiet"],
      display: "gradle test",
      cwd: base,
      framework: "gradle",
    };
  }

  return null;
}

/**
 * The full project context the UI and agent operate on.
 * @returns {import("./contracts.mjs").Project}
 */
export function detectProject(root = process.cwd(), options = {}) {
  const started = Date.now();
  const requested = resolve(root);
  if (!existsSync(requested)) {
    throw new Error(`Workspace does not exist: ${requested}`);
  }
  const base = statSync(requested).isDirectory() ? requested : dirname(requested);

  const { files, truncated, dirsSeen, entriesSeen, scanIncomplete } = walkFiles(base, options);
  const git = gitInfo(base, options);

  const languageMap = new Map();
  for (const file of files) {
    if (file.language === "text") continue;
    const entry = languageMap.get(file.language) ?? { name: file.language, files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.size;
    languageMap.set(file.language, entry);
  }
  const languages = [...languageMap.values()].sort(
    (a, b) => b.files - a.files || a.name.localeCompare(b.name),
  );

  const test = options.test ?? inferTestPlan(base, files);

  return {
    root: base,
    name: manifestName(base),
    branch: git.branch,
    repoRoot: git.repoRoot,
    nestedRepo: Boolean("nested" in git && git.nested),
    isGit: git.isGit,
    dirtyFiles: git.dirtyFiles,
    dirtyFilesTruncated: git.dirtyFilesTruncated,
    dirty: git.dirty,
    dirtyAvailable: git.dirtyAvailable,
    gitStatus: /** @type {import("./contracts.mjs").Project["gitStatus"]} */ (git.status),
    files,
    fileCount: files.length,
    truncated,
    dirsSeen,
    entriesSeen,
    scanIncomplete,
    languages,
    test,
    scannedAt: Date.now(),
    scanMs: Date.now() - started,
    packageJson: readJson(join(base, "package.json")),
  };
}

async function pathExistsAsync(path) {
  try {
    await statAsync(path);
    return true;
  } catch {
    return false;
  }
}

function removeManifestSnapshot(path) {
  const cached = MANIFEST_CACHE.get(path);
  if (!cached) return;
  manifestCacheBytes -= Buffer.byteLength(cached.text ?? "");
  MANIFEST_CACHE.delete(path);
}

function storeManifestSnapshot(path, stat, text) {
  removeManifestSnapshot(path);
  const bytes = Buffer.byteLength(text ?? "");
  while (MANIFEST_CACHE.size >= MAX_MANIFEST_CACHE_ENTRIES) {
    const oldestKey = MANIFEST_CACHE.keys().next().value;
    if (oldestKey === undefined) break;
    removeManifestSnapshot(oldestKey);
    PROJECT_METRICS.manifestCacheEvictions++;
  }
  MANIFEST_CACHE.set(path, {
    text,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
  });
  manifestCacheBytes += bytes;
}

// Manifest snapshots are validated by a fresh stat on every hit. The byte cap
// and identity check make repeated package/test/name inference cheap without
// trusting a directory index or reusing bytes after a same-length replacement.
async function readManifestTextAsync(path, metrics) {
  let stat;
  try {
    stat = await statAsync(path);
    if (!stat.isFile()) {
      removeManifestSnapshot(path);
      return null;
    }
  } catch {
    removeManifestSnapshot(path);
    return null;
  }

  const cached = MANIFEST_CACHE.get(path);
  if (cached && sameFileIdentity(stat, cached)) {
    PROJECT_METRICS.manifestCacheHits++;
    metrics.manifestCacheHits++;
    MANIFEST_CACHE.delete(path);
    MANIFEST_CACHE.set(path, cached);
    return cached.text;
  }
  if (cached) removeManifestSnapshot(path);
  PROJECT_METRICS.manifestCacheMisses++;
  metrics.manifestCacheMisses++;

  if (stat.size > MAX_MANIFEST_BYTES) {
    storeManifestSnapshot(path, stat, null);
    return null;
  }

  let handle = null;
  try {
    handle = await openAsync(path, "r");
    const opened = await handle.stat();
    if (!sameFileIdentity(stat, opened)) return null;
    const buffer = Buffer.alloc(stat.size);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== stat.size || !sameFileIdentity(stat, after)) return null;

    const raw = buffer.subarray(0, length);
    const content = raw.toString("utf8");
    PROJECT_METRICS.manifestReads++;
    metrics.manifestReads++;
    if (content.includes("\u0000") || !Buffer.from(content, "utf8").equals(raw)) {
      storeManifestSnapshot(path, stat, null);
      return null;
    }
    storeManifestSnapshot(path, stat, content);
    return content;
  } catch {
    return null;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // The bounded read result is already determined.
      }
    }
  }
}

async function readJsonAsync(path, metrics) {
  const text = await readManifestTextAsync(path, metrics);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function manifestNameAsync(root, metrics) {
  const pkg = await readJsonAsync(join(root, "package.json"), metrics);
  if (pkg?.name) return pkg.name;

  for (const file of ["pyproject.toml", "Cargo.toml", "go.mod"]) {
    const text = await readManifestTextAsync(join(root, file), metrics);
    if (!text) continue;
    const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text) || /^module\s+(\S+)/m.exec(text);
    if (match) return match[1];
  }
  return basename(root);
}

async function hasPythonTestsAsync(root, files, metrics) {
  if (await pathExistsAsync(join(root, "pytest.ini"))) return true;
  if (await pathExistsAsync(join(root, "conftest.py"))) return true;
  if (files.some((f) => /(^|\/)(tests?|testing)\/.*\.py$/i.test(f.rel))) return true;
  if (files.some((f) => /(^|\/)test_[^/]+\.py$/i.test(f.rel))) return true;
  if (files.some((f) => /[^/]+_test\.py$/i.test(f.rel))) return true;
  const pyproject = join(root, "pyproject.toml");
  if (await pathExistsAsync(pyproject)) {
    const text = await readManifestTextAsync(pyproject, metrics);
    return text ? /\[tool\.pytest/i.test(text) : false;
  }
  return false;
}

async function inferTestPlanAsync(root, files, metrics) {
  const base = resolve(root);
  const pkg = await readJsonAsync(join(base, "package.json"), metrics);
  if (pkg?.scripts?.test) {
    const runner = String(pkg.scripts.test);
    return {
      file: "npm",
      args: ["test", "--silent"],
      display: "npm test",
      cwd: base,
      framework: /node --test|tap|jest|vitest|mocha/.exec(runner)?.[0] ?? "npm",
      script: runner,
    };
  }

  if (await hasPythonTestsAsync(base, files, metrics)) {
    return {
      file: "python3",
      args: ["-m", "pytest", "-q"],
      display: "python3 -m pytest -q",
      cwd: base,
      framework: "pytest",
    };
  }

  if (await pathExistsAsync(join(base, "Cargo.toml"))) {
    return {
      file: "cargo",
      args: ["test", "--quiet"],
      display: "cargo test",
      cwd: base,
      framework: "cargo",
    };
  }
  if (await pathExistsAsync(join(base, "go.mod"))) {
    return {
      file: "go",
      args: ["test", "./..."],
      display: "go test ./...",
      cwd: base,
      framework: "go",
    };
  }
  if (await pathExistsAsync(join(base, "pom.xml"))) {
    return {
      file: "mvn",
      args: ["-q", "test"],
      display: "mvn -q test",
      cwd: base,
      framework: "maven",
    };
  }
  if (
    (await pathExistsAsync(join(base, "build.gradle"))) ||
    (await pathExistsAsync(join(base, "build.gradle.kts")))
  ) {
    return {
      file: "gradle",
      args: ["test", "--quiet"],
      display: "gradle test",
      cwd: base,
      framework: "gradle",
    };
  }
  return null;
}

function cacheHookIdentity(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return JSON.stringify(value);
  }
  let id = CACHE_HOOK_IDS.get(value);
  if (!id) {
    id = nextCacheHookId++;
    CACHE_HOOK_IDS.set(value, id);
  }
  return id;
}

function asyncScanKey(options) {
  const ignore =
    options.ignore === undefined
      ? "default"
      : options.ignore instanceof Set
        ? [...options.ignore].map(String).sort()
        : cacheHookIdentity(options.ignore);
  const exec =
    options.execFile === undefined || options.execFile === execFile
      ? "node"
      : cacheHookIdentity(options.execFile);
  return JSON.stringify({
    maxFiles: options.maxFiles === undefined ? 2500 : options.maxFiles,
    maxDepth: options.maxDepth === undefined ? 10 : options.maxDepth,
    maxBytes: options.maxBytes === undefined ? 2 * 1024 * 1024 : options.maxBytes,
    maxDirectories: options.maxDirectories === undefined ? 5000 : options.maxDirectories,
    maxEntries: options.maxEntries === undefined ? 50_000 : options.maxEntries,
    ignore,
    test: options.test == null ? null : cacheHookIdentity(options.test),
    exec,
  });
}

function projectGeneration(root) {
  return PROJECT_GENERATIONS.get(root) ?? 0;
}

function canonicalRootForInvalidation(root) {
  const requested = resolve(root);
  try {
    const base = statSync(requested).isDirectory() ? requested : dirname(requested);
    return safeRealpath(base);
  } catch {
    return safeRealpath(requested);
  }
}

function pathInsideRoot(root, path) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Invalidate display snapshots after Matrix writes/undo. In-flight scans from
 * an older generation may finish for their original callers, but are marked
 * stale, are never cached, and cannot be joined by post-invalidation callers.
 * Returns the number of completed project snapshots removed.
 */
export function invalidateProjectCache(root = null) {
  const roots = new Set();
  if (root === null) {
    for (const key of PROJECT_IN_FLIGHT.keys()) roots.add(key);
    for (const snapshot of PROJECT_SNAPSHOTS.values()) roots.add(snapshot.root);
  } else {
    roots.add(canonicalRootForInvalidation(root));
  }

  let removed = 0;
  for (const base of roots) {
    PROJECT_GENERATIONS.set(base, projectGeneration(base) + 1);
    for (const [key, snapshot] of PROJECT_SNAPSHOTS) {
      if (root !== null && snapshot.root !== base) continue;
      PROJECT_SNAPSHOTS.delete(key);
      removed++;
    }
  }

  if (root === null) {
    MANIFEST_CACHE.clear();
    manifestCacheBytes = 0;
  } else {
    const base = roots.values().next().value;
    for (const path of MANIFEST_CACHE.keys()) {
      if (pathInsideRoot(base, path)) removeManifestSnapshot(path);
    }
  }
  PROJECT_METRICS.invalidations++;
  PROJECT_METRICS.snapshotsInvalidated += removed;
  return removed;
}

function normalizedSnapshotMs(value) {
  if (value === undefined) return DEFAULT_PROJECT_SNAPSHOT_MS;
  const number = Number(value);
  if (!Number.isFinite(number)) return number === Infinity ? MAX_PROJECT_SNAPSHOT_MS : 0;
  return Math.max(0, Math.min(MAX_PROJECT_SNAPSHOT_MS, number));
}

function storeProjectSnapshot(result, key) {
  const cacheKey = `${result.root}\u0000${key}`;
  PROJECT_SNAPSHOTS.delete(cacheKey);
  while (PROJECT_SNAPSHOTS.size >= MAX_PROJECT_SNAPSHOTS) {
    const oldest = PROJECT_SNAPSHOTS.keys().next().value;
    if (oldest === undefined) break;
    PROJECT_SNAPSHOTS.delete(oldest);
    PROJECT_METRICS.snapshotEvictions++;
  }
  PROJECT_SNAPSHOTS.set(cacheKey, {
    ...result,
    project: structuredClone(result.project),
  });
}

function projectForRequest(result, cacheStatus) {
  const project = structuredClone(result.project);
  const invalidated = result.generation !== projectGeneration(result.root);
  project.snapshotStale = invalidated;
  project.scanMetrics = {
    ...project.scanMetrics,
    cacheStatus: invalidated ? "invalidated" : cacheStatus,
    snapshotId: result.id,
    snapshotAgeMs: Math.max(0, Date.now() - project.scannedAt),
  };
  return project;
}

async function performProjectScan(root, key, generation, id, options) {
  const started = Date.now();
  const metrics = {
    gitCalls: 0,
    manifestReads: 0,
    manifestCacheHits: 0,
    manifestCacheMisses: 0,
  };
  try {
    const [walk, git] = await Promise.all([
      walkFilesAsync(root, options),
      gitInfoAsync(root, options, metrics),
    ]);
    const { files, truncated, dirsSeen, entriesSeen, scanIncomplete } = walk;
    PROJECT_METRICS.entriesSeen += entriesSeen;
    PROJECT_METRICS.directoriesSeen += dirsSeen;
    PROJECT_METRICS.filesSeen += files.length;

    const languageMap = new Map();
    for (const file of files) {
      if (file.language === "text") continue;
      const entry = languageMap.get(file.language) ?? { name: file.language, files: 0, bytes: 0 };
      entry.files += 1;
      entry.bytes += file.size;
      languageMap.set(file.language, entry);
    }
    const languages = [...languageMap.values()].sort(
      (a, b) => b.files - a.files || a.name.localeCompare(b.name),
    );

    const test = options.test ?? (await inferTestPlanAsync(root, files, metrics));
    const name = await manifestNameAsync(root, metrics);
    const packageJson = await readJsonAsync(join(root, "package.json"), metrics);
    const scannedAt = Date.now();
    const project = {
      root,
      name,
      branch: git.branch,
      repoRoot: git.repoRoot,
      nestedRepo: Boolean("nested" in git && git.nested),
      isGit: git.isGit,
      dirtyFiles: git.dirtyFiles,
      dirtyFilesTruncated: git.dirtyFilesTruncated,
      dirty: git.dirty,
      dirtyAvailable: git.dirtyAvailable,
      gitStatus: /** @type {import("./contracts.mjs").Project["gitStatus"]} */ (git.status),
      files,
      fileCount: files.length,
      truncated,
      dirsSeen,
      entriesSeen,
      scanIncomplete,
      languages,
      test,
      scannedAt,
      scanMs: scannedAt - started,
      packageJson,
      scanMetrics: {
        directoriesSeen: dirsSeen,
        entriesSeen,
        filesSeen: files.length,
        ...metrics,
      },
    };
    const result = { id, root, generation, project };
    if (generation === projectGeneration(root)) storeProjectSnapshot(result, key);
    PROJECT_METRICS.scansCompleted++;
    return result;
  } catch (error) {
    PROJECT_METRICS.scansFailed++;
    throw error;
  }
}

async function requestProjectSnapshot(root, options) {
  const key = asyncScanKey(options);
  const refresh = Boolean(options.refresh);
  const cacheMs = normalizedSnapshotMs(options.cacheMs);
  const minimumScanId = refresh ? PROJECT_METRICS.scansStarted + 1 : 0;
  let missRecorded = false;

  while (true) {
    const generation = projectGeneration(root);
    const cacheKey = `${root}\u0000${key}`;
    const cached = PROJECT_SNAPSHOTS.get(cacheKey);
    if (cached) {
      const age = Math.max(0, Date.now() - cached.project.scannedAt);
      if (cached.generation !== generation) {
        PROJECT_SNAPSHOTS.delete(cacheKey);
      } else if (age >= cacheMs) {
        PROJECT_SNAPSHOTS.delete(cacheKey);
        PROJECT_METRICS.snapshotExpirations++;
      } else if (cached.id >= minimumScanId) {
        PROJECT_METRICS.cacheHits++;
        PROJECT_SNAPSHOTS.delete(cacheKey);
        PROJECT_SNAPSHOTS.set(cacheKey, cached);
        return projectForRequest(cached, "cached");
      }
    }

    if (!missRecorded) {
      PROJECT_METRICS.cacheMisses++;
      missRecorded = true;
    }

    const active = PROJECT_IN_FLIGHT.get(root);
    if (active) {
      if (active.key === key && active.generation === generation) {
        PROJECT_METRICS.inFlightHits++;
        const result = await active.promise;
        return projectForRequest(result, "deduplicated");
      }
      // Different budgets/hooks cannot share a result. Serialize them so a
      // canonical root still has at most one actual walk/git scan in flight.
      PROJECT_METRICS.queuedRequests++;
      try {
        await active.promise;
      } catch {
        // A queued request gets its own attempt even if the prior scan failed.
      }
      if (PROJECT_IN_FLIGHT.get(root) === active) PROJECT_IN_FLIGHT.delete(root);
      continue;
    }

    const id = PROJECT_METRICS.scansStarted + 1;
    PROJECT_METRICS.scansStarted = id;
    const scan = { key, generation, promise: null };
    scan.promise = performProjectScan(root, key, generation, id, options);
    PROJECT_IN_FLIGHT.set(root, scan);
    try {
      const result = await scan.promise;
      return projectForRequest(result, "scanned");
    } finally {
      if (PROJECT_IN_FLIGHT.get(root) === scan) PROJECT_IN_FLIGHT.delete(root);
    }
  }
}

/**
 * Non-render-blocking project detection with bounded async directory/git I/O.
 * Equivalent callers share work; different scan configurations are serialized
 * per canonical root. Completed display snapshots are reused for cacheMs
 * (default 1000, capped at 60000) and cloned so callers cannot poison the cache.
 *
 * Freshness policy: cached snapshots are for display, not transactional task
 * execution. Pass { refresh: true } to bypass completed snapshots (an equivalent
 * active scan is still shared). After every Matrix write/undo, call
 * invalidateProjectCache(root), then refresh before using the index. Task starts
 * that require a current inventory must also use refresh. Approval writes keep
 * their existing fresh stat-and-byte revalidation; no cached bytes authorize a
 * write. External changes can still race any scan, so incomplete/unavailable
 * results must not be presented as complete or clean.
 * @returns {Promise<import("./contracts.mjs").Project>}
 */
export async function detectProjectAsync(root = process.cwd(), options = {}) {
  PROJECT_METRICS.requests++;
  if (options.refresh) PROJECT_METRICS.refreshRequests++;
  const requested = resolve(root);
  let stat;
  try {
    stat = await statAsync(requested);
  } catch {
    throw new Error(`Workspace does not exist: ${requested}`);
  }
  const base = stat.isDirectory() ? requested : dirname(requested);
  const canonical = await safeRealpathAsync(base);
  return requestProjectSnapshot(canonical, options);
}

/** Nearest ancestor (inside `boundary`) that looks like a runnable project. */
export function projectRootForFile(workspaceRoot, filePath, { boundary = null } = {}) {
  const boundaryRoot = resolve(boundary ?? workspaceRoot);
  let dir = dirname(resolve(filePath));
  if (!isAbsolute(filePath)) dir = resolve(workspaceRoot, dirname(filePath));

  const stop = boundaryRoot;
  while (true) {
    if (
      existsSync(join(dir, "package.json")) ||
      existsSync(join(dir, "pyproject.toml")) ||
      existsSync(join(dir, "Cargo.toml")) ||
      existsSync(join(dir, "go.mod")) ||
      existsSync(join(dir, "pytest.ini")) ||
      existsSync(join(dir, "tests")) ||
      existsSync(join(dir, ".git"))
    ) {
      return dir;
    }
    if (dir === stop || dir === dirname(dir)) break;
    dir = dirname(dir);
  }
  return stop;
}

/**
 * Everything needed to run verification for an edited file:
 * the nearest project root, its test plan and the file itself.
 */
export function verifyContext(workspaceRoot, filePath) {
  const root = projectRootForFile(workspaceRoot, filePath);
  const plan = inferTestPlan(root);
  return {
    root,
    test: plan,
    file: resolve(workspaceRoot, filePath),
    rel: relative(root, resolve(workspaceRoot, filePath)).split("\\").join("/"),
  };
}

export function readFileSafe(path, { maxBytes = MAX_READ_BYTES, cache = null } = {}) {
  let fd = null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { ok: false, error: "not a file" };
    if (isBinaryPath(path)) return { ok: false, error: "binary file" };
    const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
    const cacheKey = cache ? `${path}\u0000${limit}` : null;
    const cached = cachedRead(cache, cacheKey, stat);
    if (cached) return cached;
    const capacity = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(capacity);
    let length = 0;
    fd = openSync(path, "r");
    while (length < capacity) {
      const read = readSync(fd, buffer, length, capacity - length, length);
      if (read === 0) break;
      length += read;
    }
    const raw = buffer.subarray(0, length);
    const content = raw.toString("utf8");
    if (content.includes("\u0000")) return { ok: false, error: "binary file" };
    // A round-trip preserves valid UTF-8 exactly (including a BOM) and flags
    // replacement characters produced by lossy decoding. Callers that edit
    // must also require a complete, non-truncated read.
    const utf8 = Buffer.from(content, "utf8").equals(raw);
    const result = {
      ok: true,
      content,
      utf8,
      bytes: raw.length,
      size: stat.size,
      truncated: stat.size > limit,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      dev: stat.dev,
      ino: stat.ino,
    };
    storeCachedRead(cache, cacheKey, result);
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The read result is already determined; close failure is not actionable.
      }
    }
  }
}

/** Read through a bounded per-project LRU, validating fresh stat identity on hits. */
export function readProjectFile(project, path, options = {}) {
  return readFileSafe(path, { ...options, cache: readCache(project) });
}

const QUERY_GLOB = (glob, rel) => {
  if (!glob) return true;
  const pattern = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    // NUL is an internal sentinel while translating the glob, never file input.
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`).test(rel) || rel.endsWith(glob.replace(/^\*+/, ""));
};

function withSearchMetadata(results, metadata) {
  Object.defineProperties(results, {
    scanned: { value: metadata.scanned, enumerable: false },
    scannedBytes: { value: metadata.scannedBytes, enumerable: false },
    partial: { value: metadata.partial, enumerable: false },
    truncated: { value: metadata.partial, enumerable: false },
    aborted: { value: metadata.aborted, enumerable: false },
    reason: { value: metadata.reason, enumerable: false },
  });
  return results;
}

/**
 * Literal, case-insensitive repository search. Returns real lines from real
 * files. Non-enumerable metadata reports work and incomplete budgeted scans.
 */
export function searchRepo(
  project,
  query,
  {
    limit = 40,
    glob = null,
    caseSensitive = false,
    maxFiles = DEFAULT_SEARCH_MAX_FILES,
    maxBytes = DEFAULT_SEARCH_MAX_BYTES,
    signal = null,
  } = {},
) {
  const needle = String(query ?? "");
  if (!needle) return [];
  const haystackNeedle = caseSensitive ? needle : needle.toLowerCase();
  const fileBudget = Math.max(0, Math.floor(Number(maxFiles) || 0));
  const byteBudget = Math.max(0, Math.floor(Number(maxBytes) || 0));
  const results = [];
  let scanned = 0;
  let scannedBytes = 0;
  let partial = false;
  let aborted = false;
  let reason = null;

  for (const file of project.files) {
    if (results.length >= limit) break;
    if (signal?.aborted) {
      partial = true;
      aborted = true;
      reason = "aborted";
      break;
    }
    if (isBinaryPath(file.path)) continue;
    if (!QUERY_GLOB(glob, file.rel)) continue;
    if (file.size > MAX_SEARCH_FILE_BYTES) continue;
    if (scanned >= fileBudget) {
      partial = true;
      reason = "file-budget";
      break;
    }

    const expectedBytes = Math.min(Math.max(0, Number(file.size) || 0), MAX_SEARCH_FILE_BYTES);
    const remainingBytes = Math.max(0, byteBudget - scannedBytes);
    if (expectedBytes > remainingBytes) {
      partial = true;
      reason = "byte-budget";
      break;
    }
    const readLimit = Math.min(MAX_SEARCH_FILE_BYTES, remainingBytes);
    scanned++;
    const read = readProjectFile(project, file.path, { maxBytes: readLimit });
    if (!read.ok) continue;
    scannedBytes += read.bytes ?? Buffer.byteLength(read.content);
    const stopAfterFile = read.truncated;
    if (stopAfterFile) {
      partial = true;
      reason = readLimit < MAX_SEARCH_FILE_BYTES ? "byte-budget" : "truncated-read";
    }

    const lexicalContent = caseSensitive ? read.content : read.content.toLowerCase();
    if (!lexicalContent.includes(haystackNeedle)) {
      if (stopAfterFile) break;
      continue;
    }

    const lines = read.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const haystack = caseSensitive ? line : line.toLowerCase();
      const at = haystack.indexOf(haystackNeedle);
      if (at === -1) continue;
      results.push({
        path: file.path,
        rel: file.rel,
        line: i + 1,
        column: at + 1,
        text: line.replace(/\r$/, ""),
        language: file.language,
      });
      if (results.length >= limit) break;
    }
    if (stopAfterFile) break;
  }

  return withSearchMetadata(results, { scanned, scannedBytes, partial, aborted, reason });
}

export function findFile(project, fragment) {
  const needle = String(fragment ?? "")
    .toLowerCase()
    .replace(/^\.\//, "");
  if (!needle) return null;
  const exact = project.files.find((f) => f.rel.toLowerCase() === needle);
  if (exact) return exact;
  const suffix = project.files.find((f) => f.rel.toLowerCase().endsWith(needle));
  if (suffix) return suffix;
  const base = project.files.find((f) => f.name.toLowerCase() === basename(needle));
  if (base) return base;
  return project.files.find((f) => f.rel.toLowerCase().includes(needle)) ?? null;
}

/** Path mentioned in a natural-language task, longest match wins. */
export function fileMentionedIn(task, project) {
  const raw = String(task ?? "");
  const candidates = [
    ...raw.matchAll(/(?:^|[\s"'`(])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?=$|[\s"'`),:;])/g),
  ]
    .map((m) => m[1])
    .filter((p) => !p.startsWith("http"))
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    const file = findFile(project, candidate);
    if (file) return file;
  }
  return null;
}
