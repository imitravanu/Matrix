import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runDoctor, formatDoctor } from "../lib/doctor.mjs";
import { addProviderProfile, providerConfigPath } from "../lib/provider-config.mjs";
import { installFetchTrap, makeTempDir } from "./helpers.mjs";

test("doctor reports per-provider credential presence and invalid configuration without network or secrets", async (t) => {
  const root = makeTempDir("matrix-doctor-providers-");
  const home = join(root, "home");
  const trap = installFetchTrap();
  t.after(() => {
    trap.restore();
    rmSync(root, { recursive: true, force: true });
  });
  for (const profile of [
    {
      id: "ready",
      baseUrl: "https://ready.example/v1",
      auth: { type: "bearer", env: "READY_KEY" },
    },
    {
      id: "missing",
      baseUrl: "https://missing.example/v1",
      auth: { type: "bearer", env: "MISSING_KEY" },
    },
    { id: "anonymous", baseUrl: "https://anon.example/v1", auth: { type: "none" } },
  ])
    await addProviderProfile(profile, { home });

  const key = "fake-doctor-canary-secret";
  const options = {
    cwd: root,
    env: { MATRIX_HOME: home, READY_KEY: key },
    stdout: { isTTY: false },
  };
  const report = runDoctor(options);
  assert.equal(report.checks.find((check) => check.name === "provider-config").status, "ok");
  assert.equal(report.checks.find((check) => check.name === "provider:ready").status, "ok");
  assert.equal(report.checks.find((check) => check.name === "provider:missing").status, "warn");
  assert.equal(report.checks.find((check) => check.name === "provider:anonymous").status, "ok");
  assert.equal(JSON.stringify(report).includes(key), false);
  assert.equal(formatDoctor(report, { color: false }).includes(key), false);

  writeFileSync(providerConfigPath(home), "{invalid");
  const invalid = runDoctor(options);
  assert.equal(invalid.checks.find((check) => check.name === "provider-config").status, "warn");
  assert.equal(
    invalid.checks.some((check) => check.name.startsWith("provider:")),
    false,
  );
  assert.equal(trap.calls.length, 0);
});
