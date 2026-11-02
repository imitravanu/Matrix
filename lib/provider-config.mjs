// ============================================================================
// Named provider configuration: private bounded load, serialized mutation and
// atomic replacement of ${MATRIX_HOME}/providers.json.
//
// Exclusion is held by the kernel: on Linux the lock is an abstract Unix socket
// bound for the duration of the mutation, so the kernel releases it when the
// owning process dies and no contender can ever remove a live owner's lock.
// Platforms without abstract sockets fall back to a lock directory that is
// never stolen: a stale owner is reported for manual recovery instead of being
// deleted. See docs/next-phase/decisions/PRV-101.md.
// ============================================================================

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

import { matrixHome } from "./session.mjs";
import {
  EMPTY_PROVIDER_CONFIG,
  PROVIDER_LIMITS,
  ProviderError,
  configurationDigest,
  isProviderError,
  targetDigest,
  validateProviderConfig,
  validateProviderId,
  validateProviderModel,
} from "./provider-contracts.mjs";

const LOCK_SUFFIX = ".lock";
const OWNER_FILE = "owner.json";
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MIN_MS = 15;
const LOCK_RETRY_JITTER_MS = 25;
const KERNEL_LOCK_PREFIX = "\u0000matrix-provider-config-";
const LOCK_STRATEGIES = Object.freeze(["kernel", "directory"]);
const ACTIVE_KERNEL_LOCKS = new WeakMap();

function configFileStamp(home) {
  let fd;
  try {
    fd = openSync(
      providerConfigPath(home),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile()) return null;
    return createHash("sha256")
      .update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`)
      .digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function storedConfigStamp(home) {
  let fd;
  try {
    const path = join(dirname(providerConfigPath(home)), ".providers.cache-stamp");
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size !== 64) return null;
    const buffer = Buffer.alloc(65);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, size).toString("ascii");
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function cacheStampMatches(home) {
  const current = configFileStamp(home);
  return current !== null && current === storedConfigStamp(home);
}

function writeConfigCacheStamp(home, identity) {
  const directory = dirname(providerConfigPath(home));
  const stamp = configFileStamp(home);
  if (!stamp) throw new Error("cannot inspect saved provider configuration");
  const path = join(directory, ".providers.cache-stamp");
  const temp = join(directory, `.cache-stamp-${randomBytes(12).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, stamp);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!sameDirectoryIdentity(identity, configDirectoryIdentity(providerConfigPath(home)))) {
      throw new Error("provider configuration directory changed");
    }
    renameSync(temp, path);
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* already renamed */
    }
  }
}

/** Generation changes before execution-affecting profile mutations. */
export function providerCacheGeneration(home, providerId) {
  validateProviderId(providerId);
  if (!cacheStampMatches(home)) return null;
  const path = join(dirname(providerConfigPath(home)), `.provider-${providerId}.generation`);
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const info = fstatSync(fd);
    if (!info.isFile() || info.size !== 32) return null;
    const buffer = Buffer.alloc(33);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const value = buffer.subarray(0, size).toString("ascii");
    return /^[a-f0-9]{32}$/.test(value) ? value : null;
  } catch (error) {
    return error?.code === "ENOENT" ? "legacy" : null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function advanceCacheGeneration(home, providerId, identity) {
  const directory = dirname(providerConfigPath(home));
  if (!sameDirectoryIdentity(identity, configDirectoryIdentity(providerConfigPath(home)))) {
    throw providerError(
      "CONFIG_CONFLICT",
      "provider configuration directory changed before cache invalidation",
    );
  }
  const path = join(directory, `.provider-${providerId}.generation`);
  const temp = join(directory, `.generation-${randomBytes(12).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, randomBytes(16).toString("hex"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!sameDirectoryIdentity(identity, configDirectoryIdentity(providerConfigPath(home)))) {
      throw providerError(
        "CONFIG_CONFLICT",
        "provider configuration directory changed during cache invalidation",
      );
    }
    renameSync(temp, path);
    // The generation must be durable before the config can change. If the
    // filesystem cannot confirm that, refuse the mutation rather than risk
    // resurrecting old evidence after a crash.
    const directoryFd = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* already renamed */
    }
  }
}

const EMPTY_DIGEST = configurationDigest(EMPTY_PROVIDER_CONFIG);

/** `${MATRIX_HOME}/providers.json`, following the existing home abstraction. */
export function providerConfigPath(home) {
  return join(matrixHome(home), "providers.json");
}

function providerError(code, message, details = null) {
  return new ProviderError(code, message, details);
}

function asProviderError(error, fallbackMessage) {
  if (isProviderError(error)) return error;
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  return providerError("CONFIG_INVALID", `${fallbackMessage}${code}`);
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

/**
 * Bounded, no-follow read of the configuration file.
 * Returns null when the file does not exist.
 */
function readConfigText(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw providerError("CONFIG_SYMLINK", "provider configuration must not be a symlink");
    }
    if (!info.isFile()) {
      throw providerError("CONFIG_NOT_REGULAR", "provider configuration must be a regular file");
    }
    if (info.size > PROVIDER_LIMITS.configBytes) {
      throw providerError(
        "CONFIG_TOO_LARGE",
        `provider configuration exceeds ${PROVIDER_LIMITS.configBytes} bytes`,
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw asProviderError(error, "could not inspect provider configuration");
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") {
      throw providerError("CONFIG_SYMLINK", "provider configuration must not be a symlink");
    }
    throw providerError("CONFIG_INVALID", `could not open provider configuration (${error?.code})`);
  }

  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw providerError("CONFIG_NOT_REGULAR", "provider configuration must be a regular file");
    }
    if (info.size > PROVIDER_LIMITS.configBytes) {
      throw providerError(
        "CONFIG_TOO_LARGE",
        `provider configuration exceeds ${PROVIDER_LIMITS.configBytes} bytes`,
      );
    }
    const length = Math.min(info.size, PROVIDER_LIMITS.configBytes) + 1;
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset > PROVIDER_LIMITS.configBytes) {
      throw providerError(
        "CONFIG_TOO_LARGE",
        `provider configuration exceeds ${PROVIDER_LIMITS.configBytes} bytes`,
      );
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function invalidLoad(path, error) {
  return Object.freeze({
    status: "invalid",
    path,
    config: EMPTY_PROVIDER_CONFIG,
    digest: null,
    error,
  });
}

/**
 * Read-only load. Never throws: a corrupt file is reported as `status: "invalid"`
 * so Local Forge still starts, while explicit custom-provider use fails.
 *
 * @param {{home?: string}} [options]
 */
export function loadProviderConfig({ home } = {}) {
  const path = providerConfigPath(home);
  let text;
  try {
    text = readConfigText(path);
  } catch (error) {
    return invalidLoad(path, asProviderError(error, "could not read provider configuration"));
  }
  if (text === null) {
    return Object.freeze({
      status: "missing",
      path,
      config: EMPTY_PROVIDER_CONFIG,
      digest: EMPTY_DIGEST,
      error: null,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalidLoad(
      path,
      providerError("CONFIG_INVALID_JSON", "provider configuration is not valid JSON"),
    );
  }

  try {
    const config = validateProviderConfig(parsed);
    return Object.freeze({
      status: "valid",
      path,
      config,
      digest: configurationDigest(config),
      error: null,
    });
  } catch (error) {
    return invalidLoad(path, asProviderError(error, "provider configuration is invalid"));
  }
}

function lockOwnerPath(lockDir) {
  return join(lockDir, OWNER_FILE);
}

function readLockOwner(lockDir) {
  try {
    const raw = readFileSync(lockOwnerPath(lockDir), "utf8");
    if (Buffer.byteLength(raw, "utf8") > PROVIDER_LIMITS.lockOwnerBytes) return null;
    const owner = JSON.parse(raw);
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
    return owner;
  } catch {
    return null;
  }
}

/** EPERM means the process exists but belongs to another user: treat as live. */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function describeOwner(owner) {
  if (owner && Number.isInteger(owner.pid)) return `pid ${owner.pid}`;
  return "unknown owner";
}

function delay(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * Identity of the actual configuration directory. Two Matrix homes that reach
 * the same directory through different path spellings (a symlinked home, a
 * `..` route, a bind-mounted alias) must share one lock, so exclusion is keyed
 * on the device/inode pair, never on the lexical path.
 */
function configDirectoryIdentity(configPath) {
  const directory = dirname(configPath);
  try {
    ensurePrivateDir(directory);
    const real = realpathSync(directory);
    const info = statSync(real);
    if (!info.isDirectory()) {
      throw providerError(
        "CONFIG_NOT_REGULAR",
        "provider configuration directory is not a directory",
      );
    }
    return Object.freeze({ real, dev: info.dev, ino: info.ino });
  } catch (error) {
    throw asProviderError(error, "could not inspect the provider configuration directory");
  }
}

function sameDirectoryIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

/** Stable per-directory abstract socket name; the kernel owns its lifetime. */
function lockAddress(identity) {
  const digest = createHash("sha256")
    .update(`${identity.dev}:${identity.ino}`)
    .digest("hex")
    .slice(0, 40);
  return `${KERNEL_LOCK_PREFIX}${digest}`;
}

/**
 * Bind the abstract socket, or resolve null when another process already holds
 * it. The binding itself is the atomic acquisition: no rename, no unlink, no
 * PID guesswork, and the kernel releases it when this process dies.
 */
function listenKernelLock(address) {
  return new Promise((done, fail) => {
    const server = createServer();
    const onError = (error) => {
      server.removeListener("listening", onListening);
      if (error?.code === "EADDRINUSE") {
        done(null);
        return;
      }
      fail(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      // Post-acquisition socket errors must never crash the mutation.
      server.on("error", () => {});
      server.unref();
      done(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ path: address });
  });
}

async function acquireKernelLock(identity, timeoutMs, signal) {
  const address = lockAddress(identity);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted)
      throw providerError("CONFIG_LOCKED", "provider lock acquisition cancelled");
    let server;
    try {
      server = await listenKernelLock(address);
    } catch (error) {
      throw asProviderError(error, "could not acquire the provider configuration lock");
    }
    if (server) {
      const token = randomBytes(16).toString("hex");
      ACTIVE_KERNEL_LOCKS.set(server, token);
      return { kind: "kernel", address, token, pid: process.pid, server };
    }
    if (Date.now() >= deadline) {
      throw providerError(
        "CONFIG_LOCKED",
        "provider configuration is locked by another Matrix process on this host",
      );
    }
    await delay(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS));
  }
}

/**
 * Portable fallback with the same no-stealing rule: a lock directory is only
 * ever created or removed by its own owner. A dead owner is reported with the
 * exact recovery path instead of being reclaimed, because reclaiming cannot be
 * made race-free against a process that recreates the path.
 */
async function acquireDirectoryLock(configPath, timeoutMs, signal) {
  const lockDir = `${configPath}${LOCK_SUFFIX}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (signal?.aborted)
      throw providerError("CONFIG_LOCKED", "provider lock acquisition cancelled");
    let created = false;
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw asProviderError(error, "could not acquire the provider configuration lock");
      }
    }

    if (created) {
      const token = randomBytes(16).toString("hex");
      try {
        writeFileSync(
          lockOwnerPath(lockDir),
          JSON.stringify({ v: 1, pid: process.pid, token, at: Date.now(), host: hostname() }),
          { mode: 0o600, flag: "wx" },
        );
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true });
        throw asProviderError(error, "could not record the provider configuration lock owner");
      }
      return { kind: "directory", lockDir, token, pid: process.pid };
    }

    const owner = readLockOwner(lockDir);
    if (owner && Number.isInteger(owner.pid) && !processIsAlive(owner.pid)) {
      throw providerError(
        "CONFIG_LOCKED",
        `provider configuration is locked by pid ${owner.pid}, which is no longer running; verify no Matrix process is running, then remove ${lockDir}`,
      );
    }
    if (Date.now() >= deadline) {
      throw providerError(
        "CONFIG_LOCKED",
        `provider configuration is locked by another Matrix process (${describeOwner(owner)})`,
      );
    }
    await delay(LOCK_RETRY_MIN_MS + Math.floor(Math.random() * LOCK_RETRY_JITTER_MS));
  }
}

/**
 * Acquire the configuration lock. The kernel strategy is the default on Linux;
 * `directory` exists for platforms without abstract sockets and for tests.
 * Neither strategy removes a lock it does not own.
 *
 * @param {{home?: string, lockTimeoutMs?: number, strategy?: "kernel"|"directory", signal?: AbortSignal|null}} [options]
 */
export async function acquireProviderConfigLock({
  home,
  lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  strategy = process.platform === "linux" ? "kernel" : "directory",
  signal = null,
} = {}) {
  if (!LOCK_STRATEGIES.includes(strategy)) {
    throw providerError("CONFIG_INVALID", `unknown provider lock strategy "${strategy}"`);
  }
  const configPath = providerConfigPath(home);
  const identity = configDirectoryIdentity(configPath);
  const timeout = Number.isFinite(lockTimeoutMs) ? Math.max(0, lockTimeoutMs) : 0;
  const lock =
    strategy === "kernel"
      ? await acquireKernelLock(identity, timeout, signal)
      : await acquireDirectoryLock(configPath, timeout, signal);

  if (signal?.aborted) {
    await releaseProviderConfigLock(lock);
    throw providerError("CONFIG_LOCKED", "provider lock acquisition cancelled");
  }

  // The directory can be replaced (or a symlinked parent retargeted) between
  // choosing the lock and binding it. Bind to the directory that exists now,
  // and fail closed instead of writing through a stale identity.
  const current = configDirectoryIdentity(configPath);
  if (!sameDirectoryIdentity(identity, current)) {
    await releaseProviderConfigLock(lock);
    throw providerError(
      "CONFIG_CONFLICT",
      "provider configuration directory changed while acquiring the lock; reload and retry",
    );
  }
  return { ...lock, identity };
}

/** Release only the lock this caller owns; a foreign lock is never removed. */
export async function releaseProviderConfigLock(lock) {
  if (!lock) return false;
  if (lock.kind === "kernel") {
    if (!lock.server || ACTIVE_KERNEL_LOCKS.get(lock.server) !== lock.token) return false;
    const server = lock.server;
    ACTIVE_KERNEL_LOCKS.delete(server);
    lock.server = null;
    await new Promise((done) => {
      server.close(() => done());
    });
    return true;
  }
  if (lock.kind === "directory") {
    if (!lock.lockDir || !lock.token) return false;
    const owner = readLockOwner(lock.lockDir);
    if (!owner || owner.token !== lock.token || owner.pid !== lock.pid) return false;
    try {
      rmSync(lock.lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function fsyncDirectory(path) {
  let fd = null;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Best effort; durability of the rename is the important part.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures; the write already succeeded or threw.
      }
    }
  }
}

function refuseReplacementTarget(path) {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      throw providerError("CONFIG_SYMLINK", "provider configuration must not be a symlink");
    }
    if (!info.isFile()) {
      throw providerError("CONFIG_NOT_REGULAR", "provider configuration must be a regular file");
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw asProviderError(error, "could not validate the provider configuration target");
  }
}

function writeConfigAtomic(path, config, identity) {
  // Serialize exactly once and refuse before replacement: a mutation must
  // never leave a file that its own loader would reject as oversized.
  const content = `${JSON.stringify(config, null, 2)}\n`;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > PROVIDER_LIMITS.configBytes) {
    throw providerError(
      "CONFIG_TOO_LARGE",
      `provider configuration would be ${bytes} bytes, exceeding ${PROVIDER_LIMITS.configBytes}`,
    );
  }

  ensurePrivateDir(dirname(path));
  const temp = join(
    dirname(path),
    `.providers-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd = null;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (!sameDirectoryIdentity(identity, configDirectoryIdentity(path))) {
      throw providerError(
        "CONFIG_CONFLICT",
        "provider configuration directory changed during the write; nothing was replaced",
      );
    }
    refuseReplacementTarget(path);
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The original write error is the actionable failure.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // Temp may not exist or may already be renamed.
    }
    throw asProviderError(error, "could not write provider configuration");
  }
}

function cloneConfig(config) {
  return structuredClone(config);
}

function assertNoDuplicateProfile(draft, profile) {
  if (typeof profile?.id !== "string") return;
  if (draft.providers.some((entry) => entry.id === profile.id)) {
    throw providerError("PROVIDER_DUPLICATE", `provider "${profile.id}" already exists`, {
      providerId: profile.id,
    });
  }
}

function requireProfile(draft, providerId) {
  const index = draft.providers.findIndex((entry) => entry.id === providerId);
  if (index === -1) {
    throw providerError("PROVIDER_UNKNOWN", `unknown provider "${providerId}"`, { providerId });
  }
  return index;
}

/**
 * @param {function(*): *} mutate
 * @param {{home?: string, expectedDigest?: string|null, lockTimeoutMs?: number, lockStrategy?: "kernel"|"directory"}} [options]
 */
async function mutateConfig(
  mutate,
  { home, expectedDigest = null, lockTimeoutMs, lockStrategy } = {},
) {
  const path = providerConfigPath(home);
  const lock = await acquireProviderConfigLock({
    home,
    lockTimeoutMs,
    strategy: lockStrategy,
  });
  try {
    const current = loadProviderConfig({ home });
    if (current.status === "invalid") throw current.error;

    const missing = current.status === "missing";
    const baseConfig = missing ? EMPTY_PROVIDER_CONFIG : current.config;
    const baseDigest = missing ? EMPTY_DIGEST : current.digest;

    if (expectedDigest !== null && expectedDigest !== undefined && expectedDigest !== baseDigest) {
      throw providerError(
        "CONFIG_CONFLICT",
        "provider configuration changed since it was read; reload and retry",
        { expected: String(expectedDigest).slice(0, 64), actual: baseDigest },
      );
    }

    const nextRaw = mutate(cloneConfig(baseConfig));
    const nextConfig = validateProviderConfig(nextRaw);
    const externalChange = current.status === "valid" && !cacheStampMatches(home);
    const ids = new Set(
      [...baseConfig.providers, ...nextConfig.providers].map((entry) => entry.id),
    );
    for (const id of ids) {
      const before = baseConfig.providers.find((entry) => entry.id === id);
      const after = nextConfig.providers.find((entry) => entry.id === id);
      if (externalChange || !before || !after || targetDigest(before) !== targetDigest(after))
        advanceCacheGeneration(home, id, lock.identity);
    }
    writeConfigAtomic(path, nextConfig, lock.identity);
    try {
      writeConfigCacheStamp(home, lock.identity);
    } catch {
      throw providerError(
        "CONFIG_CONFLICT",
        "provider configuration was saved, but cache tracking failed; reload before retrying",
      );
    }
    return Object.freeze({
      path,
      config: nextConfig,
      digest: configurationDigest(nextConfig),
    });
  } finally {
    await releaseProviderConfigLock(lock);
  }
}

/**
 * Adopt a validated external edit while invalidating all older observations.
 * @param {{home?: string, lockTimeoutMs?: number, signal?: AbortSignal|null}} [options]
 */
export async function synchronizeProviderCache({ home, lockTimeoutMs, signal } = {}) {
  if (signal?.aborted) return false;
  const lock = await acquireProviderConfigLock({ home, lockTimeoutMs, signal });
  try {
    if (signal?.aborted) return false;
    const loaded = loadProviderConfig({ home });
    if (loaded.status !== "valid") return false;
    if (cacheStampMatches(home)) return true;
    const before = configFileStamp(home);
    if (!before) return false;
    for (const profile of loaded.config.providers)
      advanceCacheGeneration(home, profile.id, lock.identity);
    if (configFileStamp(home) !== before) return false;
    writeConfigCacheStamp(home, lock.identity);
    return cacheStampMatches(home);
  } finally {
    await releaseProviderConfigLock(lock);
  }
}

/** Add a new named profile. Duplicate IDs are refused, never overwritten. */
export async function addProviderProfile(profile, options = {}) {
  return mutateConfig((draft) => {
    assertNoDuplicateProfile(draft, profile);
    draft.providers.push(profile);
    return draft;
  }, options);
}

/** Replace one profile in place. Renaming requires remove plus add. */
export async function replaceProviderProfile(providerId, profile, options = {}) {
  validateProviderId(providerId);
  if (profile?.id !== providerId) {
    throw providerError(
      "CONFIG_INVALID",
      "replacement profile id must match the provider being replaced",
      { providerId },
    );
  }
  return mutateConfig((draft) => {
    const index = requireProfile(draft, providerId);
    draft.providers[index] = profile;
    return draft;
  }, options);
}

/** Remove one profile by exact ID. */
export async function removeProviderProfile(providerId, options = {}) {
  validateProviderId(providerId);
  return mutateConfig((draft) => {
    requireProfile(draft, providerId);
    draft.providers = draft.providers.filter((entry) => entry.id !== providerId);
    return draft;
  }, options);
}

/** Add a manually configured model to an existing profile. */
export async function addProviderModel(providerId, model, options = {}) {
  validateProviderId(providerId);
  const validated = validateProviderModel(model);
  return mutateConfig((draft) => {
    const index = requireProfile(draft, providerId);
    const profile = draft.providers[index];
    const models = profile.models ?? [];
    if (models.some((entry) => entry.id === validated.id)) {
      throw providerError(
        "PROVIDER_DUPLICATE_MODEL",
        `provider "${providerId}" already lists model "${validated.id}"`,
        { providerId, modelId: validated.id },
      );
    }
    profile.models = [...models, validated];
    return draft;
  }, options);
}

/** Remove a configured model by exact wire ID. Unknown models are refused. */
export async function removeProviderModel(providerId, modelId, options = {}) {
  validateProviderId(providerId);
  return mutateConfig((draft) => {
    const index = requireProfile(draft, providerId);
    const profile = draft.providers[index];
    const models = profile.models ?? [];
    if (!models.some((entry) => entry.id === modelId)) {
      throw providerError(
        "PROVIDER_UNKNOWN",
        `provider "${providerId}" does not list model "${modelId}"`,
        { providerId, modelId },
      );
    }
    profile.models = models.filter((entry) => entry.id !== modelId);
    return draft;
  }, options);
}
