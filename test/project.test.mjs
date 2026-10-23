import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  detectProject,
  fileMentionedIn,
  findFile,
  inferTestPlan,
  isBinaryPath,
  languageForPath,
  projectRootForFile,
  readFileSafe,
  searchRepo,
  verifyContext,
  walkFiles,
} from "../lib/project.mjs";
import { copyDemo, makeTempDir } from "./helpers.mjs";

test("detectProject indexes the real demo project", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  assert.equal(project.name, "demo-project");
  assert.equal(project.fileCount, 2);
  assert.equal(project.test.framework, "pytest");
  assert.equal(project.test.display, "python3 -m pytest -q");
  assert.ok(project.languages.some((language) => language.name === "python" && language.files === 2));
  assert.ok(project.files.some((file) => file.rel === "src/processor.py"));
  assert.equal(project.branch, null);
  assert.equal(project.dirty, 0);
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
  assert.deepEqual(files.map((file) => file.rel), ["src/app.js"]);
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
  assert.deepEqual(files.map((file) => file.rel), ["src/app.js"]);
});

test("inferTestPlan finds pytest for Python projects", (t) => {
  const root = makeTempDir("matrix-plan-");
  t.after(() => import("node:fs").then(({ rmSync }) => rmSync(root, { recursive: true, force: true })));
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "test_x.py"), "def test_x():\n    assert True\n");
  const plan = inferTestPlan(root);
  assert.equal(plan.framework, "pytest");
  assert.equal(plan.file, "python3");
});

test("readFileSafe reports text, binary, missing and truncated files", (t) => {
  const root = makeTempDir("matrix-read-");
  t.after(() => import("node:fs").then(({ rmSync }) => rmSync(root, { recursive: true, force: true })));
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
