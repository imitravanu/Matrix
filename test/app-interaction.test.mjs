import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MatrixApp } from "../src/matrix.mjs";
import { listSessions, loadLatestSession, loadSession } from "../lib/session.mjs";
import { copyDemo, frameText, makeTempDir, waitFor } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFrame(app, pattern, label, timeoutMs = 15000) {
  const text = await waitFor(
    () => {
      const frame = frameText(app);
      return pattern.test(frame) ? frame : null;
    },
    { timeoutMs, intervalMs: 40 }
  );
  assert.ok(text, `timed out waiting for ${label}\nlast frame:\n${frameText(app).slice(-3000)}`);
  return text;
}

async function typeLine(app, text) {
  app.stdin.write(text);
  await sleep(70);
  app.stdin.write("\r");
}

function setup(t, { initialSession = null, demo = null } = {}) {
  const copy = demo ?? copyDemo("matrix-app-");
  const home = join(copy.root, "home");
  const previousHome = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = home;
  const app = render(React.createElement(MatrixApp, { cwd: copy.workspace, initialSession, offline: true }));
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      try {
        app.unmount();
      } catch {
        // already unmounted
      }
    }
    if (previousHome === undefined) delete process.env.MATRIX_HOME;
    else process.env.MATRIX_HOME = previousHome;
    copy.cleanup();
  };
  t.after(close);
  return { app, demo: copy, home, close };
}

test("a real patch gate applies, verifies, saves, resumes and undoes", async (t) => {
  const first = setup(t);
  const file = join(first.demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  await waitFrame(first.app, /S P A T I A L/, "the empty screen");

  await typeLine(first.app, TASK);
  await waitFrame(first.app, /PATCH GATE/, "the approval gate");
  assert.equal(readFileSync(file, "utf8"), before, "the file must not change before approval");

  first.app.stdin.write("y");
  await waitFrame(first.app, /Verification passed: 4 passed · 0 failed/, "verification after approval");
  const fixed = readFileSync(file, "utf8");
  assert.ok(fixed.includes(FIXED));
  assert.equal(fixed.includes(BUGGY), false);

  const sessions = listSessions({ home: first.home });
  assert.ok(sessions.length >= 1);
  const saved = loadLatestSession(first.demo.workspace, { home: first.home });
  assert.ok(saved);
  assert.ok(saved.history.some((message) => message.role === "assistant" && /Verification passed/.test(message.content ?? "")));
  assert.equal(saved.lastPatch?.file, "src/processor.py");
  assert.equal(saved.lastPatch?.updatedText, fixed, "resume needs the exact post-patch fingerprint");
  assert.equal(saved.lastPatch?.original, before, "session undo needs the original bytes too");
  assert.ok(saved.lastPatch?.backupPath);

  first.app.unmount();
  first.app = null;
  const resumed = setup(t, { initialSession: loadSession(saved.id, { home: first.home }), demo: first.demo });
  await waitFrame(resumed.app, /Verification passed/, "the resumed transcript");
  await sleep(100);
  resumed.app.stdin.write("u");
  await waitFrame(resumed.app, /restored src\/processor.py/, "undo from a resumed session");
  assert.equal(readFileSync(file, "utf8"), before);
  const afterUndo = loadSession(saved.id, { home: first.home });
  assert.equal(afterUndo.lastPatch, null);
});

test("denying the gate leaves the exact bytes untouched and has no undo", async (t) => {
  const { app, demo, home } = setup(t);
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  await waitFrame(app, /S P A T I A L/, "the empty screen");
  await typeLine(app, TASK);
  await waitFrame(app, /PATCH GATE/, "the approval gate");
  app.stdin.write("n");
  await waitFrame(app, /patch denied|denied/, "the denial result", 15000);
  await sleep(250);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(frameText(app).includes("Verification passed"), false);
  const saved = loadLatestSession(demo.workspace, { home });
  if (saved) assert.equal(saved.lastPatch, null);
  app.stdin.write("u");
  await waitFrame(app, /no applied patch to undo/, "an honest undo refusal");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("auto-approve is per-run, and /auto plus /new reset it between runs", async (t) => {
  const { app, demo } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");

  await typeLine(app, TASK);
  await waitFrame(app, /PATCH GATE/, "the first gate");
  app.stdin.write("a");
  await waitFrame(app, /Verification passed: 4 passed/, "the first auto-approved run");
  const idle = await waitFor(() => (/Describe a task/.test(frameText(app)) ? true : null), { timeoutMs: 15000 });
  assert.ok(idle, "the first run must finish before starting another");

  // `a` is not a sticky setting: the next edit must open a fresh gate.
  await typeLine(app, "rename process_bounds to process_window");
  await waitFrame(app, /PATCH GATE/, "a fresh gate after the auto-approved run");
  app.stdin.write("n");
  await waitFrame(app, /patch denied|denied/, "the denied rename");
  assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));

  await typeLine(app, "/auto");
  await waitFrame(app, /auto-approve on for the next run/, "/auto to arm the next run");
  await typeLine(app, "/new");
  await waitFrame(app, /S P A T I A L/, "/new to reset the screen");

  // /new returns auto-approve to the default; the next edit must gate again.
  await typeLine(app, "rename process_bounds to process_window");
  await waitFrame(app, /PATCH GATE/, "a gate after /new reset auto-approve");
  app.stdin.write("n");
  await waitFrame(app, /patch denied|denied/, "the final denial");
});

test("Ctrl+C aborts a /test run instead of ignoring it", async (t) => {
  const root = makeTempDir("matrix-app-slow-test-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "slow-test",
      version: "1.0.0",
      scripts: { test: 'node -e "setInterval(() => {}, 1000)"' },
    })
  );
  const { app } = setup(t, {
    demo: {
      root,
      workspace: root,
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    },
  });
  await waitFrame(app, /S P A T I A L/, "the empty screen");
  await typeLine(app, "/test");
  await waitFrame(app, /\$ npm test/, "the real test command");
  app.stdin.write("\u0003");
  await waitFrame(app, /test run aborted/, "the abort result", 15000);
  assert.equal(frameText(app).includes("Tests failed"), false);
});

test("model picker, /test, /doctor, help and screen keys are wired to real state", async (t) => {
  const { app, demo } = setup(t);
  const before = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  await waitFrame(app, /S P A T I A L/, "the empty screen");

  app.stdin.write("m");
  await waitFrame(app, /MODEL ROUTER/, "the model picker");
  app.stdin.write("\u001b[B");
  await sleep(40);
  app.stdin.write("\r");
  await waitFrame(app, /Claude Sonnet 4\.6/, "the selected remote model in the header");
  assert.equal(frameText(app).includes("MODEL ROUTER"), false);

  app.stdin.write("m");
  await waitFrame(app, /MODEL ROUTER/, "the model picker again");
  app.stdin.write("\u001b[A");
  await sleep(40);
  app.stdin.write("\r");
  const localHeader = await waitFor(() => {
    const frame = frameText(app);
    return /Local Forge/.test(frame) && !/MODEL ROUTER/.test(frame) ? frame : null;
  });
  assert.ok(localHeader);

  await typeLine(app, "/test");
  await waitFrame(app, /2 failed, 2 passed/, "/test to execute the real suite");
  assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8"), before);

  await typeLine(app, "/doctor");
  await waitFrame(app, /Ready\. Local Forge works without a network key/, "/doctor output");

  await typeLine(app, "/help");
  await waitFrame(app, /KEYMAP/, "the help screen");
  app.stdin.write("\u001b");
  const returned = await waitFor(() => {
    const frame = frameText(app);
    return /crucible/i.test(frame) && !/KEYMAP/.test(frame) ? frame : null;
  });
  assert.ok(returned, "returning from help");

  await typeLine(app, "/new");
  await waitFrame(app, /S P A T I A L/, "/new to reset the session");
  app.stdin.write("4");
  await waitFrame(app, /swarm/i, "the swarm screen key");
  app.stdin.write("5");
  await waitFrame(app, /scope lens/i, "the scope screen key");
  app.stdin.write("6");
  await waitFrame(app, /VISION/, "the vision screen key");
  app.stdin.write("2");
  await waitFrame(app, /crucible/i, "the chat screen key");
  assert.equal(frameText(app).includes("PATCH GATE"), false);
});

test("/model with an argument switches models without crashing", async (t) => {
  const { app } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");

  await typeLine(app, "/model sonnet");
  await waitFrame(app, /Claude Sonnet 4\.6/, "the slash command to select Sonnet");

  await typeLine(app, "/model local");
  const localHeader = await waitFor(() => {
    const frame = frameText(app);
    return /Local Forge/.test(frame) && !/Claude Sonnet 4\.6/.test(frame) ? frame : null;
  });
  assert.ok(localHeader, "the slash command should switch back to Local Forge");

  await typeLine(app, "/model not-a-model");
  await waitFrame(app, /MODEL ROUTER/, "an unknown model name to open the picker");
});
