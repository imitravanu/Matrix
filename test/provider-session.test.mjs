import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROVIDER_SCHEMA_VERSION,
  resolveProviderSelection,
  targetDigest,
  validateProviderConfig,
} from "../lib/provider-contracts.mjs";
import { loadSession, saveSession } from "../lib/session.mjs";
import {
  builtinSessionDigest,
  sessionProviderIdentity,
  validateSessionProvider,
} from "../lib/provider-session.mjs";
import { pickerModelFromTarget } from "../src/provider-picker.mjs";
import { makeTempDir } from "./helpers.mjs";

const config = validateProviderConfig({
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  providers: [
    {
      id: "lab",
      name: "Lab",
      baseUrl: "https://lab.example/v1",
      auth: { type: "bearer", env: "LAB_KEY" },
      models: [{ id: "vendor/manual", capabilities: { tools: "supported" } }],
    },
  ],
});
const profile = config.providers[0];
const target = {
  kind: "custom",
  providerId: "lab",
  modelId: "vendor/manual",
  configDigest: targetDigest(profile),
};
const catalog = {
  entries: [{ providerId: "lab", modelId: "vendor/manual" }],
};

test("named and explicit built-in targets become session identities", () => {
  assert.equal(sessionProviderIdentity(null), null);
  assert.equal(sessionProviderIdentity({ id: "local" }), null);
  assert.equal(
    sessionProviderIdentity({ providerTarget: { kind: "local", providerId: "matrix" } }),
    null,
    "Local Forge is fully described by its legacy model ID",
  );

  const openrouter = resolveProviderSelection({
    providerId: "openrouter",
    modelQuery: "vendor/unlisted",
  }).target;
  assert.deepEqual(sessionProviderIdentity(pickerModelFromTarget(openrouter)), {
    id: "openrouter",
    modelId: "vendor/unlisted",
    digest: builtinSessionDigest("openrouter"),
  });

  const ollama = resolveProviderSelection({
    providerId: "ollama",
    modelQuery: "llama3.2:8b",
  }).target;
  assert.deepEqual(sessionProviderIdentity(pickerModelFromTarget(ollama)), {
    id: "ollama",
    modelId: "llama3.2:8b",
    digest: builtinSessionDigest("ollama"),
  });

  assert.deepEqual(sessionProviderIdentity({ providerTarget: target }), {
    id: "lab",
    modelId: "vendor/manual",
    digest: targetDigest(profile),
  });
});

test("resume validation accepts the exact profile and refuses every mismatch", () => {
  assert.deepEqual(validateSessionProvider(null), { ok: true, error: null });
  assert.deepEqual(
    validateSessionProvider(
      { id: "lab", modelId: "vendor/manual", digest: targetDigest(profile) },
      { config, catalog },
    ),
    { ok: true, error: null },
  );

  assert.match(
    validateSessionProvider(
      { id: "gone", modelId: "vendor/manual", digest: targetDigest(profile) },
      { config, catalog },
    ).error,
    /no longer configured/,
  );

  const changed = validateProviderConfig({
    schemaVersion: PROVIDER_SCHEMA_VERSION,
    providers: [
      {
        id: "lab",
        name: "Lab",
        baseUrl: "https://other.example/v1",
        auth: { type: "bearer", env: "LAB_KEY" },
        models: [{ id: "vendor/manual" }],
      },
    ],
  }).providers[0];
  assert.match(
    validateSessionProvider(
      { id: "lab", modelId: "vendor/manual", digest: targetDigest(changed) },
      { config, catalog },
    ).error,
    /changed since this session was saved/,
  );

  assert.deepEqual(
    validateSessionProvider(
      { id: "lab", modelId: "vendor/manual", digest: targetDigest(profile) },
      { config, catalog: { entries: [] } },
    ),
    { ok: true, error: null },
    "an exact manual model does not need discovery membership",
  );

  assert.match(
    validateSessionProvider(
      { id: "lab", modelId: "vendor/manual", digest: targetDigest(profile) },
      { loaded: { status: "invalid", error: new Error("bad") } },
    ).error,
    /invalid/,
  );
  assert.match(
    validateSessionProvider({ id: "lab", modelId: "vendor/manual", digest: targetDigest(profile) })
      .error,
    /not loaded/,
  );
});

test("built-in identities round trip exact arbitrary IDs and validate without profile config", (t) => {
  const home = join(makeTempDir("matrix-builtin-session-"), "home");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  for (const [providerId, modelId] of [
    ["openrouter", "vendor/unlisted"],
    ["ollama", "llama3.2:8b"],
  ]) {
    const resolved = resolveProviderSelection({ providerId, modelQuery: modelId }).target;
    const identity = sessionProviderIdentity(pickerModelFromTarget(resolved));
    assert.deepEqual(identity, {
      id: providerId,
      modelId,
      digest: builtinSessionDigest(providerId),
    });
    assert.deepEqual(validateSessionProvider(identity), { ok: true, error: null });

    const id = `builtin-${providerId}`;
    const saved = saveSession(
      { id, cwd: "/workspace", history: [], modelId, provider: identity },
      { home, now: 1 },
    );
    assert.equal(saved.ok, true);
    assert.deepEqual(loadSession(id, { home }).provider, identity);

    assert.match(
      validateSessionProvider({ ...identity, digest: "b".repeat(64) }).error,
      /changed since this session was saved/,
    );
  }

  assert.match(
    validateSessionProvider({
      id: "ollama",
      modelId: "anthropic/claude-sonnet-4.6",
      digest: builtinSessionDigest("ollama"),
    }).error,
    /no longer available/,
  );
});

test("an uncatalogued manual model resumes without requiring discovery membership", () => {
  const resolved = resolveProviderSelection({
    providerId: "lab",
    modelQuery: "vendor/unlisted",
    config,
  }).target;
  const identity = sessionProviderIdentity(pickerModelFromTarget(resolved));
  assert.deepEqual(validateSessionProvider(identity, { config }), { ok: true, error: null });
  assert.deepEqual(validateSessionProvider(identity, { config, catalog: { entries: [] } }), {
    ok: true,
    error: null,
  });
  assert.match(
    validateSessionProvider({ ...identity, digest: "c".repeat(64) }, { config }).error,
    /changed since this session was saved/,
  );
  assert.match(
    validateSessionProvider({ ...identity, modelId: " vendor/unlisted" }, { config }).error,
    /no longer available/,
  );
});

test("a provider identity survives a session round trip and malformed ones are rejected", (t) => {
  const home = join(makeTempDir("matrix-provider-session-"), "home");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const provider = {
    id: "lab",
    modelId: "vendor/manual",
    digest: targetDigest(profile),
    apiKey: "sk-session-canary",
  };

  const saved = saveSession(
    { id: "bound", cwd: "/workspace", history: [], modelId: "vendor/manual", provider },
    { home, now: 100 },
  );
  assert.equal(saved.ok, true);
  const loaded = loadSession("bound", { home });
  assert.deepEqual(loaded.provider, {
    id: "lab",
    modelId: "vendor/manual",
    digest: targetDigest(profile),
  });
  assert.doesNotMatch(readFileSync(join(home, "sessions", "bound.json"), "utf8"), /canary/);

  const sidecar = JSON.parse(
    JSON.stringify({ version: 1, id: "bad", savedAt: 1, cwd: null, history: [], provider: {} }),
  );
  writeFileSync(join(home, "sessions", "bad.json"), JSON.stringify(sidecar), { mode: 0o600 });
  assert.equal(loadSession("bad", { home, onWarning: () => {} }), null);
});

test("a session provider accepts the full wire model id limit and no more", (t) => {
  const home = join(makeTempDir("matrix-provider-limit-"), "home");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const digest = targetDigest(profile);
  const exact = "m".repeat(512);
  const saved = saveSession(
    {
      id: "limit",
      cwd: "/workspace",
      history: [],
      modelId: exact,
      provider: { id: "lab", modelId: exact, digest },
    },
    { home, now: 1 },
  );
  assert.equal(saved.ok, true);
  assert.equal(loadSession("limit", { home }).provider.modelId, exact);

  const tooLong = {
    version: 1,
    id: "too-long",
    savedAt: 1,
    cwd: null,
    history: [],
    provider: { id: "lab", modelId: "m".repeat(513), digest },
  };
  writeFileSync(join(home, "sessions", "too-long.json"), JSON.stringify(tooLong), {
    mode: 0o600,
  });
  assert.equal(loadSession("too-long", { home, onWarning: () => {} }), null);
});
