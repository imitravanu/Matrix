// ============================================================================
// Model registry.
//
// The local engine is a first-class model, not a placeholder. Remote IDs,
// prices, context sizes and capabilities below are static, unverified registry
// metadata—not live availability or compatibility claims. Runtime accounting
// prefers provider-reported charges and labels registry-derived estimates.
// ============================================================================

export const LOCAL_MODEL = {
  id: "local",
  name: "Local Forge",
  provider: "matrix",
  short: "local",
  context: 128_000,
  pricing: { input: 0, output: 0, cacheRead: 0 },
  description: "Deterministic offline operator: real search, patch and test loop.",
  remote: false,
  free: true,
  tier: "offline",
  tools: true,
};

export const MODELS = [
  LOCAL_MODEL,
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    provider: "openrouter",
    short: "sonnet",
    context: 1_000_000,
    pricing: { input: 3, output: 15, cacheRead: 0.3 }, // USD / million tokens
    description:
      "Unverified static listing: frontier/tool model; quality, availability, context and pricing are unverified estimates.",
    remote: true,
    free: false,
    tier: "frontier",
    tools: true,
  },
  {
    id: "ollama/qwen2.5-coder",
    name: "Ollama (Qwen 2.5 Coder)",
    provider: "ollama",
    short: "ollama",
    context: 128_000,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    description:
      "Ollama daemon; listed price, context and tool support are estimates, and privacy depends on the configured endpoint.",
    remote: true,
    free: true,
    tier: "free",
    tools: true,
  },
  {
    id: "openrouter/free",
    name: "Free Models Router",
    provider: "openrouter",
    short: "free",
    context: 200_000,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    description:
      "Unverified dynamic free-model router; current routing, context, pricing and tool support are unknown.",
    remote: true,
    free: true,
    tier: "free",
    tools: true,
  },
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    name: "Nemotron 3.5 Lightning (Free)",
    provider: "openrouter",
    short: "nemotron",
    context: 1_000_000,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    description:
      "Unverified static listing: free reasoning/tool model; availability, context and pricing are unverified estimates.",
    remote: true,
    free: true,
    tier: "free",
    tools: true,
  },
  {
    id: "cohere/north-mini-code:free",
    name: "Cohere North Mini Code (Free)",
    provider: "openrouter",
    short: "cohere",
    context: 256_000,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    description:
      "Unverified static listing: free coding/tool model; speed, availability, context and pricing are unverified estimates.",
    remote: true,
    free: true,
    tier: "free",
    tools: true,
  },
  {
    id: "poolside/laguna-s-2.1:free",
    name: "Poolside Laguna S 2.1 (Free)",
    provider: "openrouter",
    short: "laguna",
    context: 262_144,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    description:
      "Unverified static listing: agentic coding/tool model; availability, context and pricing are unverified estimates.",
    remote: true,
    free: true,
    tier: "free",
    tools: true,
  },
  {
    id: "recursive/flint-v1.0:free",
    name: "Recursive Flint (Free)",
    provider: "openrouter",
    short: "flint",
    context: 262_144,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    description:
      "Unverified static listing: free reasoning/tool model; availability, context and pricing are unverified estimates.",
    remote: true,
    free: true,
    tier: "free",
    tools: true,
  },
  {
    id: "liquid/lfm-2.5-2.6b:free",
    name: "Liquid LFM 2.5 (Free)",
    provider: "openrouter",
    short: "liquid",
    context: 65_536,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    description:
      "Unverified static listing: free coding model; architecture, latency, availability and pricing are unverified estimates.",
    remote: true,
    free: true,
    tier: "free",
    tools: true,
  },
  {
    id: "google/gemma-4-31b-it:free",
    name: "Google Gemma 4 31B (Free)",
    provider: "openrouter",
    short: "gemma",
    context: 262_144,
    pricing: { input: 0, output: 0, cacheRead: 0 },
    description:
      "Unverified static listing: open-weights reasoning/tool model; availability, context and pricing are unverified estimates.",
    remote: true,
    free: true,
    tier: "free",
    tools: true,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "openrouter",
    short: "gemini",
    context: 1_048_576,
    pricing: { input: 0.3, output: 2.5, cacheRead: 0.03 },
    description:
      "Unverified static listing: long-context reasoning/tool model; speed, availability, context and pricing are unverified estimates.",
    remote: true,
    free: false,
    tier: "frontier",
    tools: true,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    provider: "openrouter",
    short: "gpt-mini",
    context: 1_047_576,
    pricing: { input: 0.4, output: 1.6, cacheRead: 0.1 },
    description:
      "Unverified static listing: general-purpose coding model; quality, availability, context and pricing are unverified estimates.",
    remote: true,
    free: false,
    tier: "frontier",
    tools: true,
  },
  {
    id: "deepseek/deepseek-chat-v3.1",
    name: "DeepSeek V3.1",
    provider: "openrouter",
    short: "deepseek",
    context: 163_840,
    pricing: { input: 0.25, output: 0.95, cacheRead: 0.13 },
    description:
      "Unverified static listing: text/tool model; reliability, availability, context and pricing are unverified estimates.",
    remote: true,
    free: false,
    tier: "frontier",
    tools: true,
  },
  {
    id: "qwen/qwen3-coder-next",
    name: "Qwen3 Coder Next",
    provider: "openrouter",
    short: "qwen",
    context: 262_144,
    pricing: { input: 0.12, output: 0.8, cacheRead: 0.07 },
    description:
      "Unverified static listing: coding model; availability, context and pricing are unverified estimates.",
    remote: true,
    free: false,
    tier: "frontier",
    tools: true,
  },
];

export function isFreeModel(model) {
  if (!model) return false;
  if (!model.remote) return true;
  return model.free === true || (model.pricing?.input === 0 && model.pricing?.output === 0);
}

export function modelById(id) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

export function resolveModel(query, { fallback = true } = {}) {
  if (!query) return MODELS[0];
  const needle = String(query).trim().toLowerCase();
  if (needle === "local" || needle === "offline" || needle === "forge") return LOCAL_MODEL;
  if (needle === "free") return MODELS.find((m) => m.id === "openrouter/free") ?? MODELS[0];
  if (needle === "ollama") return MODELS.find((m) => m.id.startsWith("ollama/")) ?? MODELS[0];
  if (needle === "ollama/") return fallback ? MODELS[0] : null;
  const found =
    MODELS.find((model) => model.id.toLowerCase() === needle) ??
    MODELS.find((model) => model.short.toLowerCase() === needle) ??
    MODELS.find((model) => model.name.toLowerCase() === needle) ??
    MODELS.find((model) => model.id.toLowerCase().includes(needle));
  if (found) return found;
  if (needle.startsWith("ollama/")) {
    const raw = String(query).trim();
    const modelTag = raw.slice(7).trim();
    if (!modelTag) return fallback ? MODELS[0] : null;
    return {
      id: raw,
      name: `Ollama (${modelTag})`,
      provider: "ollama",
      short: modelTag,
      context: null,
      pricing: { input: 0, output: 0, cacheRead: 0 },
      description: `Ollama model ${modelTag}; listed cost is an estimate, context/tools are unknown, and privacy depends on the configured endpoint.`,
      remote: true,
      free: true,
      tier: "free",
      tools: null,
    };
  }
  return fallback ? MODELS[0] : null;
}

export function filterModels(models = MODELS, query = "") {
  const needle = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!needle) return models;
  if (needle === "free") return models.filter(isFreeModel);
  if (needle === "local" || needle === "offline") return models.filter((m) => !m.remote);
  return models.filter(
    (model) =>
      model.name.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle) ||
      model.short.toLowerCase().includes(needle) ||
      (model.description ?? "").toLowerCase().includes(needle) ||
      model.provider.toLowerCase().includes(needle),
  );
}

export function modelIndex(id) {
  const index = MODELS.findIndex((model) => model.id === id);
  return index === -1 ? 0 : index;
}

/** Estimated USD cost from static registry prices; null means price unavailable. */
export function estimateCost(model, usage = {}) {
  if (!model || !usage || !model.pricing) return null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens ??
      usage.cached_tokens ??
      0,
  );
  const inputPrice = Number(model.pricing.input);
  const outputPrice = Number(model.pricing.output);
  const cachePrice = Number(model.pricing.cacheRead);
  const values = [input, output, cached, inputPrice, outputPrice, cachePrice];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
  const uncached = Math.max(0, input - cached);
  return (uncached * inputPrice + cached * cachePrice + output * outputPrice) / 1_000_000;
}

/** Never turn an unavailable or invalid charge into a decorative $0.00. */
export function formatCost(usd) {
  if (!Number.isFinite(usd) || usd < 0) return "unknown";
  if (usd === 0) return "$0.00";
  if (usd < 0.00005) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function modelLabel(model) {
  return model ? `${model.name}${model.remote ? " · remote" : " · offline"}` : "no model";
}
