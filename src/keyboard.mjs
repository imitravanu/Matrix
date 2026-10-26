// Pure keyboard routing decisions for MatrixApp. This module interprets keys but
// performs no React, controller, filesystem, or process effects.

import {
  backspace,
  deleteForward,
  deleteWordLeft,
  historyNext,
  historyPrevious,
  insertText,
  killLine,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  setValue,
} from "../lib/input.mjs";
import { SCREENS } from "./views.mjs";

const handled = { type: "handled" };
const input = (operation, extra = {}) => ({ type: "input", operation, ...extra });
const scroll = (target, delta, maxOffset = Number.POSITIVE_INFINITY) => ({
  type: "scroll",
  target,
  delta,
  maxOffset,
});
const absoluteScroll = (target, absolute) => ({ type: "scroll", target, absolute });

function primaryView(ch) {
  return { type: "primary-view", screen: SCREENS[Number(ch) - 1] };
}

function overlayView(ch) {
  return { type: "screen", screen: SCREENS[Number(ch) - 1] };
}

export function decideKeyboard(context, ch, key) {
  const {
    screen,
    inputValue,
    permission,
    commandTrustActive,
    testTrustActive,
    permissionResolved,
    running,
    chatBounds,
    permissionBounds,
    helpBounds,
    commandTrustBounds,
    testTrustBounds,
    slashMatchCount,
    scopeCount,
    hasLiveEdit,
  } = context;

  if (key.ctrl && ch === "c") return { type: "ctrl-c" };

  // Modified screen keys are unambiguous even while the prompt has focus or
  // a run is active. Printable keys always remain prompt input on main screens.
  if (key.meta && !key.ctrl && ch >= "1" && ch <= "6") return primaryView(ch);

  if (screen === "model") {
    if (ch >= "1" && ch <= "6") return overlayView(ch);
    if (key.upArrow || ch === "k") return { type: "picker-step", delta: -1 };
    if (key.downArrow || ch === "j") return { type: "picker-step", delta: 1 };
    if (key.pageUp) return { type: "picker-page", delta: -5 };
    if (key.pageDown) return { type: "picker-page", delta: 5 };
    if (key.home || ch === "g") return { type: "picker-edge", edge: "home" };
    if (key.end || ch === "G") return { type: "picker-edge", edge: "end" };
    if (key.return) return { type: "model-select" };
    if (key.escape || ch === "m") return { type: "return-screen" };
    return handled;
  }

  if (screen === "help") {
    if (ch >= "1" && ch <= "6") return overlayView(ch);
    const maxOffset = Math.max(0, helpBounds.maxOffset ?? helpBounds.total - helpBounds.height);
    const page = Math.max(1, helpBounds.height);
    if (key.upArrow || ch === "k") return scroll("help", -1);
    if (key.downArrow || ch === "j") return scroll("help", 1, maxOffset);
    if (key.pageUp || key.pageDown) return scroll("help", key.pageUp ? -page : page, maxOffset);
    if (key.home) return absoluteScroll("help", 0);
    if (key.end) return absoluteScroll("help", maxOffset);
    if (key.escape || ch === "?" || key.return) return { type: "return-screen" };
    return handled;
  }

  if (screen === "permission" && commandTrustActive) {
    if (key.escape || ch === "n") return { type: "command-trust", decision: "n" };
    if (ch === "y") return { type: "command-trust", decision: "y" };
    const maxOffset = Math.max(
      0,
      commandTrustBounds.maxOffset ?? commandTrustBounds.total - commandTrustBounds.height,
    );
    const page = Math.max(1, commandTrustBounds.height);
    if (key.upArrow || ch === "k") return scroll("command-trust", -1);
    if (key.downArrow || ch === "j") return scroll("command-trust", 1, maxOffset);
    if (key.pageUp || key.pageDown)
      return scroll("command-trust", key.pageUp ? -page : page, maxOffset);
    if (key.home) return absoluteScroll("command-trust", 0);
    if (key.end) return absoluteScroll("command-trust", maxOffset);
    // In particular, a/o cannot create a persistent or implicit command grant.
    return handled;
  }

  if (screen === "permission" && testTrustActive) {
    if (key.escape || ch === "n") return { type: "test-trust", decision: "n" };
    if (ch === "y") return { type: "test-trust", decision: "y" };
    if (ch === "o") return { type: "test-trust", decision: "once" };
    const maxOffset = Math.max(
      0,
      testTrustBounds.maxOffset ?? testTrustBounds.total - testTrustBounds.height,
    );
    const page = Math.max(1, testTrustBounds.height);
    if (key.upArrow || ch === "k") return scroll("test-trust", -1);
    if (key.downArrow || ch === "j") return scroll("test-trust", 1, maxOffset);
    if (key.pageUp || key.pageDown)
      return scroll("test-trust", key.pageUp ? -page : page, maxOffset);
    if (key.home) return absoluteScroll("test-trust", 0);
    if (key.end) return absoluteScroll("test-trust", maxOffset);
    return handled;
  }

  if (screen === "permission") {
    if (!permission) return { type: "screen", screen: "chat" };
    if (permission.status === "pending" && (ch === "y" || ch === "a" || ch === "n")) {
      return permissionResolved ? handled : { type: "approve", decision: ch };
    }
    if (key.escape) return { type: "escape-permission" };
    if (ch === "f" || ch === "F") return { type: "toggle-diff" };
    const maxOffset = Math.max(0, permissionBounds.total - permissionBounds.height);
    const page = Math.max(2, Math.floor(permissionBounds.height / 2));
    if (key.upArrow || ch === "k") return scroll("permission", -1);
    if (key.downArrow || ch === "j") return scroll("permission", 1, maxOffset);
    if (key.pageUp) return scroll("permission", -page);
    if (key.pageDown) return scroll("permission", page, maxOffset);
    if (key.home) return absoluteScroll("permission", 0);
    if (key.end) return absoluteScroll("permission", maxOffset);
    return handled;
  }

  if (key.escape) return { type: "escape" };

  if (key.pageUp || key.pageDown) {
    const step = Math.max(2, Math.floor(chatBounds.height / 2));
    const maxOffset = Math.max(0, chatBounds.total - chatBounds.height);
    return scroll("chat", key.pageUp ? step : -step, maxOffset);
  }
  const chatMaxOffset = Math.max(0, chatBounds.total - chatBounds.height);
  if (key.home && inputValue.length === 0) return absoluteScroll("chat", chatMaxOffset);
  if (key.end && inputValue.length === 0) return absoluteScroll("chat", 0);

  if (screen === "swarm" && inputValue.length === 0) {
    if (key.leftArrow) return { type: "focus-lane", delta: -1 };
    if (key.rightArrow || key.tab) return { type: "focus-lane", delta: 1 };
  }

  if (screen === "scope" && inputValue.length === 0) {
    if (key.leftArrow) return { type: "cycle-scope", delta: -1 };
    if (key.rightArrow) return { type: "cycle-scope", delta: 1 };
    if (key.upArrow || key.downArrow) {
      return { type: "scope-selection", delta: key.downArrow ? 1 : -1, scopeCount };
    }
  }

  if (screen === "vision" && inputValue.length === 0) {
    if (key.rightArrow || key.tab) return { type: "cycle-vision", delta: 1 };
    if (key.leftArrow) return { type: "cycle-vision", delta: -1 };
  }

  if (key.meta && !key.ctrl) {
    if (ch === "o" || ch === "O") return { type: "toggle-output" };
    if ((ch === "h" || ch === "H") && !running) return { type: "open-help" };
    if ((ch === "m" || ch === "M") && !running) return { type: "toggle-model" };
    if ((ch === "u" || ch === "U") && !running) return { type: "undo" };
    if ((ch === "f" || ch === "F") && running) {
      return { type: hasLiveEdit ? "toggle-diff" : "toggle-thoughts" };
    }
  }

  if (key.tab) return { type: "tab" };
  if (slashMatchCount > 0 && !inputValue.includes(" ") && (key.upArrow || key.downArrow)) {
    return { type: "slash-step", delta: key.downArrow ? 1 : -1 };
  }
  if (key.return) return { type: "submit" };
  if (key.backspace || key.delete) return input(key.backspace ? "backspace" : "delete");
  if (key.leftArrow) return input(key.meta || key.ctrl ? "word-left" : "left");
  if (key.rightArrow) return input(key.meta || key.ctrl ? "word-right" : "right");
  if (key.upArrow) return input("history-previous");
  if (key.downArrow) return input("history-next");
  if (key.home) return input("home");
  if (key.end) return input("end");
  if (key.ctrl && ch === "a") return input("home");
  if (key.ctrl && ch === "e") return input("end");
  if (key.ctrl && ch === "u") return input("clear");
  if (key.ctrl && ch === "w") return input("delete-word-left");
  if (key.ctrl && ch === "k") return input("kill-line");
  if (key.ctrl && ch === "l") return absoluteScroll("chat", 0);
  if (key.ctrl && ch === "b") return input("left");
  if (key.ctrl && ch === "f") return input("right");
  if (key.ctrl && ch === "p") return input("history-previous");
  if (key.ctrl && ch === "n") return input("history-next");
  if (ch && !key.ctrl && !key.meta) return input("insert", { text: ch });
  return handled;
}

export function applyKeyboardInput(state, action) {
  switch (action.operation) {
    case "backspace":
      return backspace(state);
    case "delete":
      return deleteForward(state);
    case "left":
      return moveLeft(state);
    case "right":
      return moveRight(state);
    case "word-left":
      return moveWordLeft(state);
    case "word-right":
      return moveWordRight(state);
    case "history-previous":
      return historyPrevious(state);
    case "history-next":
      return historyNext(state);
    case "home":
      return moveHome(state);
    case "end":
      return moveEnd(state);
    case "clear":
      return setValue(state, "");
    case "delete-word-left":
      return deleteWordLeft(state);
    case "kill-line":
      return killLine(state);
    case "insert":
      return insertText(state, action.text);
    default:
      return state;
  }
}
