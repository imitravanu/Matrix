// ============================================================================
// Synchronized Output (DEC Mode 2026) Stream Wrapper
//
// Eliminates terminal flicker, split-frame tearing, and cursor jump artifacts
// by wrapping frame renders in DEC Mode 2026 atomic blit control sequences:
//   \x1b[?2026h  (Begin Synchronized Update)
//   \x1b[?2026l  (End Synchronized Update)
// Supported natively by Ghostty, Kitty, WezTerm, iTerm2 (3.5+), Alacritty (0.13+).
// ============================================================================

import { Writable } from "node:stream";

export const SYNC_BEGIN = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";

/**
 * Detects whether the active terminal environment supports DEC Mode 2026.
 * NO_COLOR disables by presence (spec), not by value.
 */
export function isSyncSupported(env = process.env) {
  if (env.MATRIX_SYNC === "1") return true;
  if (env.MATRIX_SYNC === "0") return false;
  if ("NO_COLOR" in env) return false;
  if (env.CI) return false;

  const term = (env.TERM ?? "").toLowerCase();
  const termProg = (env.TERM_PROGRAM ?? "").toLowerCase();

  return (
    term.includes("kitty") ||
    term.includes("ghostty") ||
    term.includes("wezterm") ||
    termProg.includes("ghostty") ||
    termProg.includes("wezterm") ||
    termProg.includes("iterm")
  );
}

/**
 * SynchronizedStdout buffers writes within an event-loop tick and writes
 * an atomic DEC 2026 block to the underlying terminal stream.
 */
export class SynchronizedStdout extends Writable {
  constructor(target = process.stdout, options = {}) {
    super();
    this.target = target;
    this.syncSupported =
      options.syncSupported ?? isSyncSupported(options.env ?? process.env);
    this.buffer = [];
    this.scheduled = false;
    this.frameCount = 0;
  }

  // Forward terminal dimensions and TTY characteristics
  get columns() {
    return this.target?.columns ?? 80;
  }

  get rows() {
    return this.target?.rows ?? 24;
  }

  get isTTY() {
    return Boolean(this.target?.isTTY);
  }

  getWindowSize() {
    if (typeof this.target?.getWindowSize === "function") {
      return this.target.getWindowSize();
    }
    return [this.columns, this.rows];
  }

  // Forward event listener management to target (e.g. for resize events)
  // Note: `addListener` is the alias Ink sometimes uses; both must forward.
  on(event, listener) {
    if (this.target && typeof this.target.on === "function") {
      this.target.on(event, listener);
    }
    return super.on(event, listener);
  }

  addListener(event, listener) {
    return this.on(event, listener);
  }

  once(event, listener) {
    if (this.target && typeof this.target.once === "function") {
      this.target.once(event, listener);
    }
    return super.once(event, listener);
  }

  removeListener(event, listener) {
    if (this.target && typeof this.target.removeListener === "function") {
      this.target.removeListener(event, listener);
    }
    return super.removeListener(event, listener);
  }

  off(event, listener) {
    return this.removeListener(event, listener);
  }

  _write(chunk, encoding, callback) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buffer.push(text);

    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.flush();
      });
    }

    if (typeof callback === "function") {
      callback();
    }
  }

  /**
   * Flushes all buffered terminal updates atomically.
   * frameCount only advances when bytes actually reach the target.
   */
  flush() {
    this.scheduled = false;
    if (this.buffer.length === 0) return;

    const payload = this.buffer.join("");
    this.buffer = [];
    if (payload.length === 0) return;

    if (this.syncSupported && this.target && typeof this.target.write === "function") {
      this.target.write(SYNC_BEGIN + payload + SYNC_END);
      this.frameCount++;
    } else if (this.target && typeof this.target.write === "function") {
      this.target.write(payload);
      this.frameCount++;
    }
  }
}

/**
 * Creates a synchronized stream wrapper for Ink or stdout.
 */
export function createSynchronizedStdout(target = process.stdout, options = {}) {
  return new SynchronizedStdout(target, options);
}
