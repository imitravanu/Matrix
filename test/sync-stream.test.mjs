import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  createSynchronizedStdout,
  isSyncSupported,
  SYNC_BEGIN,
  SYNC_END,
  SynchronizedStdout,
} from "../lib/sync-stream.mjs";

function makeTarget({ columns = 80, rows = 24, isTTY = true } = {}) {
  const target = new EventEmitter();
  target.columns = columns;
  target.rows = rows;
  target.isTTY = isTTY;
  target.writes = [];
  target.write = (text) => {
    target.writes.push(text);
    return true;
  };
  return target;
}

function nextMicrotask() {
  return new Promise((resolve) => queueMicrotask(resolve));
}

test("synchronized-output detection honors overrides and known terminals", () => {
  for (const env of [
    { TERM: "xterm-kitty" },
    { TERM: "ghostty" },
    { TERM: "wezterm" },
    { TERM_PROGRAM: "ghostty" },
    { TERM_PROGRAM: "WezTerm" },
    { TERM_PROGRAM: "iTerm.app" },
    { MATRIX_SYNC: "1", NO_COLOR: "1", CI: "1" },
  ]) {
    assert.equal(isSyncSupported(env), true, JSON.stringify(env));
  }
  for (const env of [
    {},
    { TERM: "xterm-256color" },
    { TERM: "xterm-kitty", NO_COLOR: "" },
    { TERM: "xterm-kitty", CI: "1" },
    { TERM: "xterm-kitty", MATRIX_SYNC: "0" },
  ]) {
    assert.equal(isSyncSupported(env), false, JSON.stringify(env));
  }
});

test("writes in one microtask batch into exactly one synchronized frame", async () => {
  const target = makeTarget();
  const stream = createSynchronizedStdout(target, { syncSupported: true });

  stream.write("first");
  stream.write(Buffer.from("+second"));
  stream.write("+third");
  assert.deepEqual(target.writes, [], "the target must not receive partial frames");

  await nextMicrotask();
  assert.deepEqual(target.writes, [SYNC_BEGIN + "first+second+third" + SYNC_END]);
  assert.equal(stream.frameCount, 1);

  await nextMicrotask();
  assert.deepEqual(target.writes, [SYNC_BEGIN + "first+second+third" + SYNC_END]);
});

test("explicit flush emits complete frames and the scheduled flush is idempotent", async () => {
  const target = makeTarget();
  const stream = new SynchronizedStdout(target, { syncSupported: true });

  stream.flush();
  assert.equal(stream.frameCount, 0);
  stream.write("one");
  stream.flush();
  stream.write("two");
  stream.flush();
  assert.deepEqual(target.writes, [SYNC_BEGIN + "one" + SYNC_END, SYNC_BEGIN + "two" + SYNC_END]);
  assert.equal(stream.frameCount, 2);

  await nextMicrotask();
  assert.equal(target.writes.length, 2, "queued microtasks must not duplicate manual flushes");
  stream.flush();
  assert.equal(stream.frameCount, 2, "an empty flush is not a frame");
});

test("unsupported or absent targets preserve bytes and frame accounting honestly", () => {
  const target = makeTarget();
  const plain = new SynchronizedStdout(target, { syncSupported: false });
  plain.write("plain-text");
  plain.flush();
  assert.deepEqual(target.writes, ["plain-text"]);
  assert.equal(plain.frameCount, 1);

  const missing = new SynchronizedStdout(null, { syncSupported: true });
  missing.write("not-written");
  missing.flush();
  assert.equal(missing.frameCount, 0);
});

test("terminal dimensions, TTY state, and window-size calls forward dynamically", () => {
  const target = makeTarget({ columns: 132, rows: 43, isTTY: true });
  let sizeCalls = 0;
  target.getWindowSize = () => {
    sizeCalls += 1;
    return [130, 41];
  };
  const stream = new SynchronizedStdout(target, { syncSupported: false });

  assert.equal(stream.columns, 132);
  assert.equal(stream.rows, 43);
  assert.equal(stream.isTTY, true);
  assert.deepEqual(stream.getWindowSize(), [130, 41]);
  assert.equal(sizeCalls, 1);

  target.columns = 90;
  target.rows = 28;
  target.isTTY = false;
  delete target.getWindowSize;
  assert.deepEqual(stream.getWindowSize(), [90, 28]);
  assert.equal(stream.isTTY, false);

  const fallback = new SynchronizedStdout(null);
  assert.equal(fallback.columns, 80);
  assert.equal(fallback.rows, 24);
  assert.equal(fallback.isTTY, false);
  assert.deepEqual(fallback.getWindowSize(), [80, 24]);
});

test("on, addListener, once, off, and removeListener manage both event emitters", () => {
  const target = makeTarget();
  const stream = new SynchronizedStdout(target, { syncSupported: false });
  let resizeCalls = 0;
  const onResize = () => {
    resizeCalls += 1;
  };

  assert.equal(stream.on("resize", onResize), stream);
  assert.equal(target.listenerCount("resize"), 1);
  assert.equal(stream.listenerCount("resize"), 1);
  target.emit("resize");
  stream.emit("resize");
  assert.equal(resizeCalls, 2);

  assert.equal(stream.off("resize", onResize), stream);
  assert.equal(target.listenerCount("resize"), 0);
  assert.equal(stream.listenerCount("resize"), 0);
  target.emit("resize");
  stream.emit("resize");
  assert.equal(resizeCalls, 2);

  stream.addListener("resize", onResize);
  assert.equal(target.listenerCount("resize"), 1);
  assert.equal(stream.listenerCount("resize"), 1);
  stream.removeListener("resize", onResize);
  assert.equal(target.listenerCount("resize"), 0);
  assert.equal(stream.listenerCount("resize"), 0);

  let onceCalls = 0;
  const onceResize = () => {
    onceCalls += 1;
  };
  stream.once("resize", onceResize);
  assert.equal(target.listenerCount("resize"), 1);
  assert.equal(stream.listenerCount("resize"), 1);
  target.emit("resize");
  target.emit("resize");
  assert.equal(onceCalls, 1);
  stream.emit("resize");
  stream.emit("resize");
  assert.equal(onceCalls, 2);
  assert.equal(target.listenerCount("resize"), 0);
  assert.equal(stream.listenerCount("resize"), 0);

  stream.once("resize", onceResize);
  stream.removeListener("resize", onceResize);
  assert.equal(target.listenerCount("resize"), 0);
  assert.equal(stream.listenerCount("resize"), 0);
  target.emit("resize");
  stream.emit("resize");
  assert.equal(
    onceCalls,
    2,
    "removing a once listener by its original callback cleans both emitters",
  );
});
