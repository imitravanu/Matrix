import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { detectProject } from "../lib/project.mjs";
import { parseScopes } from "../lib/scope.mjs";
import {
  buildGroundedAnswer,
  classifyTask,
  extractKeywords,
  findIdentifier,
  findSliceOffByOne,
  targetFileForTask,
} from "../lib/task.mjs";
import { copyDemo } from "./helpers.mjs";

test("classifyTask separates rename, test, fix and explain intents", () => {
  assert.deepEqual(classifyTask("rename foo to bar"), {
    intent: "rename",
    from: "foo",
    to: "bar",
    text: "rename foo to bar",
  });
  assert.equal(classifyTask("run the tests").intent, "test");
  assert.equal(classifyTask("/test").intent, "test");
  assert.equal(classifyTask("fix the off-by-one in processor.py").intent, "fix");
  assert.equal(classifyTask("explain the allocator").intent, "explain");
  assert.equal(classifyTask("").intent, "explain");
});

test("extractKeywords drops stopwords and de-duplicates", () => {
  assert.deepEqual(extractKeywords("Fix the bounds bug in src/processor.py"), [
    "bounds",
    "src",
    "processor.py",
  ]);
  assert.deepEqual(extractKeywords("the and fix"), []);
  assert.deepEqual(extractKeywords("a b c d", { limit: 2 }), []);
});

test("findSliceOffByOne recognises Python and JS slice bugs", () => {
  const python = "    context = bounds[0:len(bounds) - 1]\n";
  const js = "const tail = items.slice(0, items.length - 1);\n";
  const size = "const tail = Array.from(list).slice(0, list.size - 1);\n";
  const hits = findSliceOffByOne(python + js + size);
  assert.equal(hits.length, 3);
  assert.equal(hits[0].line, 1);
  assert.match(hits[0].after, /bounds\[0:len\(bounds\)\]/);
  assert.match(hits[1].after, /items\.slice\(0, items\.length\)/);
  assert.match(hits[2].after, /\.slice\(0, list\.size\)/);
});

test("findSliceOffByOne ignores string and comment examples", () => {
  const js = [
    'const note = "use items.slice(0, items.length - 1)";',
    "// items.slice(0, items.length - 1)",
    "/* items.slice(0, items.length - 1) */",
    "const real = items.slice(0, items.length - 1);",
  ].join("\n");
  const jsHits = findSliceOffByOne(js, { language: "javascript" });
  assert.equal(jsHits.length, 1);
  assert.equal(jsHits[0].line, 4);
  assert.equal(jsHits[0].after, "const real = items.slice(0, items.length);");

  const python = [
    '"""',
    "bounds = items[0:len(items) - 1]",
    '"""',
    "# items[0:len(items) - 1]",
    "context = bounds[0:len(bounds) - 1]",
  ].join("\n");
  const pythonHits = findSliceOffByOne(python, { language: "python" });
  assert.equal(pythonHits.length, 1);
  assert.equal(pythonHits[0].line, 5);
});

test("findSliceOffByOne preserves strings beside a real slice", () => {
  const line =
    'const label = "items.slice(0, items.length - 1)"; const tail = items.slice(0, items.length - 1);';
  const hits = findSliceOffByOne(line, { language: "javascript" });
  assert.equal(hits.length, 1);
  assert.match(hits[0].after, /"items\.slice\(0, items\.length - 1\)"/);
  assert.match(hits[0].after, /const tail = items\.slice\(0, items\.length\)/);
});

test("findSliceOffByOne never rewrites valid last-element indexing", () => {
  const valid = [
    "const last = items[items.length - 1];",
    "const fromLast = items.slice(items.length - 1);",
    "const one = items.slice(0, -1);",
    "return bounds[len(bounds) - 1];",
    "# return bounds[0:len(bounds) - 1]",
    "// return items.slice(0, items.length - 1)",
    "const x = a[b - 1];",
  ].join("\n");
  assert.equal(findSliceOffByOne(valid).length, 0);
});

test("findSliceOffByOne handles Python stop bounds and JS method variants", () => {
  const source = [
    "items[0: len(items) - 1]",
    "items[0:len(items) - 1:2]",
    "text.substring(0, text.length - 1)",
    "bytes.subarray(0, bytes.length - 1)",
  ].join("\n");
  const hits = findSliceOffByOne(source);
  assert.equal(hits.length, 4);
  assert.equal(hits[0].after, "items[0: len(items)]");
  assert.equal(hits[1].after, "items[0:len(items):2]");
  assert.equal(hits[2].after, "text.substring(0, text.length)");
  assert.equal(hits[3].after, "bytes.subarray(0, bytes.length)");
});

test("findIdentifier returns every whole-word occurrence", () => {
  const hits = findIdentifier("foo foobar foo\nbar foo\n", "foo");
  assert.deepEqual(
    hits.map((hit) => [hit.line, hit.column]),
    [
      [1, 1],
      [1, 12],
      [2, 5],
    ],
  );
  assert.deepEqual(findIdentifier("nothing", "foo"), []);
});

test("targetFileForTask prefers explicit paths and then filename keywords", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  assert.equal(targetFileForTask("fix src/processor.py", project).confidence, "explicit");
  assert.equal(targetFileForTask("processor", project).file?.rel, "src/processor.py");
  assert.equal(targetFileForTask("make it better", project).confidence, "none");
});

test("buildGroundedAnswer cites only searched lines and never claims an edit", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const matches = [
    { rel: "src/processor.py", line: 20, text: "        context = bounds[0:len(bounds) - 1]" },
  ];
  const answer = buildGroundedAnswer({
    task: "explain the bounds slice",
    project,
    matches,
    file: project.files[0],
  });
  assert.match(answer, /Workspace: demo-project/);
  assert.match(answer, /Detected runner: python3 -m pytest -q/);
  assert.match(answer, /src\/processor\.py:20/);
  assert.match(answer, /No files were modified/);
  const empty = buildGroundedAnswer({ task: "explain", project, matches: [] });
  assert.match(empty, /No matching source lines found/);
});

test("the demo processor parses and its bug is precisely located", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const source = readFileSync(`${demo.workspace}/src/processor.py`, "utf8");
  const hits = findSliceOffByOne(source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 20);
  const parsed = parseScopes(source, "src/processor.py");
  assert.ok(
    parsed.flat.some(
      (node) => node.name === "process_bounds" && node.startLine <= 20 && node.endLine >= 20,
    ),
  );
});
