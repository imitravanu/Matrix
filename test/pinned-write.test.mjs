import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writePinnedAtomic } from "../lib/pinned-write.mjs";
import { makeTempDir } from "./helpers.mjs";

test("pinned atomic writes preserve bytes and explicit mode", (t) => {
  const root = makeTempDir("matrix-pinned-write-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  writeFileSync(path, "old");
  writePinnedAtomic(path, Buffer.from("new\n"), 0o751);
  assert.equal(readFileSync(path, "utf8"), "new\n");
  assert.equal(statSync(path).mode & 0o777, 0o751);
  assert.deepEqual(readdirSync(root), ["file.txt"]);
});

test("pinned atomic write removes its temporary file when rename fails", (t) => {
  const root = makeTempDir("matrix-pinned-failure-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "directory");
  mkdirSync(path);
  assert.throws(() => writePinnedAtomic(path, "text", 0o644));
  assert.deepEqual(readdirSync(root), ["directory"]);
});

test("atomic creation refuses an existing target and cleans its temporary file", (t) => {
  const root = makeTempDir("matrix-pinned-create-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  writeFileSync(path, "concurrent content");
  assert.throws(() => writePinnedAtomic(path, "new content", 0o644, { createOnly: true }), {
    code: "EEXIST",
  });
  assert.equal(readFileSync(path, "utf8"), "concurrent content");
  assert.deepEqual(readdirSync(root), ["file.txt"]);
  rmSync(path);
  writePinnedAtomic(path, "created", 0o751, { createOnly: true });
  assert.equal(readFileSync(path, "utf8"), "created");
  assert.equal(statSync(path).mode & 0o777, 0o751);
  assert.deepEqual(readdirSync(root), ["file.txt"]);
});
