// Publish only the approved images on a new Git ref. No checkout, filters,
// user index, user identity, or repository hooks participate in tree creation.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureManifest,
  captureManifestEntry,
  manifestFingerprint,
} from "./isolated-manifest.mjs";
import { integrationIntentFingerprint, readIntegrationIntent } from "./integration-intent.mjs";

function identity(path) {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Git publication storage is not a direct directory");
  return `${stat.dev}:${stat.ino}`;
}

export function integrationPublicationTarget(git) {
  if (!git) return null;
  const commonDir = realpathSync(git.commonDir);
  const objects = realpathSync(git.objects);
  return {
    commonDir,
    objects,
    objectFormat: git.objectFormat,
    head: git.head,
    repositoryIdentity: identity(commonDir),
    objectsIdentity: identity(objects),
  };
}

function environment() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Matrix Integration",
    GIT_AUTHOR_EMAIL: "matrix@localhost",
    GIT_COMMITTER_NAME: "Matrix Integration",
    GIT_COMMITTER_EMAIL: "matrix@localhost",
  };
}

/** Called only after final plan approval, or an explicit publication-retry decision. */
export function publishIntegrationIntent(
  intentPath,
  { signal = null, expectedFingerprint = null } = {},
) {
  const record = readIntegrationIntent(intentPath);
  if (!expectedFingerprint || integrationIntentFingerprint(record) !== expectedFingerprint)
    throw new Error("Publication intent changed or has not been approved");
  const target = record.publication;
  if (signal?.aborted) throw new Error("Publication aborted");
  if (!record.baseManifest?.complete || !Array.isArray(record.baseManifest.entries)) {
    throw new Error("Publication requires a complete base inventory");
  }
  const expected = new Map(record.baseManifest.entries.map((entry) => [entry.path, entry]));
  for (const entry of record.entries) expected.set(entry.path, entry.after);
  const drift = (path) => {
    const error = new Error(`Result changed before publication: ${path}`);
    error.code = "RESULT_DRIFT";
    throw error;
  };
  // A directory result includes every file. Refuse unknown additions as well
  // as modifications; unlike a Git commit, they would be part of the result.
  if (!target) {
    const current = captureManifest(record.root, record.baseManifest.limits);
    if (!current.complete || !current.exact || current.unsupportedEntries > 0)
      drift("incomplete inventory");
    const actual = new Map(current.entries.map((entry) => [entry.path, entry]));
    for (const path of new Set([...expected.keys(), ...actual.keys()])) {
      if (
        manifestFingerprint(expected.get(path) ?? null) !==
        manifestFingerprint(actual.get(path) ?? null)
      )
        drift(path);
    }
    if (signal?.aborted) throw new Error("Publication aborted");
    return { kind: "directory", workspace: record.root };
  }
  const check = () => {
    if (signal?.aborted) throw new Error("Git publication aborted");
    if (
      identity(target.commonDir) !== target.repositoryIdentity ||
      identity(target.objects) !== target.objectsIdentity
    ) {
      throw new Error("Git publication storage identity changed");
    }
  };
  check();
  const length = target.objectFormat === "sha1" ? 40 : target.objectFormat === "sha256" ? 64 : 0;
  if (
    !length ||
    !new RegExp(`^[a-f0-9]{${length}}$`).test(target.head) ||
    target.ref !== `refs/heads/matrix/parallel/${record.integrationRunId}` ||
    !Number.isSafeInteger(record.createdAt) ||
    record.createdAt < 0
  ) {
    throw new Error("Git publication identity is invalid");
  }
  // Tests may generate new scratch files. They may not alter any baseline or
  // approved path and then claim the approved commit represents that result.
  for (const [path, entry] of expected) {
    let current;
    try {
      current = captureManifestEntry(record.root, path);
    } catch {
      drift(path);
    }
    if (manifestFingerprint(current) !== manifestFingerprint(entry)) drift(path);
  }
  const shadow = mkdtempSync(join(tmpdir(), "matrix-publish-"));
  const env = environment();
  const date = `@${Math.floor(record.createdAt / 1000)} +0000`;
  env.GIT_AUTHOR_DATE = date;
  env.GIT_COMMITTER_DATE = date;
  const git = (directory, args, { input = undefined, objectStore = false } = {}) => {
    check();
    return execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.fsync=committed",
        `--git-dir=${directory}`,
        ...args,
      ],
      {
        env: objectStore ? { ...env, GIT_OBJECT_DIRECTORY: target.objects } : env,
        encoding: "utf8",
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeout: 5000,
        maxBuffer: 256 * 1024,
      },
    ).trim();
  };
  try {
    mkdirSync(join(shadow, "refs", "heads"), { recursive: true });
    mkdirSync(join(shadow, "objects"));
    writeFileSync(join(shadow, "HEAD"), `ref: refs/heads/unborn\n`, { mode: 0o600 });
    writeFileSync(
      join(shadow, "config"),
      `[core]\nrepositoryformatversion = ${length === 64 ? 1 : 0}\nbare = true\n${length === 64 ? "[extensions]\nobjectFormat = sha256\n" : ""}`,
      { mode: 0o600 },
    );
    const run = (args, input = undefined) => git(shadow, args, { input, objectStore: true });
    if (run(["cat-file", "-t", target.head]) !== "commit")
      throw new Error("Publication base is not a commit");
    run(["check-ref-format", target.ref]);
    run(["read-tree", target.head]);
    for (const entry of record.entries) {
      const blob = run(["hash-object", "--no-filters", "-w", "--stdin"], entry.updatedText);
      if (!new RegExp(`^[a-f0-9]{${length}}$`).test(blob))
        throw new Error("Invalid Git blob identity");
      const mode = entry.after.mode & 0o111 ? "100755" : "100644";
      run(["update-index", "-z", "--index-info"], `${mode} ${blob}\t${entry.path}\0`);
    }
    const tree = run(["write-tree"]);
    const commit = run(
      ["commit-tree", tree, "-p", target.head],
      `Matrix parallel integration\n\nApproved plan: ${record.planHash}\nVerification is recorded separately in the Matrix result.\n`,
    );
    if (!new RegExp(`^[a-f0-9]{${length}}$`).test(commit))
      throw new Error("Invalid Git commit identity");
    // Deterministic commit bytes make retries after an interrupted ref update
    // idempotent. A different existing ref is never replaced.
    let existing = null;
    try {
      existing = git(target.commonDir, ["show-ref", "--verify", "--hash", target.ref]);
    } catch (error) {
      if (error.status !== 1 && error.status !== 128) throw error;
    }
    if (existing) {
      if (existing !== commit)
        throw new Error("Publication branch already exists with different contents");
      let symbolic = null;
      try {
        symbolic = git(target.commonDir, ["symbolic-ref", "-q", target.ref]);
      } catch (error) {
        if (error.status !== 1) throw error;
      }
      if (symbolic) throw new Error("Publication branch is a symbolic ref");
      return {
        kind: "git",
        ref: target.ref,
        commit,
        alreadyPublished: true,
        workspace: record.root,
      };
    }
    git(target.commonDir, ["update-ref", "--no-deref", target.ref, commit, "0".repeat(length)]);
    return {
      kind: "git",
      ref: target.ref,
      commit,
      alreadyPublished: false,
      workspace: record.root,
    };
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
}
