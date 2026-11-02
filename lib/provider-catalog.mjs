// ============================================================================
// One catalog view for CLI, UI, doctor and evaluation.
//
// Built-ins keep their static registry metadata. Custom profiles contribute their
// manual models plus any bounded discovery snapshot. Availability is computed per
// profile; a global "has key" boolean is never used. No network happens here.
// ============================================================================

import { MODELS } from "./models.mjs";
import { readDiscoveryCache, readDiscoveryStatus } from "./provider-discovery.mjs";
import { readProbeRecords } from "./provider-probe.mjs";
import { loadProviderConfig } from "./provider-config.mjs";
import { isProviderCredentialAvailable, targetDigest } from "./provider-contracts.mjs";

const BUILTIN_NAMES = Object.freeze({
  matrix: "Local Forge",
  openrouter: "OpenRouter",
  ollama: "Ollama",
});

function builtinEntry(model) {
  const remote = model.remote === true;
  return Object.freeze({
    providerId: model.provider,
    providerName: BUILTIN_NAMES[model.provider] ?? model.provider,
    source: remote ? "builtin" : "local",
    modelId: model.id,
    name: model.name ?? model.id,
    contextWindow: Number.isFinite(model.context) ? model.context : null,
    pricing: model.pricing ? Object.freeze({ ...model.pricing }) : null,
    capabilities: Object.freeze({
      tools: model.tools === true ? "supported" : model.tools === false ? "unsupported" : "unknown",
    }),
    available: remote ? null : true,
    configDigest: null,
    legacy: true,
  });
}

/**
 * Freshness is separate from configuration validity: a valid config can hold a
 * stale snapshot after a failed refresh, and a rebuilt catalog must say so.
 */
export function discoverySummary(status, cached) {
  if (!status) {
    if (!cached) return null;
    return Object.freeze({
      outcome: "ok",
      stale: false,
      error: null,
      at: cached.fetchedAt,
      fetchedAt: cached.fetchedAt,
    });
  }
  return Object.freeze({
    outcome: status.outcome,
    stale: status.outcome === "error",
    error: status.error,
    at: status.at,
    fetchedAt: cached?.fetchedAt ?? status.fetchedAt ?? null,
  });
}

function customEntry(profile, model, available, observation) {
  return Object.freeze({
    providerId: profile.id,
    providerName: profile.name,
    source: "custom",
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    pricing: model.pricing,
    capabilities: model.capabilities,
    observation,
    available,
    configDigest: targetDigest(profile),
    legacy: false,
  });
}

/**
 * Build the catalog from the validated (or invalid) local configuration.
 * Read-only: takes no lock and performs no network request.
 *
 * @param {{home?: string, env?: Record<string, string|undefined>, loaded?: *}} [options]
 */
export function buildProviderCatalog({ home, env = process.env, loaded = null } = {}) {
  const state = loaded ?? loadProviderConfig({ home });
  const providers = [];
  const entries = MODELS.map(builtinEntry);

  for (const model of MODELS) {
    if (model.remote !== true) continue;
    if (!providers.some((provider) => provider.id === model.provider)) {
      providers.push(
        Object.freeze({
          id: model.provider,
          name: BUILTIN_NAMES[model.provider] ?? model.provider,
          source: "builtin",
          available: null,
          configDigest: null,
        }),
      );
    }
  }

  if (state.status === "invalid") {
    return Object.freeze({
      status: "invalid",
      path: state.path,
      error: state.error,
      providers: Object.freeze(providers),
      entries: Object.freeze(entries),
    });
  }

  for (const profile of state.config.providers) {
    const available = isProviderCredentialAvailable({ auth: profile.auth }, env);
    const observations = new Map(
      readProbeRecords(home, profile).map((record) => [
        record.modelId,
        Object.freeze({
          text: record.checks.text.status,
          tools: record.checks.tools.status,
          testedAt: record.testedAt,
        }),
      ]),
    );
    const cached = readDiscoveryCache(home, profile);
    const discovery = discoverySummary(readDiscoveryStatus(home, profile), cached);
    providers.push(
      Object.freeze({
        id: profile.id,
        name: profile.name,
        source: "custom",
        available,
        configDigest: targetDigest(profile),
        discovery,
      }),
    );
    for (const model of profile.models)
      entries.push(customEntry(profile, model, available, observations.get(model.id) ?? null));

    // Discovered entries fill gaps only; configured metadata always wins.
    const configured = new Set(profile.models.map((model) => model.id));
    for (const model of cached?.models ?? []) {
      if (configured.has(model.id)) continue;
      entries.push(
        Object.freeze({
          providerId: profile.id,
          providerName: profile.name,
          source: "discovered",
          modelId: model.id,
          name: model.id,
          contextWindow: null,
          pricing: null,
          capabilities: Object.freeze({ tools: "unknown" }),
          observation: observations.get(model.id) ?? null,
          available,
          configDigest: targetDigest(profile),
          legacy: false,
          stale: discovery?.stale === true,
          fetchedAt: cached?.fetchedAt ?? null,
          discoveryError: discovery?.error ?? null,
        }),
      );
    }
  }

  return Object.freeze({
    status: state.status,
    path: state.path,
    error: null,
    providers: Object.freeze(providers),
    entries: Object.freeze(entries),
  });
}

/** Exact tuple lookup; a model absent from the catalog is still selectable when explicit. */
export function findCatalogEntry(catalog, providerId, modelId) {
  return (
    catalog.entries.find((entry) => entry.providerId === providerId && entry.modelId === modelId) ??
    null
  );
}

/** Entries grouped for a picker, stable by provider order then model order. */
export function groupCatalog(catalog) {
  return catalog.providers.map((provider) => ({
    ...provider,
    models: catalog.entries.filter((entry) => entry.providerId === provider.id),
  }));
}

/** Local Forge remains usable when a custom file is invalid; show the diagnostic. */
export function catalogDiagnostic(catalog) {
  if (catalog.status === "invalid") {
    return `Custom provider configuration is invalid: ${catalog.error?.message ?? "unknown error"}`;
  }
  return null;
}
