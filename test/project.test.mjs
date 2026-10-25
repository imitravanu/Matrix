import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  detectProject,
  detectProjectAsync,
  fileMentionedIn,
  findFile,
  getProjectScanMetrics,
  inferTestPlan,
  invalidateProjectCache,
  isBinaryPath,
  languageForPath,
  projectRootForFile,
  readFileSafe,
  readProjectFile,
  searchRepo,
  verifyContext,
  walkFiles,
  walkFilesAsync,
} from "../lib/project.mjs";
import { copyDemo, makeTempDir } from "./helpers.mjs";

function asyncGit(exec) {
  return (file, args, options, callback) => {
    setImmediate(() => {
      try {
        callback(null, exec(file, args, options), "");
      } catch (error) {
        callback(error, "", "");
      }
    });
  };
}

test("detectProject indexes the real demo project", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  assert.equal(project.name, "demo-project");
  assert.equal(project.fileCount, 2);
  assert.equal(project.test.framework, "pytest");
  assert.equal(project.test.display, "python3 -m pytest -q");
  assert.ok(
    project.languages.some((language) => language.name === "python" && language.files === 2),
  );
  assert.ok(project.files.some((file) => file.rel === "src/processor.py"));
  assert.equal(project.branch, null);
  assert.equal(project.dirty, 0);
});

test("detectProjectAsync is compatible with the synchronous project snapshot", async (t) => {
  const demo = copyDemo();
  t.after(() => {
    invalidateProjectCache(demo.workspace);
    demo.cleanup();
  });
  const expected = detectProject(demo.workspace);
  const project = await detectProjectAsync(demo.workspace);
  assert.equal(project.name, expected.name);
  assert.equal(project.fileCount, expected.fileCount);
  assert.deepEqual(project.files, expected.files);
  assert.deepEqual(project.languages, expected.languages);
  assert.deepEqual(project.test, expected.test);
  assert.equal(project.gitStatus, expected.gitStatus);
  assert.equal(project.scanMetrics.cacheStatus, "scanned");
  assert.equal(project.scanMetrics.entriesSeen, project.entriesSeen);
});

test("languageForPath covers supported source and binary extensions", () => {
  assert.equal(languageForPath("a/b.py"), "python");
  assert.equal(languageForPath("a/b.tsx"), "typescript");
  assert.equal(languageForPath("a/b.rs"), "rust");
  assert.equal(languageForPath("a/b.go"), "go");
  assert.equal(languageForPath("a/b.rb"), "ruby");
  assert.equal(languageForPath("README.md"), "markdown");
  assert.equal(languageForPath("image.png"), "text");
  assert.equal(isBinaryPath("image.png"), true);
  assert.equal(isBinaryPath("src/a.py"), false);
});

test("walkFiles ignores heavy and hidden directories", (t) => {
  const root = makeTempDir("matrix-walk-");
  t.after(() => {
    // The test owns this directory; remove it through Node so it works even
    // when the filesystem does not allow shell wildcards.
    import("node:fs").then(({ rmSync }) => rmSync(root, { recursive: true, force: true }));
  });
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "src", "app.js"), "const x = 1;\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "x\n");
  writeFileSync(join(root, ".git", "config"), "x\n");
  const { files } = walkFiles(root);
  assert.deepEqual(
    files.map((file) => file.rel),
    ["src/app.js"],
  );
});

test("walkFiles skips symlinked files and directories", (t) => {
  const root = makeTempDir("matrix-walk-links-");
  const outside = makeTempDir("matrix-walk-outside-");
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.js"), "const x = 1;\n");
  writeFileSync(join(outside, "evil.js"), "const outside = true;\n");
  symlinkSync(outside, join(root, "linked"), "dir");
  symlinkSync(join(outside, "evil.js"), join(root, "src", "linked.js"));
  const { files } = walkFiles(root);
  assert.deepEqual(
    files.map((file) => file.rel),
    ["src/app.js"],
  );
});

test("walkFiles enforces real entry and directory work budgets", (t) => {
  const root = makeTempDir("matrix-walk-budget-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "budget", scripts: { test: "node --test" } }),
  );
  for (let index = 0; index < 10; index++) {
    mkdirSync(join(root, `d${index}`), { recursive: true });
    writeFileSync(join(root, `d${index}`, "file.js"), "x\n");
  }

  const entries = walkFiles(root, { maxEntries: 5 });
  assert.ok(entries.entriesSeen <= 5);
  assert.equal(entries.scanIncomplete, true);
  assert.equal(entries.truncated, true);

  const directories = walkFiles(root, { maxDirectories: 2, maxEntries: 100 });
  assert.ok(directories.dirsSeen <= 2);
  assert.equal(directories.scanIncomplete, true);

  const inventoryOnly = walkFiles(root, { maxFiles: 2, maxEntries: 100, maxDirectories: 100 });
  assert.equal(inventoryOnly.truncated, true);
  assert.equal(inventoryOnly.scanIncomplete, false);

  const project = detectProject(root, { maxEntries: 1 });
  assert.equal(project.scanIncomplete, true);
  assert.equal(
    project.test.display,
    "npm test",
    "root manifest detection survives inventory truncation",
  );
});

test("100,000-entry synthetic trees obey small independent sync/async work caps", async (t) => {
  const root = makeTempDir("matrix-walk-large-");
  t.after(() => {
    invalidateProjectCache(root);
    rmSync(root, { recursive: true, force: true });
  });
  // Keep each inode below filesystem link-count limits (Ubuntu CI commonly
  // rejects roughly 65,000 links to one source) while retaining 100,000 files.
  const sources = Array.from({ length: 4 }, (_, index) => join(root, `source-${index}.txt`));
  for (const source of sources) writeFileSync(source, "x\n");
  for (let index = 0; index < 100_000 - sources.length; index++) {
    linkSync(sources[index % sources.length], join(root, `f${String(index).padStart(6, "0")}.txt`));
  }
  const budgets = { maxEntries: 64, maxDirectories: 2, maxFiles: 10 };
  const syncScan = walkFiles(root, budgets);
  const asyncScan = await walkFilesAsync(root, budgets);
  for (const scan of [syncScan, asyncScan]) {
    assert.ok(scan.entriesSeen <= 64);
    assert.ok(scan.dirsSeen <= 2);
    assert.ok(scan.files.length <= 10);
    assert.equal(scan.scanIncomplete, true);
    assert.equal(scan.truncated, true);
  }
  assert.deepEqual(asyncScan, syncScan);

  const before = getProjectScanMetrics();
  const execFile = asyncGit((file, args) => {
    if (args.includes("--show-toplevel")) return root;
    if (args.includes("--abbrev-ref")) return "main";
    return "";
  });
  const project = await detectProjectAsync(root, { ...budgets, execFile });
  assert.ok(project.entriesSeen <= 64);
  assert.ok(project.dirsSeen <= 2);
  assert.ok(project.fileCount <= 10);
  assert.equal(project.scanIncomplete, true);
  assert.equal(project.scanMetrics.entriesSeen, project.entriesSeen);
  assert.equal(project.scanMetrics.gitCalls, 3);
  const after = getProjectScanMetrics();
  assert.equal(after.entriesSeen - before.entriesSeen, project.entriesSeen);
  assert.equal(after.directoriesSeen - before.directoriesSeen, project.dirsSeen);
});

test("oversized manifests are rejected without reading them into memory", (t) => {
  const root = makeTempDir("matrix-manifest-cap-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = JSON.stringify({ name: "oversized", scripts: { test: "node --test" } }).slice(
    0,
    -1,
  );
  writeFileSync(join(root, "package.json"), `${prefix}${" ".repeat(70 * 1024)}}`);
  const project = detectProject(root);
  assert.equal(project.packageJson, null);
  assert.equal(project.name, basename(root));
  assert.equal(project.test, null);
});

test("git clean, dirty, truncated and unavailable states stay explicit", async (t) => {
  const root = makeTempDir("matrix-git-states-");
  t.after(() => {
    invalidateProjectCache(root);
    rmSync(root, { recursive: true, force: true });
  });
  const outputError = new Error("simulated output cap");
  outputError.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
  const cases = [
    { output: "", status: "clean", dirty: 0, available: true },
    { output: " M a.mjs\n?? b.mjs\n", status: "dirty", dirty: 2, available: true },
    { output: outputError, status: "truncated", dirty: null, available: false },
    { output: new Error("status failed"), status: "unavailable", dirty: null, available: false },
    { output: ` M ${"x".repeat(256 * 1024)}`, status: "truncated", dirty: null, available: false },
  ];

  for (const fixture of cases) {
    const exec = (file, args) => {
      if (args.includes("--show-toplevel")) return root;
      if (args.includes("--abbrev-ref")) return "main";
      if (args.includes("status")) {
        if (fixture.output instanceof Error) throw fixture.output;
        return fixture.output;
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };
    const syncProject = detectProject(root, { exec });
    const asyncProject = await detectProjectAsync(root, {
      execFile: asyncGit(exec),
      cacheMs: 0,
    });
    for (const project of [syncProject, asyncProject]) {
      assert.equal(project.isGit, true);
      assert.equal(project.gitStatus, fixture.status);
      assert.equal(project.dirty, fixture.dirty);
      assert.equal(project.dirtyAvailable, fixture.available);
    }
  }
});

test("dirty git counts are not capped with the display list", (t) => {
  const root = makeTempDir("matrix-git-dirty-list-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lines = Array.from({ length: 205 }, (_, index) => ` M file-${index}.mjs`);
  const exec = (file, args) => {
    if (args.includes("--show-toplevel")) return root;
    if (args.includes("--abbrev-ref")) return "main";
    return lines.join("\n");
  };
  const project = detectProject(root, { exec });
  assert.equal(project.gitStatus, "dirty");
  assert.equal(project.dirty, 205);
  assert.equal(project.dirtyFiles.length, 200);
  assert.equal(project.dirtyFilesTruncated, true);
});

test("equivalent async requests deduplicate by canonical root", async (t) => {
  const root = makeTempDir("matrix-scan-dedupe-");
  t.after(() => {
    invalidateProjectCache(root);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "dedupe" }));
  writeFileSync(join(root, "a.mjs"), "export const a = 1;\n");
  symlinkSync(root, join(root, "alias"), "dir");

  let releaseStatus;
  let announceStatus;
  const statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const statusStarted = new Promise((resolve) => {
    announceStatus = resolve;
  });
  t.after(() => releaseStatus());
  let gitCalls = 0;
  const execFile = (file, args, options, callback) => {
    gitCalls++;
    setImmediate(() => {
      if (args.includes("--show-toplevel")) {
        callback(null, root, "");
      } else if (args.includes("--abbrev-ref")) {
        callback(null, "main", "");
      } else {
        announceStatus();
        statusGate.then(() => callback(null, "", ""));
      }
    });
  };
  const before = getProjectScanMetrics();
  const pending = Promise.all([
    detectProjectAsync(root, { execFile, cacheMs: 10_000, refresh: true }),
    detectProjectAsync(join(root, "."), { execFile, cacheMs: 10_000, refresh: true }),
    detectProjectAsync(join(root, "alias"), { execFile, cacheMs: 10_000, refresh: true }),
  ]);
  await statusStarted;
  for (let turn = 0; turn < 100; turn++) {
    if (getProjectScanMetrics().inFlightHits - before.inFlightHits >= 2) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const during = getProjectScanMetrics();
  assert.equal(during.inFlight, 1);
  releaseStatus();
  const projects = await pending;

  assert.equal(gitCalls, 3, "one root/branch/status sequence serves all equivalent callers");
  assert.equal(
    projects.filter((project) => project.scanMetrics.cacheStatus === "deduplicated").length,
    2,
  );
  assert.ok(projects.every((project) => project.root === root));
  assert.deepEqual(projects[0].files, projects[1].files);
  assert.deepEqual(projects[1].files, projects[2].files);
  const after = getProjectScanMetrics();
  assert.equal(after.scansStarted - before.scansStarted, 1);
  assert.equal(after.inFlightHits - before.inFlightHits, 2);
  assert.equal(after.inFlight, 0);
});

test("snapshot freshness, explicit refresh and manifest identity are observable", async (t) => {
  const root = makeTempDir("matrix-scan-freshness-");
  t.after(() => {
    invalidateProjectCache(root);
    rmSync(root, { recursive: true, force: true });
  });
  const manifest = join(root, "package.json");
  writeFileSync(manifest, JSON.stringify({ name: "alpha", scripts: { test: "node --test" } }));
  writeFileSync(join(root, "a.mjs"), "export const a = 1;\n");
  let gitCalls = 0;
  const execFile = asyncGit((file, args) => {
    gitCalls++;
    if (args.includes("--show-toplevel")) return root;
    if (args.includes("--abbrev-ref")) return "main";
    return "";
  });
  const options = { execFile, cacheMs: 60_000 };
  const before = getProjectScanMetrics();
  const first = await detectProjectAsync(root, options);
  const cached = await detectProjectAsync(root, options);
  assert.equal(cached.scanMetrics.cacheStatus, "cached");
  assert.equal(gitCalls, 3);
  assert.notEqual(cached, first, "cache callers receive isolated snapshots");

  cached.files.push({ rel: "poison.mjs" });
  const isolated = await detectProjectAsync(root, options);
  assert.equal(
    isolated.files.some((file) => file.rel === "poison.mjs"),
    false,
  );
  assert.equal(gitCalls, 3);

  writeFileSync(join(root, "b.mjs"), "export const b = 2;\n");
  assert.equal(invalidateProjectCache(root), 1);
  const invalidated = await detectProjectAsync(root, options);
  assert.ok(invalidated.files.some((file) => file.rel === "b.mjs"));
  assert.equal(gitCalls, 6);

  const unchangedManifest = await detectProjectAsync(root, { ...options, refresh: true });
  assert.equal(unchangedManifest.scanMetrics.manifestReads, 0);
  assert.ok(unchangedManifest.scanMetrics.manifestCacheHits >= 2);
  assert.equal(gitCalls, 9);

  writeFileSync(manifest, JSON.stringify({ name: "bravo", scripts: { test: "node --test" } }));
  const changedManifest = await detectProjectAsync(root, { ...options, refresh: true });
  assert.equal(changedManifest.name, "bravo", "same-length replacements invalidate manifest bytes");
  assert.equal(changedManifest.scanMetrics.manifestReads, 1);
  assert.equal(gitCalls, 12);

  await detectProjectAsync(root, { ...options, cacheMs: 0 });
  await detectProjectAsync(root, { ...options, cacheMs: 0 });
  assert.equal(gitCalls, 18, "a zero TTL cannot reuse even a same-millisecond snapshot");
  const after = getProjectScanMetrics();
  assert.equal(after.cacheHits - before.cacheHits, 2);
  assert.equal(after.scansStarted - before.scansStarted, 6);
  assert.ok(after.invalidations - before.invalidations >= 1);
});

test("write invalidation cannot cache or join an older in-flight scan", async (t) => {
  const root = makeTempDir("matrix-scan-invalidate-");
  t.after(() => {
    invalidateProjectCache(root);
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, "before.mjs"), "export const before = 1;\n");
  let releaseStatus;
  let announceStatus;
  const statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const statusStarted = new Promise((resolve) => {
    announceStatus = resolve;
  });
  t.after(() => releaseStatus());
  let statusCalls = 0;
  const execFile = (file, args, options, callback) => {
    setImmediate(() => {
      if (args.includes("--show-toplevel")) callback(null, root, "");
      else if (args.includes("--abbrev-ref")) callback(null, "main", "");
      else {
        statusCalls++;
        if (statusCalls === 1) {
          announceStatus();
          statusGate.then(() => callback(null, "", ""));
        } else {
          callback(null, "", "");
        }
      }
    });
  };

  const before = getProjectScanMetrics();
  const oldPending = detectProjectAsync(root, { execFile, cacheMs: 10_000 });
  await statusStarted;
  writeFileSync(join(root, "after.mjs"), "export const after = 2;\n");
  assert.equal(invalidateProjectCache(root), 0, "there is no completed snapshot yet");
  const freshPending = detectProjectAsync(root, { execFile, cacheMs: 10_000 });
  for (let turn = 0; turn < 100; turn++) {
    if (getProjectScanMetrics().queuedRequests - before.queuedRequests >= 1) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(getProjectScanMetrics().inFlight, 1);
  releaseStatus();
  const [oldProject, freshProject] = await Promise.all([oldPending, freshPending]);

  assert.equal(oldProject.snapshotStale, true);
  assert.equal(oldProject.scanMetrics.cacheStatus, "invalidated");
  assert.equal(freshProject.snapshotStale, false);
  assert.equal(freshProject.scanMetrics.cacheStatus, "scanned");
  assert.ok(freshProject.files.some((file) => file.rel === "after.mjs"));
  const after = getProjectScanMetrics();
  assert.equal(after.scansStarted - before.scansStarted, 2);
  assert.equal(after.queuedRequests - before.queuedRequests, 1);
  assert.equal(after.inFlightHits - before.inFlightHits, 0);
});

test("inferTestPlan finds pytest for Python projects", (t) => {
  const root = makeTempDir("matrix-plan-");
  t.after(() =>
    import("node:fs").then(({ rmSync }) => rmSync(root, { recursive: true, force: true })),
  );
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "test_x.py"), "def test_x():\n    assert True\n");
  const plan = inferTestPlan(root);
  assert.equal(plan.framework, "pytest");
  assert.equal(plan.file, "python3");
});

test("readFileSafe reports text, binary, missing and truncated files", (t) => {
  const root = makeTempDir("matrix-read-");
  t.after(() =>
    import("node:fs").then(({ rmSync }) => rmSync(root, { recursive: true, force: true })),
  );
  const text = join(root, "a.txt");
  const binary = join(root, "a.bin");
  const latin1 = join(root, "latin1.txt");
  writeFileSync(text, "hello\nworld\n");
  writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  writeFileSync(latin1, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  chmodSync(text, 0o640);
  const full = readFileSafe(text);
  assert.equal(full.ok, true);
  assert.equal(full.content, "hello\nworld\n");
  assert.equal(full.utf8, true);
  const lossy = readFileSafe(latin1);
  assert.equal(lossy.ok, true);
  assert.equal(lossy.utf8, false);
  assert.equal(lossy.content, "caf\uFFFD\n");
  assert.equal(readFileSafe(binary).ok, false);
  assert.equal(readFileSafe(join(root, "nope")).ok, false);
  const truncated = readFileSafe(text, { maxBytes: 5 });
  assert.equal(truncated.content, "hello");
  assert.equal(truncated.truncated, true);
});

test("project read cache validates identity before reusing bytes", (t) => {
  const root = makeTempDir("matrix-read-cache-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "source.txt");
  const project = { root };
  writeFileSync(path, "first\n");
  const first = readProjectFile(project, path);
  const cached = readProjectFile(project, path);
  assert.equal(first.ok, true);
  assert.equal(cached, first, "an unchanged identity uses the bounded project cache");

  writeFileSync(path, "other\n");
  const changed = readProjectFile(project, path);
  assert.equal(changed.ok, true);
  assert.equal(changed.content, "other\n");
  assert.notEqual(changed, first, "same-length replacements cannot reuse stale bytes");
});

test("no-match searches obey file and byte budgets and report partial work", (t) => {
  const root = makeTempDir("matrix-search-budget-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "source.txt");
  writeFileSync(path, "12345");
  const makeProject = (count) => ({
    root,
    files: Array.from({ length: count }, (_, index) => ({
      path,
      rel: `source-${index}.txt`,
      name: `source-${index}.txt`,
      size: 5,
      language: "text",
    })),
  });

  const files = searchRepo(makeProject(450), "absent");
  assert.equal(files.length, 0);
  assert.equal(files.scanned, 400);
  assert.equal(files.partial, true);
  assert.equal(files.reason, "file-budget");

  const bytes = searchRepo(makeProject(2), "absent", { maxBytes: 5 });
  assert.equal(bytes.scanned, 1);
  assert.equal(bytes.scannedBytes, 5);
  assert.equal(bytes.partial, true);
  assert.equal(bytes.reason, "byte-budget");

  const complete = searchRepo(makeProject(2), "absent", { maxFiles: 2, maxBytes: 10 });
  assert.equal(complete.scanned, 2);
  assert.equal(complete.partial, false);

  const controller = new AbortController();
  controller.abort();
  const aborted = searchRepo(makeProject(2), "absent", { signal: controller.signal });
  assert.equal(aborted.scanned, 0);
  assert.equal(aborted.partial, true);
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.reason, "aborted");
});

test("searchRepo returns real lines and honors case and glob filters", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const hits = searchRepo(project, "len(bounds)");
  assert.ok(hits.length >= 2);
  assert.ok(hits.every((hit) => hit.text.includes("len(bounds)") && hit.line > 0));
  assert.ok(searchRepo(project, "LEN(BOUNDS)", { caseSensitive: true }).length === 0);
  assert.ok(searchRepo(project, "class", { glob: "src/*.py" }).length > 0);
  assert.equal(searchRepo(project, "class", { glob: "tests/*.py" }).length, 0);
  assert.deepEqual(searchRepo(project, ""), []);
});

test("findFile and fileMentionedIn resolve natural-language paths", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  assert.equal(findFile(project, "processor.py")?.rel, "src/processor.py");
  assert.equal(findFile(project, "src/processor.py")?.rel, "src/processor.py");
  assert.equal(findFile(project, "nope.py"), null);
  assert.equal(fileMentionedIn("fix src/processor.py please", project)?.rel, "src/processor.py");
  assert.equal(fileMentionedIn("fix the bounds bug", project), null);
});

test("projectRootForFile and verifyContext stay inside a workspace", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const file = join(demo.workspace, "src", "processor.py");
  assert.equal(projectRootForFile(demo.workspace, file), demo.workspace);
  assert.equal(verifyContext(demo.workspace, file).root, demo.workspace);
  assert.ok(verifyContext(demo.workspace, "/etc/passwd").rel.startsWith(".."));
});
