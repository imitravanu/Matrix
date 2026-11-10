import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deletePinnedVerified,
  writePinnedAtomic,
  writePinnedVerified,
} from "../lib/pinned-write.mjs";
import { makeTempDir } from "./helpers.mjs";

test("a failed commit guard preserves the target and removes staged bytes", (t) => {
  const root = makeTempDir("matrix-pinned-write-guard-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  writeFileSync(path, "original", { mode: 0o640 });
  const failure = new Error("commit refused");
  for (const createOnly of [false, true]) {
    assert.throws(
      () =>
        writePinnedAtomic(path, "new content", 0o755, {
          createOnly,
          beforeCommit() {
            throw failure;
          },
        }),
      (error) => error === failure,
    );
    assert.equal(readFileSync(path, "utf8"), "original");
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(root), ["file.txt"]);
  }
});

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

for (const operation of ["write", "delete"]) {
  test(`verified ${operation} restores the exact displaced target when verification refuses`, (t) => {
    const root = makeTempDir("matrix-pinned-verified-refusal-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "file.txt");
    const original = "original\r\n";
    writeFileSync(path, original, { mode: 0o640 });
    const failure = new Error("displaced verification refused");
    const options = {
      verifyDisplaced(quarantine) {
        assert.equal(readFileSync(quarantine, "utf8"), original);
        assert.equal(statSync(quarantine).mode & 0o777, 0o640);
        throw failure;
      },
    };

    assert.throws(
      () =>
        operation === "delete"
          ? deletePinnedVerified(path, options)
          : writePinnedVerified(path, "new content\n", 0o755, options),
      (error) => error === failure,
    );
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.deepEqual(readdirSync(root), ["file.txt"]);
  });
}

test("verified write publishes exactly once and leaves no commit artifacts", (t) => {
  const root = makeTempDir("matrix-pinned-verified-write-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  writeFileSync(path, "old bytes\r\n", { mode: 0o640 });

  const result = writePinnedVerified(path, "new bytes\r\n", 0o751, {
    verifyDisplaced(quarantine) {
      assert.equal(readFileSync(quarantine, "utf8"), "old bytes\r\n");
      assert.equal(statSync(quarantine).mode & 0o777, 0o640);
    },
  });

  assert.deepEqual(result.retained, []);
  assert.equal(readFileSync(path, "utf8"), "new bytes\r\n");
  assert.equal(statSync(path).mode & 0o777, 0o751);
  assert.deepEqual(readdirSync(root), ["file.txt"]);
});

test("verified delete removes the target only after verifying the captured object", (t) => {
  const root = makeTempDir("matrix-pinned-verified-delete-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  writeFileSync(path, "delete these bytes", { mode: 0o640 });

  const result = deletePinnedVerified(path, {
    verifyDisplaced(quarantine) {
      assert.equal(readFileSync(quarantine, "utf8"), "delete these bytes");
      assert.equal(statSync(quarantine).mode & 0o777, 0o640);
    },
  });

  assert.deepEqual(result.retained, []);
  assert.throws(() => statSync(path), { code: "ENOENT" });
  assert.deepEqual(readdirSync(root), []);
});

test("verified write retains displaced bytes when a further replacement occupies the target", (t) => {
  const root = makeTempDir("matrix-pinned-verified-retain-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  const original = "original displaced bytes\r\n";
  writeFileSync(path, original, { mode: 0o640 });
  const failure = new Error("publish refused");
  let retainedPath = null;

  assert.throws(
    () =>
      writePinnedVerified(path, "planned bytes\n", 0o755, {
        verifyDisplaced() {},
        beforePublish() {
          writeFileSync(path, "further external bytes\n", { mode: 0o600 });
          throw failure;
        },
      }),
    (error) => {
      assert.equal(error.cause, failure);
      assert.match(error.message, /displaced target retained at /);
      retainedPath = error.message.slice(error.message.indexOf("retained at ") + 12);
      return true;
    },
  );

  assert.equal(readFileSync(path, "utf8"), "further external bytes\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(retainedPath, "utf8"), original);
  assert.equal(statSync(retainedPath).mode & 0o777, 0o640);
  const artifacts = readdirSync(root).filter((name) => name !== "file.txt");
  assert.deepEqual(artifacts, [retainedPath.slice(root.length + 1)]);
});

test("verified write restores the displaced target when publication fails without a conflict", (t) => {
  const root = makeTempDir("matrix-pinned-verified-publish-failure-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  writeFileSync(path, "publication original", { mode: 0o640 });
  const failure = new Error("publication denied");
  failure.code = "EACCES";

  const originalLink = fs.linkSync;
  fs.linkSync = (source, destination) => {
    if (
      String(source).includes(".matrix-integration-") &&
      String(destination).endsWith("file.txt")
    ) {
      throw failure;
    }
    return originalLink(source, destination);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => writePinnedVerified(path, "new content", 0o751, { verifyDisplaced() {} }),
      (error) => error === failure,
    );
  } finally {
    fs.linkSync = originalLink;
    syncBuiltinESMExports();
  }

  assert.equal(readFileSync(path, "utf8"), "publication original");
  assert.equal(statSync(path).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(root), ["file.txt"]);
});

test("verified write refuses a target that disappeared before capture and removes its staging", (t) => {
  const root = makeTempDir("matrix-pinned-verified-missing-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  const missing = join(root, "never.txt");

  assert.throws(
    () =>
      writePinnedVerified(missing, "new content\n", 0o644, {
        verifyDisplaced() {},
      }),
    /does not exist/,
  );
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => statSync(path), { code: "ENOENT" });
});

test(
  "crash after quarantine keeps the displaced bytes under the commit artifact",
  { skip: process.platform === "linux" ? false : "Linux required", timeout: 15_000 },
  (t) => {
    const root = makeTempDir("matrix-pinned-verified-crash-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "crash.txt");
    const original = "CRASH ORIGINAL\r\n";
    writeFileSync(path, original, { mode: 0o751 });

    const moduleUrl = new URL("../lib/pinned-write.mjs", import.meta.url).href;
    const script = `
      import { writePinnedVerified } from ${JSON.stringify(moduleUrl)};
      writePinnedVerified(process.argv[1], "CRASH REPLACEMENT\\n", 0o600, {
        verifyDisplaced() {},
        beforePublish() {
          process.kill(process.pid, "SIGKILL");
        },
      });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], {
      encoding: "utf8",
    });

    assert.equal(result.signal, "SIGKILL");
    assert.throws(() => statSync(path), { code: "ENOENT" });
    const quarantine = readdirSync(root).find((name) => name.startsWith(".matrix-commit-"));
    assert.ok(quarantine, "displaced target must remain under the commit artifact");
    assert.equal(readFileSync(join(root, quarantine), "utf8"), original);
    assert.equal(statSync(join(root, quarantine)).mode & 0o777, 0o751);
  },
);

test("verified commit requires displaced verification for replacement and deletion", (t) => {
  const root = makeTempDir("matrix-pinned-verified-required-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  writeFileSync(path, "original", { mode: 0o640 });

  assert.throws(
    () => writePinnedVerified(path, "new content", 0o644),
    /requires displaced-target verification/,
  );
  assert.throws(() => deletePinnedVerified(path), /requires displaced-target verification/);
  assert.equal(readFileSync(path, "utf8"), "original");
  assert.deepEqual(readdirSync(root), ["file.txt"]);
});

for (const operation of ["write", "delete"]) {
  test(`verified ${operation} restores external bytes that appear before capture`, (t) => {
    const root = makeTempDir("matrix-pinned-verified-external-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "file.txt");
    const external = "external bytes before capture\r\n";
    writeFileSync(path, "original", { mode: 0o640 });

    assert.throws(
      () =>
        operation === "delete"
          ? deletePinnedVerified(path, {
              beforeCapture() {
                writeFileSync(path, external);
                fs.chmodSync(path, 0o600);
              },
              verifyDisplaced(quarantine) {
                assert.equal(readFileSync(quarantine, "utf8"), external);
                throw new Error("displaced bytes changed");
              },
            })
          : writePinnedVerified(path, "new content", 0o644, {
              beforeCapture() {
                writeFileSync(path, external);
                fs.chmodSync(path, 0o600);
              },
              verifyDisplaced(quarantine) {
                assert.equal(readFileSync(quarantine, "utf8"), external);
                throw new Error("displaced bytes changed");
              },
            }),
      /displaced bytes changed/,
    );

    assert.equal(readFileSync(path, "utf8"), external);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(root), ["file.txt"]);
  });
}

test("verified commit reports cleanup failures and retains verified bytes", (t) => {
  const root = makeTempDir("matrix-pinned-verified-cleanup-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writePath = join(root, "write.txt");
  const deletePath = join(root, "delete.txt");
  writeFileSync(writePath, "write original", { mode: 0o640 });
  writeFileSync(deletePath, "delete original", { mode: 0o751 });

  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (path) => {
    if (String(path).includes(".matrix-integration-") || String(path).includes(".matrix-commit-")) {
      const error = new Error("cleanup denied");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlink(path);
  };
  syncBuiltinESMExports();

  let writeResult;
  let deleteResult;
  try {
    writeResult = writePinnedVerified(writePath, "write replacement", 0o700, {
      verifyDisplaced() {},
    });
    deleteResult = deletePinnedVerified(deletePath, { verifyDisplaced() {} });
  } finally {
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
  }

  assert.equal(writeResult.retained.length, 2);
  const retainedStaging = writeResult.retained.find((path) =>
    path.includes(".matrix-integration-"),
  );
  const retainedQuarantine = writeResult.retained.find((path) => path.includes(".matrix-commit-"));
  assert.ok(retainedStaging);
  assert.ok(retainedQuarantine);
  assert.equal(readFileSync(retainedStaging, "utf8"), "write replacement");
  assert.equal(readFileSync(retainedQuarantine, "utf8"), "write original");
  assert.equal(readFileSync(writePath, "utf8"), "write replacement");
  assert.equal(statSync(writePath).mode & 0o777, 0o700);

  assert.equal(deleteResult.retained.length, 1);
  assert.match(deleteResult.retained[0], /\.matrix-commit-.*\.displaced$/);
  assert.equal(readFileSync(deleteResult.retained[0], "utf8"), "delete original");
  assert.throws(() => statSync(deletePath), { code: "ENOENT" });
});

test("verified create refuses an existing target and creates after it is removed", (t) => {
  const root = makeTempDir("matrix-pinned-verified-create-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "file.txt");
  writeFileSync(path, "concurrent content", { mode: 0o600 });

  assert.throws(
    () =>
      writePinnedVerified(path, "created content", 0o751, {
        createOnly: true,
      }),
    /already exists/,
  );
  assert.equal(readFileSync(path, "utf8"), "concurrent content");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(root), ["file.txt"]);

  rmSync(path);
  const result = writePinnedVerified(path, "created content", 0o751, {
    createOnly: true,
  });
  assert.deepEqual(result.retained, []);
  assert.equal(readFileSync(path, "utf8"), "created content");
  assert.equal(statSync(path).mode & 0o777, 0o751);
  assert.deepEqual(readdirSync(root), ["file.txt"]);
});

test(
  "crash after publication keeps the published target and the displaced original",
  { skip: process.platform === "linux" ? false : "Linux required", timeout: 15_000 },
  (t) => {
    const root = makeTempDir("matrix-pinned-verified-published-crash-");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "crash.txt");
    const original = "PUBLISHED CRASH ORIGINAL\r\n";
    const replacement = "PUBLISHED CRASH REPLACEMENT\n";
    writeFileSync(path, original, { mode: 0o751 });

    const moduleUrl = new URL("../lib/pinned-write.mjs", import.meta.url).href;
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const { writePinnedVerified } = await import(${JSON.stringify(moduleUrl)});
      const path = process.argv[1];
      const originalLink = fs.linkSync;
      fs.linkSync = (source, destination) => {
        const result = originalLink(source, destination);
        if (destination === path && String(source).includes(".matrix-integration-")) {
          process.kill(process.pid, "SIGKILL");
        }
        return result;
      };
      syncBuiltinESMExports();
      writePinnedVerified(path, ${JSON.stringify(replacement)}, 0o600, {
        verifyDisplaced() {},
      });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, path], {
      encoding: "utf8",
    });

    assert.equal(result.signal, "SIGKILL");
    assert.equal(readFileSync(path, "utf8"), replacement);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const quarantine = readdirSync(root).find((name) => name.startsWith(".matrix-commit-"));
    assert.ok(quarantine, "displaced target must remain under the commit artifact");
    assert.equal(readFileSync(join(root, quarantine), "utf8"), original);
    assert.equal(statSync(join(root, quarantine)).mode & 0o777, 0o751);
  },
);
