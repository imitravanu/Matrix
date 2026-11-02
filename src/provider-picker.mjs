// ============================================================================
// Provider-aware picker models.
//
// The picker still lists the static registry first, so Local Forge and the
// built-in remote options behave exactly as before. Named profiles add one
// entry per configured or discovered model, each carrying its resolved
// provider target and that provider's own availability. Nothing here performs
// network I/O or reads a key value.
// ============================================================================

import { MODELS } from "../lib/models.mjs";
import { resolveProviderSelection } from "../lib/provider-contracts.mjs";

/** Stable identity across providers that may share one wire model ID. */
export function pickerKeyFor(model) {
  if (!model) return null;
  if (model.pickerKey) return model.pickerKey;
  return `builtin:${model.provider ?? "matrix"}:${model.id}`;
}

/** Index of the current model in the picker list, or 0 when it is absent. */
export function pickerIndexFor(models, current) {
  const key = pickerKeyFor(current);
  if (!key) return 0;
  const index = models.findIndex((model) => pickerKeyFor(model) === key);
  return index >= 0 ? index : 0;
}

/**
 * Exact and friendly lookup for `/model <arg>`. A provider-scoped key wins,
 * then an exact wire ID, then a case-insensitive name or short alias.
 */
export function findPickerModel(models, query) {
  models = models.filter((model) => !model.providerPlaceholder);
  const text = String(query ?? "").trim();
  if (!text) return null;
  const key = models.find((model) => pickerKeyFor(model) === text);
  if (key) return key;
  const exact = models.find((model) => model.id === text);
  if (exact) return exact;
  const lower = text.toLowerCase();
  return (
    models.find((model) => String(model.name ?? "").toLowerCase() === lower) ??
    models.find((model) => String(model.short ?? "").toLowerCase() === lower) ??
    models.find((model) => String(model.providerName ?? "").toLowerCase() === lower) ??
    null
  );
}

function customPickerModel(entry, config) {
  let providerTarget = null;
  let targetError = null;
  if (config) {
    try {
      providerTarget = resolveProviderSelection({
        providerId: entry.providerId,
        modelQuery: entry.modelId,
        config,
      }).target;
    } catch (error) {
      targetError = error?.message ?? "provider selection failed";
    }
  } else {
    targetError = "provider configuration is not loaded";
  }
  const discovered = entry.source === "discovered";
  const stale = entry.stale === true;
  const description = [
    `${discovered ? "Discovered" : "Configured"} model from ${entry.providerName ?? entry.providerId}`,
    stale ? "discovery stale" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: entry.modelId,
    pickerKey: `provider:${entry.providerId}:${entry.modelId}`,
    name: entry.name ?? entry.modelId,
    provider: entry.providerId,
    providerId: entry.providerId,
    providerName: entry.providerName ?? entry.providerId,
    short: entry.modelId,
    description,
    context: entry.contextWindow,
    pricing: entry.pricing ?? undefined,
    remote: true,
    free: false,
    tier: discovered ? "discovered" : "custom",
    tools:
      entry.capabilities?.tools === "supported"
        ? true
        : entry.capabilities?.tools === "unsupported"
          ? false
          : null,
    available: entry.available === true,
    source: entry.source,
    custom: true,
    stale,
    discoveryError: entry.discoveryError ?? null,
    observation: entry.observation ?? null,
    providerTarget,
    targetError,
  };
}

/**
 * Project one already-resolved target into a picker row. Used for explicit CLI
 * presets and manual exact-ID entry, neither of which needs a catalog entry.
 * Availability stays caller-owned: `null` means the UI should fall back to the
 * legacy credential check, which is the built-in policy.
 */
export function pickerModelFromTarget(
  target,
  { source = "manual", available = null, description = null, observation = null } = {},
) {
  const custom = target.kind === "custom";
  return {
    id: target.modelId,
    pickerKey: custom
      ? `provider:${target.providerId}:${target.modelId}`
      : `builtin:${target.providerId}:${target.modelId}`,
    name: target.modelName,
    provider: target.providerId,
    providerId: target.providerId,
    providerName: target.providerName,
    short: target.modelName,
    description:
      description ?? `${custom ? "Exact manual" : "Explicit"} model on ${target.providerName}`,
    context: target.contextWindow,
    pricing: target.pricing ?? undefined,
    remote: target.transport !== "local",
    free: target.providerId === "ollama" || target.kind === "local",
    tier: custom ? "custom" : target.kind === "builtin" ? "builtin" : "offline",
    tools:
      target.capabilities.tools === "supported"
        ? true
        : target.capabilities.tools === "unsupported"
          ? false
          : null,
    available,
    source,
    custom,
    stale: false,
    discoveryError: null,
    providerTarget: target,
    targetError: null,
    observation,
  };
}

/**
 * Built-in models keep their existing shape; provider entries are appended in
 * catalog order. `config` is the validated provider configuration used to
 * resolve exact targets for those entries.
 */
export function buildPickerModels({ catalog = null, config = null, base = MODELS } = {}) {
  const builtins = base.map((model) => ({
    ...model,
    providerId: model.provider ?? "matrix",
    pickerKey: `builtin:${model.provider ?? "matrix"}:${model.id}`,
  }));
  if (!catalog || catalog.status === "invalid") return builtins;
  const custom = [];
  for (const entry of catalog.entries ?? []) {
    if (entry.source !== "custom" && entry.source !== "discovered") continue;
    custom.push(customPickerModel(entry, config));
  }
  for (const provider of catalog.providers ?? []) {
    if (provider.source !== "custom" || custom.some((model) => model.providerId === provider.id))
      continue;
    custom.push({
      id: "",
      pickerKey: `provider-empty:${provider.id}`,
      name: provider.name,
      provider: provider.id,
      providerId: provider.id,
      providerName: provider.name,
      description: "No listed models · press e to enter an exact model ID",
      remote: true,
      free: false,
      custom: true,
      providerPlaceholder: true,
      available: provider.available === true,
      tools: null,
      providerTarget: null,
      targetError: "enter an exact model ID",
    });
  }
  return [...builtins, ...custom];
}
