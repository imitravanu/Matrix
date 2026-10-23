import test from "node:test";
import assert from "node:assert/strict";

import { parseTerminalMouse, isMouseSequence } from "../lib/mouse.mjs";

test("parseTerminalMouse handles wheel up and down in SGR 1006 format", () => {
  // With leading ESC
  const up = parseTerminalMouse("\x1b[<64;20;10M");
  assert.ok(up);
  assert.equal(up.direction, "up");
  assert.equal(up.col, 20);
  assert.equal(up.row, 10);
  assert.equal(up.isWheel, true);

  // Without leading ESC (stripped by terminal parser)
  const down = parseTerminalMouse("[<65;35;15M");
  assert.ok(down);
  assert.equal(down.direction, "down");
  assert.equal(down.col, 35);
  assert.equal(down.row, 15);
  assert.equal(down.isWheel, true);
});

test("parseTerminalMouse masks modifier flags on wheel events", () => {
  // Shift (4) + wheel up (64) = 68
  const shiftUp = parseTerminalMouse("[<68;10;5M");
  assert.equal(shiftUp?.direction, "up");

  // Meta (8) + wheel down (65) = 73
  const metaDown = parseTerminalMouse("[<73;10;5M");
  assert.equal(metaDown?.direction, "down");
});

test("parseTerminalMouse handles clicks and movement", () => {
  // Left button press (0)
  const press = parseTerminalMouse("[<0;12;8M");
  assert.ok(press);
  assert.equal(press.direction, null);
  assert.equal(press.isWheel, false);
  assert.equal(press.isRelease, false);
  assert.equal(press.col, 12);
  assert.equal(press.row, 8);

  // Left button release (0m)
  const release = parseTerminalMouse("[<0;12;8m");
  assert.ok(release);
  assert.equal(release.isRelease, true);

  // Mouse motion (32)
  const motion = parseTerminalMouse("[<32;15;9M");
  assert.ok(motion);
  assert.equal(motion.button, 32);
});

test("parseTerminalMouse rejects invalid and non-mouse inputs safely", () => {
  assert.equal(parseTerminalMouse(""), null);
  assert.equal(parseTerminalMouse(null), null);
  assert.equal(parseTerminalMouse(undefined), null);
  assert.equal(parseTerminalMouse("hello world"), null);
  assert.equal(parseTerminalMouse("/help"), null);
  assert.equal(parseTerminalMouse("\x1b[A"), null); // Arrow up is not mouse
});

test("isMouseSequence detects mouse telemetry", () => {
  assert.equal(isMouseSequence("[<64;1;1M"), true);
  assert.equal(isMouseSequence("[<65;1;1M"), true);
  assert.equal(isMouseSequence("[<0;1;1M"), true);
  assert.equal(isMouseSequence("hello"), false);
});
