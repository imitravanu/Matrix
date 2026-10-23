import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCompletion,
  backspace,
  completeSlash,
  createInputState,
  cursorPosition,
  deleteForward,
  deleteWordLeft,
  historyNext,
  historyPrevious,
  inputSegments,
  insertText,
  killLine,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  normalizeInput,
  setHistory,
  setValue,
  slashMatches,
  submit,
  SLASH_COMMANDS,
} from "../lib/input.mjs";

test("createInputState clamps newlines and places the cursor at the end", () => {
  const state = createInputState("  hello\nworld  ");
  assert.equal(state.value, "  hello world  ");
  assert.equal(state.cursor, state.value.length);
  assert.equal(state.historyIndex, -1);
  assert.equal(normalizeInput("a\u0000b\nc"), "ab c");
});

test("insertText, backspace and deleteForward edit at the cursor", () => {
  let state = createInputState("abc");
  state = moveLeft(moveLeft(state));
  state = insertText(state, "X");
  assert.equal(state.value, "aXbc");
  assert.equal(state.cursor, 2);
  state = backspace(state);
  assert.equal(state.value, "abc");
  state = deleteForward(state);
  assert.equal(state.value, "ac");
  state = moveHome(state);
  state = backspace(state);
  assert.equal(state.value, "ac");
});

test("word movement and home/end respect whitespace boundaries", () => {
  const state = createInputState("alpha beta gamma");
  assert.equal(cursorPosition(state), 16);
  assert.equal(cursorPosition(moveWordLeft(state)), 11);
  assert.equal(cursorPosition(moveWordLeft(moveWordLeft(state))), 6);
  assert.equal(cursorPosition(moveWordRight(moveHome(state))), 6);
  state.cursor = 7; // inside "beta"
  assert.equal(cursorPosition(moveWordLeft(state)), 6);
  assert.equal(cursorPosition(moveEnd(state)), 16);
  assert.equal(cursorPosition(moveRight(moveEnd(state))), 16);
});

test("historyPrevious/Next restores the draft at the end", () => {
  let state = createInputState("draft", ["one", "two"]);
  state = historyPrevious(state);
  assert.equal(state.value, "two");
  assert.equal(state.draft, "draft");
  state = historyPrevious(state);
  assert.equal(state.value, "one");
  state = historyPrevious(state);
  assert.equal(state.value, "one");
  state = historyNext(state);
  assert.equal(state.value, "two");
  state = historyNext(state);
  assert.equal(state.value, "draft");
  assert.equal(state.historyIndex, -1);
  assert.equal(setHistory(state, ["x"]).historyIndex, -1);
});

test("submit ignores whitespace and de-duplicates history", () => {
  let state = createInputState("  hello  ", ["hello", "other"]);
  const submitted = submit(state);
  assert.equal(submitted.value, "hello");
  assert.equal(submitted.state.value, "");
  assert.deepEqual(submitted.state.history, ["other", "hello"]);
  assert.equal(submit(createInputState("   ")).value, "");
});

test("slashMatches filters by prefix and stops after an argument", () => {
  assert.ok(slashMatches("/").length === SLASH_COMMANDS.length);
  assert.deepEqual(slashMatches("/he").map((item) => item.name), ["/help"]);
  assert.deepEqual(slashMatches("/m").map((item) => item.name), ["/model"]);
  assert.deepEqual(slashMatches("/help ").map((item) => item.name), ["/help"]);
  assert.deepEqual(slashMatches("/help now"), []);
  assert.deepEqual(slashMatches("hello"), []);
});

test("completeSlash completes a unique match and finds common prefixes", () => {
  const unique = completeSlash(createInputState("/he"));
  assert.equal(unique.value, "/help ");
  assert.equal(completeSlash(createInputState("hello")), null);
  const ambiguous = completeSlash(createInputState("/"));
  assert.equal(ambiguous.value, "/");
  assert.equal(applyCompletion(createInputState("abc"), "xyz").value, "xyz");
});

test("inputSegments exposes the cursor cell and empty state", () => {
  const state = createInputState("abc");
  state.cursor = 1;
  assert.deepEqual(inputSegments(state), { before: "a", at: "b", after: "c", empty: false });
  assert.deepEqual(inputSegments(createInputState("")), { before: "", at: "", after: "", empty: true });
});

test("setValue normalizes and moves the cursor to the end", () => {
  const state = setValue(createInputState("abc"), "x\ny");
  assert.equal(state.value, "x y");
  assert.equal(state.cursor, 3);
});

test("deleteWordLeft and killLine edit accurately", () => {
  let state = createInputState("alpha beta gamma");
  state = deleteWordLeft(state);
  assert.equal(state.value, "alpha beta ");
  assert.equal(state.cursor, 11);
  state = deleteWordLeft(state);
  assert.equal(state.value, "alpha ");
  assert.equal(state.cursor, 6);

  let state2 = createInputState("fix processor bug");
  state2 = moveHome(state2);
  state2 = moveWordRight(state2); // at end of "fix "
  state2 = killLine(state2);
  assert.equal(state2.value, "fix ");
});
