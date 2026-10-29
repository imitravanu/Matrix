import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { captureManifest, captureManifestEntry } from "../lib/isolated-manifest.mjs";
import { inspectIsolationRoot } from "../lib/isolated-workspace.mjs";
import {
  integrationPublicationTarget,
  publishIntegrationIntent,
} from "../lib/integration-publication.mjs";
import {
  integrationIntentFingerprint,
  readIntegrationIntent,
  writeIntegrationIntent,
} from "../lib/integration-intent.mjs";
import { makeTempDir } from "./helpers.mjs";

function fixture(t, objectFormat = "sha1") {
  const directory = makeTempDir("matrix-publication-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  mkdirSync(source);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", source, ...args],
      {
        encoding: "utf8",
      },
    ).trim();
  git("init", "-q", `--object-format=${objectFormat}`);
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(source, "file.txt"), "base\r\n");
  writeFileSync(join(source, "keep.txt"), "untouched\n");
  writeFileSync(join(source, ".gitattributes"), "file.txt filter=marker\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const inspection = inspectIsolationRoot(source);
  assert.equal(inspection.ok, true, inspection.error);
  const container = join(directory, "result");
  mkdirSync(container);
  const root = join(container, "workspace");
  cpSync(source, root, {
    recursive: true,
    filter: (path) => !path.includes("/.git/") && !path.endsWith("/.git"),
  });
  const baseManifest = captureManifest(root);
  const agent = join(directory, "agent");
  cpSync(root, agent, { recursive: true });
  writeFileSync(join(agent, "file.txt"), "approved\r\n");
  const plan = {
    root,
    batchId: "batch-publication",
    integrationRunId: "integration-publication-fixture",
    createdAt: 1700000000000,
    baseManifest,
    planHash: "a".repeat(64),
    publication: {
      ...integrationPublicationTarget(inspection.git),
      ref: "refs/heads/matrix/parallel/integration-publication-fixture",
    },
    entries: [
      {
        path: "file.txt",
        before: captureManifestEntry(root, "file.txt"),
        after: captureManifestEntry(agent, "file.txt"),
        workspaceRoot: agent,
      },
    ],
  };
  const intent = writeIntegrationIntent(plan);
  writeFileSync(join(root, "file.txt"), "approved\r\n");
  const publish = (options = {}) =>
    publishIntegrationIntent(intent.path, { expectedFingerprint: intent.fingerprint, ...options });
  return { directory, source, root, plan, intent, git, publish };
}

for (const format of ["sha1", "sha256"]) {
  test(`publication creates an exact ${format} commit and idempotent ref without changing HEAD or index`, (t) => {
    const f = fixture(t, format);
    const head = f.git("rev-parse", "HEAD");
    const index = readFileSync(join(f.source, ".git", "index"));
    const marker = join(f.directory, "hook-ran");
    const hooks = join(f.directory, "hooks");
    mkdirSync(hooks);
    const hook = join(hooks, "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    f.git("config", "core.hooksPath", hooks);
    f.git("config", "filter.marker.clean", hook);
    f.git("config", "filter.marker.smudge", hook);
    f.git("config", "core.fsmonitor", hook);
    f.git("config", "commit.gpgSign", "true");
    f.git("config", "gpg.program", hook);
    writeFileSync(join(f.source, "file.txt"), "external working edit\n");
    assert.equal(existsSync(marker), false, "fixture setup did not run a hook");
    const published = f.publish();
    assert.equal(existsSync(marker), false, "publication did not run a hook");
    assert.equal(published.kind, "git");
    assert.equal(f.git("rev-parse", published.ref), published.commit);
    assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.equal(f.git("rev-parse", `${published.commit}^`), head);
    assert.deepEqual(readFileSync(join(f.source, ".git", "index")), index);
    assert.equal(readFileSync(join(f.source, "file.txt"), "utf8"), "external working edit\n");
    assert.deepEqual(
      execFileSync("git", [
        "-c",
        "core.fsmonitor=false",
        "-C",
        f.source,
        "show",
        `${published.commit}:file.txt`,
      ]),
      Buffer.from("approved\r\n"),
    );
    assert.equal(
      f.git("diff-tree", "--no-commit-id", "--name-only", "-r", published.commit),
      "file.txt",
    );
    assert.equal(f.publish().alreadyPublished, true);
    assert.equal(existsSync(marker), false);
  });
}

test("publication refuses an occupied ref, cancellation, result drift, and altered review", (t) => {
  const f = fixture(t);
  f.git("update-ref", f.plan.publication.ref, f.plan.publication.head);
  assert.throws(() => f.publish(), /already exists/);
  assert.equal(f.git("rev-parse", f.plan.publication.ref), f.plan.publication.head);
  assert.throws(() => f.publish({ signal: AbortSignal.abort() }), /aborted/);
  writeFileSync(join(f.root, "keep.txt"), "unexpected change\n");
  assert.throws(() => f.publish(), /Result changed/);
  assert.throws(
    () => f.publish({ expectedFingerprint: "b".repeat(64) }),
    /changed or has not been approved/,
  );
});

test("a publication interrupted after ref creation can be retried after process restart", (t) => {
  const f = fixture(t);
  const script = `import {publishIntegrationIntent} from './lib/integration-publication.mjs';
    publishIntegrationIntent(process.argv[1], {expectedFingerprint: process.argv[2]}); process.exit(29);`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, f.intent.path, f.intent.fingerprint],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(child.status, 29, child.stderr);
  const record = readIntegrationIntent(f.intent.path);
  const result = publishIntegrationIntent(f.intent.path, {
    expectedFingerprint: integrationIntentFingerprint(record),
  });
  assert.equal(result.alreadyPublished, true);
  assert.equal(f.git("rev-parse", result.ref), result.commit);
});

test("publication retry CLI refuses noninteractive writes", (t) => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, ["bin/matrix.mjs", "publish", f.intent.path], {
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /requires an interactive terminal/);
});
