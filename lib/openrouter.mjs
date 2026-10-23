import { readFileSync } from "node:fs";
import { homedir } from "node:os";

/**
 * OpenRouter client for live model execution in Matrix.
 * Supports streaming content, reasoning tokens and tool-call deltas.
 */

export function getApiEndpoint(model = "") {
  if (process.env.MATRIX_API_BASE && process.env.MATRIX_API_BASE.trim()) {
    const base = process.env.MATRIX_API_BASE.trim().replace(/\/+$/, "");
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.trim()) {
    const base = process.env.OPENAI_BASE_URL.trim().replace(/\/+$/, "");
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }
  if (typeof model === "string" && (model.startsWith("ollama/") || model.startsWith("local/"))) {
    const host = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
    return `${host}/v1/chat/completions`;
  }
  if (process.env.OLLAMA_HOST && process.env.OLLAMA_HOST.trim()) {
    const host = process.env.OLLAMA_HOST.trim().replace(/\/+$/, "");
    return `${host}/v1/chat/completions`;
  }
  return "https://openrouter.ai/api/v1/chat/completions";
}

export function getOpenRouterKey(model = "") {
  if (typeof model === "string" && (model.startsWith("ollama/") || model.startsWith("local/"))) {
    return process.env.OLLAMA_API_KEY || "ollama";
  }
  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) {
    return process.env.OPENROUTER_API_KEY.trim();
  }
  if (process.env.MATRIX_API_KEY && process.env.MATRIX_API_KEY.trim()) {
    return process.env.MATRIX_API_KEY.trim();
  }
  for (const dir of [".matrix"]) {
    try {
      const credPath = `${homedir()}/${dir}/credentials.json`;
      const creds = JSON.parse(readFileSync(credPath, "utf8"));
      const key = creds.openrouterApiKey ?? creds.apiKey ?? creds.matrixApiKey;
      if (typeof key === "string" && key.trim()) {
        return key.trim();
      }
    } catch {
      // Continue to next path
    }
  }
  return null;
}

export function isOpenRouterAvailable(model = "") {
  return Boolean(getOpenRouterKey(model));
}

/**
 * Stream completion from OpenRouter.
 * @param {object} options
 * @param {string} [options.model="anthropic/claude-sonnet-4.6"]
 * @param {Array<{role: string, content: string}>} options.messages
 * @param {string} [options.systemPrompt]
 * @param {number} [options.maxTokens=2048]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.temperature]
 * @param {object} [options.reasoning] OpenRouter reasoning controls,
 *   e.g. `{ max_tokens: 500 }` to cap thought so long answers still arrive,
 *   or `{ exclude: true }` for answer-only streaming.
 * @param {Array<object>} [options.tools] OpenAI-compatible tool schemas.
 * @param {"auto"|"none"|object} [options.toolChoice]
 * @param {object} [options.provider] OpenRouter provider routing preferences.
 * @returns {AsyncGenerator<{type: "reasoning"|"content"|"tool_call"|"finish"|"done"|"error", ...}>}
 */
export async function* streamOpenRouter({
  model = "anthropic/claude-sonnet-4.6",
  messages = [],
  systemPrompt = "You are Matrix, an autonomous coding engine. Keep answers concise, actionable, and grounded in the repository.",
  maxTokens = 2048,
  signal,
  temperature,
  reasoning,
  tools = null,
  toolChoice = null,
  provider = null,
}) {
  const apiKey = getOpenRouterKey(model);
  if (!apiKey) {
    yield {
      type: "error",
      error: "No OpenRouter API key found in ~/.matrix/credentials.json or OPENROUTER_API_KEY",
    };
    return;
  }

  const payloadMessages = [];
  if (systemPrompt) {
    payloadMessages.push({ role: "system", content: systemPrompt });
  }
  for (const m of messages) {
    // Tool loops need the full assistant/tool message shape, not just content.
    const message = { role: m.role };
    if (m.content !== undefined) message.content = m.content;
    if (m.name) message.name = m.name;
    if (m.tool_calls) message.tool_calls = m.tool_calls;
    if (m.tool_call_id) message.tool_call_id = m.tool_call_id;
    payloadMessages.push(message);
  }

  let response;
  try {
    const endpoint = getApiEndpoint(model);
    const requestModel = typeof model === "string" && model.startsWith("ollama/")
      ? model.replace(/^ollama\//, "")
      : model;
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://matrix.dev",
        "X-Title": "Matrix Workbench",
      },
      body: JSON.stringify({
        model: requestModel,
        messages: payloadMessages,
        stream: true,
        max_tokens: maxTokens,
        stream_options: { include_usage: true },
        ...(typeof temperature === "number" ? { temperature } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(Array.isArray(tools) && tools.length > 0 ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(provider ? { provider } : {}),
      }),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      yield { type: "error", error: "Request aborted by user" };
      return;
    }
    yield { type: "error", error: `Network error: ${err.message}` };
    return;
  }

  if (!response.ok) {
    let errorText = "";
    try {
      errorText = await response.text();
    } catch {
      errorText = "";
    }
    yield {
      type: "error",
      error: `OpenRouter returned HTTP ${response.status}: ${String(errorText).slice(0, 160)}`,
    };
    return;
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    yield { type: "error", error: "OpenRouter returned empty stream body" };
    return;
  }

  let reader;
  try {
    reader = response.body.getReader();
  } catch (err) {
    yield { type: "error", error: `Stream init failed: ${err.message}` };
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let doneYielded = false;

  try {
    while (true) {
      if (signal?.aborted) {
        yield { type: "error", error: "Request aborted by user" };
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (trimmed === "data: [DONE]") {
          if (!doneYielded) {
            doneYielded = true;
            yield { type: "done" };
          }
          return;
        }
        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            // Surface provider-level errors (was: silently dropped → fake clean done)
            const chunkErr = data.error?.message || data.choices?.[0]?.error?.message;
            if (chunkErr) {
              const code = data.error?.code ?? data.choices?.[0]?.error?.code;
              yield { type: "error", error: `Provider error${code ? ` ${code}` : ""}: ${chunkErr}`.slice(0, 300) };
              return;
            }
            const choice = data.choices?.[0];
            const delta = choice?.delta || choice?.message;

            // Handle reasoning delta (multiple provider shapes)
            const reasoning =
              delta?.reasoning ||
              delta?.reasoning_content ||
              delta?.reasoning_details?.[0]?.text ||
              choice?.message?.reasoning;
            if (reasoning) {
              yield { type: "reasoning", text: reasoning };
            }

            // Handle content delta
            if (typeof delta?.content === "string" && delta.content) {
              yield { type: "content", text: delta.content };
            }

            // Handle streamed tool-call deltas. Providers send the id/name on
            // the first chunk and argument fragments on subsequent chunks.
            if (Array.isArray(delta?.tool_calls)) {
              for (const call of delta.tool_calls) {
                yield {
                  type: "tool_call",
                  index: call.index ?? 0,
                  id: call.id ?? null,
                  name: call.function?.name ?? null,
                  arguments: call.function?.arguments ?? "",
                };
              }
            }

            if (choice?.finish_reason) {
              yield { type: "finish", reason: choice.finish_reason };
            }

            if (data.usage && !doneYielded) {
              doneYielded = true;
              yield { type: "done", usage: data.usage };
            }
          } catch {
            // Ignore parse errors on malformed chunks
          }
        }
      }
    }
    if (!doneYielded) {
      doneYielded = true;
      yield { type: "done" };
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors on aborted streams
    }
  }
}
