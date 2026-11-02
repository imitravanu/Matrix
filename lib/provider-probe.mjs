// ============================================================================
// Opt-in provider compatibility probes.
//
// `matrix providers test ID --model EXACT --checks text,tools` is the only
// path here that touches the network. It sends synthetic fixtures only and
// never repository contents. One invocation is capped at three requests, 256
// requested completion tokens per request and 30 seconds in total. No real
// Matrix tool, filesystem or shell operation is reachable from a probe.
//
// A probe is evidence about one stream, not a capability measurement. It does
// not prove coding quality, context length or complete protocol compatibility.
// ============================================================================

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { streamChatCompletions } from "./openrouter.mjs";
import {
  acquireProviderConfigLock,
  loadProviderConfig,
  providerCacheGeneration,
  releaseProviderConfigLock,
  synchronizeProviderCache,
} from "./provider-config.mjs";
import {
  isExplicitBuiltinProvider,
  resolveProviderSelection,
  targetDigest,
  validateWireModelId,
} from "./provider-contracts.mjs";
import { bindProviderTarget } from "./provider-transport.mjs";
import { redactedDetail, truncateText } from "./redaction.mjs";
import { matrixHome } from "./session.mjs";

export const PROBE_LIMITS = Object.freeze({
  requests: 3,
  completionTokens: 256,
  timeoutMs: 30_000,
  models: 256,
  storeBytes: 512 * 1024,
  errorChars: 300,
  toolCallIdChars: 200,
  toolCalls: 1,
  finishReasonChars: 80,
  toolArgumentBytes: 4096,
});

export const PROBE_CHECKS = Object.freeze(["text", "tools"]);

const STORE_VERSION = 1;
const CANCELLED = "probe was cancelled";
const TOOL_NAME = "matrix_probe_noop";
const TEXT_PROMPT = "Reply with the single word pong.";
const TOOL_PROMPT = `Call the ${TOOL_NAME} tool exactly once with note "probe". Do not answer in text.`;
const TOOL_SCHEMA = Object.freeze({
  type: "object",
  properties: Object.freeze({ note: { type: "string" } }),
  additionalProperties: false,
});
const USAGE_KEYS = Object.freeze(["prompt_tokens", "completion_tokens", "total_tokens"]);
const TOOL_FIXTURE = Object.freeze({
  type: "function",
  function: Object.freeze({
    name: TOOL_NAME,
    description: "Records one synthetic probe observation. It performs no action.",
    parameters: TOOL_SCHEMA,
  }),
});

/** Parse `text,tools` (or an array) into an ordered, de-duplicated check list. */
export function normalizeProbeChecks(checks = null) {
  const raw = checks === null || checks === undefined ? PROBE_CHECKS : checks;
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const result = [];
  for (const value of list) {
    const check = String(value).trim().toLowerCase();
    if (!check) continue;
    if (!PROBE_CHECKS.includes(check)) {
      throw new Error(`unknown probe check "${value}"; expected text or tools`);
    }
    if (!result.includes(check)) result.push(check);
  }
  if (result.length === 0) throw new Error("providers test requires at least one check");
  return result;
}

function probeDigest(target, endpoint) {
  if (target.configDigest) return target.configDigest;
  return createHash("sha256")
    .update(`matrix-builtin-probe-v1\0${target.providerId}\0${endpoint}`)
    .digest("hex");
}

function resolveProbeTarget({ home, providerId, modelId }) {
  if (isExplicitBuiltinProvider(providerId)) {
    return resolveProviderSelection({ providerId, modelQuery: modelId }).target;
  }
  const loaded = loadProviderConfig({ home });
  if (loaded.status === "invalid") throw loaded.error;
  if (!loaded.config.providers.some((profile) => profile.id === providerId)) {
    throw new Error(`unknown provider "${providerId}"`);
  }
  return resolveProviderSelection({ providerId, modelQuery: modelId, config: loaded.config })
    .target;
}

function payloadMessages(messages) {
  return messages.map((message) => {
    const entry = { role: message.role };
    if (message.content !== undefined) entry.content = message.content;
    if (message.tool_calls) entry.tool_calls = message.tool_calls;
    if (message.tool_call_id) entry.tool_call_id = message.tool_call_id;
    return entry;
  });
}

function probePayload(target, messages, tools = null) {
  const payload = {
    model: target.modelId,
    messages: payloadMessages(messages),
    stream: true,
    [target.request.tokenLimitField]: PROBE_LIMITS.completionTokens,
    ...(target.request.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(tools ? { tools } : {}),
  };
  return payload;
}

function toolFragmentKey(event) {
  if (event.key) return event.key;
  if (event.index !== null && event.index !== undefined) return `index:${event.index}`;
  if (event.id) return `id:${event.id}`;
  return "anonymous";
}

/**
 * Consume one bounded completion. The shared stream core owns the SSE parser,
 * deadlines, redirect refusal and redaction; this function only observes the
 * event contract. Retries are disabled so the invocation cap is exact.
 */
async function consume({ endpoint, credential, payload, signal, remaining, fetchImpl }) {
  const headers = { "Content-Type": "application/json" };
  if (credential !== null) headers.Authorization = `Bearer ${credential}`;
  const observation = {
    contentChars: 0,
    toolCalls: new Map(),
    finishReasons: [],
    done: false,
    error: null,
    usage: null,
  };
  const budget = Math.max(1, Math.min(remaining, PROBE_LIMITS.timeoutMs));
  for await (const event of streamChatCompletions({
    endpoint,
    apiKey: credential,
    label: "Provider",
    headers,
    payload,
    signal,
    connectTimeoutMs: budget,
    idleTimeoutMs: budget,
    totalTimeoutMs: budget,
    maxRetries: 0,
    retryBaseDelayMs: 0,
    retryMaxDelayMs: 0,
    fetchImpl,
  })) {
    if (event.type === "content") {
      observation.contentChars += event.text.length;
    } else if (event.type === "tool_call") {
      const key = toolFragmentKey(event);
      if (!observation.toolCalls.has(key) && observation.toolCalls.size >= PROBE_LIMITS.toolCalls) {
        observation.error = "expected one synthetic tool call, observed more than one";
        break;
      }
      const call = observation.toolCalls.get(key) ?? {
        id: null,
        name: "",
        arguments: "",
        argumentBytes: 0,
      };
      if (event.id) call.id = event.id;
      if (event.name) call.name = event.name;
      if (typeof event.arguments === "string" && event.arguments) {
        const bytes = Buffer.byteLength(event.arguments);
        if (call.argumentBytes + bytes > PROBE_LIMITS.toolArgumentBytes) {
          // Stop at the first fragment that would cross the bound. Breaking
          // returns through the stream generator's finally, which cancels the
          // reader, so a provider cannot keep filling memory until DONE or the
          // invocation deadline.
          observation.error = "synthetic tool arguments exceeded the probe bound";
          break;
        }
        call.argumentBytes += bytes;
        call.arguments += event.arguments;
      }
      observation.toolCalls.set(key, call);
    } else if (event.type === "finish") {
      // Only one bounded finish reason is observed, so a hostile stream cannot
      // grow this metadata for the length of the deadline.
      if (typeof event.reason === "string") {
        observation.finishReasons = [truncateText(event.reason, PROBE_LIMITS.finishReasonChars)];
      }
    } else if (event.type === "done") {
      observation.done = true;
      if (event.usage && typeof event.usage === "object") observation.usage = event.usage;
    } else if (event.type === "error") {
      observation.error = event.error;
    }
  }
  return observation;
}

/**
 * Provider-controlled text (a tool name, finish reason or echoed error) may
 * carry the credential. Redact every supported encoding before bounding; a
 * surviving fragment withholds the whole detail instead of truncating it.
 */
function boundedError(error, secrets = []) {
  return redactedDetail(String(error ?? "probe failed"), {
    secrets,
    maxChars: PROBE_LIMITS.errorChars,
  });
}

function failed(error, secrets = []) {
  return { status: "fail", error: boundedError(error, secrets) };
}

/** The stream core labels each deadline; any of them consumed the probe budget. */
function timeoutLike(error) {
  return typeof error === "string" && /deadline exceeded/i.test(error);
}

function notEvaluated(reason = null, secrets = []) {
  return { status: "not-evaluated", error: reason ? boundedError(reason, secrets) : null };
}

function lastFinishReason(observation) {
  return observation.finishReasons.at(-1) ?? null;
}

function hasControlCharacters(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A JSON object with only the declared `note` string property. */
function validToolArguments(raw) {
  if (typeof raw !== "string") return false;
  let parsed;
  try {
    parsed = JSON.parse(raw.length > 0 ? raw : "{}");
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  for (const key of Object.keys(parsed)) {
    if (key !== "note") return false;
  }
  return parsed.note === undefined || typeof parsed.note === "string";
}

async function runTextCheck(context) {
  const observation = await context.request(
    probePayload(context.target, [{ role: "user", content: TEXT_PROMPT }]),
  );
  if (observation.error) return failed(observation.error, context.secrets);
  if (!observation.done) {
    return failed("stream ended without a completion event", context.secrets);
  }
  return { status: "pass", error: null, contentChars: observation.contentChars };
}

async function runToolsCheck(context) {
  const messages = [{ role: "user", content: TOOL_PROMPT }];
  const first = await context.request(probePayload(context.target, messages, [TOOL_FIXTURE]));
  if (first.error) return failed(first.error, context.secrets);
  if (!first.done) return failed("tool request ended without a completion event", context.secrets);
  if (first.toolCalls.size === 0) {
    return failed("model ignored the synthetic tool", context.secrets);
  }
  if (first.toolCalls.size > 1) {
    return failed(
      `expected one synthetic tool call, observed ${first.toolCalls.size}`,
      context.secrets,
    );
  }
  const call = [...first.toolCalls.values()][0];
  if (call.name !== TOOL_NAME) {
    return failed(`model called an unexpected tool "${call.name || "unknown"}"`, context.secrets);
  }
  if (!call.id) {
    return failed("synthetic tool call has no id to link its result", context.secrets);
  }
  // The id is echoed into the follow-up and must be a bounded wire value. A
  // control character or an oversized value is refused without echoing it.
  if (
    typeof call.id !== "string" ||
    call.id.length > PROBE_LIMITS.toolCallIdChars ||
    hasControlCharacters(call.id)
  ) {
    return failed("synthetic tool call id is not a bounded wire id", context.secrets);
  }
  if (Buffer.byteLength(call.arguments) > PROBE_LIMITS.toolArgumentBytes) {
    return failed("synthetic tool arguments exceeded the probe bound", context.secrets);
  }
  if (!validToolArguments(call.arguments)) {
    return failed(
      "synthetic tool arguments are not valid for the declared schema",
      context.secrets,
    );
  }

  const followUp = await context.request(
    probePayload(
      context.target,
      [
        ...messages,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments || "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: call.id, content: "probe observation recorded" },
      ],
      [TOOL_FIXTURE],
    ),
  );
  if (followUp.error) return failed(followUp.error, context.secrets);
  if (!followUp.done) {
    return failed("tool follow-up ended without a completion event", context.secrets);
  }
  if (followUp.toolCalls.size > 0) {
    return failed(
      "tool follow-up requested another tool call instead of completing",
      context.secrets,
    );
  }
  const reason = lastFinishReason(followUp);
  if (reason !== "stop") {
    return failed(
      `tool follow-up did not complete cleanly (finish reason: ${reason ?? "none"})`,
      context.secrets,
    );
  }
  if (followUp.contentChars === 0) {
    return failed("tool follow-up returned no text", context.secrets);
  }
  return { status: "pass", error: null };
}

function tokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  for (const key of USAGE_KEYS) {
    // Token counts are non-negative integers. Strings, fractions, negatives and
    // out-of-range numbers are malformed and stay unknown, never zero or floored.
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  return Object.keys(result).length > 0 ? result : null;
}

/** Missing token fields stay absent; a partial observation never becomes zero. */
function addUsage(total, usage) {
  const observed = tokenUsage(usage);
  if (!observed) return total;
  const next = total ? { ...total } : {};
  for (const [key, value] of Object.entries(observed)) {
    next[key] = (next[key] ?? 0) + value;
  }
  return next;
}

function completeUsage(usage) {
  return usage !== null && USAGE_KEYS.every((key) => usage[key] !== undefined);
}

/** Probe one exact provider/model. Never writes a record for caller cancellation. */
export async function probeProvider({
  home,
  providerId,
  modelId,
  checks = null,
  env = process.env,
  fetchImpl = undefined,
  signal = null,
  timeoutMs = PROBE_LIMITS.timeoutMs,
  now = () => Date.now(),
} = {}) {
  if (typeof providerId !== "string" || providerId.length === 0) {
    throw new Error("providers test requires a provider id");
  }
  const selectedModel = validateWireModelId(String(modelId ?? ""));
  const requestedChecks = normalizeProbeChecks(checks);
  const startTime = Date.now();
  const maxBudget =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(PROBE_LIMITS.timeoutMs, Math.floor(timeoutMs))
      : 1;
  let synchronized = true;
  if (!isExplicitBuiltinProvider(providerId) && !signal?.aborted) {
    try {
      synchronized = await synchronizeProviderCache({ home, signal, lockTimeoutMs: maxBudget });
    } catch (error) {
      if (!signal?.aborted) throw error;
      synchronized = false;
    }
  }
  const target = resolveProbeTarget({ home, providerId, modelId: selectedModel });
  if (!target || target.kind === "local") {
    throw new Error(`provider "${providerId}" is local and cannot be probed over the network`);
  }
  const binding = bindProviderTarget(target, env);
  if (!binding.ok) throw new Error(binding.error);
  if (!synchronized && !signal?.aborted)
    throw new Error("provider cache could not be synchronized safely");

  const digest = probeDigest(target, binding.endpoint);
  const generation =
    target.kind === "custom" ? providerCacheGeneration(home, target.providerId) : "builtin";
  const secrets = binding.credential ? [binding.credential] : [];
  const testedAt = now();
  const budget = Math.max(1, maxBudget - (Date.now() - startTime));
  const deadlineAt = testedAt + budget;
  const controller = new AbortController();
  let timedOut = Date.now() - startTime >= maxBudget;
  const callerAborted = () => signal?.aborted === true;
  const onCallerAbort = () => controller.abort(new Error(CANCELLED));
  signal?.addEventListener?.("abort", onCallerAbort, { once: true });
  if (callerAborted()) onCallerAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("probe timed out"));
  }, budget);

  const checksResult = {
    text: notEvaluated(),
    tools: notEvaluated(),
  };
  let requests = 0;
  let usage = null;
  let completeUsageRounds = 0;
  let cancelled = false;

  const request = async (payload) => {
    if (controller.signal.aborted) {
      throw new Error(timedOut ? "probe timed out" : CANCELLED);
    }
    if (requests >= PROBE_LIMITS.requests) {
      throw new Error(`probe request cap reached (${PROBE_LIMITS.requests})`);
    }
    requests += 1;
    const remaining = Math.max(1, deadlineAt - now());
    const observation = await consume({
      endpoint: binding.endpoint,
      credential: binding.credential,
      payload,
      signal: controller.signal,
      remaining,
      fetchImpl,
    });
    if (observation.usage) {
      if (completeUsage(tokenUsage(observation.usage))) completeUsageRounds += 1;
      usage = addUsage(usage, observation.usage);
    }
    return observation;
  };

  const context = { target, request, secrets };
  try {
    for (const check of requestedChecks) {
      if (callerAborted()) {
        cancelled = true;
        break;
      }
      if (timedOut || controller.signal.aborted || now() >= deadlineAt) {
        timedOut = true;
        checksResult[check] = failed("probe timed out", secrets);
        break;
      }
      try {
        const outcome =
          check === "text" ? await runTextCheck(context) : await runToolsCheck(context);
        // The stream core reports an aborted operation as a user abort and each
        // deadline with its own label. Either way the probe budget is spent, so
        // the observation says so and no further request is started.
        if (outcome.status === "fail" && (timedOut || timeoutLike(outcome.error))) {
          timedOut = true;
          checksResult[check] = { ...outcome, error: "probe timed out" };
        } else {
          checksResult[check] = outcome;
        }
      } catch (error) {
        const message = error?.message ?? String(error);
        if (timedOut || timeoutLike(message)) timedOut = true;
        checksResult[check] = failed(timedOut ? "probe timed out" : message, secrets);
      }
      if (timedOut) break;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onCallerAbort);
  }

  if (callerAborted()) cancelled = true;
  const actualChecks = requestedChecks.filter(
    (check) => checksResult[check].status !== "not-evaluated",
  );
  const ok = !cancelled && requestedChecks.every((check) => checksResult[check].status === "pass");
  // Complete usage means every request returned all three token counts. One
  // round without usage, or a field missing from one round, is a partial sum.
  const usageComplete = usage === null ? null : completeUsageRounds === requests;
  const result = {
    ok,
    cancelled,
    providerId: target.providerId,
    modelId: target.modelId,
    digest,
    testedAt,
    requestedChecks,
    actualChecks,
    checks: checksResult,
    usage,
    usageComplete,
    requests,
  };

  // An interruption is not a provider observation. Partial evidence could make
  // a later badge look complete, so cancellation records nothing.
  if (!cancelled) {
    let stored = { recorded: false, path: probeStorePath(home, target.providerId) };
    if (target.kind === "custom" && generation !== null) {
      let lock;
      try {
        lock = await acquireProviderConfigLock({
          home,
          lockTimeoutMs: Math.max(0, Math.min(5000, deadlineAt - now())),
          signal,
        });
        const loaded = loadProviderConfig({ home });
        const profile =
          loaded.status === "valid"
            ? loaded.config.providers.find((entry) => entry.id === target.providerId)
            : null;
        if (
          profile &&
          !callerAborted() &&
          targetDigest(profile) === digest &&
          providerCacheGeneration(home, target.providerId) === generation
        ) {
          stored = writeProbeRecord(home, target.providerId, digest, result, generation);
        }
      } catch {
        // Failure to acquire the publication lock must not invent a record.
      } finally {
        await releaseProviderConfigLock(lock);
      }
    } else if (target.kind !== "custom") {
      stored = writeProbeRecord(home, target.providerId, digest, result, generation);
    }
    result.recorded = stored.recorded;
    result.recordPath = stored.path;
    // Once a record was atomically published the operation has completed; an
    // abort racing the lock release must not label that committed observation
    // as cancelled. Before publication, cancellation still leaves no record.
    if (callerAborted() && !stored.recorded) {
      result.cancelled = true;
      result.ok = false;
    }
  } else {
    result.recorded = false;
    result.recordPath = null;
  }
  return Object.freeze(result);
}

/** Latest bounded, digest-keyed records for one profile. Stale digests are absent. */
export function readProbeRecords(home, profile) {
  const generation = providerCacheGeneration(home, profile.id);
  if (generation === null) return [];
  const raw = boundedRead(probeStorePath(home, profile.id), PROBE_LIMITS.storeBytes);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    // A record can never outlive an endpoint, auth or request-option change.
    const digest = targetDigest(profile);
    if (
      !parsed ||
      parsed.version !== STORE_VERSION ||
      parsed.providerId !== profile.id ||
      parsed.digest !== digest ||
      parsed.generation !== generation ||
      !Array.isArray(parsed.records)
    ) {
      return [];
    }
    const records = [];
    for (const entry of parsed.records.slice(0, PROBE_LIMITS.models)) {
      if (!entry || typeof entry.modelId !== "string") continue;
      if (entry.digest !== digest) continue;
      if (!Number.isFinite(entry.testedAt)) continue;
      const checks = {};
      for (const check of PROBE_CHECKS) {
        const status = entry.checks?.[check]?.status;
        checks[check] = {
          status: ["pass", "fail", "not-evaluated"].includes(status) ? status : "not-evaluated",
          error:
            typeof entry.checks?.[check]?.error === "string"
              ? truncateText(entry.checks[check].error, PROBE_LIMITS.errorChars)
              : null,
        };
      }
      const usage = tokenUsage(entry.usage);
      records.push(
        Object.freeze({
          modelId: entry.modelId,
          testedAt: entry.testedAt,
          requestedChecks: Object.freeze(
            Array.isArray(entry.requestedChecks)
              ? entry.requestedChecks.filter((check) => PROBE_CHECKS.includes(check))
              : [],
          ),
          actualChecks: Object.freeze(
            PROBE_CHECKS.filter((check) => checks[check].status !== "not-evaluated"),
          ),
          checks: Object.freeze(checks),
          usage,
          // An absent flag cannot be reconstructed from a summed projection;
          // treat it as partial rather than claiming complete consumption.
          usageComplete: usage === null ? null : entry.usageComplete === true,
        }),
      );
    }
    return Object.freeze(records.sort((a, b) => b.testedAt - a.testedAt));
  } catch {
    return [];
  }
}

/** One model's latest record, or null when absent or invalidated. */
export function readProbeRecord(home, profile, modelId) {
  return readProbeRecords(home, profile).find((record) => record.modelId === modelId) ?? null;
}

export function probeStorePath(home, providerId) {
  return join(matrixHome(home), "provider-cache", `${providerId}.probes.json`);
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
  // Non-blocking and no-follow: a FIFO must not stall and a symlink must not
  // redirect a private read. The type check uses the opened descriptor.
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

function writeProbeRecord(home, providerId, digest, result, generation) {
  const path = probeStorePath(home, providerId);
  try {
    const raw = boundedRead(path, PROBE_LIMITS.storeBytes);
    let records = [];
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed?.version === STORE_VERSION &&
          parsed.providerId === providerId &&
          parsed.digest === digest &&
          parsed.generation === generation &&
          Array.isArray(parsed.records)
        ) {
          records = parsed.records.filter(
            (entry) => entry && typeof entry.modelId === "string" && entry.digest === digest,
          );
        }
      } catch {
        // A malformed store is replaced by the new observation.
      }
    }
    records = records.filter((entry) => entry.modelId !== result.modelId);
    records.push({
      modelId: result.modelId,
      digest,
      testedAt: result.testedAt,
      requestedChecks: result.requestedChecks,
      actualChecks: result.actualChecks,
      checks: result.checks,
      usage: result.usage,
      usageComplete: result.usageComplete,
    });
    records.sort((a, b) => a.testedAt - b.testedAt);
    while (records.length > PROBE_LIMITS.models) records.shift();
    let payload = JSON.stringify({
      version: STORE_VERSION,
      providerId,
      digest,
      generation,
      records,
    });
    while (Buffer.byteLength(payload) > PROBE_LIMITS.storeBytes && records.length > 1) {
      records.shift();
      payload = JSON.stringify({ version: STORE_VERSION, providerId, digest, generation, records });
    }
    if (Buffer.byteLength(payload) > PROBE_LIMITS.storeBytes) {
      return { recorded: false, path };
    }
    const directory = join(matrixHome(home), "provider-cache");
    ensurePrivateDir(directory);
    const temp = join(
      directory,
      `.${providerId}-probes-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      writeFileSync(temp, `${payload}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
      try {
        chmodSync(path, 0o600);
      } catch {
        // Best effort.
      }
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        // The probe result is still returned; the record is diagnostic evidence.
      }
      return { recorded: false, path };
    }
    return { recorded: true, path };
  } catch {
    return { recorded: false, path };
  }
}
