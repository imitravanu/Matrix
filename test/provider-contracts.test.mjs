import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_PROVIDER_CONFIG,
  PROVIDER_ERROR_CODES,
  ProviderError,
  canonicalJson,
  configurationDigest,
  isProviderCredentialAvailable,
  localForgeTarget,
  normalizeProviderBaseUrl,
  resolveProviderCredential,
  resolveProviderSelection,
  targetDigest,
  validateProviderConfig,
  validateProviderId,
  validateProviderModel,
  validateWireModelId,
} from "../lib/provider-contracts.mjs";
import { MODELS, resolveModel } from "../lib/models.mjs";

const MODEL_ID = "vendor/Model-X:latest";
const API_KEY = "sk-provider-canary-do-not-persist";

function profile(overrides = {}) {
  return {
    id: "lab",
    name: "Lab inference",
    transport: "chat-completions",
    baseUrl: "https://inference.example/v1",
    auth: { type: "bearer", env: "LAB_API_KEY" },
    defaultModel: MODEL_ID,
    request: { tokenLimitField: "max_completion_tokens", includeUsage: true },
    models: [
      {
        id: MODEL_ID,
        name: "Model X",
        contextWindow: 131_072,
        pricing: { input: 1, output: 2, cacheRead: 0.1 },
        capabilities: { tools: "supported" },
      },
    ],
    ...overrides,
  };
}

function config(providers = [profile()]) {
  return { schemaVersion: 1, providers };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("the exported error code set is closed and used by every failure", () => {
  assert.ok(PROVIDER_ERROR_CODES.length >= 20);
  assert.equal(new Set(PROVIDER_ERROR_CODES).size, PROVIDER_ERROR_CODES.length);
  assert.throws(
    () => new ProviderError("NOT_A_CODE", "x"),
    /unknown provider error code/,
    "ProviderError must refuse codes outside the frozen set",
  );
});

test("provider ids are stable lowercase slugs and built-ins stay reserved", () => {
  assert.equal(validateProviderId("lab"), "lab");
  assert.equal(validateProviderId("my-lab_2"), "my-lab_2");
  for (const id of ["Lab", " lab", "lab ", "lab/one", "", "-lab", null, 7]) {
    expectCode(() => validateProviderId(id), "PROVIDER_INVALID_ID");
  }
  for (const id of ["local", "openrouter", "ollama"]) {
    expectCode(() => validateProviderId(id), "PROVIDER_RESERVED_ID");
  }
  expectCode(() => validateProviderId("a".repeat(65)), "PROVIDER_INVALID_ID");
});

test("exact wire model ids preserve case, slashes and colons", () => {
  for (const id of ["a/B:tag", "Vendor/Model-X:latest", "org/model.v2:free", "m"]) {
    assert.equal(validateWireModelId(id), id);
  }
  for (const id of ["", " padded", "padded ", "a\u0000b", "a\nb", null, 3]) {
    expectCode(() => validateWireModelId(id), "PROVIDER_INVALID_MODEL_ID");
  }
  expectCode(() => validateWireModelId("m".repeat(513)), "PROVIDER_INVALID_MODEL_ID");
});

test("base URLs keep path prefixes and reject credentials, queries and full endpoints", () => {
  assert.deepEqual(normalizeProviderBaseUrl("https://host.example/team/v1/"), {
    baseUrl: "https://host.example/team/v1",
    insecure: false,
    warning: null,
  });
  assert.equal(normalizeProviderBaseUrl("https://host.example").baseUrl, "https://host.example");
  assert.equal(
    normalizeProviderBaseUrl("https://host.example:8443/v1").baseUrl,
    "https://host.example:8443/v1",
  );
  assert.equal(
    normalizeProviderBaseUrl("http://localhost:8080/v1").baseUrl,
    "http://localhost:8080/v1",
  );
  assert.equal(
    normalizeProviderBaseUrl("http://127.0.0.1:11434").baseUrl,
    "http://127.0.0.1:11434",
  );
  assert.equal(normalizeProviderBaseUrl("http://[::1]:9000/v1").baseUrl, "http://[::1]:9000/v1");

  const insecure = normalizeProviderBaseUrl("http://10.0.0.5/v1", { allowInsecureHttp: true });
  assert.equal(insecure.insecure, true);
  assert.match(insecure.warning, /unencrypted http/);

  expectCode(() => normalizeProviderBaseUrl("http://10.0.0.5/v1"), "PROVIDER_INSECURE_HTTP");
  expectCode(
    () => normalizeProviderBaseUrl("http://localhost.evil.example/v1"),
    "PROVIDER_INSECURE_HTTP",
  );
  expectCode(
    () => normalizeProviderBaseUrl("https://user:secret@host.example/v1"),
    "PROVIDER_INVALID_BASE_URL",
  );
  expectCode(
    () => normalizeProviderBaseUrl("https://host.example/v1?key=secret"),
    "PROVIDER_INVALID_BASE_URL",
  );
  expectCode(
    () => normalizeProviderBaseUrl("https://host.example/v1#frag"),
    "PROVIDER_INVALID_BASE_URL",
  );
  expectCode(() => normalizeProviderBaseUrl("ftp://host.example/v1"), "PROVIDER_INVALID_BASE_URL");
  expectCode(
    () => normalizeProviderBaseUrl("https://host.example/v1/chat/completions"),
    "PROVIDER_FULL_ENDPOINT_URL",
  );
  expectCode(
    () => normalizeProviderBaseUrl("https://host.example/v1/models"),
    "PROVIDER_FULL_ENDPOINT_URL",
  );
  expectCode(() => normalizeProviderBaseUrl("not a url"), "PROVIDER_INVALID_BASE_URL");
  expectCode(
    () => normalizeProviderBaseUrl(`https://${"a".repeat(2100)}.example/v1`),
    "PROVIDER_INVALID_BASE_URL",
  );
});

test("configuration validation rejects unknown fields, versions and duplicates", () => {
  const validated = validateProviderConfig(config());
  assert.equal(validated.providers[0].auth.env, "LAB_API_KEY");
  assert.equal(validated.providers[0].request.tokenLimitField, "max_completion_tokens");

  expectCode(() => validateProviderConfig({ ...config(), extra: true }), "CONFIG_INVALID");
  expectCode(
    () => validateProviderConfig({ schemaVersion: 2, providers: [] }),
    "CONFIG_UNSUPPORTED_SCHEMA",
  );
  expectCode(() => validateProviderConfig({ providers: [] }), "CONFIG_UNSUPPORTED_SCHEMA");
  expectCode(
    () =>
      validateProviderConfig({ schemaVersion: 1, providers: [profile({ transport: "messages" })] }),
    "PROVIDER_UNSUPPORTED_TRANSPORT",
  );
  expectCode(
    () =>
      validateProviderConfig({
        schemaVersion: 1,
        providers: [profile({ auth: { type: "header", env: "X" } })],
      }),
    "PROVIDER_INVALID_AUTH",
  );
  expectCode(
    () =>
      validateProviderConfig({
        schemaVersion: 1,
        providers: [profile({ auth: { type: "bearer", env: "LAB KEY" } })],
      }),
    "PROVIDER_INVALID_AUTH",
  );
  expectCode(
    () =>
      validateProviderConfig({
        schemaVersion: 1,
        providers: [profile({ models: [{ id: MODEL_ID }, { id: MODEL_ID }] })],
      }),
    "PROVIDER_DUPLICATE_MODEL",
  );
  expectCode(
    () => validateProviderConfig({ schemaVersion: 1, providers: [profile(), profile()] }),
    "PROVIDER_DUPLICATE",
  );
  expectCode(
    () =>
      validateProviderConfig({
        schemaVersion: 1,
        providers: [profile({ request: { tokenLimitField: "max_output_tokens" } })],
      }),
    "PROVIDER_INVALID_REQUEST_OPTION",
  );
  expectCode(
    () =>
      validateProviderConfig({
        schemaVersion: 1,
        providers: [profile({ models: [{ id: MODEL_ID, pricing: { input: -1, output: 1 } }] })],
      }),
    "CONFIG_INVALID",
  );
  expectCode(
    () =>
      validateProviderConfig({
        schemaVersion: 1,
        providers: [profile({ allowInsecureHttp: "yes" })],
      }),
    "CONFIG_INVALID",
  );
});

test("declared defaults keep unknown metadata unknown instead of inventing capability", () => {
  const validated = validateProviderConfig({
    schemaVersion: 1,
    providers: [
      {
        id: "plain",
        baseUrl: "https://plain.example/v1",
        auth: { type: "none" },
        models: [{ id: "m/one" }],
      },
    ],
  });
  const entry = validated.providers[0];
  assert.equal(entry.name, "plain");
  assert.equal(entry.transport, "chat-completions");
  assert.equal(entry.defaultModel, null);
  assert.equal(entry.request.tokenLimitField, "max_tokens");
  assert.equal(entry.request.includeUsage, false);
  assert.deepEqual(entry.models[0].capabilities, { tools: "unknown" });
  assert.equal(entry.models[0].contextWindow, null);
  assert.equal(entry.models[0].pricing, null);
  assert.equal(entry.models[0].name, "m/one");
});

test("limits are enforced before anything is written", () => {
  const manyProviders = Array.from({ length: 65 }, (_, index) => ({
    id: `p${index}`,
    baseUrl: "https://host.example/v1",
    auth: { type: "none" },
  }));
  expectCode(
    () => validateProviderConfig({ schemaVersion: 1, providers: manyProviders }),
    "CONFIG_LIMIT_EXCEEDED",
  );

  const manyModels = Array.from({ length: 257 }, (_, index) => ({ id: `m/${index}` }));
  expectCode(
    () =>
      validateProviderConfig({
        schemaVersion: 1,
        providers: [
          {
            id: "big",
            baseUrl: "https://host.example/v1",
            auth: { type: "none" },
            models: manyModels,
          },
        ],
      }),
    "CONFIG_LIMIT_EXCEEDED",
  );
  assert.doesNotThrow(() => validateProviderModel({ id: "m/one" }));
});

test("canonical JSON sorts keys and digests ignore non-execution metadata", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');

  const first = validateProviderConfig(config());
  const reordered = validateProviderConfig({
    providers: [
      {
        models: first.providers[0].models.map((model) => ({
          capabilities: model.capabilities,
          pricing: model.pricing,
          contextWindow: model.contextWindow,
          name: model.name,
          id: model.id,
        })),
        request: first.providers[0].request,
        defaultModel: MODEL_ID,
        auth: first.providers[0].auth,
        baseUrl: first.providers[0].baseUrl,
        transport: "chat-completions",
        name: first.providers[0].name,
        id: "lab",
      },
    ],
    schemaVersion: 1,
  });
  assert.equal(configurationDigest(first), configurationDigest(reordered));

  const renamedCatalog = validateProviderConfig(
    config([
      profile({
        name: "Renamed profile",
        models: [{ ...profile().models[0], name: "Renamed model" }],
      }),
    ]),
  );
  assert.equal(
    targetDigest(first.providers[0]),
    targetDigest(renamedCatalog.providers[0]),
    "display names and catalog metadata must not invalidate an execution binding",
  );

  const retargeted = validateProviderConfig(
    config([profile({ baseUrl: "https://other.example/v2" })]),
  );
  assert.notEqual(targetDigest(first.providers[0]), targetDigest(retargeted.providers[0]));
  const rebound = validateProviderConfig(
    config([profile({ auth: { type: "bearer", env: "OTHER_API_KEY" } })]),
  );
  assert.notEqual(targetDigest(first.providers[0]), targetDigest(rebound.providers[0]));
  assert.notEqual(configurationDigest(first), configurationDigest(retargeted));
});

test("explicit provider selection accepts an exact id absent from the catalog", () => {
  const validated = validateProviderConfig(config());
  const { target, warnings } = resolveProviderSelection({
    providerId: "lab",
    modelQuery: "vendor/Unlisted-Model:Free",
    config: validated,
  });
  assert.equal(target.kind, "custom");
  assert.equal(target.providerId, "lab");
  assert.equal(target.modelId, "vendor/Unlisted-Model:Free");
  assert.equal(target.modelName, "vendor/Unlisted-Model:Free");
  assert.equal(target.baseUrl, "https://inference.example/v1");
  assert.deepEqual(target.auth, { type: "bearer", env: "LAB_API_KEY" });
  assert.deepEqual(target.capabilities, { tools: "unknown" });
  assert.equal(target.contextWindow, null);
  assert.equal(target.pricing, null);
  assert.equal(target.configDigest, targetDigest(validated.providers[0]));
  assert.equal(target.legacy, false);
  assert.deepEqual(warnings, []);
});

test("selection precedence is explicit and never silently falls back", () => {
  const validated = validateProviderConfig(
    config([profile({ defaultModel: "vendor/Default:latest" })]),
  );
  assert.equal(
    resolveProviderSelection({ providerId: "lab", config: validated }).target.modelId,
    "vendor/Default:latest",
  );
  expectCode(
    () =>
      resolveProviderSelection({
        providerId: "lab",
        config: validateProviderConfig(config([profile({ defaultModel: null })])),
      }),
    "PROVIDER_NO_DEFAULT_MODEL",
  );
  expectCode(
    () => resolveProviderSelection({ providerId: "missing", config: validated }),
    "PROVIDER_UNKNOWN",
  );
  expectCode(
    () => resolveProviderSelection({ providerId: "lab", modelQuery: " ", config: validated }),
    "PROVIDER_INVALID_MODEL_ID",
  );

  const local = resolveProviderSelection({});
  assert.equal(local.target.kind, "local");
  assert.equal(local.target.modelId, "local");
  assert.equal(local.target.providerId, "matrix");
  assert.equal(local.target.auth.type, "none");
  assert.equal(local.target.transport, "local");
  assert.deepEqual(local.target, localForgeTarget());

  const legacy = resolveProviderSelection({ modelQuery: "sonnet" });
  assert.equal(legacy.target.kind, "builtin");
  assert.equal(legacy.target.providerId, "openrouter");
  assert.equal(legacy.target.modelId, "anthropic/claude-sonnet-4.6");
  assert.equal(legacy.target.auth.type, "builtin");
  assert.equal(legacy.target.configDigest, null);
  assert.equal(legacy.target.legacy, true);
  assert.equal(legacy.target.capabilities.tools, "supported");

  const ollama = resolveProviderSelection({ modelQuery: "ollama/llama3.2" });
  assert.equal(ollama.target.providerId, "ollama");
  assert.equal(ollama.target.modelId, "ollama/llama3.2");
  assert.equal(ollama.target.capabilities.tools, "unknown");

  assert.equal(resolveProviderSelection({ modelQuery: "unknown-alias" }).target.modelId, "local");
  assert.ok(MODELS.includes(resolveModel("sonnet")));
});

test("credentials stay out of descriptors, errors and serialized targets", () => {
  const validated = validateProviderConfig(config());
  const env = { LAB_API_KEY: API_KEY };
  const { target } = resolveProviderSelection({ providerId: "lab", config: validated });

  assert.equal(isProviderCredentialAvailable(target, env), true);
  assert.equal(isProviderCredentialAvailable(target, {}), false);
  assert.equal(isProviderCredentialAvailable(localForgeTarget(), env), true);
  assert.equal(
    isProviderCredentialAvailable(resolveProviderSelection({ modelQuery: "sonnet" }).target, env),
    null,
    "built-in availability belongs to the legacy policy and must not be claimed here",
  );
  assert.equal(resolveProviderCredential(target, env), API_KEY);
  assert.equal(resolveProviderCredential(localForgeTarget(), env), null);
  assert.equal(
    resolveProviderCredential(resolveProviderSelection({ modelQuery: "sonnet" }).target, env),
    null,
  );

  const serialized = JSON.stringify(target);
  assert.equal(serialized.includes(API_KEY), false);
  assert.equal(serialized.includes("LAB_API_KEY"), true, "the env reference name is not a secret");

  assert.throws(
    () => resolveProviderCredential(target, {}),
    (error) => {
      assert.equal(error.code, "PROVIDER_MISSING_KEY");
      assert.equal(error.message.includes(API_KEY), false);
      assert.equal("key" in error.details, false);
      return true;
    },
  );
});

test("an empty configuration is explicit and frozen", () => {
  assert.deepEqual(EMPTY_PROVIDER_CONFIG, { schemaVersion: 1, providers: [] });
  assert.ok(Object.isFrozen(EMPTY_PROVIDER_CONFIG));
  assert.ok(Object.isFrozen(EMPTY_PROVIDER_CONFIG.providers));
  const local = resolveProviderSelection({ config: EMPTY_PROVIDER_CONFIG });
  assert.equal(local.target.kind, "local");
  assert.equal(Object.isFrozen(local.target.auth), true);
});
