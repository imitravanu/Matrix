// ============================================================================
// Durable-goal test guardian.
//
// This script is the sandbox command executed by Bubblewrap inside the
// per-operation PID namespace. It receives one bounded launch spec on stdin,
// waits for the host-owned gate file, and only then starts the approved test
// command. Waiting for the gate lets the host pin and persist the exact
// namespace identity (Bubblewrap monitor, namespace init, namespace inode)
// before any repository code runs.
//
// The guardian is not a policy boundary: the host already inspected and
// approved the exact executable and argv. It only delays execution and
// propagates the child's exit status. The namespace init (Bubblewrap's own
// reaper, namespace pid 1) remains the containment kill point.
// ============================================================================

import { spawn } from "node:child_process";
import { constants, existsSync, readFileSync, unlinkSync } from "node:fs";

const MAX_SPEC_BYTES = 1024 * 1024;
const GATE_WAIT_MS = 60_000;
const GATE_POLL_MS = 20;

const sleep = new Int32Array(new SharedArrayBuffer(4));
const wait = (milliseconds) => Atomics.wait(sleep, 0, 0, milliseconds);

function fail(message) {
  try {
    process.stderr.write(`goal guardian: ${message}\n`);
  } catch {
    // The sandbox may already be torn down.
  }
  process.exit(125);
}

function readSpec() {
  let raw;
  try {
    raw = readFileSync(0, "utf8");
  } catch (error) {
    fail(`launch spec could not be read: ${error?.message ?? String(error)}`);
  }
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_SPEC_BYTES) {
    fail("launch spec is missing or exceeds the bound");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("launch spec is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("launch spec is invalid");
  if (value.schemaVersion !== 1) fail("launch spec schema is unsupported");
  if (typeof value.gate !== "string" || !value.gate.startsWith("/")) fail("gate path is invalid");
  if (typeof value.file !== "string" || value.file.length === 0 || value.file.length > 4096) {
    fail("executable is invalid");
  }
  if (
    !Array.isArray(value.args) ||
    value.args.length > 512 ||
    value.args.some((arg) => typeof arg !== "string" || arg.length > 16_384)
  ) {
    fail("argument vector is invalid");
  }
  if (typeof value.cwd !== "string" || !value.cwd.startsWith("/"))
    fail("working directory is invalid");
  if (value.input !== null && value.input !== undefined && typeof value.input !== "string") {
    fail("input is invalid");
  }
  return {
    gate: value.gate,
    file: value.file,
    args: [...value.args],
    cwd: value.cwd,
    input: value.input ?? null,
  };
}

function waitForGate(gate) {
  const deadline = Date.now() + GATE_WAIT_MS;
  while (!existsSync(gate)) {
    if (Date.now() >= deadline) fail("dispatch gate was not released");
    wait(GATE_POLL_MS);
  }
  try {
    unlinkSync(gate);
  } catch {
    // The host removes it after observing exit; a missing gate is fine.
  }
}

const spec = readSpec();
waitForGate(spec.gate);

const child = spawn(spec.file, spec.args, {
  cwd: spec.cwd,
  env: process.env,
  stdio: [spec.input === null ? "ignore" : "pipe", "inherit", "inherit"],
});

if (spec.input !== null && child.stdin) {
  child.stdin.on("error", () => {});
  try {
    child.stdin.end(spec.input);
  } catch {
    // The child reports a failed read or exits without consuming it.
  }
}

child.on("error", (error) => {
  fail(`approved command could not be started: ${error?.message ?? String(error)}`);
});

child.on("exit", (code, signal) => {
  if (Number.isSafeInteger(code) && code >= 0 && code <= 255) {
    process.exit(code);
  }
  const number =
    signal && typeof constants.signals[signal] === "number" ? constants.signals[signal] : 0;
  process.exit(number > 0 ? Math.min(255, 128 + number) : 1);
});
