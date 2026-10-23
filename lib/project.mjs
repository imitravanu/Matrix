// ============================================================================
// Project intelligence: what repository are we actually standing in?
//
// Everything the workbench claims to know about the workspace is derived here:
// the git branch, the file inventory, the dominant languages and the test
// command. No hard-coded paths, no invented file counts.
// ============================================================================

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
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
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".tar", ".bz2", ".xz", ".7z", ".mp3", ".mp4", ".mov", ".wasm", ".woff",
  ".woff2", ".ttf", ".otf", ".eot", ".sqlite", ".db", ".pyc", ".class",
]);

const MAX_READ_BYTES = 512 * 1024;

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

/** Bounded, deterministic directory walk. Never follows symlinks. */
export function walkFiles(root, options = {}) {
  const {
    maxFiles = 2500,
    maxDepth = 10,
    maxBytes = 2 * 1024 * 1024,
    ignore = IGNORED_DIRS,
  } = options;

  const base = resolve(root);
  const files = [];
  let truncated = false;
  let dirsSeen = 0;

  const stack = [{ dir: base, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    dirsSeen++;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

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
  }

  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, truncated, dirsSeen };
}

function gitInfo(root) {
  const git = (args) => {
    try {
      return execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      }).trim();
    } catch {
      return null;
    }
  };

  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  if (!repoRoot) return { isGit: false, repoRoot: null, branch: null, dirtyFiles: [] };

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "detached";
  const status = git(["status", "--porcelain", "--", root]) || "";
  const dirtyFiles = status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200);

  return {
    isGit: true,
    repoRoot: safeRealpath(repoRoot),
    nested: safeRealpath(repoRoot) !== safeRealpath(root),
    branch: branch === "HEAD" ? "detached" : branch,
    dirtyFiles,
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
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
    try {
      const text = readFileSync(path, "utf8");
      const match =
        /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text) ||
        /^module\s+(\S+)/m.exec(text);
      if (match) return match[1];
    } catch {
      // ignore
    }
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
    try {
      return /\[tool\.pytest/i.test(readFileSync(pyproject, "utf8"));
    } catch {
      return false;
    }
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
    return { file: "cargo", args: ["test", "--quiet"], display: "cargo test", cwd: base, framework: "cargo" };
  }
  if (existsSync(join(base, "go.mod"))) {
    return { file: "go", args: ["test", "./..."], display: "go test ./...", cwd: base, framework: "go" };
  }
  if (existsSync(join(base, "pom.xml"))) {
    return { file: "mvn", args: ["-q", "test"], display: "mvn -q test", cwd: base, framework: "maven" };
  }
  if (existsSync(join(base, "build.gradle")) || existsSync(join(base, "build.gradle.kts"))) {
    return { file: "gradle", args: ["test", "--quiet"], display: "gradle test", cwd: base, framework: "gradle" };
  }

  return null;
}

/**
 * The full project context the UI and agent operate on.
 */
export function detectProject(root = process.cwd(), options = {}) {
  const started = Date.now();
  const requested = resolve(root);
  if (!existsSync(requested)) {
    throw new Error(`Workspace does not exist: ${requested}`);
  }
  const base = statSync(requested).isDirectory() ? requested : dirname(requested);

  const { files, truncated, dirsSeen } = walkFiles(base, options);
  const git = gitInfo(base);

  const languageMap = new Map();
  for (const file of files) {
    if (file.language === "text") continue;
    const entry = languageMap.get(file.language) ?? { name: file.language, files: 0, bytes: 0 };
    entry.files += 1;
    entry.bytes += file.size;
    languageMap.set(file.language, entry);
  }
  const languages = [...languageMap.values()].sort(
    (a, b) => b.files - a.files || a.name.localeCompare(b.name)
  );

  const test = options.test ?? inferTestPlan(base, files);

  return {
    root: base,
    name: manifestName(base),
    branch: git.branch,
    repoRoot: git.repoRoot,
    nestedRepo: Boolean(git.nested),
    isGit: git.isGit,
    dirtyFiles: git.dirtyFiles,
    dirty: git.dirtyFiles.length,
    files,
    fileCount: files.length,
    truncated,
    dirsSeen,
    languages,
    test,
    scannedAt: Date.now(),
    scanMs: Date.now() - started,
    packageJson: readJson(join(base, "package.json")),
  };
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

export function readFileSafe(path, { maxBytes = MAX_READ_BYTES } = {}) {
  let fd = null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { ok: false, error: "not a file" };
    if (isBinaryPath(path)) return { ok: false, error: "binary file" };
    const limit = Math.max(0, Math.floor(Number(maxBytes) || 0));
    const capacity = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(capacity);
    let length = 0;
    fd = openSync(path, "r");
    while (length < capacity) {
      const read = readSync(fd, buffer, length, capacity - length, length);
      if (read === 0) break;
      length += read;
    }
    const content = buffer.subarray(0, length).toString("utf8");
    if (content.includes("\u0000")) return { ok: false, error: "binary file" };
    return {
      ok: true,
      content,
      size: stat.size,
      truncated: stat.size > limit,
      mtimeMs: stat.mtimeMs,
    };
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

const QUERY_GLOB = (glob, rel) => {
  if (!glob) return true;
  const pattern = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`).test(rel) || rel.endsWith(glob.replace(/^\*+/, ""));
};

/**
 * Literal, case-insensitive repository search. Returns real lines from real
 * files. This is what the local agent and the `search` tool call.
 */
export function searchRepo(project, query, { limit = 40, glob = null, caseSensitive = false } = {}) {
  const needle = String(query ?? "");
  if (!needle) return [];
  const haystackNeedle = caseSensitive ? needle : needle.toLowerCase();
  const results = [];
  let scanned = 0;

  for (const file of project.files) {
    if (results.length >= limit) break;
    if (isBinaryPath(file.path)) continue;
    if (!QUERY_GLOB(glob, file.rel)) continue;
    if (file.size > 256 * 1024) continue;

    scanned++;
    const read = readFileSafe(file.path, { maxBytes: 256 * 1024 });
    if (!read.ok) continue;

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
  }

  return results;
}

export function findFile(project, fragment) {
  const needle = String(fragment ?? "").toLowerCase().replace(/^\.\//, "");
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
  const candidates = [...raw.matchAll(/(?:^|[\s"'`(])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?=$|[\s"'`),:;])/g)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith("http"))
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    const file = findFile(project, candidate);
    if (file) return file;
  }
  return null;
}
