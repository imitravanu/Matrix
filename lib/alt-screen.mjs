// ============================================================================
// Alternate Screen Buffer (smcup/rmcup) & Terminal Protection
//
// Switches the terminal to an isolated alternate screen buffer (\x1b[?1049h)
// with cursor home and full clear (\x1b[H\x1b[2J). On exit, cleanly restores
// the normal screen buffer (\x1b[?1049l) and shows the cursor (\x1b[?25h).
//
// Prevents terminal pollution, old scrollback bleed-through, and line tearing.
// ============================================================================

export const MOUSE_ENTER = "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007h";
export const MOUSE_EXIT = "\x1b[?1007l\x1b[?1006l\x1b[?1002l\x1b[?1000l";

export const ALT_SCREEN_ENTER = `\x1b[?1049h${MOUSE_ENTER}\x1b[H\x1b[2J`;
export const ALT_SCREEN_EXIT = `${MOUSE_EXIT}\x1b[?1049l\x1b[?25h`;

export function isAltScreenSupported(stdout = process.stdout, env = process.env) {
  if (!stdout || !stdout.isTTY) return false;
  if ((env.TERM ?? "").toLowerCase() === "dumb") return false;
  if (env.MATRIX_NO_ALT_SCREEN === "1") return false;
  if ("NO_COLOR" in env) return false;
  if (env.CI) return false;
  return true;
}

let active = false;
let currentStream = null;

export function isAltScreenActive() {
  return active;
}

export function enterAltScreen(stream = process.stdout, env = process.env) {
  if (active || !isAltScreenSupported(stream, env)) return active;
  try {
    stream.write(ALT_SCREEN_ENTER);
    active = true;
    currentStream = stream;

    // Register exit handlers to restore terminal even on abnormal exit
    setupExitHooks();
  } catch {
    // Fail silently if stream write fails
  }
  return active;
}

export function exitAltScreen(stream = process.stdout) {
  if (!active) return;
  const target = currentStream ?? stream;
  try {
    target.write(ALT_SCREEN_EXIT);
  } catch {
    // Fail silently
  } finally {
    active = false;
    currentStream = null;
  }
}

let hooksInstalled = false;

export function _resetAltScreenForTests() {
  active = false;
  currentStream = null;
  hooksInstalled = false;
}

function setupExitHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const cleanup = () => {
    if (currentStream) exitAltScreen(currentStream);
  };

  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.once("uncaughtException", (err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
}
