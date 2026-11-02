// ============================================================================
// Provider contracts: identity, validation, canonical digests and selection
// precedence for named provider profiles.
//
// Pure module: no filesystem, no network, no credential values in descriptors.
// PRV-102 (transport), PRV-103 (catalog) and PRV-104 (CLI/UI/session) consume
// these exports; see docs/next-phase/decisions/PRV-101.md for the frozen rules.
// ============================================================================

import { createHash } from "node:crypto";

import { LOCAL_MODEL, resolveModel } from "./models.mjs";

export const PROVIDER_SCHEMA_VERSION = 1;

export const PROVIDER_LIMITS = Object.freeze({
  configBytes: 1024 * 1024,
  profiles: 64,
  modelsPerProfile: 256,
  providerIdChars: 64,
  modelIdChars: 512,
  nameChars: 200,
  baseUrlChars: 2048,
  envNameChars: 128,
  lockOwnerBytes: 4096,
});

export const RESERVED_PROVIDER_IDS = Object.freeze(["local", "matrix", "openrouter", "ollama"]);
export const EXPLICIT_BUILTIN_PROVIDER_IDS = Object.freeze(["matrix", "openrouter", "ollama"]);
export const PROVIDER_TRANSPORTS = Object.freeze(["chat-completions"]);
export const TOKEN_LIMIT_FIELDS = Object.freeze(["max_tokens", "max_completion_tokens"]);
export const TOOL_CAPABILITIES = Object.freeze(["supported", "unsupported", "unknown"]);

export const PROVIDER_ERROR_CODES = Object.freeze([
  "CONFIG_TOO_LARGE",
  "CONFIG_INVALID_JSON",
  "CONFIG_UNSUPPORTED_SCHEMA",
  "CONFIG_INVALID",
  "CONFIG_LIMIT_EXCEEDED",
  "CONFIG_SYMLINK",
  "CONFIG_NOT_REGULAR",
  "CONFIG_LOCKED",
  "CONFIG_CONFLICT",
  "PROVIDER_INVALID_ID",
  "PROVIDER_RESERVED_ID",
  "PROVIDER_DUPLICATE",
  "PROVIDER_UNKNOWN",
  "PROVIDER_NO_DEFAULT_MODEL",
  "PROVIDER_INVALID_MODEL_ID",
  "PROVIDER_DUPLICATE_MODEL",
  "PROVIDER_INVALID_BASE_URL",
  "PROVIDER_INSECURE_HTTP",
  "PROVIDER_FULL_ENDPOINT_URL",
  "PROVIDER_UNSUPPORTED_TRANSPORT",
  "PROVIDER_INVALID_AUTH",
  "PROVIDER_INVALID_REQUEST_OPTION",
  "PROVIDER_MISSING_KEY",
]);

const ERROR_CODE_SET = new Set(PROVIDER_ERROR_CODES);

/** Sanitized, typed configuration/selection failure. Never carries key material. */
export class ProviderError extends Error {
  /**
   * @param {string} code One of PROVIDER_ERROR_CODES.
   * @param {string} message Human-readable, bounded, free of raw secret values.
   * @param {Record<string, *>|null} [details]
   */
  constructor(code, message, details = null) {
    super(message);
    if (!ERROR_CODE_SET.has(code)) throw new Error(`unknown provider error code: ${code}`);
    this.name = "ProviderError";
    this.code = code;
    this.details = details;
  }
}

/** @param {*} error */
export function isProviderError(error) {
  return error instanceof ProviderError;
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

function hasControlCharacters(value) {
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function fail(code, message, details = null) {
  throw new ProviderError(code, message, details);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requirePlainObject(value, path) {
  if (!isPlainObject(value)) fail("CONFIG_INVALID", `${path} must be an object`, { path });
  return value;
}

function rejectUnknownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail("CONFIG_INVALID", `${path}.${key} is not a recognized field`, {
        path: `${path}.${key}`,
      });
    }
  }
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") fail("CONFIG_INVALID", `${path} must be a boolean`, { path });
  return value;
}

function requireFiniteNonNegative(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail("CONFIG_INVALID", `${path} must be a finite non-negative number`, { path });
  }
  return value;
}

function requireNullableFiniteNonNegative(value, path) {
  if (value === null || value === undefined) return null;
  return requireFiniteNonNegative(value, path);
}

function requireBoundedText(value, path, limit) {
  if (typeof value !== "string" || value.length === 0) {
    fail("CONFIG_INVALID", `${path} must be a non-empty string`, { path });
  }
  if (value.length > limit) {
    fail("CONFIG_INVALID", `${path} exceeds ${limit} characters`, { path, limit });
  }
  if (value.trim() !== value) {
    fail("CONFIG_INVALID", `${path} must not have surrounding whitespace`, { path });
  }
  if (hasControlCharacters(value)) {
    fail("CONFIG_INVALID", `${path} contains control characters`, { path });
  }
  return value;
}

/** Stable lowercase slug, unique per file, never a built-in identifier. */
export function validateProviderId(id) {
  if (typeof id !== "string" || id.length === 0) {
    fail("PROVIDER_INVALID_ID", "provider id must be a non-empty lowercase slug", { path: "id" });
  }
  if (id.length > PROVIDER_LIMITS.providerIdChars) {
    fail(
      "PROVIDER_INVALID_ID",
      `provider id exceeds ${PROVIDER_LIMITS.providerIdChars} characters`,
      {
        path: "id",
        limit: PROVIDER_LIMITS.providerIdChars,
      },
    );
  }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    fail("PROVIDER_INVALID_ID", "provider id must match ^[a-z0-9][a-z0-9_-]*$", { path: "id" });
  }
  if (RESERVED_PROVIDER_IDS.includes(id)) {
    fail("PROVIDER_RESERVED_ID", `provider id "${id}" is reserved for a built-in provider`, {
      path: "id",
    });
  }
  return id;
}

/**
 * Exact wire model ID: case, slashes, colons and dots survive byte-for-byte.
 * No trimming, no control characters, bounded length.
 */
export function validateWireModelId(id) {
  if (typeof id !== "string" || id.length === 0) {
    fail("PROVIDER_INVALID_MODEL_ID", "model id must be a non-empty exact wire value", {
      path: "model",
    });
  }
  if (id.length > PROVIDER_LIMITS.modelIdChars) {
    fail(
      "PROVIDER_INVALID_MODEL_ID",
      `model id exceeds ${PROVIDER_LIMITS.modelIdChars} characters`,
      {
        path: "model",
        limit: PROVIDER_LIMITS.modelIdChars,
      },
    );
  }
  if (id.trim() !== id) {
    fail("PROVIDER_INVALID_MODEL_ID", "model id must not have surrounding whitespace", {
      path: "model",
    });
  }
  if (hasControlCharacters(id)) {
    fail("PROVIDER_INVALID_MODEL_ID", "model id contains control characters", { path: "model" });
  }
  return id;
}

function isLoopbackHostname(hostname) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || IPV4_LOOPBACK.test(host);
}

/**
 * Validate an API directory URL. `baseUrl` keeps its path prefix and never
 * includes the completions or models route.
 * @returns {{baseUrl: string, insecure: boolean, warning: string|null}}
 */
export function normalizeProviderBaseUrl(raw, { allowInsecureHttp = false } = {}) {
  if (typeof raw !== "string" || raw.length === 0) {
    fail("PROVIDER_INVALID_BASE_URL", "baseUrl must be a non-empty string", { path: "baseUrl" });
  }
  if (raw.length > PROVIDER_LIMITS.baseUrlChars) {
    fail(
      "PROVIDER_INVALID_BASE_URL",
      `baseUrl exceeds ${PROVIDER_LIMITS.baseUrlChars} characters`,
      {
        path: "baseUrl",
      },
    );
  }
  if (raw.trim() !== raw) {
    fail("PROVIDER_INVALID_BASE_URL", "baseUrl must not have surrounding whitespace", {
      path: "baseUrl",
    });
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    // The input may be a mistaken credential; never echo it.
    fail("PROVIDER_INVALID_BASE_URL", "baseUrl is not a valid absolute URL", { path: "baseUrl" });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("PROVIDER_INVALID_BASE_URL", "baseUrl must use https (http only for local servers)", {
      path: "baseUrl",
    });
  }
  if (url.username || url.password) {
    fail("PROVIDER_INVALID_BASE_URL", "baseUrl must not include userinfo", { path: "baseUrl" });
  }
  if (url.search || url.hash) {
    fail("PROVIDER_INVALID_BASE_URL", "baseUrl must not include a query string or fragment", {
      path: "baseUrl",
    });
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  if (/\/(?:chat\/completions|models)$/i.test(pathname)) {
    fail(
      "PROVIDER_FULL_ENDPOINT_URL",
      "baseUrl must be the API directory, not a /chat/completions or /models endpoint",
      { path: "baseUrl" },
    );
  }

  const insecure = url.protocol === "http:";
  const loopback = isLoopbackHostname(url.hostname);
  if (insecure && !loopback && allowInsecureHttp !== true) {
    fail(
      "PROVIDER_INSECURE_HTTP",
      "http baseUrl requires allowInsecureHttp: true for a non-loopback host",
      { path: "baseUrl" },
    );
  }

  const baseUrl = `${url.protocol}//${url.host}${pathname}`;
  return {
    baseUrl,
    insecure,
    warning: insecure
      ? `Provider URL ${new URL(baseUrl).host} uses unencrypted http; traffic is not private.`
      : null,
  };
}

function validateAuth(raw, path) {
  const auth = requirePlainObject(raw, path);
  if (auth.type === "none") {
    rejectUnknownFields(auth, ["type"], path);
    return Object.freeze({ type: "none" });
  }
  if (auth.type === "bearer") {
    rejectUnknownFields(auth, ["type", "env"], path);
    const env = requireBoundedText(auth.env, `${path}.env`, PROVIDER_LIMITS.envNameChars);
    if (!ENV_NAME_PATTERN.test(env)) {
      fail("PROVIDER_INVALID_AUTH", `${path}.env must be an environment variable name`, {
        path: `${path}.env`,
      });
    }
    return Object.freeze({ type: "bearer", env });
  }
  fail("PROVIDER_INVALID_AUTH", `${path}.type must be "bearer" or "none"`, {
    path: `${path}.type`,
  });
}

function validateRequestOptions(raw, path) {
  if (raw === undefined || raw === null) {
    return Object.freeze({ tokenLimitField: "max_tokens", includeUsage: false });
  }
  const request = requirePlainObject(raw, path);
  rejectUnknownFields(request, ["tokenLimitField", "includeUsage"], path);
  const tokenLimitField = request.tokenLimitField ?? "max_tokens";
  if (!TOKEN_LIMIT_FIELDS.includes(tokenLimitField)) {
    fail(
      "PROVIDER_INVALID_REQUEST_OPTION",
      `${path}.tokenLimitField must be one of ${TOKEN_LIMIT_FIELDS.join(", ")}`,
      { path: `${path}.tokenLimitField` },
    );
  }
  const includeUsage = requireBoolean(request.includeUsage ?? false, `${path}.includeUsage`);
  return Object.freeze({ tokenLimitField, includeUsage });
}

function validatePricing(raw, path) {
  if (raw === undefined || raw === null) return null;
  const pricing = requirePlainObject(raw, path);
  rejectUnknownFields(pricing, ["input", "output", "cacheRead"], path);
  return Object.freeze({
    input: requireFiniteNonNegative(pricing.input, `${path}.input`),
    output: requireFiniteNonNegative(pricing.output, `${path}.output`),
    cacheRead: requireFiniteNonNegative(pricing.cacheRead ?? 0, `${path}.cacheRead`),
  });
}

function validateCapabilities(raw, path) {
  if (raw === undefined || raw === null) return Object.freeze({ tools: "unknown" });
  const capabilities = requirePlainObject(raw, path);
  rejectUnknownFields(capabilities, ["tools"], path);
  const tools = capabilities.tools ?? "unknown";
  if (!TOOL_CAPABILITIES.includes(tools)) {
    fail("CONFIG_INVALID", `${path}.tools must be one of ${TOOL_CAPABILITIES.join(", ")}`, {
      path: `${path}.tools`,
    });
  }
  return Object.freeze({ tools });
}

/** Validate one configured model entry; unknown metadata stays unknown. */
export function validateProviderModel(raw, path = "model") {
  const model = requirePlainObject(raw, path);
  rejectUnknownFields(model, ["id", "name", "contextWindow", "pricing", "capabilities"], path);
  const id = validateWireModelId(model.id);
  const name =
    model.name === undefined || model.name === null
      ? id
      : requireBoundedText(model.name, `${path}.name`, PROVIDER_LIMITS.nameChars);
  return Object.freeze({
    id,
    name,
    contextWindow: requireNullableFiniteNonNegative(model.contextWindow, `${path}.contextWindow`),
    pricing: validatePricing(model.pricing, `${path}.pricing`),
    capabilities: validateCapabilities(model.capabilities, `${path}.capabilities`),
  });
}

/** Validate one named provider profile, applying documented defaults. */
export function validateProviderProfile(raw, path = "provider") {
  const profile = requirePlainObject(raw, path);
  rejectUnknownFields(
    profile,
    [
      "id",
      "name",
      "transport",
      "baseUrl",
      "auth",
      "defaultModel",
      "allowInsecureHttp",
      "request",
      "models",
    ],
    path,
  );

  const id = validateProviderId(profile.id);
  const name =
    profile.name === undefined || profile.name === null
      ? id
      : requireBoundedText(profile.name, `${path}.name`, PROVIDER_LIMITS.nameChars);

  const transport = profile.transport ?? "chat-completions";
  if (!PROVIDER_TRANSPORTS.includes(transport)) {
    fail(
      "PROVIDER_UNSUPPORTED_TRANSPORT",
      `${path}.transport must be one of ${PROVIDER_TRANSPORTS.join(", ")}`,
      { path: `${path}.transport` },
    );
  }

  if (profile.auth === undefined) {
    fail("PROVIDER_INVALID_AUTH", `${path}.auth is required`, { path: `${path}.auth` });
  }
  const allowInsecureHttp = requireBoolean(
    profile.allowInsecureHttp ?? false,
    `${path}.allowInsecureHttp`,
  );
  const auth = validateAuth(profile.auth, `${path}.auth`);
  const { baseUrl } = normalizeProviderBaseUrl(profile.baseUrl, { allowInsecureHttp });

  const defaultModel =
    profile.defaultModel === undefined || profile.defaultModel === null
      ? null
      : validateWireModelId(profile.defaultModel);

  const rawModels = profile.models ?? [];
  if (!Array.isArray(rawModels)) {
    fail("CONFIG_INVALID", `${path}.models must be an array`, { path: `${path}.models` });
  }
  if (rawModels.length > PROVIDER_LIMITS.modelsPerProfile) {
    fail(
      "CONFIG_LIMIT_EXCEEDED",
      `${path}.models exceeds ${PROVIDER_LIMITS.modelsPerProfile} entries`,
      { path: `${path}.models`, limit: PROVIDER_LIMITS.modelsPerProfile },
    );
  }
  const models = [];
  const seen = new Set();
  rawModels.forEach((entry, index) => {
    const model = validateProviderModel(entry, `${path}.models[${index}]`);
    if (seen.has(model.id)) {
      fail("PROVIDER_DUPLICATE_MODEL", `duplicate model id in ${path}`, {
        path: `${path}.models[${index}].id`,
        model: model.id,
      });
    }
    seen.add(model.id);
    models.push(model);
  });

  return Object.freeze({
    id,
    name,
    transport,
    baseUrl,
    auth,
    defaultModel,
    allowInsecureHttp,
    request: validateRequestOptions(profile.request, `${path}.request`),
    models: Object.freeze(models),
  });
}

export const EMPTY_PROVIDER_CONFIG = Object.freeze({
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  providers: Object.freeze([]),
});

/** Strict whole-document validation. Unknown fields, versions and duplicates fail. */
export function validateProviderConfig(raw, path = "config") {
  const config = requirePlainObject(raw, path);
  rejectUnknownFields(config, ["schemaVersion", "providers"], path);

  if (config.schemaVersion !== PROVIDER_SCHEMA_VERSION) {
    fail(
      "CONFIG_UNSUPPORTED_SCHEMA",
      `${path}.schemaVersion must be ${PROVIDER_SCHEMA_VERSION} (unsupported versions are not migrated implicitly)`,
      { path: `${path}.schemaVersion` },
    );
  }

  const rawProviders = config.providers ?? [];
  if (!Array.isArray(rawProviders)) {
    fail("CONFIG_INVALID", `${path}.providers must be an array`, { path: `${path}.providers` });
  }
  if (rawProviders.length > PROVIDER_LIMITS.profiles) {
    fail("CONFIG_LIMIT_EXCEEDED", `${path}.providers exceeds ${PROVIDER_LIMITS.profiles} entries`, {
      path: `${path}.providers`,
      limit: PROVIDER_LIMITS.profiles,
    });
  }

  const providers = [];
  const seen = new Set();
  rawProviders.forEach((entry, index) => {
    const profile = validateProviderProfile(entry, `${path}.providers[${index}]`);
    if (seen.has(profile.id)) {
      fail("PROVIDER_DUPLICATE", `duplicate provider id: ${profile.id}`, {
        path: `${path}.providers[${index}].id`,
        providerId: profile.id,
      });
    }
    seen.add(profile.id);
    providers.push(profile);
  });

  return Object.freeze({
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    providers: Object.freeze(providers),
  });
}

/**
 * Canonical JSON: lexicographically sorted object keys, preserved array order.
 * Validated configuration only; non-finite numbers and undefined are rejected.
 */
export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("CONFIG_INVALID", "canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const entries = [];
    for (const key of keys) {
      const item = value[key];
      if (item === undefined) fail("CONFIG_INVALID", `canonical JSON rejects undefined at ${key}`);
      entries.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${entries.join(",")}}`;
  }
  fail("CONFIG_INVALID", "canonical JSON rejects non-JSON values");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Whole-file digest used for optimistic concurrency and cache invalidation. */
export function configurationDigest(config) {
  return sha256(canonicalJson(validateProviderConfig(config)));
}

/**
 * Digest of the execution-affecting profile fields. The exact model ID is a
 * separate identity component, so catalog and display changes do not invalidate
 * a saved binding while endpoint, auth reference or request options do.
 */
export function targetDigest(profile) {
  return sha256(
    canonicalJson({
      version: 1,
      providerId: profile.id,
      transport: profile.transport,
      baseUrl: profile.baseUrl,
      auth: profile.auth,
      request: profile.request,
    }),
  );
}

function freezeTarget(target) {
  return Object.freeze({
    ...target,
    auth: Object.freeze({ ...target.auth }),
    request: Object.freeze({ ...target.request }),
    capabilities: Object.freeze({ ...target.capabilities }),
    pricing: target.pricing ? Object.freeze({ ...target.pricing }) : null,
  });
}

/** Offline Local Forge target: no credential, no network, no configuration digest. */
export function localForgeTarget() {
  return freezeTarget({
    kind: "local",
    providerId: "matrix",
    providerName: "Local Forge",
    transport: "local",
    baseUrl: null,
    modelId: LOCAL_MODEL.id,
    modelName: LOCAL_MODEL.name,
    auth: { type: "none" },
    request: { tokenLimitField: "max_tokens", includeUsage: false },
    capabilities: { tools: "supported" },
    contextWindow: LOCAL_MODEL.context ?? null,
    pricing: LOCAL_MODEL.pricing,
    configDigest: null,
    legacy: true,
  });
}

const BUILTIN_PROVIDER_NAMES = Object.freeze({ openrouter: "OpenRouter", ollama: "Ollama" });

/** `local` is the CLI-facing alias; resolved identity always uses `matrix`. */
export function normalizeBuiltinProviderId(providerId) {
  return providerId === "local" ? "matrix" : providerId;
}

export function isExplicitBuiltinProvider(providerId) {
  if (typeof providerId !== "string") return false;
  return EXPLICIT_BUILTIN_PROVIDER_IDS.includes(normalizeBuiltinProviderId(providerId));
}

/**
 * Explicit built-in selection keeps the legacy registry metadata but binds the
 * provider's own endpoint/auth policy at execution time. An exact wire ID absent
 * from the registry is still selectable; its cost, context and tools stay unknown.
 */
export function explicitBuiltinTarget(providerId, modelQuery = null) {
  const id = normalizeBuiltinProviderId(providerId);
  if (id === "matrix") {
    const query = modelQuery === null || modelQuery === undefined ? "" : String(modelQuery);
    if (query && !["local", "offline", "forge", LOCAL_MODEL.id].includes(query.toLowerCase())) {
      fail(
        "PROVIDER_INVALID_MODEL_ID",
        `provider "matrix" only serves Local Forge, not "${query.trim()}"`,
        { providerId: id },
      );
    }
    return localForgeTarget();
  }

  if (!EXPLICIT_BUILTIN_PROVIDER_IDS.includes(id)) {
    fail("PROVIDER_UNKNOWN", `unknown built-in provider "${providerId}"`, { providerId });
  }
  if (modelQuery === null || modelQuery === undefined || modelQuery === "") {
    fail("PROVIDER_NO_DEFAULT_MODEL", `built-in provider "${id}" requires an exact --model`, {
      providerId: id,
    });
  }

  const query = String(modelQuery);
  const resolved = resolveModel(query, { fallback: false });
  if (resolved) {
    if (resolved.provider !== id) {
      fail(
        "PROVIDER_INVALID_MODEL_ID",
        `model "${query.trim()}" belongs to provider "${resolved.provider}"`,
        { providerId: id },
      );
    }
    return builtinTarget(resolved);
  }

  const modelId = validateWireModelId(query);
  return builtinTarget({
    id: modelId,
    name: modelId,
    provider: id,
    remote: true,
    context: null,
    pricing: null,
    tools: null,
    free: id === "ollama",
  });
}

function builtinTarget(model) {
  if (!model || model.remote !== true) return localForgeTarget();
  const providerId = model.provider;
  return freezeTarget({
    kind: "builtin",
    providerId,
    providerName: BUILTIN_PROVIDER_NAMES[providerId] ?? providerId,
    transport: "chat-completions",
    baseUrl: null,
    modelId: model.id,
    modelName: model.name ?? model.id,
    auth: { type: "builtin" },
    request: { tokenLimitField: "max_tokens", includeUsage: false },
    capabilities: {
      tools: model.tools === true ? "supported" : model.tools === false ? "unsupported" : "unknown",
    },
    contextWindow: Number.isFinite(model.context) ? model.context : null,
    pricing: model.pricing ?? null,
    configDigest: null,
    legacy: true,
  });
}

function customTarget(profile, modelId) {
  const model = profile.models.find((entry) => entry.id === modelId) ?? null;
  return freezeTarget({
    kind: "custom",
    providerId: profile.id,
    providerName: profile.name,
    transport: profile.transport,
    baseUrl: profile.baseUrl,
    modelId,
    modelName: model?.name ?? modelId,
    auth: profile.auth,
    request: profile.request,
    capabilities: model?.capabilities ?? { tools: "unknown" },
    contextWindow: model?.contextWindow ?? null,
    pricing: model?.pricing ?? null,
    configDigest: targetDigest(profile),
    legacy: false,
  });
}

/**
 * Frozen selection precedence:
 *   explicit provider + model -> exact custom target (catalog not required)
 *   explicit provider only    -> profile defaultModel, else PROVIDER_NO_DEFAULT_MODEL
 *   legacy --model/no model   -> existing built-in resolver, Local Forge fallback
 * Explicit custom selection never consults global endpoint/key overrides.
 *
 * @param {{providerId?: string|null, modelQuery?: string|null, config?: *}} [options]
 */
export function resolveProviderSelection({
  providerId = null,
  modelQuery = null,
  config = EMPTY_PROVIDER_CONFIG,
} = {}) {
  if (providerId === null || providerId === undefined) {
    return Object.freeze({
      target: builtinTarget(resolveModel(modelQuery)),
      warnings: Object.freeze([]),
    });
  }

  if (isExplicitBuiltinProvider(providerId)) {
    return Object.freeze({
      target: explicitBuiltinTarget(providerId, modelQuery),
      warnings: Object.freeze([]),
    });
  }

  const validated = validateProviderConfig(config);
  const profile = validated.providers.find((entry) => entry.id === providerId);
  if (!profile) {
    fail("PROVIDER_UNKNOWN", `unknown provider "${providerId}"; add it explicitly first`, {
      providerId,
    });
  }

  let modelId;
  if (modelQuery === null || modelQuery === undefined || modelQuery === "") {
    if (!profile.defaultModel) {
      fail("PROVIDER_NO_DEFAULT_MODEL", `provider "${providerId}" has no default model`, {
        providerId,
      });
    }
    modelId = profile.defaultModel;
  } else {
    modelId = validateWireModelId(String(modelQuery));
  }

  const target = customTarget(profile, modelId);
  const warnings = profile.baseUrl.startsWith("http:")
    ? Object.freeze([`Provider "${profile.id}" uses unencrypted http; traffic is not private.`])
    : Object.freeze([]);
  return Object.freeze({ target, warnings });
}

/**
 * Whether the target's credential reference currently resolves. Returns booleans
 * only; the value is never attached to a descriptor, event or error. Built-in
 * targets return null because the legacy policy owns their availability; the UI
 * must show that as unknown rather than available.
 */
export function isProviderCredentialAvailable(target, env = process.env) {
  if (!target) return false;
  if (target.auth?.type === "none") return true;
  if (target.auth?.type !== "bearer") return null;
  const value = env?.[target.auth.env];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve one credential value for the run's transport. Throws before any network
 * activity when a bearer key is absent. Built-in targets defer to the legacy
 * credential policy owned by PRV-102.
 */
export function resolveProviderCredential(target, env = process.env) {
  if (!target || target.auth?.type !== "bearer") return null;
  const value = env?.[target.auth.env];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(
      "PROVIDER_MISSING_KEY",
      `provider "${target.providerId}" requires env ${target.auth.env}`,
      {
        providerId: target.providerId,
        env: target.auth.env,
      },
    );
  }
  return value.trim();
}
