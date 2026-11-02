import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import {
  addProvider,
  formatProviderDetail,
  formatProviderList,
  formatProviderModels,
  formatProviderUpdate,
  listProviders,
  modelsReport,
  providerProfileFromOptions,
  removeProvider,
  replaceProviderFromFile,
  showProvider,
  updateProvider,
} from "../lib/provider-commands.mjs";
import {
  acquireProviderConfigLock,
  addProviderProfile,
  loadProviderConfig,
  providerConfigPath,
  releaseProviderConfigLock,
} from "../lib/provider-config.mjs";
import { resolveProviderSelection } from "../lib/provider-contracts.mjs";
import { probeProvider, readProbeRecord } from "../lib/provider-probe.mjs";
import { discoveryStatusPath, refreshProviderModels } from "../lib/provider-discovery.mjs";
import { makeTempDir } from "./helpers.mjs";

function sandbox(t) {
  const home = join(makeTempDir("matrix-provider-commands-"), "home");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("whole-profile replacement requires a current digest and preserves other providers", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(
    { id: "lab", baseUrl: "https://old.example/v1", auth: { type: "none" } },
    { home },
  );
  await addProviderProfile(
    { id: "other", baseUrl: "https://other.example/v1", auth: { type: "none" } },
    { home },
  );
  const digest = showProvider({ home, providerId: "lab" }).configurationDigest;
  const path = join(home, "replacement.json");
  writeFileSync(
    path,
    JSON.stringify({
      id: "lab",
      baseUrl: "https://new.example/v1",
      auth: { type: "none" },
      models: [{ id: "exact/Model" }],
    }),
  );
  const result = await replaceProviderFromFile({
    home,
    providerId: "lab",
    profileFile: path,
    expectedDigest: digest,
  });
  assert.notEqual(result.digest, digest);
  assert.equal(
    loadProviderConfig({ home }).config.providers.find((p) => p.id === "lab").baseUrl,
    "https://new.example/v1",
  );
  assert.equal(
    loadProviderConfig({ home }).config.providers.find((p) => p.id === "other").baseUrl,
    "https://other.example/v1",
  );
  await assert.rejects(
    replaceProviderFromFile({ home, providerId: "lab", profileFile: path, expectedDigest: digest }),
    /changed since it was read/,
  );
  const current = loadProviderConfig({ home }).digest;
  writeFileSync(
    path,
    JSON.stringify({ id: "other", baseUrl: "https://new.example/v1", auth: { type: "none" } }),
  );
  await assert.rejects(
    replaceProviderFromFile({
      home,
      providerId: "lab",
      profileFile: path,
      expectedDigest: current,
    }),
    /id must match/,
  );
  writeFileSync(path, "{invalid");
  await assert.rejects(
    replaceProviderFromFile({
      home,
      providerId: "lab",
      profileFile: path,
      expectedDigest: current,
    }),
    /valid bounded profile JSON/,
  );
  const link = join(home, "link.json");
  symlinkSync(path, link);
  await assert.rejects(
    replaceProviderFromFile({
      home,
      providerId: "lab",
      profileFile: link,
      expectedDigest: current,
    }),
    /valid bounded profile JSON/,
  );
  assert.equal(loadProviderConfig({ home }).digest, current);
});

test("replacement hides discovery and probe records bound to a previous endpoint", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(
    { id: "lab", baseUrl: "https://old.example/v1", auth: { type: "none" } },
    { home },
  );
  await refreshProviderModels({
    home,
    providerId: "lab",
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: "discovered" }] }), {
        headers: { "content-type": "application/json" },
      }),
  });
  await probeProvider({
    home,
    providerId: "lab",
    modelId: "manual",
    checks: "text",
    fetchImpl: async () =>
      new Response(
        'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const oldProfile = loadProviderConfig({ home }).config.providers[0];
  assert.ok(readProbeRecord(home, oldProfile, "manual"));
  assert.deepEqual(showProvider({ home, providerId: "lab" }).discovered, ["discovered"]);
  const detail = showProvider({ home, providerId: "lab" });
  assert.deepEqual(
    detail.observations.map(({ modelId, text, tools }) => ({ modelId, text, tools })),
    [{ modelId: "manual", text: "pass", tools: "not-evaluated" }],
  );
  assert.match(formatProviderDetail(detail), /manual · text pass · tools not-evaluated/);
  const path = join(home, "replacement.json");
  writeFileSync(
    path,
    JSON.stringify({ id: "lab", baseUrl: "https://new.example/v1", auth: { type: "none" } }),
  );
  await replaceProviderFromFile({
    home,
    providerId: "lab",
    profileFile: path,
    expectedDigest: loadProviderConfig({ home }).digest,
  });
  const replacement = loadProviderConfig({ home }).config.providers[0];
  assert.equal(readProbeRecord(home, replacement, "manual"), null);
  assert.deepEqual(showProvider({ home, providerId: "lab" }).discovered, []);
  assert.deepEqual(showProvider({ home, providerId: "lab" }).observations, []);
});

test("replacement and reversion cannot revive records or publish in-flight old results", async (t) => {
  const home = sandbox(t);
  const profile = (hostname) => ({
    id: "lab",
    baseUrl: `https://${hostname}.example/v1`,
    auth: { type: "none" },
  });
  await addProviderProfile(profile("old"), { home });
  const profilePath = join(home, "replacement.json");
  const replace = async (hostname) => {
    writeFileSync(profilePath, JSON.stringify(profile(hostname)));
    await replaceProviderFromFile({
      home,
      providerId: "lab",
      profileFile: profilePath,
      expectedDigest: loadProviderConfig({ home }).digest,
    });
  };
  const textResponse = () =>
    new Response(
      'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  await probeProvider({
    home,
    providerId: "lab",
    modelId: "old",
    checks: "text",
    fetchImpl: async () => textResponse(),
  });
  let releaseProbe;
  let releaseDiscovery;
  let releaseFailure;
  let probeStarted;
  let discoveryStarted;
  let failureStarted;
  const probeReady = new Promise((resolve) => {
    probeStarted = resolve;
  });
  const discoveryReady = new Promise((resolve) => {
    discoveryStarted = resolve;
  });
  const failureReady = new Promise((resolve) => {
    failureStarted = resolve;
  });
  const pendingProbe = probeProvider({
    home,
    providerId: "lab",
    modelId: "late",
    checks: "text",
    fetchImpl: () => {
      probeStarted();
      return new Promise((resolve) => {
        releaseProbe = () => resolve(textResponse());
      });
    },
  });
  const pendingDiscovery = refreshProviderModels({
    home,
    providerId: "lab",
    fetchImpl: () => {
      discoveryStarted();
      return new Promise((resolve) => {
        releaseDiscovery = () =>
          resolve(
            new Response(JSON.stringify({ data: [{ id: "late" }] }), {
              headers: { "content-type": "application/json" },
            }),
          );
      });
    },
  });
  const pendingFailure = refreshProviderModels({
    home,
    providerId: "lab",
    fetchImpl: () => {
      failureStarted();
      return new Promise((resolve) => {
        releaseFailure = () => resolve(new Response("unavailable", { status: 503 }));
      });
    },
  });
  await Promise.all([probeReady, discoveryReady, failureReady]);
  await replace("new");
  await replace("old");
  const fresh = await probeProvider({
    home,
    providerId: "lab",
    modelId: "fresh",
    checks: "text",
    fetchImpl: async () => textResponse(),
  });
  assert.equal(fresh.recorded, true);
  releaseProbe();
  releaseDiscovery();
  releaseFailure();
  const [probe, discovery, failure] = await Promise.all([
    pendingProbe,
    pendingDiscovery,
    pendingFailure,
  ]);
  const current = loadProviderConfig({ home }).config.providers[0];
  assert.equal(probe.recorded, false);
  assert.equal(discovery.ok, false);
  assert.equal(failure.ok, false);
  assert.equal(readProbeRecord(home, current, "old"), null);
  assert.equal(readProbeRecord(home, current, "late"), null);
  assert.deepEqual(showProvider({ home, providerId: "lab" }).discovered, []);
  assert.equal(showProvider({ home, providerId: "lab" }).discovery, null);
  assert.ok(readProbeRecord(home, current, "fresh"));
  await removeProvider({ home, providerId: "lab" });
  await addProviderProfile(profile("old"), { home });
  const readded = loadProviderConfig({ home }).config.providers[0];
  assert.equal(readProbeRecord(home, readded, "fresh"), null);
});

test("an unreadable generation marker prevents discovery publication", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(
    { id: "lab", baseUrl: "https://old.example/v1", auth: { type: "none" } },
    { home },
  );
  const marker = join(home, ".provider-lab.generation");
  rmSync(marker);
  const target = join(home, "marker-target");
  writeFileSync(target, "canary");
  symlinkSync(target, marker);
  const result = await refreshProviderModels({
    home,
    providerId: "lab",
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: "not-published" }] }), {
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not be saved/);
  assert.deepEqual(showProvider({ home, providerId: "lab" }).discovered, []);
});

test("direct A-to-B-to-A configuration edits cannot revive or publish old observations", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(
    { id: "lab", baseUrl: "https://old.example/v1", auth: { type: "none" } },
    { home },
  );
  const response = () =>
    new Response(
      'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  await probeProvider({
    home,
    providerId: "lab",
    modelId: "old",
    checks: "text",
    fetchImpl: async () => response(),
  });
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const pending = probeProvider({
    home,
    providerId: "lab",
    modelId: "late",
    checks: "text",
    fetchImpl: () => {
      started();
      return new Promise((resolve) => {
        release = () => resolve(response());
      });
    },
  });
  await ready;
  const path = providerConfigPath(home);
  const original = readFileSync(path, "utf8");
  const changed = JSON.parse(original);
  changed.providers[0].baseUrl = "https://new.example/v1";
  writeFileSync(path, JSON.stringify(changed));
  writeFileSync(path, original);
  let profile = loadProviderConfig({ home }).config.providers[0];
  assert.equal(readProbeRecord(home, profile, "old"), null);
  const fresh = await probeProvider({
    home,
    providerId: "lab",
    modelId: "fresh",
    checks: "text",
    fetchImpl: async () => response(),
  });
  assert.equal(fresh.recorded, true);
  release();
  assert.equal((await pending).recorded, false);
  profile = loadProviderConfig({ home }).config.providers[0];
  assert.ok(readProbeRecord(home, profile, "fresh"));
  writeFileSync(path, JSON.stringify(changed));
  writeFileSync(path, original);
  await updateProvider({ home, providerId: "lab", providerName: "Renamed" });
  profile = loadProviderConfig({ home }).config.providers[0];
  assert.equal(readProbeRecord(home, profile, "fresh"), null);
});

test("a symlinked configuration stamp invalidates old evidence without following the link", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(
    { id: "lab", baseUrl: "https://old.example/v1", auth: { type: "none" } },
    { home },
  );
  const response = () =>
    new Response(
      'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  await probeProvider({
    home,
    providerId: "lab",
    modelId: "old",
    checks: "text",
    fetchImpl: async () => response(),
  });
  const stamp = join(home, ".providers.cache-stamp");
  const canary = join(home, "stamp-canary");
  rmSync(stamp);
  writeFileSync(canary, "unmodified");
  symlinkSync(canary, stamp);
  const profile = loadProviderConfig({ home }).config.providers[0];
  assert.equal(readProbeRecord(home, profile, "old"), null);
  const fresh = await probeProvider({
    home,
    providerId: "lab",
    modelId: "fresh",
    checks: "text",
    fetchImpl: async () => response(),
  });
  assert.equal(fresh.recorded, true);
  assert.equal(readFileSync(canary, "utf8"), "unmodified");
  assert.equal(readProbeRecord(home, profile, "old"), null);
});

test("cancelling probe and discovery interrupts a held cache lock without requests", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(
    { id: "lab", baseUrl: "https://old.example/v1", auth: { type: "none" } },
    { home },
  );
  const lock = await acquireProviderConfigLock({ home });
  const controller = new AbortController();
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    throw new Error("unexpected request");
  };
  try {
    const start = Date.now();
    const probe = probeProvider({
      home,
      providerId: "lab",
      modelId: "manual",
      checks: "text",
      fetchImpl,
      signal: controller.signal,
    });
    const discovery = refreshProviderModels({
      home,
      providerId: "lab",
      fetchImpl,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    const [probeResult, discoveryResult] = await Promise.all([probe, discovery]);
    assert.equal(probeResult.cancelled, true);
    assert.equal(discoveryResult.ok, false);
    assert.match(discoveryResult.error, /cancelled/i);
    assert.equal(requests, 0);
    assert.ok(Date.now() - start < 2000, "cancellation must not wait for the lock deadline");
  } finally {
    await releaseProviderConfigLock(lock);
  }
});

test("pre-cancelled operations do not adopt a direct configuration edit", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(
    { id: "lab", baseUrl: "https://old.example/v1", auth: { type: "none" } },
    { home },
  );
  const stampPath = join(home, ".providers.cache-stamp");
  const generationPath = join(home, ".provider-lab.generation");
  const stamp = readFileSync(stampPath, "utf8");
  const generation = readFileSync(generationPath, "utf8");
  const path = providerConfigPath(home);
  const changed = JSON.parse(readFileSync(path, "utf8"));
  changed.providers[0].name = "External edit";
  writeFileSync(path, JSON.stringify(changed));
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    throw new Error("unexpected request");
  };
  const probe = await probeProvider({
    home,
    providerId: "lab",
    modelId: "manual",
    checks: "text",
    fetchImpl,
    signal: controller.signal,
  });
  const discovery = await refreshProviderModels({
    home,
    providerId: "lab",
    fetchImpl,
    signal: controller.signal,
  });
  assert.equal(probe.cancelled, true);
  assert.equal(discovery.ok, false);
  assert.equal(requests, 0);
  assert.equal(readFileSync(stampPath, "utf8"), stamp);
  assert.equal(readFileSync(generationPath, "utf8"), generation);
});

test("profile construction stores the env name, never a key value", () => {
  const bearer = providerProfileFromOptions({
    providerAddId: "lab",
    providerBaseUrl: "https://inference.example/v1",
    providerApiKeyEnv: "LAB_API_KEY",
    providerName: "Lab",
    modelQuery: "Vendor/Model-X:latest",
  });
  assert.deepEqual(bearer.auth, { type: "bearer", env: "LAB_API_KEY" });
  assert.deepEqual(bearer.models, [
    { id: "Vendor/Model-X:latest", capabilities: { tools: "unknown" } },
  ]);
  assert.equal(bearer.defaultModel, "Vendor/Model-X:latest");

  const anonymous = providerProfileFromOptions({
    providerAddId: "lab",
    providerBaseUrl: "https://inference.example/v1",
    providerAuth: "none",
  });
  assert.deepEqual(anonymous.auth, { type: "none" });
  assert.deepEqual(anonymous.models, []);
  assert.equal("name" in anonymous, false);
});

test("add/list/models/remove run against the bounded store", async (t) => {
  const home = sandbox(t);
  const added = await addProvider({
    home,
    providerAddId: "lab",
    providerBaseUrl: "https://inference.example/v1",
    providerApiKeyEnv: "LAB_API_KEY",
    providerName: "Lab",
    modelQuery: "Vendor/Model-X:latest",
  });
  assert.equal(added.providerId, "lab");
  assert.deepEqual(added.models, ["Vendor/Model-X:latest"]);
  assert.match(added.digest, /^[a-f0-9]{64}$/);
  assert.equal(added.path, join(home, "providers.json"));

  const listed = listProviders({ home, env: { LAB_API_KEY: "canary" } });
  assert.equal(listed.status, "valid");
  assert.equal(listed.error, null);
  const lab = listed.providers.find((provider) => provider.id === "lab");
  assert.equal(lab.available, true);
  assert.equal(lab.discovery, null);
  assert.deepEqual(
    lab.models.map((model) => [model.id, model.source]),
    [["Vendor/Model-X:latest", "custom"]],
  );
  assert.ok(listed.providers.some((provider) => provider.id === "openrouter"));

  const report = await modelsReport({ home, providerId: "lab", env: { LAB_API_KEY: "canary" } });
  assert.deepEqual(report.configured, ["Vendor/Model-X:latest"]);
  assert.deepEqual(report.discovered, []);
  assert.equal(report.fetchedAt, null);
  assert.equal(report.discovery, null);
  assert.equal(report.refresh, null);
  assert.equal(report.available, true);

  await assert.rejects(
    () => modelsReport({ home, providerId: "missing", env: {} }),
    /unknown provider "missing"/,
  );

  const removed = await removeProvider({ home, providerId: "lab" });
  assert.deepEqual(removed.remaining, []);
  await assert.rejects(() => removeProvider({ home, providerId: "lab" }), /unknown provider/);
});

test("an invalid configuration is reported, and mutations refuse it", async (t) => {
  const home = sandbox(t);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "providers.json"), "{ broken", { mode: 0o600 });

  const listed = listProviders({ home });
  assert.equal(listed.status, "invalid");
  assert.match(listed.error, /invalid/i);
  const text = formatProviderList(listed);
  assert.match(text, /invalid configuration/);

  await assert.rejects(
    () =>
      modelsReport({
        home,
        providerId: "lab",
        env: {},
      }),
    /JSON/i,
  );
  assert.throws(() => showProvider({ home, providerId: "lab", env: {} }), /JSON/i);
  await assert.rejects(
    () =>
      addProvider({
        home,
        providerAddId: "lab",
        providerBaseUrl: "https://inference.example/v1",
        providerAuth: "none",
      }),
    /JSON/i,
  );
});

test("list formatting distinguishes built-ins, freshness, staleness and absence", () => {
  const path = "/tmp/home/providers.json";
  const text = formatProviderList({
    path,
    error: null,
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        source: "builtin",
        available: null,
        discovery: null,
        models: [{ id: "a" }],
      },
      {
        id: "lab",
        name: "Lab",
        source: "custom",
        available: true,
        discovery: {
          outcome: "ok",
          stale: false,
          error: null,
          fetchedAt: Date.UTC(2023, 10, 14, 22, 13, 20),
        },
        models: [{ id: "m" }, { id: "n" }],
      },
      {
        id: "stale",
        name: "Stale",
        source: "custom",
        available: false,
        discovery: { outcome: "error", stale: true, error: "HTTP 503" },
        models: [],
      },
      {
        id: "bare",
        name: "Bare",
        source: "custom",
        available: false,
        discovery: null,
        models: [{ id: "x" }],
      },
      {
        id: "anon",
        name: "Anon",
        source: "custom",
        auth: "none",
        available: true,
        discovery: null,
        models: [],
      },
    ],
  });
  assert.match(text, /openrouter\s+OpenRouter · 1 model · built-in/);
  assert.match(text, /fresh · 2023-11-14T22:13:20Z/);
  assert.match(text, /stale: HTTP 503/);
  assert.match(text, /no snapshot/);
  assert.match(text, /2 models/);
  assert.match(text, /1 model ·/);
  assert.match(text, /anon\s+Anon · 0 models · no key required/);
  assert.equal(
    formatProviderList({ path, error: "bad file", providers: [] }),
    `PROVIDERS  ${path}\n  ✗ invalid configuration: bad file\n  no providers configured`,
  );
  assert.match(formatProviderList({ path, error: null, providers: [] }), /no providers configured/);

  const hostile = formatProviderList({
    path,
    error: null,
    providers: [
      {
        id: "evil",
        name: "Evil",
        source: "custom",
        available: true,
        discovery: {
          outcome: "error",
          stale: true,
          error: "HTTP 500\n  ✓ key present \u001b[2J\u001b[2J",
        },
        models: [],
      },
    ],
  });
  assert.equal(hostile.split("\n").length, 2, "a provider body cannot forge extra rows");
  assert.match(hostile, /stale: HTTP 500 ✓ key present/);
  assert.equal(hostile.includes("\u001b"), false, "escapes are removed before display");
});

test("show and update expose one profile and preserve unnamed fields", async (t) => {
  const home = sandbox(t);
  await addProvider({
    home,
    providerAddId: "lab",
    providerBaseUrl: "https://inference.example/v1",
    providerApiKeyEnv: "LAB_API_KEY",
    providerName: "Lab",
    modelQuery: "vendor/a",
  });
  const env = { LAB_API_KEY: "sk-show-canary" };

  const detail = showProvider({ home, providerId: "lab", env });
  assert.equal(detail.name, "Lab");
  assert.equal(detail.baseUrl, "https://inference.example/v1");
  assert.deepEqual(detail.auth, { type: "bearer", env: "LAB_API_KEY" });
  assert.equal(detail.available, true);
  assert.equal(detail.defaultModel, "vendor/a");
  assert.deepEqual(detail.models, [
    { id: "vendor/a", name: "vendor/a", tools: "unknown", contextWindow: null },
  ]);
  assert.deepEqual(detail.discovered, []);
  assert.equal(detail.discovery, null);
  assert.equal(formatProviderDetail(detail).includes("sk-show-canary"), false);

  const renamed = await updateProvider({ home, providerId: "lab", providerName: "Lab Two" });
  assert.deepEqual(renamed.changes, ["name"]);
  assert.equal(renamed.name, "Lab Two");
  assert.deepEqual(renamed.models, ["vendor/a"]);
  assert.match(formatProviderUpdate(renamed), /updated · name/);

  const added = await updateProvider({ home, providerId: "lab", modelQuery: "vendor/b" });
  assert.deepEqual(added.changes, ["model"]);
  assert.deepEqual(added.models, ["vendor/a", "vendor/b"]);
  assert.equal(added.defaultModel, "vendor/a", "adding a model keeps the default");

  const removed = await updateProvider({
    home,
    providerId: "lab",
    providerRemoveModel: "vendor/a",
  });
  assert.deepEqual(removed.changes, ["model", "defaultModel"]);
  assert.deepEqual(removed.models, ["vendor/b"]);
  assert.equal(removed.defaultModel, null, "removing the default clears the pointer");

  const defaulted = await updateProvider({
    home,
    providerId: "lab",
    providerDefaultModel: "vendor/b",
  });
  assert.deepEqual(defaulted.changes, ["defaultModel"]);
  assert.equal(defaulted.defaultModel, "vendor/b");

  const anonymous = await updateProvider({ home, providerId: "lab", providerAuth: "none" });
  assert.deepEqual(anonymous.auth, { type: "none", env: null });
  const anonymousDetail = showProvider({ home, providerId: "lab", env });
  assert.equal(anonymousDetail.available, true);
  assert.match(formatProviderDetail(anonymousDetail), /auth anonymous \(no key\)/);
  assert.match(formatProviderDetail(anonymousDetail), /no key required/);
  assert.match(formatProviderUpdate(anonymous), /anonymous/);
  await assert.rejects(
    () => updateProvider({ home, providerId: "lab", providerAuth: "bearer" }),
    /requires --api-key-env/,
  );

  const bearer = await updateProvider({
    home,
    providerId: "lab",
    providerAuth: "bearer",
    providerApiKeyEnv: "NEW_KEY",
  });
  assert.deepEqual(bearer.auth, { type: "bearer", env: "NEW_KEY" });
  await assert.rejects(
    () => updateProvider({ home, providerId: "lab", providerAuth: "magic" }),
    /--auth expects/,
  );

  const unlisted = await updateProvider({
    home,
    providerId: "lab",
    providerDefaultModel: "Vendor/Manual:latest",
  });
  assert.equal(unlisted.defaultModel, "Vendor/Manual:latest");
  assert.deepEqual(unlisted.models, ["vendor/b"], "setting a default does not add a model");
  await assert.rejects(
    () => updateProvider({ home, providerId: "lab", providerDefaultModel: "bad\u0000id" }),
    /control characters/,
  );
  await assert.rejects(
    () => updateProvider({ home, providerId: "lab", modelQuery: "vendor/b" }),
    /already lists model/,
  );
  await assert.rejects(
    () => updateProvider({ home, providerId: "lab", providerRemoveModel: "vendor/missing" }),
    /does not list model/,
  );
  await assert.rejects(
    () =>
      updateProvider({
        home,
        providerId: "lab",
        modelQuery: "vendor/c",
        providerRemoveModel: "vendor/c",
      }),
    /cannot name the same model/,
  );
  await assert.rejects(() => updateProvider({ home, providerId: "lab" }), /at least one change/);
  await assert.rejects(
    () => updateProvider({ home, providerId: "lab", providerAuth: "none", providerApiKeyEnv: "X" }),
    /not valid with --auth none/,
  );
  const preserved = await updateProvider({ home, providerId: "lab", providerAuth: "bearer" });
  assert.deepEqual(preserved.auth, { type: "bearer", env: "NEW_KEY" });
  await assert.rejects(
    () => updateProvider({ home, providerId: "missing", providerName: "X" }),
    /unknown provider/,
  );
  assert.throws(() => showProvider({ home, providerId: "missing", env }), /unknown provider/);
});

test("a target change invalidates discovery while a rename keeps it", async (t) => {
  const home = sandbox(t);
  await addProvider({
    home,
    providerAddId: "lab",
    providerBaseUrl: "https://inference.example/v1",
    providerApiKeyEnv: "LAB_API_KEY",
    modelQuery: "vendor/configured",
  });
  const env = { LAB_API_KEY: "sk-discovery-canary" };
  const refreshed = await refreshProviderModels({
    home,
    providerId: "lab",
    env,
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: "vendor/discovered" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.equal(refreshed.ok, true);

  const before = showProvider({ home, providerId: "lab", env });
  assert.deepEqual(before.discovered, ["vendor/discovered"]);
  assert.ok(before.fetchedAt > 0);
  assert.equal(before.discovery.outcome, "ok");
  assert.match(formatProviderDetail(before), /last refresh ok/);

  await updateProvider({ home, providerId: "lab", providerName: "Renamed" });
  const renamed = showProvider({ home, providerId: "lab", env });
  assert.deepEqual(renamed.discovered, ["vendor/discovered"]);
  assert.ok(renamed.fetchedAt > 0, "a display-only change keeps the snapshot");

  await updateProvider({ home, providerId: "lab", providerBaseUrl: "https://other.example/v1" });
  const retargeted = showProvider({ home, providerId: "lab", env });
  assert.deepEqual(retargeted.discovered, []);
  assert.equal(retargeted.fetchedAt, null);
  assert.equal(retargeted.discovery, null);
  assert.match(formatProviderDetail(retargeted), /no snapshot yet/);
});

test("an unlisted default survives unrelated updates and clears only on removal", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(
    {
      id: "lab",
      name: "Lab",
      baseUrl: "https://inference.example/v1",
      auth: { type: "none" },
      defaultModel: "Vendor/Manual:latest",
      models: [],
    },
    { home },
  );
  const resolve = () =>
    resolveProviderSelection({
      providerId: "lab",
      config: loadProviderConfig({ home }).config,
    }).target;
  assert.equal(resolve().modelId, "Vendor/Manual:latest");

  const renamed = await updateProvider({ home, providerId: "lab", providerName: "Renamed" });
  assert.deepEqual(renamed.changes, ["name"]);
  assert.equal(renamed.defaultModel, "Vendor/Manual:latest");
  assert.equal(resolve().modelId, "Vendor/Manual:latest");

  const retargeted = await updateProvider({
    home,
    providerId: "lab",
    providerBaseUrl: "https://other.example/v1",
  });
  assert.equal(retargeted.changes.includes("defaultModel"), false);
  assert.equal(retargeted.defaultModel, "Vendor/Manual:latest");
  assert.equal(resolve().modelId, "Vendor/Manual:latest");

  const bearer = await updateProvider({
    home,
    providerId: "lab",
    providerAuth: "bearer",
    providerApiKeyEnv: "LAB_KEY",
  });
  assert.equal(bearer.changes.includes("defaultModel"), false);
  assert.equal(bearer.defaultModel, "Vendor/Manual:latest");
  assert.equal(resolve().modelId, "Vendor/Manual:latest");

  await updateProvider({
    home,
    providerId: "lab",
    modelQuery: "vendor/x",
    providerDefaultModel: "vendor/x",
  });
  const cleared = await updateProvider({
    home,
    providerId: "lab",
    providerRemoveModel: "vendor/x",
  });
  assert.deepEqual(cleared.changes, ["model", "defaultModel"]);
  assert.equal(cleared.defaultModel, null);

  await updateProvider({ home, providerId: "lab", modelQuery: "vendor/a" });
  await updateProvider({ home, providerId: "lab", modelQuery: "vendor/b" });
  await updateProvider({ home, providerId: "lab", providerDefaultModel: "vendor/a" });
  const replaced = await updateProvider({
    home,
    providerId: "lab",
    providerRemoveModel: "vendor/a",
    modelQuery: "vendor/c",
    providerDefaultModel: "vendor/c",
  });
  assert.deepEqual(replaced.changes, ["model", "defaultModel"]);
  assert.equal(replaced.defaultModel, "vendor/c");
  assert.deepEqual(replaced.models, ["vendor/b", "vendor/c"]);

  const manual = await updateProvider({
    home,
    providerId: "lab",
    providerDefaultModel: "Vendor/Manual:latest",
  });
  assert.equal(manual.defaultModel, "Vendor/Manual:latest");
  assert.deepEqual(manual.models, ["vendor/b", "vendor/c"]);
  assert.equal(resolve().modelId, "Vendor/Manual:latest");
});

test("provider detail renders capability, context and failure state", () => {
  const text = formatProviderDetail({
    providerId: "lab",
    path: "/tmp/home/providers.json",
    name: "Lab",
    baseUrl: "https://inference.example/v1",
    transport: "chat-completions",
    auth: { type: "bearer", env: "LAB_API_KEY" },
    available: false,
    defaultModel: null,
    models: [
      { id: "a", name: "a", tools: "supported", contextWindow: 2_000_000 },
      { id: "b", name: "b", tools: "unsupported", contextWindow: 128_000 },
      { id: "c", name: "c", tools: "unknown", contextWindow: 500 },
    ],
    discovered: ["vendor/d"],
    fetchedAt: null,
    discovery: { outcome: "error", stale: true, error: "HTTP 503" },
  });
  assert.match(text, /a · tools · 2M ctx/);
  assert.match(text, /b · no tools · 128k ctx/);
  assert.match(text, /c · tools unknown · 500 ctx/);
  assert.match(text, /stale: HTTP 503/);
  assert.match(text, /key missing/);
  assert.match(text, /default none/);
});

test("modelsReport projects a real refresh and keeps a failure visible", async (t) => {
  let status = 200;
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      status === 200
        ? JSON.stringify({ data: [{ id: "Vendor/Model-X:latest" }, { id: "vendor/extra" }] })
        : "upstream down",
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const home = sandbox(t);
  await addProvider({
    home,
    providerAddId: "lab",
    providerBaseUrl: `http://127.0.0.1:${server.address().port}`,
    providerApiKeyEnv: "LAB_API_KEY",
    modelQuery: "Vendor/Model-X:latest",
  });
  const env = { LAB_API_KEY: "sk-commands-canary" };

  const fresh = await modelsReport({ home, providerId: "lab", env, refresh: true });
  assert.equal(fresh.auth, "bearer");
  assert.deepEqual(fresh.configured, ["Vendor/Model-X:latest"]);
  assert.deepEqual(fresh.discovered, ["vendor/extra"]);
  assert.equal(fresh.discovery.outcome, "ok");
  assert.equal(fresh.refresh.ok, true);
  assert.equal(fresh.refresh.count, 2);
  assert.equal(fresh.refresh.error, null);
  assert.equal(fresh.refresh.stale, false);
  assert.equal(fresh.refresh.truncated, false);
  assert.equal(fresh.fetchedAt, fresh.discovery.at);
  assert.equal(fresh.discovery.fetchedAt, fresh.fetchedAt);

  // A snapshot written before status existed is still summarised consistently.
  unlinkSync(discoveryStatusPath(home, "lab"));
  const legacy = await modelsReport({ home, providerId: "lab", env });
  assert.equal(legacy.refresh, null);
  assert.equal(legacy.discovery.outcome, "ok");
  assert.equal(legacy.discovery.stale, false);
  assert.equal(legacy.discovery.fetchedAt, fresh.fetchedAt);
  assert.equal(calls, 1);

  status = 503;
  const failed = await modelsReport({ home, providerId: "lab", env, refresh: true });
  assert.equal(failed.refresh.ok, false);
  assert.equal(failed.refresh.stale, true);
  assert.equal(failed.refresh.count, 2, "a failed refresh reports the models it kept");
  assert.match(failed.refresh.error, /HTTP 503/);
  assert.deepEqual(failed.discovered, ["vendor/extra"], "the prior snapshot survives");
  assert.equal(failed.fetchedAt, fresh.fetchedAt);
  assert.equal(failed.discovery.outcome, "error");
  assert.equal(failed.discovery.stale, true);

  // A later read without --refresh must not hide the failed refresh.
  const cached = await modelsReport({ home, providerId: "lab", env });
  assert.equal(cached.refresh, null);
  assert.equal(cached.discovery.outcome, "error");
  assert.equal(cached.discovery.stale, true);
  assert.equal(calls, 2, "a cached read makes no network request");
  assert.deepEqual(cached.configured, ["Vendor/Model-X:latest"]);
  assert.deepEqual(cached.discovered, ["vendor/extra"]);
  const cachedText = formatProviderModels(cached);
  assert.match(cachedText, /stale: .*HTTP 503/);
  assert.match(cachedText, /configured \(1\)\n {4}Vendor\/Model-X:latest/);
  assert.doesNotMatch(cachedText, /refresh failed/);
  assert.equal(JSON.parse(JSON.stringify(cached)).discovery.stale, true);
  assert.equal(
    listProviders({ home, env }).providers.find((provider) => provider.id === "lab").discovery
      .stale,
    true,
  );

  await addProvider({
    home,
    providerAddId: "anon",
    providerBaseUrl: "http://127.0.0.1:9",
    providerAuth: "none",
  });
  const anonymous = await modelsReport({ home, providerId: "anon", env: {} });
  assert.equal(anonymous.auth, "none");
  assert.equal(anonymous.available, true);
  assert.match(formatProviderModels(anonymous), /no key required/);
  assert.equal(
    listProviders({ home, env: {} }).providers.find((provider) => provider.id === "anon").auth,
    "none",
  );
});

test("model formatting reports snapshot, staleness, refresh outcome and truncation", () => {
  const base = {
    providerId: "lab",
    baseUrl: "https://inference.example/v1",
    available: false,
    fetchedAt: null,
    configured: ["Vendor/Model-X:latest"],
    discovered: [],
    discovery: null,
  };
  assert.match(formatProviderModels(base), /snapshot never/);
  assert.equal(
    formatProviderModels({ ...base, auth: "none", available: true }),
    `PROVIDER lab · https://inference.example/v1\n  no key required · snapshot never\n  configured (1)\n    Vendor/Model-X:latest\n  discovered (0)\n  no snapshot yet; run with --refresh to ask the provider`,
  );
  assert.match(
    formatProviderModels({ ...base, fetchedAt: 1e20 }),
    /snapshot never/,
    "an out-of-range timestamp is reported as never",
  );
  assert.match(formatProviderModels(base), /no snapshot yet/);
  assert.match(
    formatProviderModels({ ...base, discovered: ["vendor/a"], fetchedAt: 1 }),
    /discovered \(1\)\n {4}vendor\/a/,
  );
  assert.match(
    formatProviderModels({ ...base, discovery: { outcome: "ok", stale: false } }),
    /last refresh ok/,
  );
  assert.match(
    formatProviderModels({ ...base, discovery: { outcome: "error", stale: true, error: "boom" } }),
    /stale: boom/,
  );
  assert.match(
    formatProviderModels({
      ...base,
      refresh: { ok: true, count: 2, truncated: true, error: null, stale: false },
    }),
    /refresh ok · 2 models \(truncated\)/,
  );
  assert.match(
    formatProviderModels({
      ...base,
      refresh: { ok: false, error: "HTTP 500", count: 0, truncated: false, stale: true },
    }),
    /refresh failed · HTTP 500 · no snapshot available/,
    "a failure without a snapshot must not claim one was preserved",
  );
  assert.match(
    formatProviderModels({
      ...base,
      fetchedAt: 1,
      refresh: { ok: false, error: "HTTP 500", count: 1, truncated: false, stale: true },
    }),
    /refresh failed · HTTP 500 · prior snapshot preserved/,
  );
  const hostileRefresh = formatProviderModels({
    ...base,
    refresh: {
      ok: false,
      error: "HTTP 502\n  ✓ key present \u001b[31m",
      count: 0,
      truncated: false,
      stale: true,
    },
  });
  assert.equal(hostileRefresh.split("\n").length, 6, "the refresh error stays on its own row");
  assert.match(hostileRefresh, /refresh failed · HTTP 502 ✓ key present/);
  assert.equal(hostileRefresh.includes("\u001b"), false);
  assert.match(
    formatProviderModels({
      ...base,
      refresh: { ok: true, count: 1, truncated: false, error: null, stale: false },
    }),
    /refresh ok · 1 model$/,
  );
});
