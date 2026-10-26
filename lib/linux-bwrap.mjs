// Linux bubblewrap backend. Every command uses required namespaces, a minimal
// root, a disposable snapshot and a cleared environment. There is no fallback.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { runProcess } from "./process.mjs";
import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from "./linux-snapshot.mjs";

export const LINUX_BWRAP_BACKEND = "linux-bwrap";
export const LINUX_RESOURCE_LIMITS = Object.freeze({
  cpuSeconds: 30,
  addressSpaceBytes: 2 * 1024 * 1024 * 1024,
  fileSizeBytes: 16 * 1024 * 1024,
  openFiles: 64,
  maxProcesses: 2048,
  tmpfsBytes: 16 * 1024 * 1024,
  outputChars: 128 * 1024,
});
export const LINUX_SANDBOX_POLICY = Object.freeze({
  backend: LINUX_BWRAP_BACKEND,
  namespaces: Object.freeze(["user", "pid", "ipc", "network", "uts"]),
  network: "new-empty-network-namespace; no inherited sockets or host socket paths",
  seccomp: "none; namespace isolation is not a kernel-syscall filter",
  root: "read-only tmpfs with fresh /dev and procfs",
  runtimeMounts: Object.freeze([
    "/usr (read-only)",
    "/etc/ld.so.cache (selected public file)",
    "realpath(process.execPath) (exact file, read-only, only when outside /usr/workspace)",
  ]),
  workspace: "private no-follow snapshot at its canonical absolute path; writes discarded",
  temporary: "separate bounded tmpfs at /tmp",
  environment: Object.freeze(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PWD"]),
  fileDescriptors: "stdin ignored; only the designed stdout/stderr pipes cross the boundary",
});

const HARD_LIMITS = Object.freeze({
  cpuSeconds: [1, 300],
  addressSpaceBytes: [256 * 1024 * 1024, 8 * 1024 * 1024 * 1024],
  fileSizeBytes: [4096, 256 * 1024 * 1024],
  openFiles: [16, 256],
  maxProcesses: [32, 4096],
  tmpfsBytes: [1024 * 1024, 256 * 1024 * 1024],
  outputChars: [1024, 512 * 1024],
});
const FIXED_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/nonexistent",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TMPDIR: "/tmp",
});

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function currentNodeExecutable() {
  try {
    return realpathSync(process.execPath);
  } catch {
    return null;
  }
}

function resourceLimits(overrides = {}) {
  const result = { ...LINUX_RESOURCE_LIMITS };
  for (const key of Object.keys(overrides)) {
    if (!(key in result)) throw new Error(`unsupported Linux resource limit: ${key}`);
    const value = overrides[key];
    const [minimum, maximum] = HARD_LIMITS[key];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Linux resource limit ${key} must be between ${minimum} and ${maximum}`);
    }
    result[key] = value;
  }
  return result;
}

function prlimitArguments(limits) {
  const hardCpu = Math.min(HARD_LIMITS.cpuSeconds[1] + 2, limits.cpuSeconds + 2);
  return [
    "--core=0:0",
    `--cpu=${limits.cpuSeconds}:${hardCpu}`,
    `--as=${limits.addressSpaceBytes}:${limits.addressSpaceBytes}`,
    `--fsize=${limits.fileSizeBytes}:${limits.fileSizeBytes}`,
    `--nofile=${limits.openFiles}:${limits.openFiles}`,
    `--nproc=${limits.maxProcesses}:${limits.maxProcesses}`,
  ];
}

function validateMountLayout(plan) {
  if (
    plan.workspace === "/" ||
    ["/usr", "/etc", "/proc", "/dev", "/tmp"].includes(plan.workspace)
  ) {
    throw new Error("workspace root conflicts with the minimal sandbox mount layout");
  }
  for (const mounted of ["/usr", "/etc", "/proc", "/dev"]) {
    if (inside(plan.workspace, mounted) || inside(mounted, plan.workspace)) {
      throw new Error("workspace may not contain or overlap a fixed public runtime mount");
    }
  }
}

/** Build only bwrap's own argv; the approved executable and literal argv follow `--`. */
export function linuxBwrapArguments(plan, snapshot, overrides = {}) {
  validateMountLayout(plan);
  if (snapshot.sourceRoot !== plan.workspace)
    throw new Error("snapshot/workspace identity mismatch");
  const limits = resourceLimits(overrides);
  const args = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-net",
    "--unshare-uts",
    "--disable-userns",
    "--assert-userns-disabled",
    "--die-with-parent",
    "--hostname",
    "matrix-sandbox",
    "--clearenv",
  ];
  for (const [key, value] of Object.entries(FIXED_ENV)) args.push("--setenv", key, value);
  args.push("--tmpfs", "/", "--dir", "/usr", "--ro-bind", "/usr", "/usr", "--dir", "/etc");
  const loaderCache = "/etc/ld.so.cache";
  if (existsSync(loaderCache) && statSync(loaderCache).isFile()) {
    args.push("--ro-bind", loaderCache, loaderCache);
  }
  args.push(
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    String(limits.tmpfsBytes),
    "--tmpfs",
    "/tmp",
  );
  const currentNode = currentNodeExecutable();
  if (
    plan.executable === currentNode &&
    !inside("/usr", currentNode) &&
    !inside(plan.workspace, currentNode)
  ) {
    // Mount only the running trusted Node file, never its parent directory or
    // any neighboring /tmp, /opt, home, or lookalike executable.
    args.push("--dir", dirname(currentNode), "--ro-bind", currentNode, currentNode);
  }
  args.push(
    "--dir",
    plan.workspace,
    "--bind",
    snapshot.workspacePath,
    plan.workspace,
    // Remount only the root; snapshot and /tmp submounts remain writable.
    "--remount-ro",
    "/",
    "--chdir",
    plan.cwd,
    "--",
    plan.executable,
    ...plan.argv,
  );
  return args;
}

function probeSource() {
  return `
    const fs = require("node:fs");
    const namespaces = {};
    for (const name of ["user", "pid", "ipc", "net", "uts"]) {
      namespaces[name] = fs.readlinkSync("/proc/self/ns/" + name);
    }
    let rootWrite = "allowed";
    try { fs.writeFileSync("/matrix-probe-escape", "no"); }
    catch (error) { rootWrite = error.code; }
    fs.writeFileSync("probe.txt", "snapshot-changed");
    process.stdout.write(JSON.stringify({
      namespaces,
      rootWrite,
      root: fs.readdirSync("/").sort(),
      absent: ["/home", "/root", "/run", "/var"].every((path) => !fs.existsSync(path)),
      environment: Object.keys(process.env).sort(),
      hostname: require("node:os").hostname(),
      pid: process.pid
    }));
  `;
}

function parseProbe(stdout) {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) throw new Error("sandbox probe returned no status");
  return JSON.parse(line);
}

/** Create a backend with one cached real-policy probe per executable pair. */
export function createLinuxBwrapBackend({
  bwrapPath = "/usr/bin/bwrap",
  prlimitPath = "/usr/bin/prlimit",
  probeExecutable = process.execPath,
  limits = {},
} = {}) {
  const baseLimits = resourceLimits(limits);
  let probePromise = null;

  const spawn = (plan, snapshot, options = {}) => {
    const merged = { ...baseLimits, ...(options.limits ?? {}) };
    const checked = resourceLimits(merged);
    const wallTimeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(wallTimeoutMs) || wallTimeoutMs < 1 || wallTimeoutMs > 600_000) {
      throw new Error("sandbox wall timeout must be between 1 and 600000 milliseconds");
    }
    return runProcess({
      file: prlimitPath,
      args: [
        ...prlimitArguments(checked),
        bwrapPath,
        ...linuxBwrapArguments(plan, snapshot, checked),
      ],
      cwd: snapshot.workspacePath,
      timeoutMs: wallTimeoutMs,
      signal: options.signal ?? null,
      env: {},
      // Node's explicit three-entry stdio layout closes every other inherited
      // descriptor, including network sockets; no bwrap control FD is inherited.
      stdin: "ignore",
      onLine: options.onLine ?? null,
      display: plan.command,
    });
  };

  const probe = () => {
    if (probePromise) return probePromise;
    let cleanupFailure = null;
    probePromise = (async () => {
      if (process.platform !== "linux") {
        return {
          available: false,
          backend: LINUX_BWRAP_BACKEND,
          reason: "bubblewrap requires Linux",
        };
      }
      let probeRuntime;
      try {
        probeRuntime = realpathSync(probeExecutable);
      } catch {
        return {
          available: false,
          backend: LINUX_BWRAP_BACKEND,
          reason: `required sandbox executable is unavailable: ${probeExecutable}`,
        };
      }
      for (const executable of [bwrapPath, prlimitPath, probeRuntime]) {
        try {
          if (!isAbsolute(executable) || !statSync(executable).isFile())
            throw new Error("not a file");
        } catch {
          return {
            available: false,
            backend: LINUX_BWRAP_BACKEND,
            reason: `required sandbox executable is unavailable: ${executable}`,
          };
        }
      }
      const scratchRoot = join(tmpdir(), `matrix-bwrap-probe-${process.pid}-${Date.now()}`);
      let snapshot = null;
      try {
        rmSync(scratchRoot, { recursive: true, force: true });
        const source = join(scratchRoot, "source");
        mkdirSync(source, { recursive: true, mode: 0o700 });
        writeFileSync(join(source, "probe.txt"), "live-probe", { mode: 0o600 });
        snapshot = createWorkspaceSnapshot(source, { scratchDir: join(scratchRoot, "scratch") });
        const plan = {
          executable: probeRuntime,
          argv: ["-e", probeSource()],
          cwd: snapshot.sourceRoot,
          workspace: snapshot.sourceRoot,
          command: `${probeRuntime} -e <fixed sandbox probe>`,
        };
        const hostNamespaces = Object.fromEntries(
          ["user", "pid", "ipc", "net", "uts"].map((name) => [
            name,
            readlinkSync(`/proc/self/ns/${name}`),
          ]),
        );
        const run = await spawn(plan, snapshot, { timeoutMs: 5000 });
        if (run.error || run.timedOut || run.aborted || run.code !== 0) {
          return {
            available: false,
            backend: LINUX_BWRAP_BACKEND,
            reason: `sandbox policy probe failed: ${run.error ?? `exit ${run.code ?? run.signal ?? "unknown"}`}`,
          };
        }
        const status = parseProbe(run.stdout);
        for (const [name, identity] of Object.entries(hostNamespaces)) {
          if (status.namespaces?.[name] === identity) {
            return {
              available: false,
              backend: LINUX_BWRAP_BACKEND,
              reason: `sandbox probe did not create the required ${name} namespace`,
            };
          }
        }
        const expectedEnvironment = Object.keys(FIXED_ENV).concat("PWD").sort();
        if (
          status.rootWrite !== "EROFS" ||
          status.absent !== true ||
          status.hostname !== "matrix-sandbox" ||
          JSON.stringify(status.environment) !== JSON.stringify(expectedEnvironment)
        ) {
          return {
            available: false,
            backend: LINUX_BWRAP_BACKEND,
            reason: "sandbox probe did not enforce the required root/environment boundary",
          };
        }
        if (readFileSync(join(source, "probe.txt"), "utf8") !== "live-probe") {
          return {
            available: false,
            backend: LINUX_BWRAP_BACKEND,
            reason: "sandbox probe modified its live source instead of only the snapshot",
          };
        }
        return { available: true, backend: LINUX_BWRAP_BACKEND, reason: null };
      } catch (error) {
        return {
          available: false,
          backend: LINUX_BWRAP_BACKEND,
          reason: `sandbox policy probe failed: ${error.message}`,
        };
      } finally {
        const cleaned = snapshot ? cleanupWorkspaceSnapshot(snapshot) : { ok: true };
        rmSync(scratchRoot, { recursive: true, force: true });
        if (!cleaned.ok) cleanupFailure = cleaned.error;
      }
    })()
      .then((result) =>
        cleanupFailure
          ? { available: false, backend: LINUX_BWRAP_BACKEND, reason: cleanupFailure }
          : result,
      )
      .catch((error) => ({
        available: false,
        backend: LINUX_BWRAP_BACKEND,
        reason: `sandbox policy probe cleanup failed: ${error.message}`,
      }));
    return probePromise;
  };

  return {
    name: LINUX_BWRAP_BACKEND,
    policy: LINUX_SANDBOX_POLICY,
    probe,
    async execute(plan, snapshot, options = {}) {
      const available = await probe();
      if (!available.available) return { ...available, unavailable: true };
      if (options.signal?.aborted) {
        return {
          ok: false,
          processOk: false,
          code: null,
          signal: null,
          timedOut: false,
          aborted: true,
          error: null,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 0,
        };
      }
      const run = await spawn(plan, snapshot, options);
      const checked = resourceLimits({ ...baseLimits, ...(options.limits ?? {}) });
      const outputChars = checked.outputChars;
      for (const stream of ["stdout", "stderr"]) {
        if (run[stream].length > outputChars) {
          run[stream] = run[stream].slice(-outputChars);
          run[`${stream}Truncated`] = true;
        }
      }
      return { ...run, available: true, unavailable: false, backend: LINUX_BWRAP_BACKEND };
    },
  };
}
