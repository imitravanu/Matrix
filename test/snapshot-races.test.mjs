import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers.mjs";

function instrument(script, args) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 2000,
  });
}

test("snapshot cleanup refuses a directory swapped for an outside symlink", (t) => {
  const root = makeTempDir("matrix-cleanup-race-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = join(root, "snapshot");
  const outside = join(root, "outside");
  mkdirSync(join(snapshot, "nested"), { recursive: true });
  mkdirSync(outside, { mode: 0o755 });
  const result = instrument(
    `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const [snapshot, outside] = process.argv.slice(1);
    const original = fs.lstatSync; let swapped = false;
    fs.lstatSync = function(path, ...args) {
      const stat = original.call(this, path, ...args);
      if (!swapped && String(path).endsWith('/nested')) {
        swapped = true; fs.renameSync(path, snapshot + '/moved'); fs.symlinkSync(outside, path);
      }
      return stat;
    }; syncBuiltinESMExports();
    const { cleanupWorkspaceSnapshot } = await import('./lib/linux-snapshot.mjs');
    process.stdout.write(JSON.stringify(cleanupWorkspaceSnapshot({root:snapshot})));
  `,
    [snapshot, outside],
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(statSync(outside).mode & 0o777, 0o755);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test("failed snapshot setup exposes its own retained cleanup for retry", (t) => {
  const root = makeTempDir("matrix-snapshot-failed-cleanup-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const scratch = join(root, "scratch");
  mkdirSync(workspace);
  mkdirSync(scratch);
  writeFileSync(join(workspace, "file.txt"), "too large");
  const result = instrument(
    `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const [workspace, scratch] = process.argv.slice(1);
    const chmod = fs.chmodSync; let fail = true;
    fs.chmodSync = function(path, ...args) {
      if (fail && String(path).startsWith('/proc/self/fd/')) throw new Error('injected cleanup failure');
      return chmod.call(this, path, ...args);
    }; syncBuiltinESMExports();
    const {createWorkspaceSnapshot} = await import('./lib/linux-snapshot.mjs');
    let error; try { createWorkspaceSnapshot(workspace, {scratchDir:scratch, limits:{fileBytes:1}}); }
    catch (caught) { error = caught; }
    const retained = fs.readdirSync(scratch).length;
    fail = false; const retry = error.retryCleanup();
    process.stdout.write(JSON.stringify({error:error.cleanupError, retained, retry:retry.ok, left:fs.readdirSync(scratch).length}));
  `,
    [workspace, scratch],
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const data = JSON.parse(result.stdout);
  assert.match(data.error, /injected cleanup failure/);
  assert.equal(data.retained, 1);
  assert.equal(data.retry, true);
  assert.equal(data.left, 0);
});

for (const operation of ["snapshot", "manifest"]) {
  test(`${operation} does not block if a regular file becomes a FIFO`, (t) => {
    const root = makeTempDir("matrix-fifo-race-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const scratch = join(root, "scratch");
    mkdirSync(workspace);
    mkdirSync(scratch);
    writeFileSync(join(workspace, "file.txt"), "data");
    execFileSync("mkfifo", [join(root, "fifo")]);
    const result = instrument(
      `
      import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
      const [workspace, scratch, fifo, operation] = process.argv.slice(1);
      const original = fs.openSync; let swapped = false;
      fs.openSync = function(path, ...args) {
        if (!swapped && String(path).endsWith('/file.txt')) {
          swapped = true; fs.unlinkSync(path); fs.renameSync(fifo, path);
        }
        return original.call(this, path, ...args);
      }; syncBuiltinESMExports();
      if (operation === 'snapshot') {
        const { createWorkspaceSnapshot } = await import('./lib/linux-snapshot.mjs');
        try { createWorkspaceSnapshot(workspace, {scratchDir:scratch}); process.stdout.write('unexpected'); }
        catch { process.stdout.write('rejected'); }
      } else {
        const { captureManifest } = await import('./lib/isolated-manifest.mjs');
        process.stdout.write(captureManifest(workspace).complete ? 'unexpected' : 'rejected');
      }
    `,
      [workspace, scratch, join(root, "fifo"), operation],
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(result.stdout, "rejected");
  });
}

test("integration undo refuses a FIFO without blocking", (t) => {
  const root = makeTempDir("matrix-undo-fifo-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "file.txt"), "after");
  execFileSync("mkfifo", [join(root, "fifo")]);
  const result = instrument(
    `
    import fs from 'node:fs'; import {join} from 'node:path';
    const [root, fifo] = process.argv.slice(1);
    const {createRunController} = await import('./lib/controller.mjs');
    const controller = createRunController();
    const path = join(root, 'file.txt');
    const restored = controller.restoreFromSession({version:1, runId:'integration-fifo',
      entries:[{absPath:path, file:'file.txt', original:'before', updatedText:'after', isCreation:false}]}, {root});
    fs.unlinkSync(path); fs.renameSync(fifo, path);
    const undo = controller.undoLast(); controller.dispose();
    process.stdout.write(JSON.stringify({restored, ok:undo.ok}));
  `,
    [workspace, join(root, "fifo")],
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { restored: true, ok: false });
});

test("integration session restore refuses a parent swapped after path validation", (t) => {
  const root = makeTempDir("matrix-restore-parent-race-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, "nested"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, "nested", "file.txt"), "after");
  writeFileSync(join(outside, "file.txt"), "after");
  const result = instrument(
    `
    import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    import {join} from 'node:path';
    const [root, outside] = process.argv.slice(1); const target = join(root, 'nested', 'file.txt');
    const original = fs.realpathSync; let swapped = false;
    fs.realpathSync = function(path, ...args) {
      const real = original.call(this, path, ...args);
      if (!swapped && path === target) {
        swapped = true; fs.renameSync(join(root, 'nested'), join(root, 'moved'));
        fs.symlinkSync(outside, join(root, 'nested'));
      }
      return real;
    }; syncBuiltinESMExports();
    const {createRunController} = await import('./lib/controller.mjs');
    const controller = createRunController();
    const restored = controller.restoreFromSession({version:1, runId:'integration-race',
      entries:[{absPath:target, file:'nested/file.txt', original:'before', updatedText:'after', isCreation:false}]}, {root});
    controller.dispose(); process.stdout.write(JSON.stringify({restored, swapped}));
  `,
    [workspace, outside],
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { restored: false, swapped: true });
});
