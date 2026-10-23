import test from "node:test";
import assert from "node:assert/strict";

import {
  applyEdits,
  applyHunks,
  applyUnifiedDiff,
  diffLineArrays,
  diffStatsFromText,
  hunkStats,
  joinLines,
  makeUnifiedDiff,
  normalizeEdit,
  parseUnifiedDiff,
  proposeEdits,
  splitLines,
} from "../lib/diff.mjs";

const OLD = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
const NEW = "alpha\nbeta\ngamma changed\ndelta\nepsilon\n";

test("splitLines preserves EOL style and final newline", () => {
  assert.deepEqual(splitLines("a\r\nb\r\n"), { lines: ["a", "b"], eol: "\r\n", finalNewline: true });
  assert.deepEqual(splitLines("a\nb"), { lines: ["a", "b"], eol: "\n", finalNewline: false });
  assert.equal(joinLines(["a", "b"], { finalNewline: false }), "a\nb");
  assert.equal(joinLines(["a"], { eol: "\r\n" }), "a\r\n");
});

test("diffLineArrays marks context, deletions and additions", () => {
  const rows = diffLineArrays(["a", "b", "c"], ["a", "x", "c"]);
  assert.deepEqual(rows, [
    { type: "ctx", text: "a" },
    { type: "del", text: "b" },
    { type: "add", text: "x" },
    { type: "ctx", text: "c" },
  ]);
  assert.deepEqual(diffLineArrays([], []), []);
});

test("makeUnifiedDiff and parseUnifiedDiff round-trip a real change", () => {
  const patch = makeUnifiedDiff(OLD, NEW, { file: "src/x.txt" });
  assert.ok(patch.includes("--- a/src/x.txt"));
  assert.ok(patch.includes("+++ b/src/x.txt"));
  assert.ok(patch.includes("-gamma"));
  assert.ok(patch.includes("+gamma changed"));
  const parsed = parseUnifiedDiff(patch);
  assert.equal(parsed.hunks.length, 1);
  assert.equal(parsed.hunks[0].oldLines, 5);
  assert.equal(parsed.hunks[0].newLines, 5);
  assert.deepEqual(hunkStats(parsed.hunks), { adds: 1, dels: 1, context: 4 });
  assert.equal(applyHunks(OLD, parsed.hunks).text, NEW);
  assert.equal(applyUnifiedDiff(OLD, patch).text, NEW);
});

test("applyHunks refuses a patch whose context no longer matches", () => {
  const patch = makeUnifiedDiff(OLD, NEW);
  const result = applyHunks(OLD.replace("beta", "BETA"), parseUnifiedDiff(patch).hunks);
  assert.equal(result.ok, false);
  assert.match(result.error, /context|hunk/i);
});

test("normalizeEdit handles insertion, replacement arrays and newline trimming", () => {
  assert.deepEqual(normalizeEdit({ startLine: 3, endLine: 4, replacement: "x\n" }), {
    startLine: 3,
    endLine: 4,
    replacementLines: ["x"],
    reason: "",
  });
  assert.deepEqual(normalizeEdit({ startLine: 1, endLine: 1, replacement: ["a", "b"] }).replacementLines, ["a", "b"]);
  assert.equal(normalizeEdit({ startLine: 0, endLine: -2, replacement: "r" }).startLine, 1);
});

test("applyEdits supports insert, delete, replace and multiple disjoint edits", () => {
  const inserted = applyEdits("a\nb\n", [{ startLine: 2, endLine: 2, replacement: "x\n" }]);
  assert.equal(inserted.text, "a\nx\nb\n");
  const deleted = applyEdits("a\nb\nc\n", [{ startLine: 2, endLine: 3, replacement: "" }]);
  assert.equal(deleted.text, "a\nc\n");
  const replaced = applyEdits("a\nb\nc\n", [{ startLine: 2, endLine: 3, replacement: "B\n" }]);
  assert.equal(replaced.text, "a\nB\nc\n");
  const multiple = applyEdits("a\nb\nc\nd\n", [
    { startLine: 1, endLine: 2, replacement: "A\n" },
    { startLine: 3, endLine: 4, replacement: "C\n" },
  ]);
  assert.equal(multiple.text, "A\nb\nC\nd\n");
});

test("applyEdits rejects overlapping and out-of-range edits", () => {
  const overlap = applyEdits("a\nb\nc\n", [
    { startLine: 1, endLine: 3, replacement: "x\n" },
    { startLine: 2, endLine: 3, replacement: "y\n" },
  ]);
  assert.equal(overlap.ok, false);
  assert.match(overlap.error, /Overlapping/);
  const outside = applyEdits("a\n", [{ startLine: 9, endLine: 10, replacement: "x" }]);
  assert.equal(outside.ok, false);
  assert.match(outside.error, /outside/);
});

test("proposeEdits produces a validated patch and stats", () => {
  const proposed = proposeEdits(OLD, [{ startLine: 3, endLine: 4, replacement: "gamma changed\n" }], { file: "src/x.txt" });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.updatedText, NEW);
  assert.deepEqual(proposed.stats, { adds: 1, dels: 1, changed: 2 });
  assert.equal(proposed.patch.includes("gamma changed"), true);
  assert.equal(proposeEdits(OLD, [{ startLine: 3, endLine: 4, replacement: "gamma" }]).patch, "");
});

test("diffStatsFromText ignores file headers", () => {
  assert.deepEqual(diffStatsFromText("--- a/x\n+++ b/x\n+one\n-two\n"), { adds: 1, dels: 1, changed: 2 });
});
