// ============================================================================
// Cursor-aware single-line input model.
//
// The first version only appended and backspaced at the end. A workbench input
// needs real editing: cursor movement, word jumps, delete-forward, history, and
// completion. This module is pure so it can be tested without Ink.
// ============================================================================

const asChars = (value) => [...String(value ?? "")];

export function normalizeInput(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function createInputState(value = "", history = []) {
  const clean = normalizeInput(value);
  return {
    value: clean,
    cursor: asChars(clean).length,
    history: [...history].slice(-100),
    historyIndex: -1,
    draft: "",
  };
}

export function setValue(state, value) {
  const clean = normalizeInput(value);
  return {
    ...state,
    value: clean,
    cursor: asChars(clean).length,
  };
}

export function insertText(state, text) {
  const chars = asChars(state.value);
  const insertion = asChars(normalizeInput(text));
  if (insertion.length === 0) return state;
  const before = chars.slice(0, state.cursor).join("");
  const after = chars.slice(state.cursor).join("");
  const value = before + insertion.join("") + after;
  return { ...state, value, cursor: state.cursor + insertion.length };
}

export function backspace(state) {
  if (state.cursor <= 0) return state;
  const chars = asChars(state.value);
  chars.splice(state.cursor - 1, 1);
  return { ...state, value: chars.join(""), cursor: state.cursor - 1 };
}

export function deleteForward(state) {
  const chars = asChars(state.value);
  if (state.cursor >= chars.length) return state;
  chars.splice(state.cursor, 1);
  return { ...state, value: chars.join("") };
}

export function moveLeft(state, amount = 1) {
  return { ...state, cursor: Math.max(0, state.cursor - amount) };
}

export function moveRight(state, amount = 1) {
  return { ...state, cursor: Math.min(asChars(state.value).length, state.cursor + amount) };
}

export function moveHome(state) {
  return { ...state, cursor: 0 };
}

export function moveEnd(state) {
  return { ...state, cursor: asChars(state.value).length };
}

export function moveWordLeft(state) {
  const chars = asChars(state.value);
  let i = state.cursor;
  while (i > 0 && /\s/.test(chars[i - 1])) i--;
  while (i > 0 && !/\s/.test(chars[i - 1])) i--;
  return { ...state, cursor: i };
}

export function moveWordRight(state) {
  const chars = asChars(state.value);
  let i = state.cursor;
  while (i < chars.length && !/\s/.test(chars[i])) i++;
  while (i < chars.length && /\s/.test(chars[i])) i++;
  return { ...state, cursor: i };
}

/** Up-arrow history: first press saves the current draft. */
export function historyPrevious(state) {
  if (state.history.length === 0) return state;
  let index;
  if (state.historyIndex === -1) {
    index = state.history.length - 1;
    const value = state.history[index];
    return {
      ...state,
      historyIndex: index,
      draft: state.value,
      value,
      cursor: asChars(value).length,
    };
  }
  if (state.historyIndex <= 0) return state;
  index = state.historyIndex - 1;
  const value = state.history[index];
  return { ...state, historyIndex: index, value, cursor: asChars(value).length };
}

export function historyNext(state) {
  if (state.historyIndex === -1) return state;
  if (state.historyIndex >= state.history.length - 1) {
    const value = state.draft;
    return { ...state, historyIndex: -1, value, cursor: asChars(value).length };
  }
  const index = state.historyIndex + 1;
  const value = state.history[index];
  return { ...state, historyIndex: index, value, cursor: asChars(value).length };
}

export function setHistory(state, history) {
  return { ...state, history: [...history].slice(-100), historyIndex: -1, draft: "" };
}

/**
 * Commit the input. Returns {state, value}; empty submissions are ignored.
 */
export function submit(state) {
  const value = state.value.trim();
  if (!value) return { state, value: "" };
  const history = [...state.history.filter((h) => h !== value), value].slice(-100);
  return {
    state: createInputState("", history),
    value,
  };
}

export function applyCompletion(state, completion) {
  return setValue(state, completion);
}

export function cursorPosition(state) {
  return state.cursor;
}

/** Render the input as three pieces so the UI can draw a cursor cell. */
export function inputSegments(state) {
  const chars = asChars(state.value);
  return {
    before: chars.slice(0, state.cursor).join(""),
    at: chars[state.cursor] ?? "",
    after: chars.slice(state.cursor + 1).join(""),
    empty: chars.length === 0,
  };
}

/** Completable slash commands, filtered by the current input. */
export const SLASH_COMMANDS = [
  { name: "/help", description: "show keymap and commands" },
  { name: "/new", description: "start a new session; clears metrics and undo" },
  { name: "/clear", description: "clear the transcript, keep the session" },
  { name: "/test", description: "run the project's test command" },
  { name: "/auto", description: "toggle auto-approve for the next run" },
  { name: "/diff", description: "open the last applied patch" },
  { name: "/ast", description: "open the structural scope lens" },
  { name: "/swarm", description: "open the live agent lanes" },
  { name: "/vision", description: "open the pixel canvas" },
  { name: "/model", description: "switch the active model" },
  { name: "/undo", description: "restore the backup from the last edit" },
  { name: "/session", description: "show session and workspace details" },
  { name: "/doctor", description: "run environment diagnostics" },
  { name: "/quit", description: "save the session and exit" },
];

export function slashMatches(value) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("/")) return [];
  const [head, ...rest] = text.split(/\s+/);
  if (rest.length > 0) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(head));
}

export function completeSlash(state) {
  const matches = slashMatches(state.value);
  if (matches.length === 0) return null;
  if (matches.length === 1) return applyCompletion(state, matches[0].name + " ");
  // Complete the longest common prefix.
  const names = matches.map((m) => m.name);
  let prefix = names[0];
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return applyCompletion(state, prefix);
}
