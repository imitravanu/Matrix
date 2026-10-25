import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";

import { MatrixApp } from "../src/matrix.mjs";
import { REST_TIME } from "../lib/wordmark.mjs";
import { copyDemo, frameText, makeTempDir, patchEnv, waitFor } from "./helpers.mjs";

const h = React.createElement;

test("a settled idle intro stops rendering and never rereads credentials", async (t) => {
  const home = makeTempDir("matrix-idle-home-");
  const demo = copyDemo("matrix-idle-workspace-");
  const restoreEnv = patchEnv({
    HOME: home,
    MATRIX_HOME: join(home, ".matrix"),
    OPENROUTER_API_KEY: undefined,
    MATRIX_API_KEY: undefined,
    MATRIX_API_BASE: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_BASE_URL: undefined,
    OLLAMA_API_KEY: undefined,
    OLLAMA_HOST: undefined,
    MATRIX_REDUCED_MOTION: undefined,
    INK_SCREEN_READER: undefined,
    MATRIX_COLS: "80",
    MATRIX_ROWS: "26",
  });
  let app = null;
  t.after(() => {
    app?.unmount();
    restoreEnv();
    demo.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  let credentialReads = 0;
  let renders = 0;
  const checkCredentialAvailability = () => {
    credentialReads += 1;
    return false;
  };
  const onRender = () => {
    renders += 1;
  };
  const element = h(
    React.Profiler,
    { id: "matrix-idle", onRender },
    h(MatrixApp, { cwd: demo.workspace, offline: true, checkCredentialAvailability }),
  );
  app = render(element);
  const loaded = await waitFor(() => (/demo-project/.test(frameText(app)) ? true : null));
  assert.ok(loaded, "the asynchronous workspace index should load");
  assert.equal(credentialReads, 1, "availability is read once for the initial model");

  for (let index = 0; index < 20; index++) app.rerender(element);
  assert.equal(credentialReads, 1, "warm parent renders reuse credential availability");

  // Deliberate animation-duration observation, not an interaction sleep. The
  // final settling commit is allowed; every later idle commit is a regression.
  await new Promise((resolve) => setTimeout(resolve, REST_TIME + 350));
  const settledRenders = renders;
  const settledFrames = app.frames.length;
  const settledFrame = frameText(app);
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.equal(frameText(app), settledFrame);
  assert.equal(app.frames.length, settledFrames, "the resting wordmark must not publish frames");
  assert.equal(
    renders,
    settledRenders,
    "the resting wordmark must stop its animation subscription",
  );
  assert.equal(credentialReads, 1, "idle animation must not read credentials");

  app.stdin.write("\x1bm");
  const picker = await waitFor(() => (/MODEL ROUTER/.test(frameText(app)) ? true : null));
  assert.ok(picker, "Alt+M should open the model picker");
  assert.equal(credentialReads, 2, "an explicit picker refresh may revalidate availability");
});
