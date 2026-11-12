// ============================================================================
// Durable-goal process containment.
//
// A goal test is executed inside a Bubblewrap live-root PID namespace:
//
//   host runner ── bwrap monitor ── namespace init (ns pid 1, the reaper)
//                                      └── guardian (ns pid 2)
//                                            └── approved test command
//
// The host pins the monitor, the namespace init and the namespace inode before
// it releases the guardian's gate. A detached descendant may leave its process
// group, but it cannot leave the PID namespace; killing namespace init (through
// the reviewed pidfd helper) stops every member. Normal completion, timeout and
// cancellation all settle the exact namespace before the runner reports a
// result, and a successful settlement persists a reconciliation record so the
// workspace authority probe does not block the goal's own next operation.
// ============================================================================

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripAnsi } from "./text.mjs";
import { LINUX_SANDBOX_ENV, linuxIsolationArguments } from "./linux-bwrap.mjs";

const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";
const GUARDIAN_PATH = fileURLToPath(new URL("./goal-guardian.mjs", import.meta.url));

// The durable-goal test boundary reuses the `run_sandboxed_command` isolation
// layout: a minimal read-only root, a disposable no-follow workspace snapshot,
// a new empty network namespace and a cleared environment. Only the trusted
// host files the approved plan needs are mounted read-only.
const GOAL_MOUNT_ROOT = "/matrix-goal";
const GATE_MOUNT = `${GOAL_MOUNT_ROOT}/gate`;
const GUARDIAN_MOUNT = `${GOAL_MOUNT_ROOT}/guardian.mjs`;

/**
 * The namespace flags for the durable-goal boundary. It keeps the isolated
 * command's namespaces and cleared environment, but deliberately omits
 * `--die-with-parent`: the goal's namespace must survive the death of its owner
 * so that a later process can prove its teardown through the ownership
 * boundary.
 */
const GOAL_NAMESPACE_FLAGS = Object.freeze([
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-net",
  "--unshare-uts",
  "--hostname",
  "matrix-sandbox",
  "--clearenv",
]);
const MAX_CAPTURE = 512 * 1024;
const PIN_TIMEOUT_MS = 10_000;
const POLL_MS = 10;
const EXIT_GRACE_MS = 5_000;
const CLOSE_GRACE_MS = 1_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Read the direct children of one process from the host's procfs. */
export function readChildPids(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    return raw
      .trim()
      .split(/\s+/)
      .filter((value) => /^[0-9]+$/.test(value))
      .map(Number);
  } catch {
    return null;
  }
}

function createCapture(onLine) {
  const states = new Map();
  let stdout = "";
  let stderr = "";
  let stdoutChars = 0;
  let stderrChars = 0;
  const decoders = new Map();

  const emit = (stream, line) => {
    if (typeof onLine !== "function") return;
    try {
      onLine(stripAnsi(line).replace(/\r$/, ""), stream);
    } catch {
      // A rendering callback must never crash the runner.
    }
  };
  const push = (text, stream) => {
    if (!text) return;
    if (!states.has(stream)) states.set(stream, { buffer: "", truncated: false });
    const state = states.get(stream);
    state.buffer += text;
    let index;
    while ((index = state.buffer.indexOf("\n")) !== -1) {
      const line = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 1);
      emit(stream, (state.truncated ? "…" : "") + line);
      state.truncated = false;
    }
    if (state.buffer.length > MAX_CAPTURE) {
      state.buffer = state.buffer.slice(-MAX_CAPTURE);
      state.truncated = true;
    }
    if (stream === "stdout") {
      stdoutChars += text.length;
      stdout = (stdout + text).slice(-MAX_CAPTURE);
    } else {
      stderrChars += text.length;
      stderr = (stderr + text).slice(-MAX_CAPTURE);
    }
  };
  return {
    feed(chunk, stream) {
      if (!decoders.has(stream)) decoders.set(stream, new StringDecoder("utf8"));
      push(decoders.get(stream).write(chunk), stream);
    },
    end() {
      for (const [stream, decoder] of decoders) push(decoder.end(), stream);
      for (const [stream, state] of states) {
        if (state.buffer.length > 0) {
          emit(stream, (state.truncated ? "…" : "") + state.buffer);
          state.buffer = "";
        }
      }
    },
    stdout: () => stdout,
    stderr: () => stderr,
    stdoutTruncated: () => stdoutChars > MAX_CAPTURE,
    stderrTruncated: () => stderrChars > MAX_CAPTURE,
  };
}

function privateGateDirectory(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    // The caller's MATRIX_HOME is already private in normal deployments.
  }
}

function openGate(path) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  closeSync(fd);
}

function removeQuietly(path) {
  try {
    if (path) rmSync(path, { force: true });
  } catch {
    // Best effort.
  }
}

function failureOf(settlement) {
  if (!settlement) return null;
  if (settlement.error) return settlement.error;
  const value = settlement.value;
  if (!value || value.ok !== true) {
    return new Error(
      `goal containment: teardown could not be verified (${value?.reason ?? "unknown"}: ${
        value?.detail ?? "no detail"
      })`,
    );
  }
  return null;
}

function inside(root, candidate) {
  if (!root || !candidate) return false;
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

/**
 * The Node runtime distribution that provides the running Node, when the
 * approved plan is one of the tools installed with it (npm, npx). A developer
 * installation outside `/usr` is mounted read-only at its canonical path so the
 * approved plan can still start, and its `bin` directory is added to the
 * isolated `PATH` so its `#!/usr/bin/env node` shebang resolves.
 */
function nodeRuntimePrefix(executable) {
  return goalRuntimePrefix(goalRuntimeRealpath(process.execPath), executable);
}

/**
 * The Node runtime distribution that provides `currentNode`, when the approved
 * executable belongs to it (npm, npx). A distribution outside `/usr` is
 * mounted read-only at its canonical path so the approved plan can still
 * start, and its `bin` directory is added to the isolated `PATH` so its
 * `#!/usr/bin/env node` shebang resolves.
 *
 * @param {string|null} currentNode the canonical path of the running Node
 * @param {string} executable the approved executable
 * @returns {string|null} the distribution prefix, or null when none applies
 */
export function goalRuntimePrefix(currentNode, executable) {
  if (!currentNode) return null;
  const binDirectory = dirname(currentNode);
  if (basename(binDirectory) !== "bin") return null;
  const prefix = dirname(binDirectory);
  if (!inside(prefix, executable)) return null;
  if (inside("/usr", prefix)) return null;
  return prefix;
}

/** The canonical path of a trusted runtime file, or null when it cannot be read. */
export function goalRuntimeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Build the disposable-snapshot isolation for one goal test dispatch.
 *
 * The approved command runs inside the same layout as `run_sandboxed_command`:
 * a minimal read-only root, the workspace snapshot bound at the canonical
 * workspace path, a new empty network namespace and a cleared environment. The
 * snapshot absorbs every write, so the live workspace, the Matrix home and the
 * rest of the host filesystem are unreachable to the test.
 *
 * @param {{
 *   workspace: string,
 *   cwd: string,
 *   executable: string,
 *   gateRoot: string,
 *   guardianPath?: string,
 *   scratchDir?: string,
 *   matrixHome?: string|null,
 *   signal?: AbortSignal|null,
 * }} options
 */
export function createGoalTestIsolation({
  workspace,
  cwd,
  executable,
  gateRoot,
  snapshot,
  env = {},
  guardianPath = GUARDIAN_PATH,
}) {
  if (!isAbsolute(workspace)) throw new Error("goal isolation: the workspace must be absolute");
  if (!isAbsolute(cwd)) throw new Error("goal isolation: the working directory must be absolute");
  if (!isAbsolute(executable)) {
    throw new Error("goal isolation: the approved executable must be absolute");
  }
  if (!snapshot?.workspacePath) {
    throw new Error("goal isolation: a disposable workspace snapshot is required");
  }
  const bindings = [];
  // The isolated command keeps the credential-cleared environment the trusted
  // test runner already produced, so a project test keeps the variables it
  // needs. `HOME` is replaced with a path that does not exist inside the
  // isolated root, and the credential files under the real home are not
  // reachable at all: the root carries no `/home`, `/root` or `/var`.
  const inNamespaceEnv = {
    ...env,
    HOME: LINUX_SANDBOX_ENV.HOME,
    LANG: env.LANG ?? LINUX_SANDBOX_ENV.LANG,
    LC_ALL: env.LC_ALL ?? LINUX_SANDBOX_ENV.LC_ALL,
    TMPDIR: LINUX_SANDBOX_ENV.TMPDIR,
    PATH: env.PATH ?? LINUX_SANDBOX_ENV.PATH,
  };

  // The dispatch gate is host-owned. It is mounted read-only so the isolated
  // command can observe the release but cannot create or delete it.
  bindings.push({ host: gateRoot, mount: GATE_MOUNT });

  // The guardian is trusted host code, never repository code. It is mounted
  // read-only at a dedicated path so it cannot be reached or replaced through
  // the workspace snapshot.
  bindings.push({ host: guardianPath, mount: GUARDIAN_MOUNT });

  const currentNode = goalRuntimeRealpath(process.execPath);
  if (currentNode && !inside("/usr", currentNode)) {
    bindings.push({ host: currentNode, mount: currentNode });
  }

  const prefix = nodeRuntimePrefix(executable);
  if (prefix) {
    bindings.push({ host: prefix, mount: prefix });
    if (!inNamespaceEnv.PATH.split(":").includes(join(prefix, "bin"))) {
      inNamespaceEnv.PATH = `${inNamespaceEnv.PATH}:${join(prefix, "bin")}`;
    }
  } else if (!inside("/usr", executable) && executable !== currentNode) {
    // A single trusted executable outside the public runtime is mounted
    // read-only at its canonical path; never its parent directory.
    bindings.push({ host: executable, mount: executable });
  }

  const bwrapArgs = [
    ...linuxIsolationArguments({
      snapshot,
      workspace,
      cwd,
      namespaceFlags: GOAL_NAMESPACE_FLAGS,
      bindings,
      env: inNamespaceEnv,
    }),
    "--",
    currentNode ?? process.execPath,
    GUARDIAN_MOUNT,
  ];

  return {
    snapshot,
    bwrapArgs,
    gateMount: GATE_MOUNT,
  };
}

/**
 * Build a `processRunner` for `runTests` that executes the approved plan inside
 * a pinned PID namespace and settles ownership before returning.
 *
 * @param {{
 *   ownership: *,
 *   gateRoot: string,
 *   bwrapPath?: string,
 *   guardianPath?: string,
 *   onPin: (containment: *) => *,
 * }} config
 */
export function createContainmentProcessRunner(config = {}) {
  const { ownership, gateRoot, onPin } = config;
  if (!ownership || typeof ownership.pinContainment !== "function") {
    throw new Error("goal containment: the execution-ownership boundary is required");
  }
  if (typeof onPin !== "function") {
    throw new Error("goal containment: a dispatch-record callback is required");
  }
  if (typeof gateRoot !== "string" || gateRoot.length === 0) {
    throw new Error("goal containment: a private gate directory is required");
  }
  const bwrapPath = config.bwrapPath ?? DEFAULT_BWRAP_PATH;
  const isolation = config.isolation;
  if (typeof isolation !== "function") {
    throw new Error("goal containment: a disposable-snapshot isolation builder is required");
  }

  return async function runContainedProcess(options = {}) {
    const file = options.file;
    const args = Array.isArray(options.args) ? [...options.args] : [];
    const cwd = options.cwd ?? process.cwd();
    const command = options.display ?? `${file ?? ""} ${args.join(" ")}`.trim();
    const started = Date.now();
    const emptyResult = (extra = {}) => ({
      ok: false,
      code: null,
      signal: null,
      timedOut: false,
      aborted: false,
      error: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
      command,
      cwd,
      ...extra,
    });
    if (typeof file !== "string" || file.length === 0) {
      return emptyResult({ error: "goal containment: an executable is required" });
    }
    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
    const signal = options.signal ?? null;
    if (signal?.aborted) {
      return emptyResult({ aborted: true });
    }

    const capture = createCapture(options.onLine);
    privateGateDirectory(gateRoot);
    const gateName = `gate-${process.pid}-${randomBytes(8).toString("hex")}`;
    const gate = join(gateRoot, gateName);
    let built = null;
    const spec = {
      schemaVersion: 1,
      // The guardian waits for the gate inside the isolated root. The host
      // creates the same file at its own path; the read-only bind makes the
      // release visible without exposing a writable host directory.
      gate: "",
      file,
      args,
      cwd,
      input: options.input ?? null,
    };

    /** @type {import("node:child_process").ChildProcess | null} */
    let child = null;
    let monitorPid;
    let containment = null;
    let record = null;
    let closed = false;
    let aborting = false;
    let aborted = false;
    let timedOut = false;
    let settlement = null;
    let settlementStarted = false;
    let setupError = null;
    let spawnError = null;
    /** @type {{code: number | null, signal: string | null} | null} */
    let exitInfo = null;

    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const settleExit = (code, signalName) => {
      if (exitInfo) return;
      exitInfo = { code: Number.isSafeInteger(code) ? code : null, signal: signalName ?? null };
      closed = true;
      resolveExit(exitInfo);
    };

    const stopUnpinnedMonitor = () => {
      if (!closed) child?.kill("SIGKILL");
    };

    // The settlement is synchronous and idempotent: cancellation, timeout and
    // normal completion all funnel through the exact pinned identity.
    const settle = () => {
      if (settlementStarted) return settlement;
      settlementStarted = true;
      try {
        if (record) {
          settlement = { value: ownership.settleOperation(record) };
        } else if (containment) {
          settlement = { value: ownership.teardownContainment(containment) };
        } else {
          // No gate was ever released, so no repository code has run in the
          // namespace. The still-unpinned monitor can be stopped directly.
          settlement = { value: { ok: true, mechanism: "pre-dispatch" } };
        }
      } catch (error) {
        settlement = { error: error instanceof Error ? error : new Error(String(error)) };
      }
      // Before pinning, the closed gate prevents repository code from running.
      if (!record && !containment) stopUnpinnedMonitor();
      return settlement;
    };

    const onAbort = () => {
      aborted = true;
      aborting = true;
      settle();
    };
    const onTimeout = () => {
      timedOut = true;
      aborting = true;
      settle();
    };

    let timer = null;
    let initPid = null;
    try {
      built = await isolation({
        file,
        args,
        cwd,
        env: options.env ?? process.env,
        gateRoot,
        gateName,
        signal,
      });
      if (!built || !Array.isArray(built.bwrapArgs) || typeof built.gateMount !== "string") {
        throw new Error("goal containment: the isolation builder returned no usable boundary");
      }
      spec.gate = `${built.gateMount}/${gateName}`;
      child = spawn(bwrapPath, built.bwrapArgs, {
        cwd,
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      monitorPid = child.pid ?? null;
      if (monitorPid === null) throw new Error("goal containment: Bubblewrap did not start");
      child.once("error", (error) => {
        spawnError = error instanceof Error ? error : new Error(String(error));
        settleExit(null, null);
      });
      child.once("exit", (code, signalName) => settleExit(code, signalName));
      child.once("close", (code, signalName) => settleExit(code, signalName));
      child.stdout?.on("data", (chunk) => capture.feed(chunk, "stdout"));
      child.stderr?.on("data", (chunk) => capture.feed(chunk, "stderr"));
      child.stdin?.on("error", () => {});
      try {
        child.stdin?.end(JSON.stringify(spec));
      } catch {
        // The guardian reports a failed read or the monitor exits.
      }

      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onTimeout, timeoutMs);
      timer.unref?.();

      const deadline = Date.now() + PIN_TIMEOUT_MS;
      while (!aborting && !closed && Date.now() < deadline) {
        const children = readChildPids(monitorPid);
        if (children && children.length > 0) {
          initPid = children[0];
          break;
        }
        await delay(POLL_MS);
      }

      if (!aborting && !closed && initPid === null) {
        throw new Error("goal containment: the namespace init did not appear");
      }
      if (!aborting && !closed) {
        containment = ownership.pinContainment({ monitorPid, initPid });
        record = onPin(containment);
        if (!record || typeof record !== "object") {
          throw new Error("goal containment: the dispatch record was not persisted");
        }
        // The namespace must still be the exact one that was recorded before
        // any repository code is allowed to run.
        ownership.assertContainmentIdentity(containment);
        openGate(gate);
      }
    } catch (error) {
      setupError = error instanceof Error ? error : new Error(String(error));
      settle();
    }

    if (!closed) {
      await Promise.race([exitPromise, delay(EXIT_GRACE_MS)]);
    }
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);

    // The monitor may exit while namespace init still reaps a detached
    // descendant. Normal completion must settle/prove the namespace even when
    // the monitor's exit preceded it.
    if (!settlementStarted) settle();

    // Wait briefly for the captured pipes to drain; a detached member holding
    // them is already dead after settlement, so closing is bounded.
    if (child) {
      const closedPromise = new Promise((resolve) => child.once("close", resolve));
      if (!closed) await Promise.race([closedPromise, delay(CLOSE_GRACE_MS)]);
    }
    try {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    } catch {
      // Streams may already be closed.
    }
    capture.end();
    removeQuietly(gate);
    if (built) {
      try {
        const cleaned = await built.cleanup?.();
        if (cleaned && cleaned.ok === false) {
          throw new Error(`goal containment: disposable snapshot cleanup failed: ${cleaned.error}`);
        }
      } catch (error) {
        if (!setupError) {
          setupError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    const exit = exitInfo ?? { code: null, signal: null };
    const failure = failureOf(settlement);
    const error = spawnError ?? failure ?? null;
    const result = {
      ok:
        !aborting &&
        !aborted &&
        !timedOut &&
        failure === null &&
        spawnError === null &&
        exit.code === 0,
      code: exit.code,
      signal: exit.signal,
      timedOut,
      aborted,
      error: error?.message ?? null,
      stdout: capture.stdout(),
      stderr: capture.stderr(),
      stdoutTruncated: capture.stdoutTruncated(),
      stderrTruncated: capture.stderrTruncated(),
      durationMs: Date.now() - started,
      command,
      cwd,
    };

    if (aborted || timedOut) return result;
    if (setupError) throw setupError;
    if (spawnError) return result;
    if (!record) throw new Error("goal containment: no owned namespace was recorded");
    if (failure) throw failure;
    return result;
  };
}

export { DEFAULT_BWRAP_PATH, GUARDIAN_PATH };
