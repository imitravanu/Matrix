import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  acquireProviderConfigLock,
  addProviderModel,
  addProviderProfile,
  loadProviderConfig,
  providerConfigPath,
  releaseProviderConfigLock,
  removeProviderModel,
  removeProviderProfile,
  replaceProviderProfile,
} from "../lib/provider-config.mjs";
import {
  PROVIDER_LIMITS,
  ProviderError,
  configurationDigest,
  resolveProviderSelection,
} from "../lib/provider-contracts.mjs";
import { PACKAGE_ROOT, makeTempDir } from "./helpers.mjs";

const CONFIG_MODULE = pathToFileURL(join(PACKAGE_ROOT, "lib", "provider-config.mjs")).href;
const API_KEY = "sk-config-canary-never-persisted";

function profile(id = "lab", overrides = {}) {
  return {
    id,
    name: "Lab inference",
    baseUrl: "https://inference.example/v1",
    auth: { type: "bearer", env: "LAB_API_KEY" },
    defaultModel: "vendor/Model-X:latest",
    models: [{ id: "vendor/Model-X:latest", capabilities: { tools: "supported" } }],
    ...overrides,
  };
}

function sandbox(t) {
  const root = makeTempDir("matrix-provider-config-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home: join(root, "home"), env: { LAB_API_KEY: API_KEY } };
}

async function expectCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.ok(error instanceof ProviderError, `expected ProviderError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

function bytes(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

test("a missing file is an empty configuration, not an error", (t) => {
  const { home } = sandbox(t);
  const loaded = loadProviderConfig({ home });
  assert.equal(loaded.status, "missing");
  assert.equal(loaded.path, providerConfigPath(home));
  assert.deepEqual(loaded.config, { schemaVersion: 1, providers: [] });
  assert.equal(loaded.error, null);
  assert.equal(loaded.digest, configurationDigest(loaded.config));
  assert.deepEqual(resolveProviderSelection({ config: loaded.config }).target.kind, "local");
});

test("add writes a private regular file and persists only the env reference", async (t) => {
  const { home, env } = sandbox(t);
  const result = await addProviderProfile(profile(), { home });

  const path = providerConfigPath(home);
  assert.equal(result.path, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(home)).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).isFile(), true);

  const raw = readFileSync(path, "utf8");
  assert.equal(raw.includes(API_KEY), false);
  assert.equal(raw.includes("LAB_API_KEY"), true);
  assert.equal(raw.endsWith("\n"), true);

  const loaded = loadProviderConfig({ home });
  assert.equal(loaded.status, "valid");
  assert.equal(loaded.digest, configurationDigest(loaded.config));
  assert.equal(loaded.config.providers[0].id, "lab");
  assert.equal(loaded.config.providers[0].baseUrl, "https://inference.example/v1");
  assert.equal(env.LAB_API_KEY, API_KEY);
});

test("duplicate adds and stale replacements never overwrite the prior bytes", async (t) => {
  const { home } = sandbox(t);
  await addProviderProfile(profile(), { home });
  const before = bytes(providerConfigPath(home));
  const digest = loadProviderConfig({ home }).digest;

  await expectCode(() => addProviderProfile(profile(), { home }), "PROVIDER_DUPLICATE");
  assert.equal(bytes(providerConfigPath(home)), before);

  await expectCode(
    () =>
      replaceProviderProfile("lab", profile("lab", { baseUrl: "https://evil.example/v1" }), {
        home,
        expectedDigest: "0".repeat(64),
      }),
    "CONFIG_CONFLICT",
  );
  assert.equal(bytes(providerConfigPath(home)), before);

  await replaceProviderProfile("lab", profile("lab", { baseUrl: "https://other.example/v2" }), {
    home,
    expectedDigest: digest,
  });
  const replaced = loadProviderConfig({ home });
  assert.equal(replaced.status, "valid");
  assert.equal(replaced.config.providers[0].baseUrl, "https://other.example/v2");
  assert.notEqual(replaced.digest, digest);
});

test("profile mutation requires an exact id and refuses unknown targets", async (t) => {
  const { home } = sandbox(t);
  await addProviderProfile(profile(), { home });

  await expectCode(
    () => replaceProviderProfile("lab", profile("renamed"), { home }),
    "CONFIG_INVALID",
  );
  await expectCode(
    () => replaceProviderProfile("missing", profile("missing"), { home }),
    "PROVIDER_UNKNOWN",
  );
  await expectCode(() => removeProviderProfile("missing", { home }), "PROVIDER_UNKNOWN");

  await removeProviderProfile("lab", { home });
  const loaded = loadProviderConfig({ home });
  assert.equal(loaded.status, "valid");
  assert.deepEqual(loaded.config.providers, []);
  assert.equal(loaded.digest, configurationDigest(loaded.config));
});

test("manual models are added and removed by exact wire id", async (t) => {
  const { home } = sandbox(t);
  await addProviderProfile(profile(), { home });

  await addProviderModel("lab", { id: "Vendor/Other-M:free", name: "Other M" }, { home });
  let loaded = loadProviderConfig({ home });
  assert.deepEqual(
    loaded.config.providers[0].models.map((model) => model.id),
    ["vendor/Model-X:latest", "Vendor/Other-M:free"],
  );
  assert.deepEqual(loaded.config.providers[0].models[1].capabilities, { tools: "unknown" });

  await expectCode(
    () => addProviderModel("lab", { id: "Vendor/Other-M:free" }, { home }),
    "PROVIDER_DUPLICATE_MODEL",
  );
  await expectCode(
    () => addProviderModel("missing", { id: "m/one" }, { home }),
    "PROVIDER_UNKNOWN",
  );

  await removeProviderModel("lab", "Vendor/Other-M:free", { home });
  loaded = loadProviderConfig({ home });
  assert.deepEqual(
    loaded.config.providers[0].models.map((model) => model.id),
    ["vendor/Model-X:latest"],
  );
  await expectCode(
    () => removeProviderModel("lab", "Vendor/Other-M:free", { home }),
    "PROVIDER_UNKNOWN",
  );
});

test("a corrupt file is reported without blocking Local Forge, but never mutated", async (t) => {
  const { home } = sandbox(t);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = providerConfigPath(home);
  writeFileSync(path, '{"schemaVersion": 1, "providers": [', { mode: 0o600 });
  const before = readFileSync(path, "utf8");

  const loaded = loadProviderConfig({ home });
  assert.equal(loaded.status, "invalid");
  assert.equal(loaded.error.code, "CONFIG_INVALID_JSON");
  assert.equal(loaded.digest, null);
  assert.deepEqual(loaded.config.providers, []);
  assert.equal(resolveProviderSelection({ config: loaded.config }).target.kind, "local");

  await expectCode(() => addProviderProfile(profile(), { home }), "CONFIG_INVALID_JSON");
  assert.equal(readFileSync(path, "utf8"), before);

  writeFileSync(path, JSON.stringify({ schemaVersion: 99, providers: [] }), { mode: 0o600 });
  const unsupported = loadProviderConfig({ home });
  assert.equal(unsupported.status, "invalid");
  assert.equal(unsupported.error.code, "CONFIG_UNSUPPORTED_SCHEMA");

  writeFileSync(path, JSON.stringify({ schemaVersion: 1, providers: [], extra: 1 }), {
    mode: 0o600,
  });
  assert.equal(loadProviderConfig({ home }).error.code, "CONFIG_INVALID");
});

test("oversized and symlinked configuration targets are refused unread", async (t) => {
  const { home } = sandbox(t);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = providerConfigPath(home);

  writeFileSync(path, "x".repeat(PROVIDER_LIMITS.configBytes + 1), { mode: 0o600 });
  const large = loadProviderConfig({ home });
  assert.equal(large.status, "invalid");
  assert.equal(large.error.code, "CONFIG_TOO_LARGE");
  await expectCode(() => addProviderProfile(profile(), { home }), "CONFIG_TOO_LARGE");

  rmSync(path);
  const target = join(home, "target.json");
  writeFileSync(target, JSON.stringify({ schemaVersion: 1, providers: [] }), { mode: 0o600 });
  symlinkSync(target, path);
  const linked = loadProviderConfig({ home });
  assert.equal(linked.status, "invalid");
  assert.equal(linked.error.code, "CONFIG_SYMLINK");
  await expectCode(() => addProviderProfile(profile(), { home }), "CONFIG_SYMLINK");
  assert.equal(readFileSync(target, "utf8").includes('"providers":[]'), true);

  rmSync(path);
  rmSync(target);
  mkdirSync(path, { recursive: true });
  const directory = loadProviderConfig({ home });
  assert.equal(directory.status, "invalid");
  assert.equal(directory.error.code, "CONFIG_NOT_REGULAR");
  await expectCode(() => addProviderProfile(profile(), { home }), "CONFIG_NOT_REGULAR");
});

test("a mutation that would exceed the persisted byte limit keeps the prior bytes", async (t) => {
  const { home } = sandbox(t);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = providerConfigPath(home);
  const smallModels = Array.from({ length: 256 }, (_, index) => ({ id: `vendor/m-${index}` }));
  const seeded = {
    schemaVersion: 1,
    providers: [
      {
        id: "seed",
        baseUrl: "https://inference.example/v1",
        auth: { type: "none" },
        models: smallModels,
      },
    ],
  };
  writeFileSync(path, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 });
  assert.equal(loadProviderConfig({ home }).status, "valid");

  const largeModels = Array.from({ length: 256 }, (_, index) => ({
    id: `vendor/large-${index}-${"z".repeat(400)}`,
    name: `Large model ${index}`,
  }));
  let added = 0;
  for (;;) {
    const snapshot = readFileSync(path, "utf8");
    const next = {
      id: `large-${added}`,
      baseUrl: "https://inference.example/v1",
      auth: { type: "none" },
      models: largeModels,
    };
    try {
      await addProviderProfile(next, { home });
      added++;
      assert.ok(added < 64, "the byte limit must be reached before the profile count");
    } catch (error) {
      assert.equal(error.code, "CONFIG_TOO_LARGE", error.message);
      assert.equal(readFileSync(path, "utf8"), snapshot, "a refused write must not touch the file");
      assert.equal(loadProviderConfig({ home }).status, "valid");
      break;
    }
  }
  assert.ok(added > 0);
});

test("a live kernel lock blocks mutation and is released only by its owner", async (t) => {
  const { root, home } = sandbox(t);
  const holder = join(root, "hold-lock.mjs");
  writeFileSync(
    holder,
    [
      `import { acquireProviderConfigLock, releaseProviderConfigLock } from ${JSON.stringify(CONFIG_MODULE)};`,
      "const lock = await acquireProviderConfigLock({ home: process.argv[2], lockTimeoutMs: 5000 });",
      'process.stdout.write("locked:" + lock.kind + "\\n");',
      "process.stdin.resume();",
      "process.stdin.on('end', async () => { await releaseProviderConfigLock(lock); process.exit(0); });",
    ].join("\n"),
  );

  const child = spawn(process.execPath, [holder, home], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    child.stdin.end();
    child.kill("SIGKILL");
  });
  const ready = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("locked:")) resolve(output.trim());
    });
    child.once("error", reject);
    child.once("close", (code) => reject(new Error(`holder exited early (${code}): ${output}`)));
  });
  assert.equal(ready, "locked:kernel");

  await expectCode(
    () => addProviderProfile(profile(), { home, lockTimeoutMs: 60 }),
    "CONFIG_LOCKED",
  );
  assert.equal(bytes(providerConfigPath(home)), null);

  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  await addProviderProfile(profile(), { home, lockTimeoutMs: 2000 });
  assert.equal(loadProviderConfig({ home }).status, "valid");
});

test("a process that dies holding the kernel lock releases it immediately", async (t) => {
  const { root, home } = sandbox(t);
  const runner = join(root, "crash-lock.mjs");
  writeFileSync(
    runner,
    [
      `import { acquireProviderConfigLock } from ${JSON.stringify(CONFIG_MODULE)};`,
      "const lock = await acquireProviderConfigLock({ home: process.argv[2] });",
      'process.stdout.write("locked:" + lock.kind);',
      "process.exit(0);",
    ].join("\n"),
  );

  const crashed = spawnSync(process.execPath, [runner, home], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(crashed.status, 0, crashed.stderr);
  assert.match(crashed.stdout, /^locked:kernel$/);

  const started = Date.now();
  await addProviderProfile(profile(), { home, lockTimeoutMs: 2000 });
  assert.ok(Date.now() - started < 1500, "a dead owner must not hold the lock for a timeout");
  const loaded = loadProviderConfig({ home });
  assert.equal(loaded.status, "valid");
  assert.equal(loaded.config.providers[0].id, "lab");
});

test("concurrent writers serialize without losing either configuration", async (t) => {
  const { root, home } = sandbox(t);
  const runner = join(root, "add-provider.mjs");
  writeFileSync(
    runner,
    [
      `import { addProviderProfile } from ${JSON.stringify(CONFIG_MODULE)};`,
      "const [, , home, id] = process.argv;",
      `await addProviderProfile({`,
      "  id,",
      '  baseUrl: "https://" + id + ".example/v1",',
      '  auth: { type: "none" },',
      '  models: [{ id: "m/" + id }],',
      "}, { home, lockTimeoutMs: 10_000 });",
      'process.stdout.write("added:" + id);',
    ].join("\n"),
  );

  const run = (id) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runner, home, id], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    });

  const results = await Promise.all([run("alpha"), run("beta")]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);

  const loaded = loadProviderConfig({ home });
  assert.equal(loaded.status, "valid");
  assert.deepEqual(loaded.config.providers.map((entry) => entry.id).sort(), ["alpha", "beta"]);
  assert.equal(loaded.digest, configurationDigest(loaded.config));
});

test("our own lock is token-checked and reacquirable after release", async (t) => {
  const { home } = sandbox(t);
  const lock = await acquireProviderConfigLock({ home, lockTimeoutMs: 100 });
  assert.equal(lock.kind, "kernel");

  await expectCode(() => acquireProviderConfigLock({ home, lockTimeoutMs: 30 }), "CONFIG_LOCKED");
  assert.equal(await releaseProviderConfigLock({ ...lock, token: "not-ours" }), false);
  assert.equal(await releaseProviderConfigLock(lock), true);
  assert.equal(await releaseProviderConfigLock(lock), false);

  const relocked = await acquireProviderConfigLock({ home, lockTimeoutMs: 100 });
  assert.equal(await releaseProviderConfigLock(relocked), true);
});

test("the directory fallback never steals a dead owner's lock", async (t) => {
  const { home } = sandbox(t);
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 10_000 });
  assert.equal(child.status, 0);

  const lockDir = `${providerConfigPath(home)}.lock`;
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(lockDir, "owner.json"),
    JSON.stringify({ v: 1, pid: child.pid, token: "dead-token", at: Date.now() }),
    { mode: 0o600 },
  );

  await expectCode(
    () => addProviderProfile(profile(), { home, lockTimeoutMs: 80, lockStrategy: "directory" }),
    "CONFIG_LOCKED",
  );
  assert.equal(existsSync(lockDir), true, "a stale lock directory must never be reclaimed");
  assert.equal(bytes(providerConfigPath(home)), null);

  // Recovery is an explicit operator action, never an automatic rename.
  rmSync(lockDir, { recursive: true, force: true });

  const lock = await acquireProviderConfigLock({
    home,
    lockTimeoutMs: 100,
    strategy: "directory",
  });
  assert.equal(lock.kind, "directory");
  assert.equal(lock.lockDir, lockDir);
  assert.equal(await releaseProviderConfigLock({ ...lock, token: "not-ours" }), false);
  assert.equal(await releaseProviderConfigLock(lock), true);
  assert.equal(existsSync(lockDir), false);

  await addProviderProfile(profile(), { home, lockTimeoutMs: 2000 });
  assert.equal(loadProviderConfig({ home }).status, "valid");
});

test("unknown lock strategies are rejected instead of guessing", async (t) => {
  const { home } = sandbox(t);
  await expectCode(
    () => acquireProviderConfigLock({ home, strategy: "guess", lockTimeoutMs: 10 }),
    "CONFIG_INVALID",
  );
});

test("a paused kernel lock owner still excludes other writers", async (t) => {
  const { root, home } = sandbox(t);
  const holder = join(root, "paused-lock.mjs");
  writeFileSync(
    holder,
    [
      `import { acquireProviderConfigLock, releaseProviderConfigLock } from ${JSON.stringify(CONFIG_MODULE)};`,
      "const lock = await acquireProviderConfigLock({ home: process.argv[2], lockTimeoutMs: 5000 });",
      'process.stdout.write("locked\\n");',
      "process.stdin.resume();",
      "process.stdin.on('end', async () => { await releaseProviderConfigLock(lock); process.exit(0); });",
    ].join("\n"),
  );
  const child = spawn(process.execPath, [holder, home], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => {
    child.stdin.end();
    child.kill("SIGKILL");
  });
  await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.once("data", resolve);
    child.once("error", reject);
  });

  process.kill(child.pid, "SIGSTOP");
  try {
    await expectCode(
      () => addProviderProfile(profile(), { home, lockTimeoutMs: 80 }),
      "CONFIG_LOCKED",
    );
    assert.equal(bytes(providerConfigPath(home)), null);
  } finally {
    process.kill(child.pid, "SIGCONT");
  }

  child.stdin.end();
  await new Promise((resolve) => child.once("close", resolve));
  await addProviderProfile(profile(), { home, lockTimeoutMs: 2000 });
  assert.equal(loadProviderConfig({ home }).status, "valid");
});

test("real and symlinked homes share one lock and never lose an update", async (t) => {
  const { root, home } = sandbox(t);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const alias = join(root, "home-alias");
  symlinkSync(home, alias, "dir");

  const lock = await acquireProviderConfigLock({ home, lockTimeoutMs: 100 });
  await expectCode(
    () => acquireProviderConfigLock({ home: alias, lockTimeoutMs: 60 }),
    "CONFIG_LOCKED",
  );
  assert.equal(await releaseProviderConfigLock(lock), true);

  const runner = join(root, "add-through-home.mjs");
  writeFileSync(
    runner,
    [
      `import { addProviderProfile } from ${JSON.stringify(CONFIG_MODULE)};`,
      "const [, , home, id] = process.argv;",
      "await addProviderProfile({",
      "  id,",
      '  baseUrl: "https://" + id + ".example/v1",',
      '  auth: { type: "none" },',
      '  models: [{ id: "m/" + id }],',
      "}, { home, lockTimeoutMs: 10_000 });",
    ].join("\n"),
  );

  const run = (target, id) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runner, target, id], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    });

  const results = await Promise.all([run(home, "real"), run(alias, "aliased")]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);

  const loaded = loadProviderConfig({ home });
  assert.equal(loaded.status, "valid");
  assert.deepEqual(loaded.config.providers.map((entry) => entry.id).sort(), ["aliased", "real"]);
});
