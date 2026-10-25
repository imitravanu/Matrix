import test from "node:test";
import assert from "node:assert/strict";
import React from "react";

import * as matrix from "../src/matrix.mjs";
import { checkFrame, renderAllScreens, renderAt, renderScreen } from "../src/render.mjs";
import { MODELS } from "../lib/models.mjs";
import { ChatScreen, buildChatLines } from "../src/screens/chat.mjs";
import { buildPermissionLines } from "../src/screens/permission.mjs";
import { buildVisionCanvas } from "../src/screens/vision.mjs";
import * as cards from "../src/cards.mjs";

const h = React.createElement;
const PRIMARY_VIEWS = ["empty", "chat", "permission", "swarm", "scope", "vision"];
const ALL_VIEWS = [...PRIMARY_VIEWS, "model", "help"];
const CARD_EXPORTS = [
  "formatCodeBlock",
  "formatTokens",
  "renderContentWithCodeBlocks",
  "renderEditFileCard",
  "renderPlanCard",
  "renderReadFileCard",
  "renderThoughtCard",
  "renderVerifyTestsCard",
];

function fixture() {
  return {
    model: MODELS[0],
    hasKey: false,
    animTime: 2000,
    chatHistory: [
      { id: "user", role: "user", content: "inspect the workspace" },
      {
        id: "assistant",
        role: "assistant",
        content: "inspection complete",
        modelName: "Local Forge",
      },
    ],
    permission: {
      file: "src/example.js",
      patch: "@@ -1 +1 @@\n-old\n+new",
      hunks: [],
      stats: { adds: 1, dels: 1 },
      status: "pending",
    },
  };
}

test("the orchestrator keeps every legacy UI and card export", () => {
  for (const name of [
    "Frame",
    "ScreenView",
    "MatrixScreens",
    "MatrixApp",
    "ChatScreen",
    "buildChatLines",
    "buildPermissionLines",
    "buildVisionCanvas",
    ...CARD_EXPORTS,
  ]) {
    assert.equal(typeof matrix[name], "function", `${name} must remain exported`);
  }
  assert.equal(matrix.MatrixScreens, matrix.ScreenView);
  assert.equal(matrix.ChatScreen, ChatScreen);
  assert.equal(matrix.buildChatLines, buildChatLines);
  assert.equal(matrix.buildPermissionLines, buildPermissionLines);
  assert.equal(matrix.buildVisionCanvas, buildVisionCanvas);
  for (const name of CARD_EXPORTS) assert.equal(matrix[name], cards[name]);
  assert.deepEqual(matrix.SCREENS, PRIMARY_VIEWS);
});

test("the shared Frame covers the same primary and overlay views as render helpers", () => {
  const props = fixture();
  const size = { columns: 60, rows: 22 };
  const all = renderAllScreens(props, size);
  assert.deepEqual(Object.keys(all), ALL_VIEWS);
  for (const screen of ALL_VIEWS) {
    assert.equal(
      checkFrame(all[screen], size).ok,
      true,
      `${screen}: ${checkFrame(all[screen], size).problems.join(", ")}`,
    );
    assert.equal(all[screen], renderScreen(screen, props, size));
  }
  assert.equal(
    renderScreen("chat", props, size),
    renderAt(h(matrix.Frame, { screen: "chat", ...props }), size),
    "renderScreen must retain the public Frame behavior",
  );
});

test("legacy ast and perm aliases retain their normalized Frame behavior", () => {
  const props = fixture();
  const size = { columns: 60, rows: 22 };
  assert.equal(renderScreen("ast", props, size), renderScreen("scope", props, size));
  assert.equal(renderScreen("perm", props, size), renderScreen("permission", props, size));
});
