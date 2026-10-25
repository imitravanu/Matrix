import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MatrixApp } from "../src/matrix.mjs";
import { listSessions, loadLatestSession, loadSession } from "../lib/session.mjs";
import {
  copyDemo,
  frameText,
  installFetchTrap,
  makeTempDir,
  patchEnv,
  PROVIDER_ENVIRONMENT_KEYS,
  waitFor,
} from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";
const TIMING_REGRESSION_DELAY_MS = 80;

let isolatedHome;
let restoreProviderEnv;
let fetchTrap;

beforeEach(() => {
  isolatedHome = makeTempDir("matrix-app-provider-env-");
  restoreProviderEnv = patchEnv({
    HOME: isolatedHome,
    ...Object.fromEntries(PROVIDER_ENVIRONMENT_KEYS.map((key) => [key, undefined])),
  });
  fetchTrap = installFetchTrap();
});

afterEach(() => {
  try {
    assert.equal(fetchTrap.calls.length, 0, "the offline app must not make provider requests");
  } finally {
    fetchTrap.restore();
    restoreProviderEnv();
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

async function waitFrame(app, pattern, label, timeoutMs = 15000) {
  const text = await waitFor(
    () => {
      const frame = frameText(app);
      return pattern.test(frame) ? frame : null;
    },
    { timeoutMs, intervalMs: 40 },
  );
  assert.ok(text, `timed out waiting for ${label}\nlast frame:\n${frameText(app).slice(-3000)}`);
  return text;
}

async function waitInput(app, value, { prompt = "matrix ❯", present = true } = {}) {
  const marker = `${prompt} ${value}`;
  const frame = await waitFor(
    () => {
      const current = frameText(app);
      return current.includes(marker) === present ? current : null;
    },
    { timeoutMs: 5000, intervalMs: 10 },
  );
  assert.ok(
    frame,
    `timed out waiting for ${present ? "input" : "input removal"} ${JSON.stringify(value)}\nlast frame:\n${frameText(app).slice(-3000)}`,
  );
  return frame;
}

async function typeLine(app, text) {
  await waitFrame(app, /Describe a task/, "the idle prompt before typing", 5000);
  app.stdin.write(text);
  await waitInput(app, text);
  app.stdin.write("\r");
}

async function approveTestTrust(app, { once = false } = {}) {
  await waitFrame(app, /TEST TRUST · WORKSPACE/, "workspace test trust");
  app.stdin.write(once ? "o" : "y");
  await waitFrame(app, /TEST TRUST · TEST PLAN/, "exact test-plan trust");
  app.stdin.write(once ? "o" : "y");
}

async function typeProgressively(app, text) {
  let value = "";
  for (const character of text) {
    value += character;
    app.stdin.write(character);
    await waitInput(app, value);
  }
}

async function pressUntilFrame(app, input, pattern, label) {
  const frame = await waitFor(
    () => {
      app.stdin.write(input);
      const current = frameText(app);
      return pattern.test(current) ? current : null;
    },
    { timeoutMs: 5000, intervalMs: 40 },
  );
  assert.ok(frame, `timed out waiting for ${label}\nlast frame:\n${frameText(app).slice(-3000)}`);
  return frame;
}

async function clearPrompt(app, value, prompt = "matrix ❯") {
  app.stdin.write("\x15");
  await waitInput(app, value, { prompt, present: false });
}

function setup(t, { initialSession = null, demo = null, autoApprove = false } = {}) {
  const copy = demo ?? copyDemo("matrix-app-");
  const home = join(copy.root, "home");
  const previousHome = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = home;
  const app = render(
    React.createElement(MatrixApp, {
      cwd: copy.workspace,
      initialSession,
      autoApprove,
      offline: true,
    }),
  );
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
  await approveTestTrust(first.app);
  await waitFrame(
    first.app,
    /Verification passed: 4 passed · 0 failed/,
    "verification after approval",
  );
  const fixed = readFileSync(file, "utf8");
  assert.ok(fixed.includes(FIXED));
  assert.equal(fixed.includes(BUGGY), false);

  const sessions = listSessions({ home: first.home });
  assert.ok(sessions.length >= 1);
  const saved = loadLatestSession(first.demo.workspace, { home: first.home });
  assert.ok(saved);
  assert.ok(
    saved.history.some(
      (message) =>
        message.role === "assistant" && /Verification passed/.test(message.content ?? ""),
    ),
  );
  assert.equal(saved.lastPatch, null, "new sessions persist only the versioned run record");
  assert.equal(saved.undoRun?.version, 1);
  assert.equal(saved.undoRun?.entries.length, 1);
  const savedEntry = saved.undoRun?.entries[0];
  assert.equal(savedEntry?.file, "src/processor.py");
  assert.equal(savedEntry?.updatedText, fixed, "resume needs the exact post-patch fingerprint");
  assert.equal(savedEntry?.original, before, "session undo needs the original bytes too");
  assert.equal(savedEntry?.isCreation, false);
  assert.ok(savedEntry?.backupPath);
  const finalMessage = saved.history.at(-1);
  assert.equal(finalMessage.ok, true);
  assert.equal(finalMessage.status, "success");
  assert.equal(typeof finalMessage.elapsedMs, "number");
  assert.equal(saved.metrics.elapsedMs, finalMessage.elapsedMs);

  first.app.unmount();
  first.app = null;
  const resumed = setup(t, {
    initialSession: loadSession(saved.id, { home: first.home }),
    demo: first.demo,
  });
  await waitFrame(resumed.app, /Verification passed/, "the resumed transcript");
  await waitFrame(resumed.app, /Describe a task/, "the resumed idle prompt");
  resumed.app.stdin.write("\x1bu");
  await waitFrame(resumed.app, /restored src\/processor.py/, "undo from a resumed session");
  assert.equal(readFileSync(file, "utf8"), before);
  const afterUndo = loadSession(saved.id, { home: first.home });
  assert.equal(afterUndo.lastPatch, null);
  assert.equal(afterUndo.undoRun, null);
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
  await waitFrame(app, /Describe a task/, "the idle prompt after denial");
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(frameText(app).includes("Verification passed"), false);
  const saved = loadLatestSession(demo.workspace, { home });
  if (saved) {
    assert.equal(saved.lastPatch, null);
    assert.equal(saved.undoRun, null);
  }
  await pressUntilFrame(app, "\x1bu", /no applied patch to undo/, "an honest undo refusal");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("auto-approve is per-run, and /auto plus /new reset it between runs", async (t) => {
  const { app, demo } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");

  await typeLine(app, TASK);
  await waitFrame(app, /PATCH GATE/, "the first gate");
  app.stdin.write("a");
  await approveTestTrust(app);
  await waitFrame(app, /Verification passed: 4 passed/, "the first auto-approved run");
  const idle = await waitFor(() => (/Describe a task/.test(frameText(app)) ? true : null), {
    timeoutMs: 15000,
  });
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

test("/new always disables auto-approve even when the app started with it", async (t) => {
  const { app } = setup(t, { autoApprove: true });
  await waitFrame(app, /S P A T I A L/, "the empty screen");
  await typeLine(app, "/new");
  await waitFrame(app, /new session/, "the new session reset");
  await typeLine(app, TASK);
  await waitFrame(app, /PATCH GATE/, "a fresh gate after /new");
  app.stdin.write("n");
  await waitFrame(app, /patch denied|denied/, "denying the reset run");
});

test("historical /diff is a read-only review rather than a waiting gate", async (t) => {
  const { app } = setup(t, { autoApprove: true });
  await waitFrame(app, /S P A T I A L/, "the empty screen");
  await typeLine(app, TASK);
  await approveTestTrust(app);
  await waitFrame(app, /Verification passed: 4 passed/, "the auto-approved run");
  await typeLine(app, "/diff");
  const review = await waitFrame(app, /PATCH GATE/, "the historical diff review");
  assert.equal(review.includes("WAITING"), false);
  assert.doesNotMatch(review, /y apply|a apply all|n deny/);
  assert.doesNotMatch(
    review,
    /if not bounds/,
    "the collapsed fixture must make folding observable",
  );
  app.stdin.write("y");
  app.stdin.write("f");
  const expanded = await waitFor(() => {
    const frame = frameText(app);
    return /PATCH GATE/.test(frame) && /if not bounds/.test(frame) ? frame : null;
  });
  assert.ok(expanded, "folding after the ignored approval key must leave the historical gate open");
  assert.doesNotMatch(expanded, /y apply|a apply all|n deny/);
  app.stdin.write("\u001b");
  await waitFrame(app, /crucible/i, "closing the historical review");
});

test("Ctrl+C aborts a /test run instead of ignoring it", async (t) => {
  const root = makeTempDir("matrix-app-slow-test-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "slow-test",
      version: "1.0.0",
      scripts: { test: 'node -e "setInterval(() => {}, 1000)"' },
    }),
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
  await approveTestTrust(app, { once: true });
  await waitFrame(app, /\$ npm test/, "the real test command");
  app.stdin.write("\u0003");
  await waitFrame(app, /test run aborted/, "the abort result", 15000);
  assert.equal(frameText(app).includes("Tests failed"), false);
});

test("once test trust requires reapproval and denial does not execute", async (t) => {
  const { app } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");
  await typeLine(app, "/test");
  await waitFrame(app, /TEST TRUST · WORKSPACE/, "first-use workspace trust");
  assert.match(frameText(app), /-m pytest -q/);
  await approveTestTrust(app, { once: true });
  await waitFrame(app, /2 failed, 2 passed/, "the once-approved test run");

  await typeLine(app, "/test");
  await waitFrame(app, /TEST TRUST · WORKSPACE/, "workspace trust is required again");
  app.stdin.write("n");
  await waitFrame(app, /workspace trust was denied/, "the denied test execution");
});

test("agent verification failures expose retained output with the shared expansion control", async (t) => {
  const restoreGeometry = patchEnv({ MATRIX_COLS: "100", MATRIX_ROWS: "30" });
  t.after(restoreGeometry);
  const { app, demo, home } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");
  await typeLine(app, "run tests");
  await approveTestTrust(app);

  await waitFrame(
    app,
    /FAILED tests\/test_processor\.py::test_processor_large_window - assert 1 == 14/,
    "the agent failure tail without expanding output",
  );
  await waitFrame(app, /Describe a task/, "the completed agent test run");
  const collapsed = frameText(app);
  assert.match(collapsed, /retained output · \d+ lines retained/);
  assert.match(collapsed, /Alt\+O expand/);

  const saved = loadLatestSession(demo.workspace, { home });
  const verification = saved?.history.at(-1)?.verifyTests;
  assert.ok(verification);
  assert.ok(verification.output.length > 8);
  assert.equal(verification.outputLineCount, verification.output.length);
  assert.equal(verification.outputTruncated, false);

  app.stdin.write("\x1bo");
  await waitFrame(app, /E\s+assert 1 == 14/, "expanded agent output");
});

test("direct /test retains the latest 400 lines, wraps output, and scrolls without disturbing the prompt", async (t) => {
  const restoreGeometry = patchEnv({ MATRIX_COLS: "100", MATRIX_ROWS: "30" });
  t.after(restoreGeometry);
  const root = makeTempDir("matrix-app-retained-output-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "retained-output-test",
      version: "1.0.0",
      scripts: { test: "node retained-output.cjs" },
    }),
  );
  writeFileSync(
    join(root, "retained-output.cjs"),
    [
      "for (let index = 0; index < 450; index += 1) {",
      '  if (index === 440) console.log(`LONG_${"z".repeat(180)}_END_OF_OUTPUT`);',
      '  else if (index === 448) console.log("not ok 1 diagnosable failure");',
      '  else if (index === 449) console.log("E AssertionError: EXPECTED_FAILURE_TAIL");',
      "  else console.log(`retained line ${index}`);",
      "}",
      "process.exitCode = 1;",
    ].join("\n"),
  );
  const { app, home } = setup(t, {
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
  await approveTestTrust(app);

  await waitFrame(app, /EXPECTED_FAILURE_TAIL/, "the direct /test failure tail");
  await waitFrame(app, /Describe a task/, "the completed direct /test run");
  const collapsed = frameText(app);
  assert.match(collapsed, /retained output · last 400 of 450 lines/);
  assert.match(collapsed, /showing last 8 retained · Alt\+O expand/);
  assert.doesNotMatch(collapsed, /retained line 50(?:\s|$)/);
  assert.doesNotMatch(collapsed, /END_OF_OUTPUT/);

  const saved = loadLatestSession(root, { home });
  const verification = saved?.history.at(-1)?.verifyTests;
  assert.ok(verification);
  assert.equal(verification.output.length, 400);
  assert.equal(verification.output[0], "retained line 50");
  assert.equal(verification.output.at(-1), "E AssertionError: EXPECTED_FAILURE_TAIL");
  assert.equal(verification.outputLineCount, 450);
  assert.equal(verification.outputTruncated, true);
  assert.equal(Object.hasOwn(verification, "stdout"), false);
  assert.equal(Object.hasOwn(verification, "stderr"), false);

  await typeProgressively(app, "output draft");
  app.stdin.write("\x1bo");
  const expanded = await waitFrame(app, /END_OF_OUTPUT/, "expanded direct /test output");
  await waitInput(app, "output draft");

  const scrollStart = (frame) => Number(/L\s+(\d+)-\d+\/\d+/.exec(frame)?.[1] ?? 0);
  const bottomStart = scrollStart(expanded);
  assert.ok(bottomStart > 1);
  app.stdin.write("\x1b[5~");
  const scrolled = await waitFor(() => {
    const frame = frameText(app);
    return scrollStart(frame) < bottomStart && frame.includes("matrix ❯ output draft")
      ? frame
      : null;
  });
  assert.ok(scrolled, "PgUp must scroll retained output while preserving the prompt draft");
  await clearPrompt(app, "output draft");

  app.stdin.write("\x1b[F");
  const returnedToTail = await waitFrame(
    app,
    /EXPECTED_FAILURE_TAIL/,
    "End returning to the retained output tail",
  );
  assert.match(returnedToTail, /END_OF_OUTPUT/);
  app.stdin.write("\x1b[H");
  await waitFrame(app, /retained line 50(?:\s|$)/, "Home reaching the first retained line");

  app.stdin.write("\x1bo");
  const collapsedAgain = await waitFrame(
    app,
    /showing last 8 retained · Alt\+O expand/,
    "collapsing retained output",
  );
  assert.match(collapsedAgain, /EXPECTED_FAILURE_TAIL/);
});

test("unrecognized test output is presented as unverified rather than a pass", async (t) => {
  const root = makeTempDir("matrix-app-unverified-test-");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "unverified-test", version: "1.0.0", scripts: { test: "node -e ''" } }),
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
  await approveTestTrust(app);
  await waitFrame(
    app,
    /verification unavailable|unrecognized test output/,
    "the unverified result",
  );
  assert.equal(frameText(app).includes("Tests passed"), false);
});

test("printable prompt input never becomes a timing-based shortcut", async (t) => {
  const { app } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");

  for (const text of [
    "make a fix",
    "update the bounds",
    "1. check bounds",
    "4 lanes need detail",
    "? investigate this",
  ]) {
    app.stdin.write(text[0]);
    // Deliberate timing regression: a pause after one printable key must not
    // reinterpret that key as a shortcut.
    await new Promise((resolve) => setTimeout(resolve, TIMING_REGRESSION_DELAY_MS));
    app.stdin.write(text.slice(1));
    const frame = await waitInput(app, text);
    assert.ok(
      frame.includes(text),
      `the complete prompt ${JSON.stringify(text)} should be preserved`,
    );
    assert.equal(frame.includes("MODEL ROUTER"), false);
    assert.equal(frame.includes("KEYMAP"), false);
    await clearPrompt(app, text);
  }
});

test("Alt screen keys support live inspection without stealing printable input", async (t) => {
  const { app } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");
  await typeLine(app, TASK);
  await waitFrame(app, /PATCH GATE/, "the approval gate");

  app.stdin.write("\x1b4");
  await waitFrame(app, /swarm/i, "live swarm navigation while the run waits");

  app.stdin.write("f");
  // Deliberate timing regression: printable input stays printable even after
  // a pause while another screen is being inspected during a run.
  await new Promise((resolve) => setTimeout(resolve, TIMING_REGRESSION_DELAY_MS));
  app.stdin.write("ocus the lanes");
  await waitInput(app, "focus the lanes", { prompt: "working ❯" });
  await clearPrompt(app, "focus the lanes", "working ❯");

  app.stdin.write("\x1b3");
  await waitFrame(app, /PATCH GATE/, "returning to the waiting gate");
  app.stdin.write("n");
  await waitFrame(app, /patch denied|denied/, "denying the inspected patch");
});

test("model picker, /test, /doctor, help and screen keys are wired to real state", async (t) => {
  const { app, demo } = setup(t);
  const before = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  await waitFrame(app, /S P A T I A L/, "the empty screen");

  app.stdin.write("\x1bm");
  await waitFrame(app, /MODEL ROUTER/, "the model picker");
  app.stdin.write("\u001b[B");
  await waitFrame(app, /❯ Claude Sonnet 4\.6/, "the model picker selection");
  app.stdin.write("\r");
  await waitFrame(app, /Claude Sonnet 4\.6/, "the selected remote model in the header");
  assert.equal(frameText(app).includes("MODEL ROUTER"), false);

  app.stdin.write("\x1bm");
  await waitFrame(app, /MODEL ROUTER/, "the model picker again");
  app.stdin.write("\u001b[A");
  await waitFrame(app, /❯ Local Forge/, "the restored local picker selection");
  app.stdin.write("\r");
  const localHeader = await waitFor(() => {
    const frame = frameText(app);
    return /Local Forge/.test(frame) && !/MODEL ROUTER/.test(frame) ? frame : null;
  });
  assert.ok(localHeader);

  await typeLine(app, "/test");
  await approveTestTrust(app);
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
  app.stdin.write("\x1b4");
  await waitFrame(app, /swarm/i, "the swarm screen key");
  app.stdin.write("\x1b5");
  await waitFrame(app, /scope lens/i, "the scope screen key");
  app.stdin.write("\x1b6");
  await waitFrame(app, /VISION/, "the vision screen key");
  app.stdin.write("\x1b2");
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

test("help scrolls to the final command and back at 40x20", async (t) => {
  const restore = patchEnv({ MATRIX_COLS: "40", MATRIX_ROWS: "20" });
  t.after(restore);
  const { app } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");
  await typeLine(app, "/help");
  await waitFrame(app, /KEYMAP/, "the help screen");
  app.stdin.write("\u001b[F");
  await waitFrame(app, /\/quit/, "the final slash command");
  app.stdin.write("\u001b[H");
  await waitFrame(app, /Alt\+1\/2/, "the first keymap entry");
});

test("reduced motion keeps the resting frame static", async (t) => {
  const restore = patchEnv({ MATRIX_REDUCED_MOTION: "1" });
  t.after(restore);
  const { app } = setup(t);
  await waitFrame(app, /demo-project/, "the workspace index to load before checking motion");
  const first = frameText(app);
  // Deliberate animation observation window, not an ordinary interaction sleep.
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(frameText(app), first);
});

test("typing text starting with 'f' or 'F' preserves the initial letter and does not swallow it", async (t) => {
  const { app } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");

  await typeProgressively(app, "fix the processor");
  await waitFrame(
    app,
    /fix the processor/,
    "the input line containing the full text with lowercase f",
  );
  await clearPrompt(app, "fix the processor");

  await typeProgressively(app, "Fix the slice bug");
  await waitFrame(
    app,
    /Fix the slice bug/,
    "the input line containing the full text with uppercase F",
  );
});

test("typing text starting with 'm', 'u', numbers, or screen keys preserves initial characters across all screens", async (t) => {
  const { app } = setup(t);
  await waitFrame(app, /S P A T I A L/, "the empty screen");

  await typeProgressively(app, "make a processor fix");
  await waitFrame(app, /make a processor fix/, "full prompt starting with m preserved");
  assert.equal(
    frameText(app).includes("MODEL ROUTER"),
    false,
    "model router must not open when typing words starting with m",
  );
  await clearPrompt(app, "make a processor fix");

  await typeProgressively(app, "update the bounds slice");
  await waitFrame(app, /update the bounds slice/, "full prompt starting with u preserved");
  await clearPrompt(app, "update the bounds slice");

  await typeProgressively(app, "1. check bounds");
  await waitFrame(app, /1\. check bounds/, "full prompt starting with 1 preserved");
  await clearPrompt(app, "1. check bounds");

  await typeLine(app, "/swarm");
  await waitFrame(app, /swarm/i, "swarm screen");
  await typeProgressively(app, "help refine the lanes");
  await waitFrame(app, /help refine the lanes/, "full prompt on swarm starting with h preserved");
  await clearPrompt(app, "help refine the lanes");

  await typeLine(app, "/scope");
  await waitFrame(app, /scope lens/i, "scope lens screen");
  await typeProgressively(app, "keep the comments");
  await waitFrame(app, /keep the comments/, "full prompt on scope starting with k preserved");
  await clearPrompt(app, "keep the comments");

  await typeLine(app, "/vision");
  await waitFrame(app, /VISION/, "vision screen");
  await typeProgressively(app, "verify canvas pixel runs");
  await waitFrame(
    app,
    /verify canvas pixel runs/,
    "full prompt on vision starting with v preserved",
  );
});
