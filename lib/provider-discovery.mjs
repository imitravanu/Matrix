// ============================================================================
// Explicit provider model discovery.
//
// Only an explicit refresh calls the network. Manual selection never depends on
// /models. Responses are bounded, redirects are refused, configured metadata wins
// over discovered entries, and a failed refresh keeps the last valid snapshot with
// a stale label instead of inventing models.
// ============================================================================

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  acquireProviderConfigLock,
  loadProviderConfig,
  providerCacheGeneration,
  releaseProviderConfigLock,
  synchronizeProviderCache,
} from "./provider-config.mjs";
import { redactedDetail, redactSecrets, truncateText } from "./redaction.mjs";
import {
  ProviderError,
  resolveProviderCredential,
  targetDigest,
  validateWireModelId,
} from "./provider-contracts.mjs";
import { matrixHome } from "./session.mjs";

export const DISCOVERY_LIMITS = Object.freeze({
  responseBytes: 1024 * 1024,
  entries: 1000,
  timeoutMs: 15_000,
  cacheBytes: 1024 * 1024,
  statusBytes: 4096,
  statusErrorChars: 300,
});

const STATUS_VERSION = 1;
const CANCELLED = "models refresh was cancelled";

function cacheDirectory(home) {
  return join(matrixHome(home), "provider-cache");
}

/** One current snapshot per profile, private to the Matrix home. */
export function discoveryCachePath(home, providerId) {
  return join(cacheDirectory(home), `${providerId}.json`);
}

/** Last refresh outcome for one profile, kept beside the model snapshot. */
export function discoveryStatusPath(home, providerId) {
  return join(cacheDirectory(home), `${providerId}.refresh.json`);
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

function boundedRead(path, limit) {
  // Non-blocking and no-follow: a FIFO cache entry must not stall the caller
  // waiting for a writer, and a symlink must not redirect the read. The type
  // check happens on the opened descriptor, so a pre-open swap cannot race it.
  let fd;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > limit) return null;
    const buffer = Buffer.allocUnsafe(Math.min(info.size, limit) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset > limit) return null;
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the last valid discovery snapshot for this profile/configuration digest.
 * Returns null for missing, stale, oversized or malformed caches.
 */
export function readDiscoveryCache(home, profile) {
  const generation = providerCacheGeneration(home, profile.id);
  if (generation === null) return null;
  const raw = boundedRead(discoveryCachePath(home, profile.id), DISCOVERY_LIMITS.cacheBytes);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== 1 ||
      parsed.providerId !== profile.id ||
      parsed.digest !== targetDigest(profile) ||
      parsed.generation !== generation ||
      !Array.isArray(parsed.models) ||
      parsed.models.length > DISCOVERY_LIMITS.entries
    ) {
      return null;
    }
    const models = [];
    const seen = new Set();
    for (const entry of parsed.models) {
      if (typeof entry?.id !== "string") return null;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      models.push(Object.freeze({ id: entry.id }));
    }
    return Object.freeze({
      providerId: profile.id,
      digest: parsed.digest,
      fetchedAt: Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : null,
      models: Object.freeze(models),
    });
  } catch {
    return null;
  }
}

function writeDiscoveryStatus(home, profile, { outcome, error, fetchedAt, at, generation }) {
  try {
    const directory = cacheDirectory(home);
    ensurePrivateDir(directory);
    const path = discoveryStatusPath(home, profile.id);
    const temp = join(
      directory,
      `.${profile.id}-refresh-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    const payload = {
      version: STATUS_VERSION,
      providerId: profile.id,
      digest: targetDigest(profile),
      generation,
      at,
      outcome,
      error:
        outcome === "error" && typeof error === "string"
          ? truncateText(error, DISCOVERY_LIMITS.statusErrorChars)
          : null,
      fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null,
    };
    try {
      writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        // The refresh result is still returned; status is diagnostic only.
      }
    }
  } catch {
    // Refresh outcome reporting must never fail a refresh that already happened.
  }
}

/**
 * Read the last refresh outcome for this profile/digest. Returns null when the
 * record is missing, malformed, oversized or belongs to another configuration,
 * so configured models stay usable without an invented freshness label.
 */
export function readDiscoveryStatus(home, profile) {
  const generation = providerCacheGeneration(home, profile.id);
  if (generation === null) return null;
  const raw = boundedRead(discoveryStatusPath(home, profile.id), DISCOVERY_LIMITS.statusBytes);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== STATUS_VERSION ||
      parsed.providerId !== profile.id ||
      parsed.digest !== targetDigest(profile) ||
      parsed.generation !== generation ||
      (parsed.outcome !== "ok" && parsed.outcome !== "error")
    ) {
      return null;
    }
    return Object.freeze({
      outcome: parsed.outcome,
      error:
        parsed.outcome === "error" && typeof parsed.error === "string"
          ? truncateText(parsed.error, DISCOVERY_LIMITS.statusErrorChars)
          : null,
      at: Number.isFinite(parsed.at) ? parsed.at : null,
      fetchedAt: Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : null,
    });
  } catch {
    return null;
  }
}

function writeDiscoveryCache(home, profile, models, fetchedAt, generation) {
  const directory = cacheDirectory(home);
  ensurePrivateDir(directory);
  const path = discoveryCachePath(home, profile.id);
  const temp = join(
    directory,
    `.${profile.id}-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  const payload = {
    version: 1,
    providerId: profile.id,
    digest: targetDigest(profile),
    generation,
    fetchedAt,
    models: models.map((model) => ({ id: model.id })),
  };
  try {
    writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort.
    }
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Ignore cleanup failure; the write error is actionable.
    }
    throw error;
  }
}

async function readBoundedBody(response, limit, controller) {
  const body = response?.body;
  if (!body || typeof body.getReader !== "function") return "";
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  // A caller cancellation must interrupt a stalled body, not wait for the
  // deadline. Cancelling the reader resolves a pending read as done.
  const onAbort = () => {
    Promise.resolve(reader.cancel("discovery cancelled")).catch(() => {});
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > limit) {
        controller.abort();
        try {
          await reader.cancel("discovery response exceeded the byte limit");
        } catch {
          // Cancellation is best effort.
        }
        throw new ProviderError(
          "CONFIG_LIMIT_EXCEEDED",
          `discovery response exceeded ${limit} bytes`,
        );
      }
      chunks.push(chunk);
    }
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function failed(providerId, error, cached) {
  return {
    ok: false,
    providerId,
    error,
    models: cached ? cached.models : [],
    stale: cached ? true : null,
  };
}

/**
 * GET the profile's /models endpoint exactly once, with that profile's own auth
 * and base URL. Runs only when the caller explicitly refreshes.
 */
export async function refreshProviderModels({
  home,
  providerId,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DISCOVERY_LIMITS.timeoutMs,
  maxBytes = DISCOVERY_LIMITS.responseBytes,
  maxEntries = DISCOVERY_LIMITS.entries,
  now = () => Date.now(),
  signal = null,
} = {}) {
  if (signal?.aborted) return failed(providerId, CANCELLED, null);
  const startedAt = Date.now();
  const budget =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(DISCOVERY_LIMITS.timeoutMs, Math.floor(timeoutMs))
      : 1;
  try {
    const synchronized = await synchronizeProviderCache({ home, signal, lockTimeoutMs: budget });
    if (signal?.aborted) return failed(providerId, CANCELLED, null);
    if (!synchronized && loadProviderConfig({ home }).status === "valid") {
      return failed(providerId, "provider cache could not be synchronized safely", null);
    }
  } catch {
    if (signal?.aborted) return failed(providerId, CANCELLED, null);
    return failed(providerId, "provider cache could not be synchronized safely", null);
  }
  const loaded = loadProviderConfig({ home });
  if (loaded.status === "invalid") {
    return failed(providerId, loaded.error.message, null);
  }
  const profile = loaded.config.providers.find((entry) => entry.id === providerId);
  if (!profile) return failed(providerId, `unknown provider "${providerId}"`, null);

  const generation = providerCacheGeneration(home, profile.id);
  const publicationDeadline = startedAt + budget;
  if (Date.now() >= publicationDeadline)
    return failed(providerId, "models request timed out", null);
  async function publishIfCurrent(publish) {
    if (generation === null) return false;
    let lock;
    try {
      lock = await acquireProviderConfigLock({
        home,
        lockTimeoutMs: Math.max(0, Math.min(5000, publicationDeadline - Date.now())),
        signal,
      });
      const current = loadProviderConfig({ home });
      const active =
        current.status === "valid"
          ? current.config.providers.find((entry) => entry.id === providerId)
          : null;
      if (
        !active ||
        signal?.aborted === true ||
        targetDigest(active) !== targetDigest(profile) ||
        providerCacheGeneration(home, providerId) !== generation
      )
        return false;
      publish();
      return true;
    } catch {
      // A lock or publication error leaves observations unavailable.
      return false;
    } finally {
      await releaseProviderConfigLock(lock);
    }
  }

  const cached = readDiscoveryCache(home, profile);
  const callerAborted = () => signal?.aborted === true;
  if (callerAborted()) return failed(providerId, CANCELLED, cached);

  // Record a provider-side failure so a rebuilt catalog can label the snapshot
  // stale; a caller cancellation is not a provider failure and keeps the last
  // recorded outcome untouched.
  const recordFailure = async (message) => {
    await publishIfCurrent(() =>
      writeDiscoveryStatus(home, profile, {
        outcome: "error",
        error: message,
        fetchedAt: cached?.fetchedAt ?? null,
        at: now(),
        generation,
      }),
    );
    return failed(providerId, message, cached);
  };

  let credential;
  try {
    credential = resolveProviderCredential({ providerId: profile.id, auth: profile.auth }, env);
  } catch (error) {
    return recordFailure(error.message);
  }

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(new Error(CANCELLED));
  signal?.addEventListener?.("abort", onCallerAbort, { once: true });
  if (callerAborted()) onCallerAbort();
  const timer = setTimeout(
    () => controller.abort(new Error("discovery timeout")),
    Math.max(1, publicationDeadline - Date.now()),
  );
  try {
    const headers = { Accept: "application/json" };
    if (credential !== null) headers.Authorization = `Bearer ${credential}`;
    const response = await fetchImpl(`${profile.baseUrl}/models`, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "manual",
    });

    if (!response?.ok) {
      const status = Number(response?.status ?? 0);
      const body = await readBoundedBody(response, 4096, controller).catch(() => "");
      if (callerAborted()) return failed(providerId, CANCELLED, cached);
      const detail = redactedDetail(body, { secrets: [credential], maxChars: 160 });
      return recordFailure(`models endpoint returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    }

    const text = await readBoundedBody(response, maxBytes, controller);

    // A caller can cancel after the bytes arrived but before anything is
    // committed; the prior snapshot must survive that race.
    if (callerAborted()) return failed(providerId, CANCELLED, cached);
    // The deadline can cancel a stalled reader that then resolves with partial
    // bytes. That is a provider-side failure: record it so a rebuilt catalog
    // does not label the retained snapshot as fresh.
    if (controller.signal.aborted) return recordFailure("models request timed out");

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return recordFailure("models endpoint returned invalid JSON");
    }
    if (!parsed || !Array.isArray(parsed.data)) {
      return recordFailure("models response is missing a data array");
    }

    const models = [];
    const seen = new Set();
    for (const entry of parsed.data) {
      if (models.length >= maxEntries) break;
      if (typeof entry?.id !== "string") continue;
      let id;
      try {
        id = validateWireModelId(entry.id);
      } catch {
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      models.push(Object.freeze({ id }));
    }

    const fetchedAt = now();
    const published = await publishIfCurrent(() => {
      writeDiscoveryCache(home, profile, models, fetchedAt, generation);
      writeDiscoveryStatus(home, profile, {
        outcome: "ok",
        error: null,
        fetchedAt,
        at: fetchedAt,
        generation,
      });
    });
    if (!published) {
      if (callerAborted()) return failed(providerId, CANCELLED, cached);
      return failed(
        providerId,
        "models were received but could not be saved because the provider changed or the cache was unavailable",
        null,
      );
    }
    return {
      ok: true,
      providerId,
      models,
      fetchedAt,
      stale: false,
      truncated: parsed.data.length > models.length,
    };
  } catch (error) {
    if (callerAborted()) return failed(providerId, CANCELLED, cached);
    const message =
      error?.name === "AbortError" || controller.signal.aborted
        ? "models request was cancelled or timed out"
        : `models request failed: ${redactSecrets(error?.message ?? String(error), [credential])}`;
    return recordFailure(message);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onCallerAbort);
  }
}

/** Remove a profile's cached snapshot when its configuration changes or it is removed. */
export function clearDiscoveryCache(home, providerId) {
  try {
    rmSync(discoveryCachePath(home, providerId), { force: true });
    rmSync(discoveryStatusPath(home, providerId), { force: true });
    return true;
  } catch {
    return false;
  }
}
