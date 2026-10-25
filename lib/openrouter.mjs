import { getOpenRouterKey, isOpenRouterAvailable, isOllamaModel, modelId } from "./credentials.mjs";

export { getOpenRouterKey, isOpenRouterAvailable, isOllamaModel };

/**
 * OpenRouter client for live model execution in Matrix.
 * Supports streaming content, reasoning tokens and tool-call deltas.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ERROR_BODY_BYTES = 16 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_RETRIES = 8;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;

export function getApiEndpoint(model = "") {
  if (isOllamaModel(model)) {
    const host = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
    return `${host}/v1/chat/completions`;
  }
  if (process.env.MATRIX_API_BASE && process.env.MATRIX_API_BASE.trim()) {
    const base = process.env.MATRIX_API_BASE.trim().replace(/\/+$/, "");
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.trim()) {
    const base = process.env.OPENAI_BASE_URL.trim().replace(/\/+$/, "");
    return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  }
  return "https://openrouter.ai/api/v1/chat/completions";
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

function runtimeClock(clock) {
  return {
    now: typeof clock?.now === "function" ? () => clock.now() : () => Date.now(),
    setTimeout:
      typeof clock?.setTimeout === "function"
        ? (callback, delay) => clock.setTimeout(callback, delay)
        : (callback, delay) => setTimeout(callback, delay),
    clearTimeout:
      typeof clock?.clearTimeout === "function"
        ? (timer) => clock.clearTimeout(timer)
        : (timer) => clearTimeout(timer),
  };
}

/** @returns {Error & {code?: string, expose?: boolean}} */
function transportError(code, message) {
  /** @type {Error & {code?: string, expose?: boolean}} */
  const error = new Error(message);
  error.code = code;
  error.expose = true;
  return error;
}

function callerAbortError() {
  /** @type {Error & {code?: string}} */
  const error = new Error("Request aborted by user");
  error.name = "AbortError";
  error.code = "ABORTED";
  return error;
}

function timeoutError(code, milliseconds) {
  const labels = {
    CONNECT_TIMEOUT: "Connection",
    IDLE_TIMEOUT: "Stream idle",
    TOTAL_TIMEOUT: "Total request",
  };
  const error = transportError(code, `${labels[code]} deadline exceeded after ${milliseconds} ms`);
  error.name = "TimeoutError";
  return error;
}

function createOperation(callerSignal, totalTimeoutMs, clock) {
  const controller = new AbortController();
  let cleaned = false;
  const onCallerAbort = () => controller.abort(callerAbortError());
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const totalTimer = clock.setTimeout(() => {
    controller.abort(timeoutError("TOTAL_TIMEOUT", totalTimeoutMs));
  }, totalTimeoutMs);

  return {
    signal: controller.signal,
    abort(error) {
      if (!controller.signal.aborted) controller.abort(error);
    },
    throwIfAborted() {
      if (controller.signal.aborted) throw controller.signal.reason ?? callerAbortError();
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clock.clearTimeout(totalTimer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** Await an operation while keeping its late rejection handled after abort/timeout. */
function waitForOperation(promise, operation, clock, timeoutMs, timeoutCode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer !== undefined) clock.clearTimeout(timer);
      operation.signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => settle(reject, operation.signal.reason ?? callerAbortError());

    Promise.resolve(promise).then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
    operation.signal.addEventListener("abort", onAbort, { once: true });
    if (operation.signal.aborted) {
      onAbort();
      return;
    }
    timer = clock.setTimeout(() => {
      const error = timeoutError(timeoutCode, timeoutMs);
      operation.abort(error);
      settle(reject, error);
    }, timeoutMs);
  });
}

function sleepWithAbort(milliseconds, operation, clock) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer !== undefined) clock.clearTimeout(timer);
      operation.signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => settle(reject, operation.signal.reason ?? callerAbortError());
    operation.signal.addEventListener("abort", onAbort, { once: true });
    if (operation.signal.aborted) {
      onAbort();
      return;
    }
    timer = clock.setTimeout(() => settle(resolve), milliseconds);
  });
}

function ignoreRejection(value) {
  try {
    Promise.resolve(value).catch(() => {});
  } catch {
    // Cancellation is best-effort and must never create an unhandled rejection.
  }
}

function cancelBody(body, reason) {
  if (!body || typeof body.cancel !== "function") return;
  try {
    ignoreRejection(body.cancel(reason));
  } catch {
    // Some mocks and already-disturbed bodies throw synchronously on cancellation.
  }
}

function cancelReader(reader, body, reason) {
  if (reader && typeof reader.cancel === "function") {
    try {
      ignoreRejection(reader.cancel(reason));
    } catch {
      // Continue to release the lock even when cancellation fails.
    }
  } else {
    cancelBody(body, reason);
  }
  if (reader && typeof reader.releaseLock === "function") {
    try {
      reader.releaseLock();
    } catch {
      // Releasing an errored or already-released reader is harmless here.
    }
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw transportError("INVALID_STREAM_CHUNK", "OpenRouter stream returned a non-byte chunk");
}

function readReader(reader, operation, clock, idleTimeoutMs) {
  return waitForOperation(
    Promise.resolve().then(() => reader.read()),
    operation,
    clock,
    idleTimeoutMs,
    "IDLE_TIMEOUT",
  );
}

async function readErrorBody(response, operation, clock, idleTimeoutMs, maximumBytes) {
  const body = response.body;
  if (!body || maximumBytes === 0 || typeof body.getReader !== "function") {
    cancelBody(body, "HTTP error response discarded");
    return { text: "", truncated: false };
  }

  let reader;
  try {
    reader = body.getReader();
  } catch {
    cancelBody(body, "HTTP error response discarded");
    return { text: "", truncated: false };
  }

  const parts = [];
  let size = 0;
  let truncated = false;
  try {
    while (size < maximumBytes) {
      const { done, value } = await readReader(reader, operation, clock, idleTimeoutMs);
      if (done) break;
      const bytes = asBytes(value);
      const remaining = maximumBytes - size;
      const retained = bytes.slice(0, Math.min(remaining, bytes.byteLength));
      if (retained.byteLength > 0) parts.push(retained);
      size += retained.byteLength;
      if (bytes.byteLength > remaining) {
        truncated = true;
        break;
      }
    }
  } finally {
    cancelReader(reader, body, "HTTP error response discarded");
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function retryDelay(response, attempt, clock, baseDelayMs, maximumDelayMs) {
  const header = response.headers?.get?.("retry-after")?.trim();
  let delay = null;
  if (header) {
    if (/^\d+$/.test(header)) {
      delay = Number(header) * 1000;
    } else {
      const date = Date.parse(header);
      if (Number.isFinite(date)) delay = Math.max(0, date - clock.now());
    }
  }
  if (delay === null || !Number.isFinite(delay)) {
    delay = baseDelayMs * 2 ** attempt;
  }
  return Math.min(MAX_TIMER_MS, maximumDelayMs, Math.max(0, delay));
}

/** A byte-oriented SSE parser: pending input never exceeds the configured event budget. */
class SseParser {
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
    this.lineParts = [];
    this.lineBytes = 0;
    this.eventBytes = 0;
    this.dataLines = null;
    this.atStart = true;
  }

  decodeLine() {
    let bytes;
    if (this.lineParts.length === 1) {
      bytes = this.lineParts[0];
    } else {
      bytes = new Uint8Array(this.lineBytes);
      let offset = 0;
      for (const part of this.lineParts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
    }
    this.lineParts = [];
    const length = this.lineBytes;
    this.lineBytes = 0;
    if (length === 0) return "";
    if (bytes[length - 1] === 13) bytes = bytes.subarray(0, length - 1);
    try {
      const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (this.atStart) {
        this.atStart = false;
        return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      }
      return line;
    } catch {
      throw transportError("INVALID_SSE_UTF8", "OpenRouter stream contained invalid UTF-8");
    }
  }

  processLine(line) {
    if (line === "") {
      this.eventBytes = 0;
      if (this.dataLines === null) return null;
      const data = this.dataLines.join("\n");
      this.dataLines = null;
      return data;
    }
    if (line.startsWith(":")) return null;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      if (this.dataLines === null) this.dataLines = [];
      this.dataLines.push(value);
    }
    return null;
  }

  *push(value) {
    const bytes = asBytes(value);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const relativeNewline = bytes.indexOf(10, offset);
      const newline = relativeNewline === -1 ? -1 : relativeNewline;
      const end = newline === -1 ? bytes.byteLength : newline;
      const partBytes = end - offset + (newline === -1 ? 0 : 1);
      if (this.eventBytes + partBytes > this.maximumBytes) {
        throw transportError(
          "SSE_EVENT_TOO_LARGE",
          `OpenRouter SSE event exceeded the ${this.maximumBytes}-byte buffer limit`,
        );
      }
      this.eventBytes += partBytes;
      if (end > offset) {
        // Copy retained bytes so a small pending line cannot pin a huge upstream chunk.
        const part = bytes.slice(offset, end);
        this.lineParts.push(part);
        this.lineBytes += part.byteLength;
      }
      offset = end + (newline === -1 ? 0 : 1);
      if (newline !== -1) {
        const data = this.processLine(this.decodeLine());
        if (data !== null) yield data;
      }
    }
  }

  *finish() {
    if (this.lineBytes > 0 || this.lineParts.length > 0) {
      const data = this.processLine(this.decodeLine());
      if (data !== null) yield data;
    }
    if (this.dataLines !== null) {
      const data = this.dataLines.join("\n");
      this.dataLines = null;
      this.eventBytes = 0;
      yield data;
    }
  }
}

function parseSseJson(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("event payload is not an object");
    }
    return parsed;
  } catch (error) {
    throw transportError("MALFORMED_SSE_JSON", `Malformed SSE JSON: ${error.message}`);
  }
}

function createToolCallIdentity() {
  const ids = new Map();
  const unindexedSlots = new Map();
  let anonymous = 0;

  return (call, position) => {
    const index = call?.index ?? null;
    const id = typeof call?.id === "string" && call.id ? call.id : null;
    const name = call?.function?.name ?? null;

    if (index !== null) {
      const key = `index:${typeof index}:${String(index)}`;
      if (id) ids.set(id, key);
      return { index, key };
    }

    if (id && ids.has(id)) {
      const key = ids.get(id);
      unindexedSlots.set(position, key);
      return { index: null, key };
    }

    const slotKey = unindexedSlots.get(position);
    if (slotKey && !name) {
      if (id) ids.set(id, slotKey);
      return { index: null, key: slotKey };
    }

    // A named delta without an id or index starts a new call. Argument-only
    // deltas retain their array-slot identity, including parallel calls.
    const key = id ? `id:${id}` : `anonymous:${++anonymous}`;
    if (id) ids.set(id, key);
    unindexedSlots.set(position, key);
    return { index: null, key };
  };
}

function publicStreamError(error, operation, callerSignal) {
  if (
    error?.name === "AbortError" ||
    callerSignal?.aborted ||
    (operation.signal.aborted && operation.signal.reason?.name === "AbortError")
  ) {
    return "Request aborted by user";
  }
  if (error?.expose || error?.name === "TimeoutError") return error.message;
  return `Stream error: ${error?.message ?? String(error)}`;
}

/**
 * Stream completion from OpenRouter.
 * @param {object} options
 * @param {string} [options.model="anthropic/claude-sonnet-4.6"]
 * @param {Array<import("./contracts.mjs").ProviderMessage>} options.messages
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
 * @param {number} [options.connectTimeoutMs=15000] Per-attempt response-header deadline.
 * @param {number} [options.idleTimeoutMs=45000] Deadline between body chunks.
 * @param {number} [options.totalTimeoutMs=300000] Deadline covering retries and backoff.
 * @param {number} [options.maxErrorBodyBytes=16384] Bounded HTTP error-body retention.
 * @param {number} [options.maxEventBytes=1048576] Bounded raw SSE event buffering.
 * @param {number} [options.maxRetries=2] Retries for pre-stream 408/429/5xx only (hard cap: 8).
 * @param {number} [options.retryBaseDelayMs=250]
 * @param {number} [options.retryMaxDelayMs=10000] Also caps Retry-After delays.
 * @param {typeof fetch} [options.fetchImpl] Network injection for deterministic tests.
 * @param {{now?: Function, setTimeout?: Function, clearTimeout?: Function}} [options.clock]
 * @returns {AsyncGenerator<import("./contracts.mjs").OpenRouterEvent>}
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
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  maxErrorBodyBytes = DEFAULT_MAX_ERROR_BODY_BYTES,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
  fetchImpl,
  clock: injectedClock,
}) {
  const apiKey = getOpenRouterKey(model);
  if (!apiKey) {
    yield {
      type: "error",
      error: "No OpenRouter API key found in ~/.matrix/credentials.json or OPENROUTER_API_KEY",
    };
    return;
  }

  /** @type {import("./contracts.mjs").ProviderMessage[]} */
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

  if (signal?.aborted) {
    yield { type: "error", error: "Request aborted by user" };
    return;
  }

  const clock = runtimeClock(injectedClock);
  const connectDeadline = boundedInteger(
    connectTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
    0,
    MAX_TIMER_MS,
  );
  const idleDeadline = boundedInteger(idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 0, MAX_TIMER_MS);
  const totalDeadline = boundedInteger(totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, 0, MAX_TIMER_MS);
  const errorBodyLimit = boundedInteger(
    maxErrorBodyBytes,
    DEFAULT_MAX_ERROR_BODY_BYTES,
    0,
    MAX_ERROR_BODY_BYTES,
  );
  const eventLimit = boundedInteger(maxEventBytes, DEFAULT_MAX_EVENT_BYTES, 1, MAX_EVENT_BYTES);
  const retryLimit = boundedInteger(maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES);
  const retryBase = boundedInteger(retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS, 0, MAX_TIMER_MS);
  const retryMaximum = boundedInteger(retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS, 0, MAX_TIMER_MS);
  const doFetch = fetchImpl ?? globalThis.fetch;
  const operation = createOperation(signal, totalDeadline, clock);

  try {
    const endpoint = getApiEndpoint(model);
    const requestModel = isOllamaModel(model)
      ? modelId(model).replace(/^(?:ollama|local)\//i, "")
      : modelId(model);
    const requestInit = {
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
      signal: operation.signal,
    };

    let response;
    for (let attempt = 0; ; attempt += 1) {
      operation.throwIfAborted();
      try {
        const pendingResponse = Promise.resolve()
          .then(() => {
            operation.throwIfAborted();
            if (typeof doFetch !== "function") throw new Error("fetch is unavailable");
            return doFetch(endpoint, requestInit);
          })
          .then((result) => {
            if (operation.signal.aborted) {
              cancelBody(result?.body, operation.signal.reason);
              throw operation.signal.reason ?? callerAbortError();
            }
            return result;
          });
        response = await waitForOperation(
          pendingResponse,
          operation,
          clock,
          connectDeadline,
          "CONNECT_TIMEOUT",
        );
      } catch (error) {
        if (operation.signal.aborted) throw operation.signal.reason ?? callerAbortError();
        if (error?.name === "AbortError") throw callerAbortError();
        throw transportError("NETWORK_ERROR", `Network error: ${error?.message ?? String(error)}`);
      }

      operation.throwIfAborted();
      if (response?.ok) break;

      const status = Number(response?.status ?? 0);
      const errorBody = await readErrorBody(
        response ?? {},
        operation,
        clock,
        idleDeadline,
        errorBodyLimit,
      );
      operation.throwIfAborted();
      const retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
      if (retryable && attempt < retryLimit) {
        const delay = retryDelay(response, attempt, clock, retryBase, retryMaximum);
        await sleepWithAbort(delay, operation, clock);
        continue;
      }
      const detail = String(errorBody.text).slice(0, 160);
      throw transportError(
        "HTTP_ERROR",
        `OpenRouter returned HTTP ${status}: ${detail}${errorBody.truncated ? "…" : ""}`,
      );
    }

    const contentType = response.headers?.get?.("content-type") ?? "";
    if (String(contentType).split(";", 1)[0].trim().toLowerCase() !== "text/event-stream") {
      cancelBody(response.body, "Non-SSE success response discarded");
      const label = contentType ? String(contentType).slice(0, 80) : "missing Content-Type";
      throw transportError(
        "NON_SSE_RESPONSE",
        `OpenRouter returned non-SSE success response (${label})`,
      );
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      cancelBody(response.body, "Empty stream body discarded");
      throw transportError("EMPTY_STREAM", "OpenRouter returned empty stream body");
    }

    let reader;
    try {
      reader = response.body.getReader();
    } catch (error) {
      cancelBody(response.body, "Stream initialization failed");
      throw transportError("STREAM_INIT", `Stream init failed: ${error.message}`);
    }

    const parser = new SseParser(eventLimit);
    const toolCallIdentity = createToolCallIdentity();
    let terminated = false;
    let usage = null;
    let readerClosed = false;
    const closeReader = () => {
      if (readerClosed) return;
      readerClosed = true;
      operation.signal.removeEventListener("abort", closeReader);
      cancelReader(reader, response.body, operation.signal.reason ?? "OpenRouter stream closed");
    };
    operation.signal.addEventListener("abort", closeReader, { once: true });
    try {
      while (!terminated) {
        operation.throwIfAborted();
        const { done, value } = await readReader(reader, operation, clock, idleDeadline);
        const events = done ? parser.finish() : parser.push(value);
        for (const eventData of events) {
          operation.throwIfAborted();
          if (eventData === "[DONE]") {
            terminated = true;
            break;
          }
          const data = parseSseJson(eventData);
          const chunkError = data.error?.message || data.choices?.[0]?.error?.message;
          if (chunkError) {
            const code = data.error?.code ?? data.choices?.[0]?.error?.code;
            throw transportError(
              "PROVIDER_ERROR",
              `Provider error${code ? ` ${code}` : ""}: ${chunkError}`.slice(0, 300),
            );
          }

          const choice = data.choices?.[0];
          const delta = choice?.delta || choice?.message;
          const reasoningText =
            delta?.reasoning ||
            delta?.reasoning_content ||
            delta?.reasoning_details?.[0]?.text ||
            choice?.message?.reasoning;
          if (reasoningText) yield { type: "reasoning", text: reasoningText };
          if (typeof delta?.content === "string" && delta.content) {
            yield { type: "content", text: delta.content };
          }
          if (Array.isArray(delta?.tool_calls)) {
            for (const [position, call] of delta.tool_calls.entries()) {
              const identity = toolCallIdentity(call, position);
              yield {
                type: "tool_call",
                index: identity.index,
                key: identity.key,
                id: call?.id ?? null,
                name: call?.function?.name ?? null,
                arguments: call?.function?.arguments ?? "",
              };
            }
          }
          if (choice?.finish_reason) yield { type: "finish", reason: choice.finish_reason };
          if (data.usage && usage === null) usage = data.usage;
        }
        if (done && !terminated) {
          throw transportError("INCOMPLETE_SSE", "OpenRouter stream ended before the [DONE] event");
        }
      }
    } finally {
      closeReader();
    }

    operation.throwIfAborted();
    operation.cleanup();
    yield usage === null ? { type: "done" } : { type: "done", usage };
    return;
  } catch (error) {
    operation.cleanup();
    yield { type: "error", error: publicStreamError(error, operation, signal) };
  } finally {
    operation.cleanup();
  }
}
