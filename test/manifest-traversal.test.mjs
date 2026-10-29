import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { makeTempDir } from "./helpers.mjs";

function runInstrumented(script, args) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("manifest traversal stays pinned when a directory is replaced by an outside symlink", (t) => {
  const root = makeTempDir("matrix-manifest-swap-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, "nested"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, "nested", "inside.txt"), "inside");
  writeFileSync(join(outside, "secret.txt"), "outside");
  const result = runInstrumented(
    `import fs from 'node:fs';
     import { syncBuiltinESMExports } from 'node:module';
     import { join } from 'node:path';
     const [workspace, outside] = process.argv.slice(1);
     const original = fs.opendirSync;
     let calls = 0;
     fs.opendirSync = function (...args) {
       if (++calls === 2) {
         fs.renameSync(join(workspace, 'nested'), join(workspace, 'moved'));
         fs.symlinkSync(outside, join(workspace, 'nested'));
       }
       return original.apply(this, args);
     };
     syncBuiltinESMExports();
     const { captureManifest } = await import('./lib/isolated-manifest.mjs');
     const manifest = captureManifest(workspace);
     process.stdout.write(JSON.stringify(manifest));`,
    [workspace, outside],
  );
  assert.equal(result.complete, false);
  assert.ok(result.entries.some((entry) => entry.path === "nested/inside.txt"));
  assert.ok(!result.entries.some((entry) => entry.path === "nested/secret.txt"));
});

test("manifest enumeration stops reading a directory at its entry budget", (t) => {
  const root = makeTempDir("matrix-manifest-budget-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 30; i += 1) writeFileSync(join(root, `file-${i}`), "x");
  const result = runInstrumented(
    `import fs from 'node:fs';
     import { syncBuiltinESMExports } from 'node:module';
     const original = fs.opendirSync;
     let reads = 0;
     fs.opendirSync = function (...args) {
       const dir = original.apply(this, args);
       const read = dir.readSync.bind(dir);
       dir.readSync = (...readArgs) => { reads += 1; return read(...readArgs); };
       return dir;
     };
     syncBuiltinESMExports();
     const { captureManifest } = await import('./lib/isolated-manifest.mjs');
     const manifest = captureManifest(process.argv[1], { entries: 3 });
     process.stdout.write(JSON.stringify({ complete: manifest.complete, reasons: manifest.reasons, reads }));`,
    [root],
  );
  assert.equal(result.complete, false);
  assert.deepEqual(result.reasons, ["entry-cap"]);
  assert.equal(result.reads, 4);
});
