import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  appendRunEvent,
  backupFile,
  loadLatestSession,
  loadSession,
  matrixHome,
  newRunId,
  readBackup,
  removeBackup,
  saveSession,
  sessionsDir,
} from "../lib/session.mjs";
import { relativePath, resolveInside, writeFileAtomic } from "../lib/workspace.mjs";
import { makeTempDir } from "./helpers.mjs";

function tempHome(t) {
  const root = makeTempDir("matrix-home-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("saveSession, loadSession and loadLatestSession round-trip a transcript", (t) => {
  const home = tempHome(t);
  const cwd = "/tmp/example-workspace";
  const saved = saveSession(
    {
      id: "ses-test-1",
      cwd,
      project: { name: "example", fileCount: 2 },
      modelId: "local",
      history: [{ role: "user", content: "hello" }],
      tokenStats: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      metrics: { elapsedMs: 42 },
      lastPatch: { file: "a.py", patch: "x" },
    },
    { home, now: 1234 }
  );
  assert.equal(saved.id, "ses-test-1");
  assert.ok(saved.path.endsWith("ses-test-1.json"));
  const loaded = loadSession("ses-test-1", { home });
  assert.equal(loaded.cwd, cwd);
  assert.equal(loaded.history[0].content, "hello");
  assert.equal(loaded.savedAt, 1234);
  assert.equal(loadSession("missing", { home }), null);
  assert.equal(loadSession("ses-test-1", { home, cwd })?.id, "ses-test-1");
  assert.equal(loadSession("ses-test-1", { home, cwd: "/tmp/other-workspace" }), null);
  assert.equal(loadSession("../ses-test-1", { home }), null);
  assert.equal(loadSession("..", { home }), null);
  assert.equal(loadLatestSession(cwd, { home })?.id, "ses-test-1");
  assert.equal(loadLatestSession("/tmp/other", { home }), null);
});

test("listSessions sorts newest first and ignores corrupt records", async (t) => {
  const home = tempHome(t);
  saveSession({ id: "old", cwd: "/tmp/a", history: [] }, { home, now: 1000 });
  saveSession({ id: "new", cwd: "/tmp/b", history: [{ role: "user", content: "x" }] }, { home, now: 2000 });
  writeFileSync(join(sessionsDir(home), "corrupt.json"), "{ nope");
  const list = await awaitList(home);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "new");
  assert.equal(list[1].id, "old");
  assert.equal(list[0].messages, 1);
});

function awaitList(home) {
  // listSessions is synchronous; this wrapper keeps the test readable.
  return import("../lib/session.mjs").then(({ listSessions }) => listSessions({ home }));
}

test("backupFile stores exact bytes, backups are private, and remove is safe", (t) => {
  const root = tempHome(t);
  const file = join(root, "source.py");
  writeFileSync(file, "original\n");
  chmodSync(file, 0o640);
  const backup = backupFile(file, { home: root });
  assert.ok(backup.path);
  assert.equal(backup.size, 9);
  assert.equal((statSync(backup.path).mode & 0o777).toString(8), "600");
  assert.equal(readBackup(backup.path).content.toString(), "original\n");
  removeBackup(backup.path);
  assert.equal(readBackup(backup.path).ok, false);
  assert.equal(backupFile(join(root, "missing"), { home: root }), null);
});

test("appendRunEvent writes one valid JSON object per line and never throws", (t) => {
  const home = tempHome(t);
  const file = appendRunEvent("run-1", { type: "proposal", file: "x.py" }, { home });
  appendRunEvent("run-1", { type: "applied", file: "x.py" }, { home });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, "proposal");
  assert.equal(JSON.parse(lines[1]).type, "applied");
  assert.equal(appendRunEvent("run-2", { type: "x", fn: () => {} }, { home }).endsWith(".jsonl"), true);
});

test("newRunId and matrixHome are stable, safe strings", () => {
  assert.match(newRunId(0), /^19700101000000-[0-9a-f]{6}$/);
  assert.equal(matrixHome("/tmp/example"), "/tmp/example");
  assert.match(matrixHome(), /[\\/]\.matrix$/);
});

test("resolveInside allows descendants and rejects traversal, absolute escapes and symlinks", (t) => {
  const root = tempHome(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.py"), "x\n");
  const inside = resolveInside(root, "src/a.py");
  assert.equal(inside.ok, true);
  assert.equal(inside.rel, "src/a.py");
  assert.equal(resolveInside(root, "./src/../src/a.py").ok, true);
  assert.equal(resolveInside(root, "../outside.py").ok, false);
  assert.equal(resolveInside(root, "/etc/passwd").ok, false);
  symlinkSync("/etc/passwd", join(root, "escape"));
  assert.equal(resolveInside(root, "escape").ok, false);
  assert.equal(resolveInside(root, "").ok, false);
});

test("writeFileAtomic preserves an existing mode and leaves no temp files", (t) => {
  const root = tempHome(t);
  const file = join(root, "a.txt");
  writeFileSync(file, "old");
  chmodSync(file, 0o640);
  writeFileAtomic(file, "new");
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.equal((statSync(file).mode & 0o777).toString(8), "640");
  assert.deepEqual(readdirSync(root).filter((name) => name.includes(".tmp")), []);
  assert.equal(relativePath(root, file), "a.txt");
});
