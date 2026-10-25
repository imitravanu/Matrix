import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";

import {
  canDrawWordmark,
  FRAME_PAD_X,
  layout,
  MIN_COLS,
  MIN_ROWS,
  reducedMotion,
  screenReaderMode,
  terminalSize,
  useLayout,
} from "../lib/term.mjs";
import { frameText, patchEnv } from "./helpers.mjs";

function stubStdout(t, values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(process.stdout, key));
    Object.defineProperty(process.stdout, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else delete process.stdout[key];
    }
  });
}

test("terminalSize gives valid MATRIX_COLS and MATRIX_ROWS precedence over live stdout", (t) => {
  stubStdout(t, { getWindowSize: () => [92, 27] });
  t.after(patchEnv({ MATRIX_COLS: "118", MATRIX_ROWS: "37" }));
  assert.deepEqual(terminalSize(), { cols: 118, rows: 37 });
});

test("terminalSize uses getWindowSize before column and row properties", (t) => {
  stubStdout(t, {
    getWindowSize: () => [91, 26],
    columns: 110,
    rows: 50,
  });
  t.after(patchEnv({ MATRIX_COLS: undefined, MATRIX_ROWS: undefined }));
  assert.deepEqual(terminalSize(), { cols: 91, rows: 26 });
});

test("terminalSize falls back to stdout properties when getWindowSize is unavailable", (t) => {
  stubStdout(t, { getWindowSize: undefined, columns: 72, rows: 22 });
  t.after(patchEnv({ MATRIX_COLS: undefined, MATRIX_ROWS: undefined }));
  assert.deepEqual(terminalSize(), { cols: 72, rows: 22 });
});

test("terminalSize rejects invalid environment and live dimensions", (t) => {
  stubStdout(t, { getWindowSize: () => [0, Number.NaN], columns: 70, rows: 20 });
  t.after(patchEnv({ MATRIX_COLS: "0", MATRIX_ROWS: "not-a-number" }));
  assert.deepEqual(terminalSize(), { cols: 80, rows: 30 });
});

test("terminalSize survives stdout geometry errors and has deterministic defaults", (t) => {
  stubStdout(t, {
    getWindowSize() {
      throw new Error("stdout is not a terminal");
    },
  });
  t.after(patchEnv({ MATRIX_COLS: "", MATRIX_ROWS: "   " }));
  assert.deepEqual(terminalSize(), { cols: 80, rows: 30 });
});

test("layout derives content, height, and rules from one geometry", () => {
  assert.deepEqual(layout({ cols: 80, rows: 30 }), {
    cols: 80,
    rows: 30,
    content: 78,
    height: 29,
    rule: "─".repeat(78),
  });
  assert.equal(FRAME_PAD_X, 1);
  assert.equal(layout({ cols: 140, rows: 40 }).rule.length, 138);
});

test("layout enforces minimum content and non-scrolling height at tiny sizes", () => {
  for (const size of [
    { cols: 0, rows: 0 },
    { cols: MIN_COLS, rows: MIN_ROWS },
    { cols: 4, rows: 2 },
  ]) {
    const result = layout(size);
    assert.equal(result.cols, size.cols);
    assert.equal(result.rows, size.rows);
    assert.equal(result.content, MIN_COLS - FRAME_PAD_X);
    assert.equal(result.height, MIN_ROWS);
    assert.equal(result.rule, "─".repeat(MIN_COLS - FRAME_PAD_X));
  }
  assert.equal(layout({ cols: 21, rows: 11 }).content, 19);
  assert.equal(layout({ cols: 22, rows: 12 }).content, 20);
  assert.equal(layout({ cols: 22, rows: 12 }).height, 11);
});

test("wordmark layout respects exact thresholds and the ASCII override", (t) => {
  const restoreEnvironment = patchEnv({ MATRIX_ASCII: undefined });
  t.after(restoreEnvironment);
  assert.equal(canDrawWordmark({ cols: 49, rows: 16 }), true);
  assert.equal(canDrawWordmark({ cols: 48, rows: 16 }), false);
  assert.equal(canDrawWordmark({ cols: 49, rows: 15 }), false);

  restoreEnvironment();
  const restore = patchEnv({ MATRIX_ASCII: "1" });
  t.after(restore);
  assert.equal(canDrawWordmark({ cols: 140, rows: 40 }), false);
});

test("useLayout shares environment-driven geometry with static rendering", (t) => {
  t.after(patchEnv({ MATRIX_COLS: "63", MATRIX_ROWS: "23" }));
  function Probe() {
    const current = useLayout();
    return React.createElement(
      Text,
      null,
      `${current.cols}x${current.rows}:${current.content}/${current.height}`,
    );
  }
  const app = render(React.createElement(Probe));
  try {
    assert.match(frameText(app), /63x23:61\/22/);
  } finally {
    app.unmount();
  }
});

test("reduced motion and screen-reader modes are explicit and compatible", () => {
  assert.equal(reducedMotion({}), false);
  assert.equal(screenReaderMode({}), false);
  assert.equal(reducedMotion({ MATRIX_REDUCED_MOTION: "1" }), true);
  assert.equal(reducedMotion({ MATRIX_REDUCED_MOTION: "true" }), true);
  assert.equal(screenReaderMode({ INK_SCREEN_READER: "1" }), true);
  assert.equal(screenReaderMode({ INK_SCREEN_READER: "true" }), true);
  assert.equal(reducedMotion({ INK_SCREEN_READER: "true" }), true);
});
