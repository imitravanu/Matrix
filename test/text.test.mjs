import test from "node:test";
import assert from "node:assert/strict";

import {
  charWidth,
  clamp,
  codePointWidth,
  displayWidth,
  formatBytes,
  formatDuration,
  oneLine,
  padToWidth,
  plural,
  sanitizeText,
  stripAnsi,
  truncateToWidth,
  wrapToWidth,
} from "../lib/text.mjs";

test("stripAnsi removes SGR, OSC, kitty and cursor sequences", () => {
  const input = "\x1b[31mred\x1b[0m \x1b]8;;https://x\x07link\x1b]8;;\x07 \x1b_Gi=1;AAAA\x1b\\ \x1b[?25l";
  assert.equal(stripAnsi(input), "red link  ");
});

test("displayWidth measures columns, not UTF-16 code units", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("リンゴ"), 6);
  assert.equal(displayWidth("🙂"), 2);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(displayWidth("\x1b[1mabc\x1b[0m"), 3);
  assert.equal(charWidth("リン"), 2);
  assert.equal(codePointWidth(0x0301), 0);
});

test("truncateToWidth respects cells and never splits a wide glyph", () => {
  assert.equal(truncateToWidth("abcdef", 1), "…");
  assert.equal(truncateToWidth("abcdef", 1, ""), "a");
  assert.equal(truncateToWidth("abcdef", 4), "abc…");
  assert.equal(truncateToWidth("リンゴ", 4), "リ…");
  assert.equal(truncateToWidth("short", 10), "short");
  assert.equal(truncateToWidth("abcdef", 0, ""), "");
});

test("padToWidth produces exactly the requested cell count", () => {
  assert.equal(displayWidth(padToWidth("x", 5)), 5);
  assert.equal(padToWidth("x", 5, "right"), "    x");
  assert.equal(padToWidth("x", 4, "center"), " x  ");
  assert.equal(displayWidth(padToWidth("リンゴ", 5)), 5);
});

test("wrapToWidth wraps words, preserves paragraphs, and hard-splits long tokens", () => {
  assert.deepEqual(wrapToWidth("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapToWidth("a\n\nb", 10), ["a", "", "b"]);
  const long = "x".repeat(20);
  const parts = wrapToWidth(long, 8);
  assert.ok(parts.length >= 3);
  for (const line of parts) assert.ok(displayWidth(line) <= 8);
});

test("wrapToWidth keeps indentation on continuation lines", () => {
  const parts = wrapToWidth("    alpha beta gamma", 12);
  assert.ok(parts.length >= 2);
  assert.ok(parts[0].startsWith("    "));
  assert.ok(parts[1].startsWith("    "));
});

test("sanitizeText and oneLine remove terminal-corrupting input", () => {
  assert.equal(sanitizeText("a\u0000b\u0007c\nd"), "abc\nd");
  assert.equal(oneLine("  a\n b\t c  "), "a b c");
  assert.equal(oneLine("abcdef", 3), "ab…");
});

test("formatDuration and formatBytes are deterministic", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(61_000), "1m 01s");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1024 * 1024), "1 MB");
});

test("clamp, plural and codePointWidth handle edges", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(2, "file"), "2 files");
  assert.equal(codePointWidth(0), 0);
});
