import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";

import { Frame } from "../src/frame.mjs";
import { ALL_VIEWS, DEFAULT_SCOPE_EXTENSIONS, SCREENS, scopeFilesFor } from "../src/views.mjs";
import { appendHistory, historyFromSession, sessionSnapshot } from "../src/session-codec.mjs";
import { projectDirectTestResult, projectResult } from "../src/result-projection.mjs";
import { makeLive, reduceRunEvent } from "../src/event-reducer.mjs";
import { applyKeyboardInput, decideKeyboard } from "../src/keyboard.mjs";
import { createInputState } from "../lib/input.mjs";
import { MODELS } from "../lib/models.mjs";
import { isOpenRouterAvailable as uiCredentialAvailability } from "../src/credentials.mjs";
import { isOpenRouterAvailable as providerCredentialAvailability } from "../lib/openrouter.mjs";
import { patchEnv } from "./helpers.mjs";

const h = React.createElement;
const key = (extra = {}) => ({ ...extra });

function keyboardContext(overrides = {}) {
  return {
    screen: "chat",
    inputValue: "",
    permission: null,
    testTrustActive: false,
    permissionResolved: false,
    running: false,
    chatBounds: { total: 100, height: 20 },
    permissionBounds: { total: 100, height: 20 },
    helpBounds: { total: 100, height: 20, maxOffset: 80 },
    testTrustBounds: { total: 100, height: 20, maxOffset: 80 },
    slashMatchCount: 0,
    scopeCount: 3,
    hasLiveEdit: false,
    ...overrides,
  };
}

test("shared view and scope definitions retain the documented order and extension contract", () => {
  assert.deepEqual(SCREENS, ["empty", "chat", "permission", "swarm", "scope", "vision"]);
  assert.deepEqual(ALL_VIEWS, [...SCREENS, "model", "help"]);
  assert.deepEqual(
    [...DEFAULT_SCOPE_EXTENSIONS],
    [
      ".py",
      ".pyi",
      ".js",
      ".mjs",
      ".cjs",
      ".jsx",
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".rs",
      ".go",
      ".rb",
    ],
  );
  const files = scopeFilesFor({
    files: [
      { rel: "a.py", ext: ".py", size: 10 },
      { rel: "b.txt", ext: ".txt", language: "python", size: 10 },
      { rel: "large.js", ext: ".js", size: 220_000 },
      { rel: "README.md", ext: ".md", language: "markdown", size: 10 },
    ],
  });
  assert.deepEqual(files, ["a.py", "b.txt"]);
});

test("session history projection preserves stable identities on ordinary appends", () => {
  const first = { id: "first", role: "user", content: "one" };
  const second = { id: "second", role: "assistant", content: "two" };
  const previous = [first, second];
  const next = appendHistory(previous, { id: "third", role: "system", content: "three" });
  assert.equal(previous.length, 2);
  assert.equal(next.length, 3);
  assert.equal(next[0], first);
  assert.equal(next[1], second);
  assert.equal(next[2].id, "third");

  const resumed = historyFromSession({
    history: [
      null,
      { role: "user", content: 42 },
      { id: "kept", role: "assistant", content: "answer" },
    ],
  });
  assert.deepEqual(
    resumed.map((message) => [message.id, message.content]),
    [
      ["resumed-0", "42"],
      ["kept", "answer"],
    ],
  );
});

test("session snapshots retain exact undo data while projecting transcript cards", () => {
  const snapshot = sessionSnapshot({
    sessionId: "session-1",
    cwd: "/workspace",
    project: { name: "project", root: "/workspace", languages: [], test: { display: "npm test" } },
    history: [
      {
        id: "assistant",
        role: "assistant",
        content: "done",
        readFile: { path: "a.js", absPath: "/workspace/a.js", content: "x" },
        verifyTests: { command: "npm test", lines: ["ok"], outputLineCount: 1 },
      },
    ],
    model: { id: "local" },
    tokenStats: { inputTokens: 1 },
    metrics: { elapsedMs: 12 },
    elapsedMs: 12,
    undoRun: {
      version: 1,
      runId: "run-1",
      entries: [
        {
          file: "a.js",
          absPath: "/workspace/a.js",
          original: "before",
          updatedText: "after",
          backupPath: "/backup/a.js",
          isCreation: false,
        },
      ],
    },
  });
  assert.equal(snapshot.lastPatch, null);
  assert.equal(snapshot.history[0].readFile.absPath, undefined);
  assert.deepEqual(snapshot.history[0].verifyTests.output, ["ok"]);
  assert.equal(snapshot.undoRun.entries[0].original, "before");
  assert.equal(snapshot.undoRun.entries[0].updatedText, "after");
  assert.equal(snapshot.undoRun.entries[0].patch, "");
});

test("result projections preserve outcome, elapsed, usage, and retained verification fields", () => {
  const { normalized, finalMetrics, message } = projectResult(
    {
      content: "implementation complete",
      verifyTests: {
        command: "npm test",
        output: ["result line"],
        outputLineCount: 2,
        ok: false,
        verified: false,
        verificationStatus: "failed",
      },
      metrics: { elapsedMs: 1234 },
      usage: { provenance: "estimated", costProvenance: "unavailable", costComplete: false },
    },
    {
      liveVerification: {
        cmd: "npm test",
        output: ["result line", "live line"],
        outputLineCount: 2,
      },
      modelName: "Local Forge",
      now: () => 42,
    },
  );
  assert.equal(normalized.status, "failed");
  assert.equal(finalMetrics.elapsedMs, 1234);
  assert.equal(message.id, "asst-42");
  assert.equal(message.timestamp, 42);
  assert.equal(message.elapsedTime, 1);
  assert.equal(message.ok, false);
  assert.deepEqual(message.verifyTests.output, ["result line", "live line"]);
  assert.equal(message.usageProvenance, "estimated");
  assert.equal(message.costProvenance, "unavailable");

  const direct = projectDirectTestResult(
    {
      command: "npm test",
      durationMs: 9,
      lines: ["aborting"],
      cases: [],
      passed: 0,
      failed: 0,
      ok: false,
      processOk: false,
      verified: false,
      verificationStatus: "aborted",
      aborted: true,
    },
    { aborted: true, now: () => 7 },
  );
  assert.equal(direct.normalized.status, "aborted");
  assert.equal(direct.message.id, "test-7");
  assert.equal(direct.message.verifyTests.verificationStatus, "aborted");
  assert.match(direct.message.content, /Test run aborted/);
});

test("event reduction preserves live cards and newest bounded verification output", () => {
  let live = null;
  const apply = (event, extra = {}) => {
    const reduction = reduceRunEvent(event, { live, modelName: "Local Forge", ...extra });
    live = reduction.live;
    return reduction;
  };
  const started = apply({
    type: "run:start",
    task: "fix",
    plan: [{ title: "inspect", status: "active" }],
  });
  assert.equal(started.runStart, true);
  assert.equal(live.modelName, "Local Forge");
  apply({ type: "thought", text: "reason " });
  apply({ type: "content", text: "answer" });
  apply({ type: "tool:start", id: "tool-1", name: "read_file", label: "Read" });
  apply({
    type: "tool:end",
    id: "tool-1",
    ok: false,
    summary: "denied",
    data: { status: "denied" },
  });
  const proposed = apply({
    type: "proposal",
    proposal: {
      file: "a.js",
      scope: "run()",
      patch: "@@ -1 +1 @@\n-a\n+b",
      hunks: [],
      stats: { adds: 1, dels: 1 },
    },
  });
  assert.equal(proposed.showPermission, true);
  assert.equal(live.toolCards[0].ok, false);
  assert.equal(live.editFile.status, "pending");
  apply({ type: "applied", backupPath: "/backup/a.js" });
  assert.equal(live.editFile.status, "applied");
  apply({ type: "verify:start", command: "npm test" });
  for (let index = 0; index < 405; index++) apply({ type: "verify:line", line: `line ${index}` });
  assert.equal(live.verifyTests.output.length, 400);
  assert.equal(live.verifyTests.output[0], "line 5");
  assert.equal(live.verifyTests.output.at(-1), "line 404");
  assert.equal(live.verifyTests.outputLineCount, 405);
  assert.equal(live.verifyTests.outputTruncated, true);
  assert.equal(reduceRunEvent({ type: "content", text: "ignored" }, { live: null }).bump, null);
  const automatic = reduceRunEvent(
    { type: "proposal", proposal: { file: "b.js" } },
    {
      live: makeLive("task", "model"),
      autoApprove: true,
    },
  );
  assert.equal(automatic.showPermission, false);
});

test("keyboard decisions keep printable input, modified views, overlays, and gates distinct", () => {
  const printable = decideKeyboard(keyboardContext(), "1", key());
  assert.deepEqual(printable, { type: "input", operation: "insert", text: "1" });
  assert.equal(applyKeyboardInput(createInputState(""), printable).value, "1");
  assert.deepEqual(decideKeyboard(keyboardContext(), "5", key({ meta: true })), {
    type: "primary-view",
    screen: "scope",
  });
  assert.equal(
    decideKeyboard(keyboardContext({ screen: "model" }), "j", key()).type,
    "picker-step",
  );
  assert.deepEqual(decideKeyboard(keyboardContext({ screen: "model" }), "2", key()), {
    type: "screen",
    screen: "chat",
  });
  assert.deepEqual(
    decideKeyboard(
      keyboardContext({
        screen: "permission",
        permission: { status: "pending" },
      }),
      "a",
      key(),
    ),
    { type: "approve", decision: "a" },
  );
  assert.equal(
    decideKeyboard(
      keyboardContext({
        screen: "permission",
        permission: { status: "pending" },
        permissionResolved: true,
      }),
      "y",
      key(),
    ).type,
    "handled",
  );
  assert.deepEqual(
    decideKeyboard(
      keyboardContext({
        screen: "permission",
        testTrustActive: true,
      }),
      "o",
      key(),
    ),
    { type: "test-trust", decision: "once" },
  );
  assert.equal(
    decideKeyboard(keyboardContext({ running: true }), "f", key({ meta: true })).type,
    "toggle-thoughts",
  );
});

test("keyboard scroll and slash decisions retain bounds and direction", () => {
  const pageUp = decideKeyboard(keyboardContext(), "", key({ pageUp: true }));
  assert.deepEqual(pageUp, { type: "scroll", target: "chat", delta: 10, maxOffset: 80 });
  const helpDown = decideKeyboard(keyboardContext({ screen: "help" }), "", key({ pageDown: true }));
  assert.deepEqual(helpDown, { type: "scroll", target: "help", delta: 20, maxOffset: 80 });
  const slash = decideKeyboard(
    keyboardContext({ inputValue: "/he", slashMatchCount: 2 }),
    "",
    key({ downArrow: true }),
  );
  assert.deepEqual(slash, { type: "slash-step", delta: 1 });
  const state = createInputState("abc");
  assert.equal(applyKeyboardInput(state, { operation: "clear" }).value, "");
});

test("Frame credential availability is cached across idle renders and bypassed by explicit hasKey", (t) => {
  const restore = patchEnv({ MATRIX_COLS: "60", MATRIX_ROWS: "22", MATRIX_REDUCED_MOTION: "1" });
  let reads = 0;
  const checkCredentialAvailability = () => {
    reads++;
    return true;
  };
  const app = render(h(Frame, { screen: "chat", model: MODELS[0], checkCredentialAvailability }));
  t.after(() => {
    app.unmount();
    restore();
  });
  assert.equal(reads, 1);
  for (let index = 0; index < 20; index++) {
    app.rerender(h(Frame, { screen: "chat", model: MODELS[0], checkCredentialAvailability }));
  }
  assert.equal(reads, 1);
  app.rerender(h(Frame, { screen: "chat", model: MODELS[1], checkCredentialAvailability }));
  assert.equal(reads, 2);
  app.rerender(
    h(Frame, { screen: "chat", model: MODELS[2], hasKey: false, checkCredentialAvailability }),
  );
  assert.equal(reads, 2);
});

test("the UI and provider share one transport-free credential availability implementation", () => {
  assert.equal(uiCredentialAvailability, providerCredentialAvailability);
});
