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
  assert.deepEqual(splitLines("a\r\nb\r\n"), {
    lines: ["a", "b"],
    eol: "\r\n",
    finalNewline: true,
  });
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

test("multi-hunk patches use original coordinates and round-trip exactly", () => {
  const original = Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join("\n") + "\n";
  const variants = [
    [
      "line1",
      "line2",
      "inserted",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line9 changed",
      "line10",
      "line11",
      "line12",
    ],
    [
      "line1",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line9 changed",
      "line10",
      "line11",
      "line12",
    ],
    [
      "line1",
      "line2a",
      "line2b",
      "line2c",
      "line3",
      "line4",
      "line5",
      "line6",
      "line7",
      "line8",
      "line10",
      "line11",
      "line12",
    ],
  ];
  for (const lines of variants) {
    const updated = lines.join("\n") + "\n";
    const patch = makeUnifiedDiff(original, updated);
    assert.ok((patch.match(/@@/g) ?? []).length >= 2);
    const applied = applyUnifiedDiff(original, patch);
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.text, updated);
  }
});

test("EOF newline and EOL transitions round-trip with explicit metadata", () => {
  const cases = [
    ["a", "a\n"],
    ["a\n", "a"],
    ["", "\n"],
    ["\n", ""],
    ["a\nb\n", "a\r\nb\r\n"],
    ["a\r\nb\r\n", "a\nb\n"],
    ["a\nb", "a\r\nB\r\n"],
  ];
  for (const [original, updated] of cases) {
    const patch = makeUnifiedDiff(original, updated, { file: "x.txt" });
    assert.ok(patch.length > 0);
    const applied = applyUnifiedDiff(original, patch);
    assert.equal(applied.ok, true, applied.error);
    assert.equal(
      applied.text,
      updated,
      `round trip ${JSON.stringify(original)} → ${JSON.stringify(updated)}`,
    );
  }
  assert.match(makeUnifiedDiff("a\nb\n", "a\r\nb\r\n"), /\\ EOL: CRLF/);
  assert.match(makeUnifiedDiff("a", "a\n"), /\\ Final newline: yes/);
});

test("standard no-newline markers are applied to the correct side", () => {
  const patch = "@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+a\n";
  assert.equal(applyUnifiedDiff("a", patch).text, "a\n");
  const deletion = "@@ -1,1 +0,0 @@\n-a\n\\ No newline at end of file\n";
  assert.equal(applyUnifiedDiff("a", deletion).text, "");
});

test("mixed-EOL edits are rejected instead of rewriting unchanged lines", () => {
  const mixed = "a\nb\r\nc\n";
  assert.equal(makeUnifiedDiff(mixed, mixed), "");
  assert.throws(() => makeUnifiedDiff(mixed, mixed.replace("b", "B")), /Mixed line endings/);
  const edited = applyEdits(mixed, [{ startLine: 2, endLine: 3, replacement: "B" }]);
  assert.equal(edited.ok, false);
  assert.match(edited.error, /Mixed line endings/);
  const patch = makeUnifiedDiff("a\nb\nc\n", "a\nB\nc\n");
  const applied = applyUnifiedDiff(mixed, patch);
  assert.equal(applied.ok, false);
  assert.match(applied.error, /Mixed line endings/);
});

test("deterministic multi-edit and encoding fixtures round-trip exactly", () => {
  let seed = 17;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  for (let sample = 0; sample < 60; sample++) {
    const original =
      Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n") +
      (sample % 2 ? "\n" : "");
    const lines = original.split("\n");
    if (original.endsWith("\n")) lines.pop();
    for (const index of new Set(
      [2, 8, 17].map((base) => Math.min(lines.length - 1, base + Math.floor(random() * 3))),
    )) {
      const choice = random();
      if (choice < 0.33) lines.splice(index, 0, `inserted ${sample}-${index}`);
      else if (choice < 0.66) lines.splice(index, 1, `changed ${sample}-${index}`);
      else if (lines.length > 4) lines.splice(index, 1);
    }
    const eol = sample % 3 === 0 ? "\r\n" : "\n";
    const updated = lines.join(eol) + (sample % 4 < 2 ? eol : "");
    const patch = makeUnifiedDiff(original, updated);
    const applied = applyUnifiedDiff(original, patch);
    assert.equal(applied.ok, true, applied.error);
    assert.equal(applied.text, updated, `sample ${sample}`);
  }
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
  assert.deepEqual(
    normalizeEdit({ startLine: 1, endLine: 1, replacement: ["a", "b"] }).replacementLines,
    ["a", "b"],
  );
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
  for (const edit of [
    { replacement: "X" },
    { startLine: Number.NaN, endLine: 1, replacement: "X" },
    { startLine: 1, endLine: Number.POSITIVE_INFINITY, replacement: "X" },
  ]) {
    const invalid = applyEdits("a\n", [edit]);
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /finite numbers/);
  }
});

test("proposeEdits produces a validated patch and stats", () => {
  const proposed = proposeEdits(
    OLD,
    [{ startLine: 3, endLine: 4, replacement: "gamma changed\n" }],
    { file: "src/x.txt" },
  );
  assert.equal(proposed.ok, true);
  assert.equal(proposed.updatedText, NEW);
  assert.deepEqual(proposed.stats, { adds: 1, dels: 1, changed: 2 });
  assert.equal(proposed.patch.includes("gamma changed"), true);
  assert.equal(proposeEdits(OLD, [{ startLine: 3, endLine: 4, replacement: "gamma" }]).patch, "");
});

test("diffStatsFromText ignores file headers but counts header-like source lines", () => {
  assert.deepEqual(diffStatsFromText("--- a/x\n+++ b/x\n+one\n-two\n"), {
    adds: 1,
    dels: 1,
    changed: 2,
  });
  assert.deepEqual(
    diffStatsFromText("--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n--- deleted source\n+++ added source\n"),
    { adds: 1, dels: 1, changed: 2 },
  );
});
