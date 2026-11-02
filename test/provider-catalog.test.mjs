import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildProviderCatalog,
  catalogDiagnostic,
  findCatalogEntry,
  groupCatalog,
} from "../lib/provider-catalog.mjs";
import {
  addProviderProfile,
  loadProviderConfig,
  providerCacheGeneration,
  providerConfigPath,
  replaceProviderProfile,
} from "../lib/provider-config.mjs";
import {
  clearDiscoveryCache,
  discoveryCachePath,
  readDiscoveryCache,
  readDiscoveryStatus,
  refreshProviderModels,
} from "../lib/provider-discovery.mjs";
import { targetDigest } from "../lib/provider-contracts.mjs";
import { PACKAGE_ROOT, makeTempDir } from "./helpers.mjs";

const MODEL = "Vendor/Model-X:Free";
const KEY = "sk-discovery-canary-key";

function profile(baseUrl, overrides = {}) {
  return {
    id: "lab",
    name: "Lab inference",
    baseUrl: `${baseUrl}/team/v1`,
    auth: { type: "bearer", env: "LAB_API_KEY" },
    models: [{ id: MODEL, name: "Configured X", capabilities: { tools: "supported" } }],
    ...overrides,
  };
}

function sandbox(t) {
  const home = join(makeTempDir("matrix-catalog-"), "home");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

async function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    Promise.resolve(handler(req, res)).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("the catalog combines built-ins and custom profiles with per-profile availability", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example", { id: "lab" }), { home });

  const catalog = buildProviderCatalog({ home, env: { LAB_API_KEY: KEY } });
  assert.equal(catalog.status, "valid");
  assert.equal(catalogDiagnostic(catalog), null);

  const local = findCatalogEntry(catalog, "matrix", "local");
  assert.equal(local.available, true);
  assert.equal(local.legacy, true);

  const openrouter = catalog.entries.find((entry) => entry.providerId === "openrouter");
  assert.equal(openrouter.available, null, "built-in availability stays unknown here");

  const custom = findCatalogEntry(catalog, "lab", MODEL);
  assert.equal(custom.source, "custom");
  assert.equal(custom.name, "Configured X");
  assert.equal(custom.available, true);
  assert.equal(custom.configDigest.length, 64);

  const unavailable = buildProviderCatalog({ home, env: {} });
  assert.equal(findCatalogEntry(unavailable, "lab", MODEL).available, false);
  assert.equal(
    findCatalogEntry(unavailable, "matrix", "local").available,
    true,
    "Local Forge availability must not depend on provider keys",
  );

  const grouped = groupCatalog(catalog);
  const lab = grouped.find((provider) => provider.id === "lab");
  assert.equal(lab.models.length, 1);
  assert.equal(lab.models[0].modelId, MODEL);
});

test("an invalid custom file leaves Local Forge visible with a diagnostic", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example"), { home });
  const configPath = providerConfigPath(home);
  writeFileSync(configPath, "{ broken", { mode: 0o600 });

  const catalog = buildProviderCatalog({ home, env: { LAB_API_KEY: KEY } });
  assert.equal(catalog.status, "invalid");
  assert.match(catalogDiagnostic(catalog), /invalid/i);
  assert.ok(findCatalogEntry(catalog, "matrix", "local"));
  assert.equal(findCatalogEntry(catalog, "lab", MODEL), null);
});

test("discovery is explicit, authenticated, bounded and cached privately", async (t) => {
  const server = await startServer((req, res) => {
    json(res, {
      data: [
        { id: "Vendor/Other-M:free" },
        { id: "Vendor/Other-M:free" },
        { id: "bad\u0000id" },
        { id: "vendor/third:tag" },
      ],
    });
  });
  t.after(() => server.close());
  const home = sandbox(t);
  await addProviderProfile(profile(server.baseUrl), { home });

  const before = buildProviderCatalog({ home, env: { LAB_API_KEY: KEY } });
  assert.equal(before.entries.filter((entry) => entry.source === "discovered").length, 0);

  const result = await refreshProviderModels({
    home,
    providerId: "lab",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["Vendor/Other-M:free", "vendor/third:tag"],
  );
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/team/v1/models");
  assert.equal(server.requests[0].headers.authorization, `Bearer ${KEY}`);

  const cachePath = discoveryCachePath(home, "lab");
  assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  const cached = readDiscoveryCache(home, loadProviderConfig({ home }).config.providers[0]);
  assert.equal(cached.models.length, 2);

  const catalog = buildProviderCatalog({ home, env: { LAB_API_KEY: KEY } });
  const discovered = catalog.entries.filter((entry) => entry.source === "discovered");
  assert.equal(discovered.length, 2);
  assert.equal(findCatalogEntry(catalog, "lab", MODEL).source, "custom");
  assert.equal(findCatalogEntry(catalog, "lab", MODEL).name, "Configured X");
  assert.equal(
    findCatalogEntry(catalog, "lab", "Vendor/Other-M:free").capabilities.tools,
    "unknown",
  );
});

test("a failed refresh keeps the last snapshot as stale and never invents models", async (t) => {
  let mode = "ok";
  const server = await startServer((req, res) => {
    if (mode === "ok") json(res, { data: [{ id: "vendor/first" }] });
    else json(res, { error: "unavailable" }, 503);
  });
  t.after(() => server.close());
  const home = sandbox(t);
  await addProviderProfile(profile(server.baseUrl), { home });

  assert.equal(
    (await refreshProviderModels({ home, providerId: "lab", env: { LAB_API_KEY: KEY } })).ok,
    true,
  );
  mode = "fail";
  const failed = await refreshProviderModels({
    home,
    providerId: "lab",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.stale, true);
  assert.deepEqual(
    failed.models.map((model) => model.id),
    ["vendor/first"],
  );
  assert.match(failed.error, /HTTP 503/);

  const catalog = buildProviderCatalog({ home, env: { LAB_API_KEY: KEY } });
  assert.ok(findCatalogEntry(catalog, "lab", MODEL), "configured metadata survives failure");
  assert.equal(findCatalogEntry(catalog, "lab", "vendor/first").source, "discovered");
});

test("discovery refuses redirects, missing keys and unknown providers", async (t) => {
  const destination = await startServer((req, res) => json(res, { data: [] }));
  const origin = await startServer((req, res) => {
    res.writeHead(302, { location: `${destination.baseUrl}/models` });
    res.end("moved");
  });
  t.after(() => Promise.all([origin.close(), destination.close()]));
  const home = sandbox(t);
  await addProviderProfile(profile(origin.baseUrl), { home });

  const redirected = await refreshProviderModels({
    home,
    providerId: "lab",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(redirected.ok, false);
  assert.match(redirected.error, /HTTP 302/);
  assert.equal(destination.requests.length, 0);

  const missing = await refreshProviderModels({ home, providerId: "lab", env: {} });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /requires env LAB_API_KEY/);
  assert.equal(origin.requests.length, 1);

  const unknown = await refreshProviderModels({
    home,
    providerId: "absent",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown provider/);
});

test("configuration changes invalidate the snapshot instead of retargeting it", async (t) => {
  const server = await startServer((req, res) => json(res, { data: [{ id: "vendor/first" }] }));
  t.after(() => server.close());
  const home = sandbox(t);
  await addProviderProfile(profile(server.baseUrl), { home });
  await refreshProviderModels({ home, providerId: "lab", env: { LAB_API_KEY: KEY } });

  const loaded = loadProviderConfig({ home });
  assert.ok(readDiscoveryCache(home, loaded.config.providers[0]));

  // Same provider id, different base URL: the old digest must not be reused.
  await replaceProviderProfile("lab", profile("https://other.example"), { home });
  const changed = loadProviderConfig({ home });
  assert.equal(readDiscoveryCache(home, changed.config.providers[0]), null);
  assert.equal(
    buildProviderCatalog({ home }).entries.some((e) => e.source === "discovered"),
    false,
  );

  assert.equal(clearDiscoveryCache(home, "lab"), true);
});

test("discovery error bodies never echo a credential in any encoding", async (t) => {
  const key = "sk-discovery/leak+canary:7";
  const server = await startServer((req, res) => {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end(
      `bad key ${encodeURIComponent(key)} (${JSON.stringify(key).slice(1, -1)}) stale ${key.slice(0, 4)}`,
    );
  });
  t.after(() => server.close());
  const home = sandbox(t);
  await addProviderProfile(profile(server.baseUrl), { home });

  const result = await refreshProviderModels({
    home,
    providerId: "lab",
    env: { LAB_API_KEY: key },
  });
  assert.equal(result.ok, false);
  for (const form of [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]) {
    assert.equal(result.error.includes(form), false, `credential form leaked: ${result.error}`);
  }
  for (let index = 0; index + 4 <= key.length; index++) {
    assert.equal(result.error.includes(key.slice(index, index + 4)), false, "fragment leaked");
  }
});

test("a FIFO discovery cache cannot hang catalog loading", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example"), { home });
  const cacheDirectory = join(home, "provider-cache");
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const cachePath = discoveryCachePath(home, "lab");
  const fifo = spawnSync("mkfifo", [cachePath]);
  if (fifo.status !== 0) {
    // No mkfifo on this host: the symlink test below covers the no-follow rule.
    writeFileSync(cachePath, "");
  }

  const script = [
    `import { buildProviderCatalog } from ${JSON.stringify(pathToFileURL(join(PACKAGE_ROOT, "lib", "provider-catalog.mjs")).href)};`,
    "const catalog = buildProviderCatalog({ home: process.argv[1], env: { LAB_API_KEY: 'sk-child-canary' } });",
    "process.stdout.write(JSON.stringify(catalog.entries.map((entry) => entry.modelId)));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", script, home], {
    encoding: "utf8",
    timeout: 3000,
  });
  assert.equal(
    child.status,
    0,
    `catalog loading did not finish: ${child.error?.code ?? child.stderr ?? "unknown"}`,
  );
  assert.ok(JSON.parse(child.stdout).includes(MODEL), "configured models stay visible");
});

test("a symlinked discovery cache is treated as absent", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example"), { home });
  const loaded = loadProviderConfig({ home });
  const configured = loaded.config.providers[0];
  const cacheDirectory = join(home, "provider-cache");
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const cachePath = discoveryCachePath(home, "lab");
  const payload = {
    version: 1,
    providerId: "lab",
    digest: targetDigest(configured),
    generation: providerCacheGeneration(home, "lab"),
    fetchedAt: Date.now(),
    models: [{ id: "vendor/discovered" }],
  };

  writeFileSync(cachePath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  assert.ok(readDiscoveryCache(home, configured), "the payload is otherwise valid");

  const target = join(home, "snapshot.json");
  rmSync(cachePath);
  writeFileSync(target, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  symlinkSync(target, cachePath);
  assert.equal(readDiscoveryCache(home, configured), null);
});

test("an already-aborted caller cancels discovery with zero requests", async (t) => {
  const server = await startServer((req, res) => json(res, { data: [{ id: "vendor/late" }] }));
  t.after(() => server.close());
  const home = sandbox(t);
  await addProviderProfile(profile(server.baseUrl), { home });

  const controller = new AbortController();
  controller.abort();
  const result = await refreshProviderModels({
    home,
    providerId: "lab",
    env: { LAB_API_KEY: KEY },
    signal: controller.signal,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cancel/i);
  assert.equal(server.requests.length, 0);
  const configured = loadProviderConfig({ home }).config.providers[0];
  assert.equal(readDiscoveryCache(home, configured), null);
  assert.equal(readDiscoveryStatus(home, configured), null);
});

test("cancelling while the body is streaming preserves the prior snapshot", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example"), { home });
  const configured = loadProviderConfig({ home }).config.providers[0];
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(source) {
      source.enqueue(new TextEncoder().encode('{"data":[{"id":"vendor/late"}]'));
    },
  });
  const result = await refreshProviderModels({
    home,
    providerId: "lab",
    env: { LAB_API_KEY: KEY },
    signal: controller.signal,
    timeoutMs: 10_000,
    fetchImpl: async () => {
      setTimeout(() => controller.abort(), 10);
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cancel/i);
  assert.equal(readDiscoveryCache(home, configured), null);
});

test("cancellation after the bytes arrive never commits the refresh", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example"), { home });
  const configured = loadProviderConfig({ home }).config.providers[0];
  const controller = new AbortController();
  const result = await refreshProviderModels({
    home,
    providerId: "lab",
    env: { LAB_API_KEY: KEY },
    signal: controller.signal,
    fetchImpl: async () => {
      controller.abort();
      return new Response(JSON.stringify({ data: [{ id: "vendor/late" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cancel/i);
  assert.equal(readDiscoveryCache(home, configured), null, "the late model must not be committed");
  assert.equal(readDiscoveryStatus(home, configured), null);
});

test("a failed refresh stays visible in the rebuilt catalog until success", async (t) => {
  let fail = false;
  const server = await startServer((req, res) =>
    fail ? json(res, { error: "unavailable" }, 503) : json(res, { data: [{ id: "vendor/exact" }] }),
  );
  t.after(() => server.close());
  const home = sandbox(t);
  await addProviderProfile(profile(server.baseUrl), { home });
  const env = { LAB_API_KEY: KEY };

  const first = await refreshProviderModels({ home, providerId: "lab", env });
  assert.equal(first.ok, true);
  let catalog = buildProviderCatalog({ home, env });
  let discovered = catalog.entries.find((entry) => entry.source === "discovered");
  assert.equal(discovered.modelId, "vendor/exact");
  assert.equal(discovered.stale, false);
  assert.equal(typeof discovered.fetchedAt, "number");
  assert.equal(catalog.providers.find((entry) => entry.id === "lab").discovery.outcome, "ok");

  fail = true;
  const second = await refreshProviderModels({ home, providerId: "lab", env });
  assert.equal(second.ok, false);
  assert.equal(second.stale, true);
  assert.equal(second.models.length, 1, "the prior snapshot is preserved");

  // A rebuilt catalog (same files, no network) must not claim freshness.
  catalog = buildProviderCatalog({ home, env });
  const lab = catalog.providers.find((entry) => entry.id === "lab");
  assert.equal(lab.discovery.outcome, "error");
  assert.equal(lab.discovery.stale, true);
  assert.match(lab.discovery.error, /HTTP 503/);
  assert.equal(typeof lab.discovery.fetchedAt, "number");
  discovered = catalog.entries.find((entry) => entry.source === "discovered");
  assert.equal(discovered.stale, true);
  assert.equal(discovered.fetchedAt, lab.discovery.fetchedAt);
  assert.match(discovered.discoveryError, /HTTP 503/);
  assert.ok(findCatalogEntry(catalog, "lab", MODEL), "manual models survive a failed refresh");
  assert.equal(
    readDiscoveryCache(home, loadProviderConfig({ home }).config.providers[0]).models.length,
    1,
  );

  // A later success clears the error without changing configuration validity.
  fail = false;
  const third = await refreshProviderModels({ home, providerId: "lab", env });
  assert.equal(third.ok, true);
  catalog = buildProviderCatalog({ home, env });
  assert.equal(catalog.status, "valid");
  assert.equal(catalog.providers.find((entry) => entry.id === "lab").discovery.stale, false);
  assert.equal(catalog.providers.find((entry) => entry.id === "lab").discovery.error, null);
  assert.equal(catalog.entries.find((entry) => entry.source === "discovered").stale, false);
});

test("a snapshot without a generation is not promoted to fresh evidence", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example"), { home });
  const configured = loadProviderConfig({ home }).config.providers[0];
  const cacheDirectory = join(home, "provider-cache");
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  const fetchedAt = Date.now() - 60_000;
  writeFileSync(
    discoveryCachePath(home, "lab"),
    `${JSON.stringify({
      version: 1,
      providerId: "lab",
      digest: targetDigest(configured),
      fetchedAt,
      models: [{ id: "vendor/legacy" }],
    })}\n`,
    { mode: 0o600 },
  );

  const catalog = buildProviderCatalog({ home, env: { LAB_API_KEY: KEY } });
  const lab = catalog.providers.find((entry) => entry.id === "lab");
  assert.equal(lab.discovery, null);
  assert.equal(
    catalog.entries.some((entry) => entry.source === "discovered"),
    false,
  );
});

test("a body timeout leaves the rebuilt catalog stale, not fresh", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example"), { home });
  const env = { LAB_API_KEY: KEY };
  const okFetch = async () =>
    new Response(JSON.stringify({ data: [{ id: "vendor/exact" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const seeded = await refreshProviderModels({
    home,
    providerId: "lab",
    env,
    fetchImpl: okFetch,
    now: () => 1000,
  });
  assert.equal(seeded.ok, true);

  const stalled = new ReadableStream({
    start(source) {
      source.enqueue(new TextEncoder().encode('{"data":[{"id":"vendor/late"}]'));
    },
  });
  const timedOut = await refreshProviderModels({
    home,
    providerId: "lab",
    env,
    timeoutMs: 20,
    fetchImpl: async () =>
      new Response(stalled, { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /timed out/);
  assert.equal(timedOut.stale, true);
  assert.equal(timedOut.models[0].id, "vendor/exact", "the prior snapshot is preserved");

  const catalog = buildProviderCatalog({ home, env });
  const lab = catalog.providers.find((entry) => entry.id === "lab");
  assert.equal(lab.discovery.outcome, "error");
  assert.equal(lab.discovery.stale, true);
  assert.match(lab.discovery.error, /timed out/);
  assert.equal(lab.discovery.fetchedAt, 1000);
  const discovered = catalog.entries.find((entry) => entry.source === "discovered");
  assert.equal(discovered.modelId, "vendor/exact");
  assert.equal(discovered.stale, true);
  assert.match(discovered.discoveryError, /timed out/);

  const cleared = await refreshProviderModels({
    home,
    providerId: "lab",
    env,
    fetchImpl: okFetch,
    now: () => 2000,
  });
  assert.equal(cleared.ok, true);
  const rebuilt = buildProviderCatalog({ home, env });
  assert.equal(rebuilt.providers.find((entry) => entry.id === "lab").discovery.stale, false);
  assert.equal(rebuilt.providers.find((entry) => entry.id === "lab").discovery.fetchedAt, 2000);
});

test("a body read rejected by the deadline is recorded as a failed refresh", async (t) => {
  const home = sandbox(t);
  await addProviderProfile(profile("https://inference.example"), { home });
  const env = { LAB_API_KEY: KEY };
  const failedRefresh = await refreshProviderModels({
    home,
    providerId: "lab",
    env,
    timeoutMs: 10,
    fetchImpl: async (url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        getReader: () => ({
          read: () =>
            new Promise((resolve, reject) => {
              init.signal.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            }),
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    }),
  });
  assert.equal(failedRefresh.ok, false);
  assert.match(failedRefresh.error, /timed out|cancelled/);

  const catalog = buildProviderCatalog({ home, env });
  const lab = catalog.providers.find((entry) => entry.id === "lab");
  assert.equal(lab.discovery.outcome, "error");
  assert.equal(lab.discovery.stale, true);
});
