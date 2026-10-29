import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureManifest, captureManifestEntry } from "../lib/isolated-manifest.mjs";
import {
  integrationIntentFingerprint,
  reconcileIntegrationIntent,
  writeIntegrationIntent,
} from "../lib/integration-intent.mjs";
import { loadSession, recoverIntegrationSession, saveSession } from "../lib/session.mjs";
import { createRunController } from "../lib/controller.mjs";
import { makeTempDir } from "./helpers.mjs";

function fixture(t) {
  const parent = makeTempDir("matrix-reconcile-");
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "workspace");
  const home = join(parent, "home");
  mkdirSync(root);
  writeFileSync(join(root, "first.txt"), "base\r\n", { mode: 0o751 });
  writeFileSync(join(root, "second.txt"), "two\n");
  const baseManifest = captureManifest(root);
  const agent = join(parent, "agent");
  cpSync(root, agent, { recursive: true });
  writeFileSync(join(agent, "first.txt"), "approved\r\n");
  writeFileSync(join(agent, "second.txt"), "second approved\n");
  writeFileSync(join(agent, "new.txt"), "created\n");
  const plan = {
    root,
    baseManifest,
    planHash: "c".repeat(64),
    batchId: "recovery-fixture",
    integrationRunId: "integration-recovery-fixture",
    createdAt: 1700000000000,
    entries: ["first.txt", "second.txt", "new.txt"].map((path) => ({
      path,
      before: captureManifestEntry(root, path),
      after: captureManifestEntry(agent, path),
      workspaceRoot: agent,
    })),
  };
  const intent = writeIntegrationIntent(plan);
  return { parent, root, home, intent };
}

test("recovery reconstructs partial exact undo including creations and survives a second reopen", (t) => {
  const f = fixture(t);
  assert.equal(reconcileIntegrationIntent(f.intent.path).recoveryStatus, "not-started");
  writeFileSync(join(f.root, "first.txt"), "approved\r\n");
  writeFileSync(join(f.root, "new.txt"), "created\n");
  const recovered = recoverIntegrationSession(f.intent.path, { home: f.home });
  assert.equal(recovered.recoveryStatus, "partial");
  assert.equal(recovered.undoEntries, 2);
  const session = loadSession(recovered.sessionId, { home: f.home, cwd: f.root });
  assert.equal(session.undoRun.entries[0].original, "base\r\n");
  const controller = createRunController({ home: f.home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(session.undoRun, { root: f.root }), true);
  assert.equal(controller.undoLast().ok, true);
  assert.equal(readFileSync(join(f.root, "first.txt"), "utf8"), "base\r\n");
  const reloaded = loadSession(recovered.sessionId, { home: f.home, cwd: f.root });
  assert.equal(reloaded.integrationRecovery, "not-started");
  assert.equal(reloaded.undoRun, null);
});

test("recovery never offers a stale prefix when any file diverges", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "first.txt"), "approved\r\n");
  const recovered = recoverIntegrationSession(f.intent.path, { home: f.home });
  writeFileSync(join(f.root, "second.txt"), "external edit\n");
  assert.throws(() => recoverIntegrationSession(f.intent.path, { home: f.home }), /diverged/);
  const warnings = [];
  const session = loadSession(recovered.sessionId, {
    home: f.home,
    cwd: f.root,
    onWarning: (warning) => warnings.push(warning),
  });
  assert.equal(session.undoRun, null);
  assert.equal(session.integrationRecovery, "refused");
  assert.equal(warnings[0].code, "integration-recovery-refused");
  assert.equal(readFileSync(join(f.root, "second.txt"), "utf8"), "external edit\n");
});

test("recovery refuses a copied replacement root even when file bytes match", (t) => {
  const f = fixture(t);
  renameSync(f.root, join(f.parent, "moved"));
  cpSync(join(f.parent, "moved"), f.root, { recursive: true });
  assert.throws(() => reconcileIntegrationIntent(f.intent.path), /identity changed/);
});

test("recovery with a missing or truncated intent cannot expose stale undo", (t) => {
  const f = fixture(t);
  const saved = saveSession(
    {
      id: "pending",
      cwd: f.root,
      integrationIntent: f.intent.path,
      integrationIntentFingerprint: f.intent.fingerprint,
      undoRun: { version: 1, runId: "integration-stale", entries: [{ file: "wrong" }] },
    },
    { home: f.home },
  );
  assert.equal(saved.ok, true);
  writeFileSync(f.intent.path, '{"record":');
  assert.equal(loadSession("pending", { home: f.home }).undoRun, null);
  rmSync(f.intent.path);
  assert.equal(loadSession("pending", { home: f.home }).integrationRecovery, "refused");
});

test("a recomputed checksum cannot change the intent bound to an existing session", (t) => {
  const f = fixture(t);
  const recovered = recoverIntegrationSession(f.intent.path, { home: f.home });
  const envelope = JSON.parse(readFileSync(f.intent.path, "utf8"));
  envelope.record.createdAt += 1000;
  envelope.checksum = integrationIntentFingerprint(envelope.record);
  writeFileSync(f.intent.path, JSON.stringify(envelope));
  const session = loadSession(recovered.sessionId, { home: f.home });
  assert.equal(session.integrationRecovery, "refused");
  assert.equal(session.undoRun, null);
});
