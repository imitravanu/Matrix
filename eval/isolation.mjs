import childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { EVAL_CANARY, EVAL_FAKE_PROVIDER_KEY } from "./cases.mjs";
import { EVIDENCE_CLASS } from "./versions.mjs";
import { createProviderMock } from "./provider.mjs";

const PROVIDER_KEYS = [
  "OPENROUTER_API_KEY",
  "MATRIX_API_KEY",
  "MATRIX_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_HOST",
];

function outsideWorkspace(workspace, path) {
  const rel = relative(resolve(workspace), resolve(path));
  return rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel);
}

function installSpawnObserver() {
  const originalSpawn = childProcess.spawn;
  const records = [];
  const active = new Set();
  let installed = true;

  function observedSpawn(file, args = [], options = {}) {
    const actualArgs = Array.isArray(args) ? args : [];
    const actualOptions = Array.isArray(args) ? options : (args ?? {});
    const child = originalSpawn.call(this, file, actualArgs, actualOptions);
    let settle;
    const closed = new Promise((resolveClosed) => {
      settle = resolveClosed;
    });
    const record = {
      executable: String(file),
      args: actualArgs.map(String),
      cwd: actualOptions.cwd ? String(actualOptions.cwd) : process.cwd(),
      shell: Boolean(actualOptions.shell),
      detached: Boolean(actualOptions.detached),
      pid: child.pid ?? null,
      active: true,
      code: null,
      signal: null,
      error: null,
      closed,
    };
    records.push(record);
    active.add(record);
    const finish = () => {
      if (!record.active) return;
      record.active = false;
      active.delete(record);
      settle();
    };
    child.once("error", (error) => {
      record.error = error.message;
      finish();
    });
    child.once("close", (code, signal) => {
      record.code = code;
      record.signal = signal;
      finish();
    });
    return child;
  }

  childProcess.spawn = observedSpawn;
  syncBuiltinESMExports();

  async function stopActive() {
    for (const record of active) {
      try {
        if (process.platform !== "win32" && record.detached && record.pid) {
          process.kill(-record.pid, "SIGKILL");
        } else if (record.pid) process.kill(record.pid, "SIGKILL");
      } catch {
        // The child may have exited between inspection and cleanup.
      }
    }
    if (active.size > 0) {
      let timer;
      await Promise.race([
        Promise.all([...active].map((record) => record.closed)),
        new Promise((resolveWait) => {
          timer = setTimeout(resolveWait, 2000);
        }),
      ]);
      clearTimeout(timer);
    }
    return active.size;
  }

  function restore() {
    if (!installed) return;
    installed = false;
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }

  return {
    records,
    active,
    stopActive,
    restore,
    restored: () => !installed && childProcess.spawn === originalSpawn,
  };
}

function patchEnvironment(values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  return {
    previous,
    restore() {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
    restored() {
      return [...previous].every(([key, value]) => process.env[key] === value);
    },
  };
}

/**
 * Run one serial case with isolated state. Callback failures are returned, not
 * thrown, after process, fetch, environment and temporary-tree cleanup finishes.
 */
export async function withEvalIsolation(definition, callback) {
  let root = null;
  let workspace = null;
  let provider = null;
  let spawnObserver = null;
  let environment = null;
  const previousFetch = globalThis.fetch;
  let value = null;
  let error = null;
  const cleanup = {
    rootRemoved: false,
    homeOutsideWorkspace: false,
    matrixHomeOutsideWorkspace: false,
    environmentRestored: false,
    fetchRestored: false,
    spawnRestored: false,
    activeProcesses: 0,
    errors: [],
  };

  try {
    root = mkdtempSync(join(tmpdir(), "matrix-eval-"));
    workspace = join(root, "workspace");
    const home = join(root, "home");
    const matrixHome = join(root, "matrix-home");
    mkdirSync(workspace, { recursive: true, mode: 0o750 });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(matrixHome, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    chmodSync(matrixHome, 0o700);
    cleanup.homeOutsideWorkspace = outsideWorkspace(workspace, home);
    cleanup.matrixHomeOutsideWorkspace = outsideWorkspace(workspace, matrixHome);

    environment = patchEnvironment({
      HOME: home,
      MATRIX_HOME: matrixHome,
      MATRIX_EVAL_CANARY_SECRET: EVAL_CANARY,
      ...Object.fromEntries(PROVIDER_KEYS.map((key) => [key, undefined])),
      ...(definition.evidenceClass === EVIDENCE_CLASS.MOCKED_REMOTE
        ? { OPENROUTER_API_KEY: EVAL_FAKE_PROVIDER_KEY }
        : {}),
    });
    provider = createProviderMock(definition);
    globalThis.fetch = provider.fetchMock;
    spawnObserver = installSpawnObserver();

    value = await callback({ root, workspace, home, matrixHome, provider, spawnObserver });
  } catch (caught) {
    error = caught;
  }

  try {
    if (spawnObserver) {
      cleanup.activeProcesses = await spawnObserver.stopActive();
      spawnObserver.restore();
    }
  } catch (caught) {
    cleanup.errors.push(`process cleanup: ${caught.message}`);
  } finally {
    if (spawnObserver) {
      try {
        spawnObserver.restore();
      } catch (caught) {
        cleanup.errors.push(`spawn restore: ${caught.message}`);
      }
    }
    cleanup.spawnRestored = spawnObserver ? spawnObserver.restored() : false;
  }

  try {
    globalThis.fetch = previousFetch;
    cleanup.fetchRestored = globalThis.fetch === previousFetch;
  } catch (caught) {
    cleanup.errors.push(`fetch restore: ${caught.message}`);
  }
  try {
    environment?.restore();
    cleanup.environmentRestored = environment ? environment.restored() : false;
  } catch (caught) {
    cleanup.errors.push(`environment restore: ${caught.message}`);
  }
  if (root) {
    try {
      rmSync(root, { recursive: true, force: true });
      cleanup.rootRemoved = !existsSync(root);
    } catch (caught) {
      cleanup.errors.push(`temporary-tree cleanup: ${caught.message}`);
    }
  }

  return { value, error, cleanup, provider, spawnObserver, root, workspace };
}
