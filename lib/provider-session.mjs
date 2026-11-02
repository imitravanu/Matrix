// ============================================================================
// Session-bound provider identity.
//
// A session records which provider/model/config digest a run used. Resuming it
// against a different endpoint or auth reference is refused instead of silently
// switching the run to another provider or to Local Forge. No key value is
// stored; the digest covers only execution-affecting profile fields.
// ============================================================================

import { createHash } from "node:crypto";

import {
  isExplicitBuiltinProvider,
  resolveProviderSelection,
  targetDigest,
} from "./provider-contracts.mjs";

/**
 * Fixed digest for a built-in identity. Built-ins have no mutable profile, but
 * the session schema still needs a stable 64-hex value so an edited sidecar
 * cannot silently claim another provider's identity.
 */
export function builtinSessionDigest(providerId) {
  return createHash("sha256").update(`matrix-builtin-provider-v1\0${providerId}`).digest("hex");
}

/** Project a selected picker model into the small identity saved with a session. */
export function sessionProviderIdentity(model) {
  const target = model?.providerTarget;
  if (!target) return null;
  // Local Forge is fully described by its model ID and keeps the legacy shape.
  if (target.kind === "local") return null;
  if (target.kind === "builtin") {
    // Explicit built-ins can serve arbitrary wire IDs that the legacy model
    // registry cannot reconstruct. Persist the exact provider/model pair so a
    // resume never falls back to Local Forge.
    return Object.freeze({
      id: target.providerId,
      modelId: target.modelId,
      digest: builtinSessionDigest(target.providerId),
    });
  }
  if (target.kind !== "custom") return null;
  return Object.freeze({
    id: target.providerId,
    modelId: target.modelId,
    digest: target.configDigest,
  });
}

/**
 * Compare a saved identity with the current configuration and catalog. Returns
 * an actionable error, never a repaired or fallback target.
 */
export function validateSessionProvider(
  identity,
  { config = null, loaded = null, catalog: _catalog = null } = {},
) {
  if (!identity) return { ok: true, error: null };
  if (isExplicitBuiltinProvider(identity.id)) {
    if (identity.digest !== builtinSessionDigest(identity.id)) {
      return {
        ok: false,
        error: `provider "${identity.id}" changed since this session was saved`,
      };
    }
    try {
      resolveProviderSelection({ providerId: identity.id, modelQuery: identity.modelId });
    } catch (error) {
      return {
        ok: false,
        error: `model "${identity.modelId}" is no longer available for provider "${identity.id}": ${error?.message ?? String(error)}`,
      };
    }
    return { ok: true, error: null };
  }
  if (loaded && loaded.status !== "valid") {
    return {
      ok: false,
      error: `provider configuration is ${loaded.status === "invalid" ? "invalid" : "missing"}; the session cannot be resumed safely`,
    };
  }
  const active = config ?? loaded?.config ?? null;
  if (!active) return { ok: false, error: "provider configuration is not loaded" };
  const profile = active.providers.find((entry) => entry.id === identity.id);
  if (!profile) {
    return { ok: false, error: `provider "${identity.id}" is no longer configured` };
  }
  if (targetDigest(profile) !== identity.digest) {
    return {
      ok: false,
      error: `provider "${identity.id}" changed since this session was saved (endpoint, auth or request options)`,
    };
  }
  // Manual exact IDs intentionally need no catalog entry. Re-resolve the saved
  // model against the unchanged profile so a malformed/wire-invalid ID is still
  // refused; discovery membership is not an execution prerequisite.
  try {
    resolveProviderSelection({
      providerId: identity.id,
      modelQuery: identity.modelId,
      config: active,
    });
  } catch (error) {
    return {
      ok: false,
      error: `model "${identity.modelId}" is no longer available for provider "${identity.id}": ${error?.message ?? String(error)}`,
    };
  }
  return { ok: true, error: null };
}
