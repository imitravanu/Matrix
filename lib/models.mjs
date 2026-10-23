// ============================================================================
// Model registry.
//
// The local engine is a first-class model, not a placeholder. Remote IDs and
// prices are real OpenRouter entries (verified against /api/v1/models); the UI
// shows the price it will actually pay instead of a decorative "free" badge.
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
    description: "Frontier reasoning and tool use. Highest quality, highest cost.",
    remote: true,
    tools: true,
  },
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "openrouter",
    short: "gemini",
    context: 1_048_576,
    pricing: { input: 0.3, output: 2.5, cacheRead: 0.03 },
    description: "Fast, long-context model with tool calls and reasoning tokens.",
    remote: true,
    tools: true,
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    provider: "openrouter",
    short: "gpt-mini",
    context: 1_047_576,
    pricing: { input: 0.4, output: 1.6, cacheRead: 0.1 },
    description: "Balanced general-purpose coding model.",
    remote: true,
    tools: true,
  },
  {
    id: "deepseek/deepseek-chat-v3.1",
    name: "DeepSeek V3.1",
    provider: "openrouter",
    short: "deepseek",
    context: 163_840,
    pricing: { input: 0.25, output: 0.95, cacheRead: 0.13 },
    description: "Low-cost text model with reliable tool calls.",
    remote: true,
    tools: true,
  },
  {
    id: "qwen/qwen3-coder-next",
    name: "Qwen3 Coder Next",
    provider: "openrouter",
    short: "qwen",
    context: 262_144,
    pricing: { input: 0.12, output: 0.8, cacheRead: 0.07 },
    description: "Coding-specialised model with a large context window.",
    remote: true,
    tools: true,
  },
];

export function modelById(id) {
  return MODELS.find((model) => model.id === id) ?? MODELS[0];
}

export function resolveModel(query) {
  if (!query) return MODELS[0];
  const needle = String(query).trim().toLowerCase();
  if (needle === "local" || needle === "offline" || needle === "forge") return LOCAL_MODEL;
  return (
    MODELS.find((model) => model.id.toLowerCase() === needle) ??
    MODELS.find((model) => model.short.toLowerCase() === needle) ??
    MODELS.find((model) => model.name.toLowerCase() === needle) ??
    MODELS.find((model) => model.id.toLowerCase().includes(needle)) ??
    MODELS[0]
  );
}

export function modelIndex(id) {
  const index = MODELS.findIndex((model) => model.id === id);
  return index === -1 ? 0 : index;
}

/** Estimated USD cost from OpenRouter usage (prompt/completion token counts). */
export function estimateCost(model, usage = {}) {
  if (!model || !usage) return 0;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
  const price = model.pricing ?? { input: 0, output: 0, cacheRead: 0 };
  const uncached = Math.max(0, input - cached);
  return (uncached * price.input + cached * price.cacheRead + output * price.output) / 1_000_000;
}

export function formatCost(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function modelLabel(model) {
  return model ? `${model.name}${model.remote ? " · remote" : " · offline"}` : "no model";
}
