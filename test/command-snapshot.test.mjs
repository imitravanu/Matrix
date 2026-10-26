import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from "../lib/linux-snapshot.mjs";
import { makeTempDir } from "./helpers.mjs";

function fixture(t) {
  const root = makeTempDir("matrix-command-snapshot-");
  const workspace = join(root, "workspace");
  const scratch = join(root, "scratch");
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, scratch };
}

test("snapshot omits sensitive/VCS/Matrix paths, preserves modes and symlinks, and breaks hardlinks", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, "tool.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o751 });
  chmodSync(join(f.workspace, "tool.sh"), 0o751);
  writeFileSync(join(f.workspace, "sentinel.txt"), "live-original");
  linkSync(join(f.workspace, "sentinel.txt"), join(f.workspace, "hardlink.txt"));
  symlinkSync("sentinel.txt", join(f.workspace, "relative-link"));
  symlinkSync("../outside.txt", join(f.workspace, "escape-link"));
  for (const directory of [".git", ".matrix", ".ssh", "nested/.matrix"]) {
    mkdirSync(join(f.workspace, directory), { recursive: true });
    writeFileSync(join(f.workspace, directory, "canary.txt"), "do-not-copy");
  }
  writeFileSync(join(f.workspace, ".env"), "CANARY=do-not-copy");
  writeFileSync(join(f.workspace, "credentials.json"), '{"canary":"do-not-copy"}');

  const snapshot = createWorkspaceSnapshot(f.workspace, {
    scratchDir: f.scratch,
    matrixHome: join(f.workspace, "nested", ".matrix"),
  });
  assert.equal(statSync(join(snapshot.workspacePath, "tool.sh")).mode & 0o777, 0o751);
  assert.equal(readlinkSync(join(snapshot.workspacePath, "relative-link")), "sentinel.txt");
  assert.equal(readlinkSync(join(snapshot.workspacePath, "escape-link")), "../outside.txt");
  for (const omitted of [".git", ".matrix", ".ssh", ".env", "credentials.json", "nested/.matrix"]) {
    assert.equal(existsSync(join(snapshot.workspacePath, omitted)), false, omitted);
  }
  assert.notEqual(
    statSync(join(snapshot.workspacePath, "hardlink.txt")).ino,
    statSync(join(f.workspace, "sentinel.txt")).ino,
  );
  writeFileSync(join(snapshot.workspacePath, "hardlink.txt"), "snapshot-only");
  assert.equal(readFileSync(join(f.workspace, "sentinel.txt"), "utf8"), "live-original");
  assert.equal(readFileSync(join(f.workspace, "hardlink.txt"), "utf8"), "live-original");
  assert.ok(snapshot.stats.omittedEntries >= 5);
  assert.equal(cleanupWorkspaceSnapshot(snapshot).ok, true);
  assert.deepEqual(readdirSync(f.scratch), []);
});

test("snapshot bounds fail closed and clean every scratch resource", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, "too-large.txt"), "more-than-four-bytes");
  assert.throws(
    () => createWorkspaceSnapshot(f.workspace, { scratchDir: f.scratch, limits: { fileBytes: 4 } }),
    /byte budget/,
  );
  assert.deepEqual(readdirSync(f.scratch), []);

  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      createWorkspaceSnapshot(f.workspace, { scratchDir: f.scratch, signal: controller.signal }),
    /aborted/,
  );
  assert.deepEqual(readdirSync(f.scratch), []);
});

test("cleanup restores removable directory modes without following symlinks", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, "locked"));
  writeFileSync(join(f.workspace, "locked", "file.txt"), "snapshot");
  symlinkSync(f.root, join(f.workspace, "root-link"));
  const snapshot = createWorkspaceSnapshot(f.workspace, { scratchDir: f.scratch });
  chmodSync(join(snapshot.workspacePath, "locked"), 0);
  assert.equal(cleanupWorkspaceSnapshot(snapshot).ok, true);
  assert.equal(existsSync(snapshot.root), false);
  assert.equal(lstatSync(join(f.workspace, "root-link")).isSymbolicLink(), true);
});
