import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_EXIT,
  _resetAltScreenForTests,
  enterAltScreen,
  exitAltScreen,
  isAltScreenActive,
  isAltScreenSupported,
} from "../lib/alt-screen.mjs";

const ALT_SCREEN_MODULE = new URL("../lib/alt-screen.mjs", import.meta.url).href;
const HOOK_EVENTS = ["exit", "SIGINT", "SIGTERM", "uncaughtException"];

function listenerCounts() {
  return Object.fromEntries(HOOK_EVENTS.map((event) => [event, process.listenerCount(event)]));
}

function outputStream() {
  const writes = [];
  return {
    writes,
    stream: {
      isTTY: true,
      write(text) {
        writes.push(text);
      },
    },
  };
}

afterEach(() => {
  exitAltScreen();
  _resetAltScreenForTests();
});

test("alternate-screen support requires a capable TTY and respects opt-outs", () => {
  const stream = { isTTY: true };
  assert.equal(isAltScreenSupported(stream, { TERM: "xterm-256color" }), true);
  assert.equal(isAltScreenSupported({ isTTY: false }, { TERM: "xterm" }), false);
  assert.equal(isAltScreenSupported(null, { TERM: "xterm" }), false);
  assert.equal(isAltScreenSupported(stream, { TERM: "dumb" }), false);
  assert.equal(isAltScreenSupported(stream, { TERM: "xterm", MATRIX_NO_ALT_SCREEN: "1" }), false);
  assert.equal(isAltScreenSupported(stream, { TERM: "xterm", NO_COLOR: "" }), false);
  assert.equal(isAltScreenSupported(stream, { TERM: "xterm", CI: "1" }), false);
});

test("enter and exit are idempotent and restoration uses the original stream", () => {
  const original = outputStream();
  const other = outputStream();
  const env = { TERM: "xterm-256color" };

  assert.equal(enterAltScreen(original.stream, env), true);
  assert.equal(isAltScreenActive(), true);
  assert.deepEqual(original.writes, [ALT_SCREEN_ENTER]);

  assert.equal(enterAltScreen(original.stream, env), true, "a nested enter must not emit twice");
  assert.deepEqual(original.writes, [ALT_SCREEN_ENTER]);

  exitAltScreen(other.stream);
  assert.equal(isAltScreenActive(), false);
  assert.deepEqual(original.writes, [ALT_SCREEN_ENTER, ALT_SCREEN_EXIT]);
  assert.deepEqual(other.writes, []);

  exitAltScreen(original.stream);
  assert.deepEqual(original.writes, [ALT_SCREEN_ENTER, ALT_SCREEN_EXIT]);
});

test("unsupported streams and write failures never leave active state behind", () => {
  const baseline = listenerCounts();
  const plain = outputStream();
  assert.equal(enterAltScreen(plain.stream, { TERM: "dumb" }), false);
  assert.deepEqual(plain.writes, []);
  assert.equal(isAltScreenActive(), false);

  const failing = outputStream();
  failing.stream.write = () => {
    throw new Error("terminal closed");
  };
  assert.equal(enterAltScreen(failing.stream, { TERM: "xterm" }), false);
  assert.equal(isAltScreenActive(), false);

  const active = outputStream();
  assert.equal(enterAltScreen(active.stream, { TERM: "xterm" }), true);
  active.stream.write = () => {
    throw new Error("terminal closed during restore");
  };
  assert.doesNotThrow(() => exitAltScreen(active.stream));
  assert.equal(isAltScreenActive(), false);
  assert.deepEqual(listenerCounts(), baseline);
});

test("normal exit, repeated sessions, and test reset clean up every process hook", () => {
  const baseline = listenerCounts();
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const target = outputStream();
    assert.equal(enterAltScreen(target.stream, { TERM: "xterm" }), true);
    for (const event of HOOK_EVENTS) {
      assert.equal(
        process.listenerCount(event),
        baseline[event] + 1,
        `${event} hook missing on cycle ${cycle}`,
      );
    }
    exitAltScreen(target.stream);
    assert.deepEqual(listenerCounts(), baseline, `hooks leaked after cycle ${cycle}`);
  }

  const target = outputStream();
  enterAltScreen(target.stream, { TERM: "xterm" });
  _resetAltScreenForTests();
  assert.equal(isAltScreenActive(), false);
  assert.deepEqual(listenerCounts(), baseline);
});

async function runAbnormalChild(action) {
  const actions = {
    exit: "process.exit(23);",
    SIGINT: 'process.kill(process.pid, "SIGINT"); setInterval(() => {}, 1000);',
    SIGTERM: 'process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000);',
    uncaughtException: 'setImmediate(() => { throw new Error("alt-screen-test-exception"); });',
  };
  const source = `
    import { writeSync } from "node:fs";
    const { ALT_SCREEN_ENTER, enterAltScreen } = await import(${JSON.stringify(ALT_SCREEN_MODULE)});
    const stream = { isTTY: true, write(text) { writeSync(1, text); } };
    if (!enterAltScreen(stream, { TERM: "xterm-256color" })) throw new Error("enter failed");
    ${actions[action]}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
  watchdog.unref();
  try {
    const [code, signal] = await once(child, "close");
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(watchdog);
  }
}

test("exit, signals, and uncaught exceptions restore the normal screen exactly once", async (t) => {
  const cases = [
    ["exit", 23],
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["uncaughtException", 1],
  ];
  for (const [action, expectedCode] of cases) {
    await t.test(action, async () => {
      const result = await runAbnormalChild(action);
      assert.equal(result.code, expectedCode, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, ALT_SCREEN_ENTER + ALT_SCREEN_EXIT);
      if (action === "uncaughtException") assert.match(result.stderr, /alt-screen-test-exception/);
    });
  }
});
