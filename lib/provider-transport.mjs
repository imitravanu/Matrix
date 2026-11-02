// ============================================================================
// Named-provider transport.
//
// Binds one resolved provider target to one endpoint/auth decision for the whole
// streaming run, then delegates to the existing SSE parser, retry and deadline
// core in lib/openrouter.mjs. No second parser, no OpenRouter-specific fields,
// no redirect following, no arbitrary request-body overrides.
// ============================================================================

import { getExplicitBuiltinEndpoint, getExplicitBuiltinKey } from "./credentials.mjs";
import { streamChatCompletions } from "./openrouter.mjs";
import { ProviderError, resolveProviderCredential } from "./provider-contracts.mjs";

const CUSTOM_KIND = "custom";

function requireCustomTarget(target) {
  if (!target || target.kind !== CUSTOM_KIND) {
    throw new ProviderError(
      "PROVIDER_UNSUPPORTED_TRANSPORT",
      "named-provider transport requires a custom resolved target; built-in targets use the legacy adapter",
    );
  }
  if (!target.baseUrl || target.transport !== "chat-completions") {
    throw new ProviderError(
      "PROVIDER_UNSUPPORTED_TRANSPORT",
      `provider "${target.providerId}" does not have a chat-completions base URL`,
    );
  }
  return target;
}

function payloadMessages(messages, systemPrompt) {
  const output = [];
  if (systemPrompt) output.push({ role: "system", content: systemPrompt });
  for (const message of messages) {
    const entry = { role: message.role };
    if (message.content !== undefined) entry.content = message.content;
    if (message.name) entry.name = message.name;
    if (message.tool_calls) entry.tool_calls = message.tool_calls;
    if (message.tool_call_id) entry.tool_call_id = message.tool_call_id;
    output.push(entry);
  }
  return output;
}

/**
 * Resolve the credential exactly once for a whole agent run. Every tool round,
 * retry and audit redactor must share this binding: rereading the environment
 * per round lets one run straddle two credentials.
 *
 * Returns a frozen result instead of throwing so callers can surface the same
 * error event the transport would produce.
 */
export function bindProviderCredential(target, env = process.env) {
  try {
    requireCustomTarget(target);
    return Object.freeze({
      ok: true,
      credential: resolveProviderCredential(target, env),
      endpoint: `${target.baseUrl}/chat/completions`,
      error: null,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      credential: null,
      endpoint: null,
      error: error?.message ?? String(error),
    });
  }
}

/**
 * Bind either a custom profile or an explicit built-in to one endpoint and one
 * credential for the whole run. Built-ins use their dedicated policy, never the
 * global MATRIX_API_BASE / OPENAI_BASE_URL compatibility overrides.
 */
export function bindProviderTarget(target, env = process.env) {
  if (target?.kind === "custom") return bindProviderCredential(target, env);
  if (target?.kind !== "builtin") {
    return Object.freeze({
      ok: false,
      credential: null,
      endpoint: null,
      error: "provider transport requires a custom or built-in target",
    });
  }
  try {
    const endpoint = getExplicitBuiltinEndpoint(target.providerId, env);
    const credential = getExplicitBuiltinKey(target.providerId, env);
    if (!credential) {
      return Object.freeze({
        ok: false,
        credential: null,
        endpoint,
        error: `provider "${target.providerId}" requires OPENROUTER_API_KEY or ~/.matrix/credentials.json`,
      });
    }
    return Object.freeze({ ok: true, credential, endpoint, error: null });
  } catch (error) {
    return Object.freeze({
      ok: false,
      credential: null,
      endpoint: null,
      error: error?.message ?? String(error),
    });
  }
}

/**
 * Build the immutable request for one run. An explicit `credential` (including
 * `null` for auth-none) is used as-is; only an omitted credential is resolved
 * from the environment for direct callers.
 *
 * Throws PROVIDER_MISSING_KEY before any network activity.
 */
export function prepareProviderRequest(
  target,
  {
    env = process.env,
    credential = undefined,
    messages = [],
    systemPrompt = null,
    maxTokens = 2048,
    tools = null,
    toolChoice = null,
    temperature = undefined,
  } = {},
) {
  requireCustomTarget(target);
  const secret = credential === undefined ? resolveProviderCredential(target, env) : credential;

  const payload = {
    model: target.modelId,
    messages: payloadMessages(messages, systemPrompt),
    stream: true,
    [target.request.tokenLimitField]: maxTokens,
    ...(target.request.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };

  const headers = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;

  return Object.freeze({
    endpoint: `${target.baseUrl}/chat/completions`,
    headers: Object.freeze(headers),
    payload: Object.freeze(payload),
    credential: secret,
  });
}

/**
 * Stream one named-provider completion. Yields the same OpenRouterEvent contract
 * as the legacy adapter; a missing key or unsupported target becomes one honest
 * error event without touching the network.
 *
 * @returns {AsyncGenerator<import("./contracts.mjs").OpenRouterEvent>}
 */
export async function* streamProviderChat({
  target,
  env = process.env,
  credential = undefined,
  bindingError = null,
  messages = [],
  systemPrompt = null,
  maxTokens = 2048,
  tools = null,
  toolChoice = null,
  temperature = undefined,
  ...transportOptions
}) {
  if (bindingError) {
    yield { type: "error", error: bindingError };
    return;
  }

  let prepared;
  try {
    prepared = prepareProviderRequest(target, {
      env,
      credential,
      messages,
      systemPrompt,
      maxTokens,
      tools,
      toolChoice,
      temperature,
    });
  } catch (error) {
    yield { type: "error", error: error?.message ?? String(error) };
    return;
  }

  yield* streamChatCompletions({
    ...transportOptions,
    endpoint: prepared.endpoint,
    apiKey: prepared.credential,
    label: target.providerName || "Provider",
    headers: prepared.headers,
    payload: prepared.payload,
  });
}
