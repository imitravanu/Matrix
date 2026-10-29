import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { createIntegrationWorkspace } from "../lib/integration-workspace.mjs";
import { captureManifest } from "../lib/isolated-manifest.mjs";
import { makeTempDir } from "./helpers.mjs";

test("integration snapshot matches its base and is independent of the original", (t) => {
  const parent = makeTempDir("matrix-integration-workspace-");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "source");
  const scratchDir = join(parent, "results");
  mkdirSync(root);
  writeFileSync(join(root, "file.txt"), "base\n", { mode: 0o751 });
  const baseManifest = captureManifest(root);
  const workspace = createIntegrationWorkspace({ root, baseManifest, scratchDir });
  assert.equal(statSync(join(workspace.root, "file.txt")).mode & 0o777, 0o751);
  writeFileSync(join(root, "file.txt"), "external\n");
  writeFileSync(join(workspace.root, "file.txt"), "approved\n");
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "external\n");
  assert.equal(readFileSync(join(workspace.root, "file.txt"), "utf8"), "approved\n");
  assert.equal(workspace.cleanup().ok, true);
  assert.equal(existsSync(workspace.root), false);
});

test("integration snapshot refuses a base containing an omitted sensitive file", (t) => {
  const parent = makeTempDir("matrix-integration-workspace-omission-");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "source");
  const scratchDir = join(parent, "results");
  mkdirSync(root);
  writeFileSync(join(root, ".env"), "fixture-only\n");
  const baseManifest = captureManifest(root);
  assert.throws(
    () => createIntegrationWorkspace({ root, baseManifest, scratchDir }),
    /does not match the base: .env/,
  );
  assert.deepEqual(readdirSync(scratchDir), []);
});

test("integration snapshot refuses drift and removes its incomplete copy", (t) => {
  const parent = makeTempDir("matrix-integration-workspace-drift-");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "source");
  const scratchDir = join(parent, "results");
  mkdirSync(root);
  writeFileSync(join(root, "file.txt"), "base\n");
  const baseManifest = captureManifest(root);
  writeFileSync(join(root, "file.txt"), "changed\n");
  assert.throws(
    () => createIntegrationWorkspace({ root, baseManifest, scratchDir }),
    /does not match the base: file.txt/,
  );
  assert.deepEqual(readdirSync(scratchDir), []);
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "changed\n");
});
