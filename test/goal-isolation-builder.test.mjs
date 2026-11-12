// DUR-001 contract repair — the durable-goal isolation builder.
//
// The builder turns an approved test plan into a Bubblewrap command line that
// carries the disposable-snapshot boundary: a minimal read-only root, the
// snapshot bound at the canonical workspace path, a new empty network
// namespace, a cleared environment and only the exact trusted host files the
// plan needs.
//
// These regressions assert the shape of that boundary, so a later change
// cannot silently drop the snapshot, the network namespace or the cleared
// environment.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGoalTestIsolation,
  goalRuntimePrefix,
  goalRuntimeRealpath,
} from "../lib/goal-containment.mjs";
import { createWorkspaceSnapshot } from "../lib/linux-snapshot.mjs";

const linux = { skip: process.platform !== "linux" };

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "matrix-goal-isolation-builder-"));
  const workspace = join(base, "workspace");
  const gateRoot = join(base, "containment");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(gateRoot, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, workspace, gateRoot };
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

/** The value passed to `--setenv` for one environment key. */
function envValue(args, key) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--setenv") continue;
    if (args[index + 1] === key) return args[index + 2];
  }
  return null;
}

test("the isolation builder refuses an unusable boundary", linux, (t) => {
  const { workspace, gateRoot } = fixture(t);
  const snapshot = createWorkspaceSnapshot(workspace, { matrixHome: null });
  t.after(() => rmSync(snapshot.root, { recursive: true, force: true }));
  const base = {
    workspace,
    cwd: workspace,
    executable: process.execPath,
    gateRoot,
    snapshot,
  };
  assert.throws(
    () => createGoalTestIsolation({ ...base, workspace: "relative/workspace" }),
    /the workspace must be absolute/,
  );
  assert.throws(
    () => createGoalTestIsolation({ ...base, cwd: "relative/cwd" }),
    /the working directory must be absolute/,
  );
  assert.throws(
    () => createGoalTestIsolation({ ...base, executable: "node" }),
    /the approved executable must be absolute/,
  );
  assert.throws(
    () => createGoalTestIsolation({ ...base, snapshot: null }),
    /a disposable workspace snapshot is required/,
  );
});

test("the isolation builder carries the disposable-snapshot boundary", linux, (t) => {
  const { workspace, gateRoot } = fixture(t);
  const snapshot = createWorkspaceSnapshot(workspace, { matrixHome: null });
  t.after(() => rmSync(snapshot.root, { recursive: true, force: true }));
  const built = createGoalTestIsolation({
    workspace,
    cwd: workspace,
    executable: process.execPath,
    gateRoot,
    snapshot,
    env: { PATH: "/usr/bin:/bin", CI: "1", OPENROUTER_API_KEY: "cleared-upstream" },
  });
  const args = built.bwrapArgs;

  // The namespace is isolated from the host network and from the host
  // filesystem, and it survives the death of its owner.
  assert.ok(args.includes("--unshare-net"), "the namespace must have its own network");
  assert.ok(args.includes("--unshare-pid"), "the namespace must have its own pid namespace");
  assert.ok(args.includes("--clearenv"), "the environment must be cleared");
  assert.ok(!args.includes("--die-with-parent"), "the durable namespace must survive its owner");

  // The snapshot is bound at the canonical workspace path.
  assert.equal(argValue(args, "--bind"), snapshot.workspacePath);
  assert.ok(args.includes(workspace), "the snapshot must be bound at the workspace path");
  assert.ok(args.includes("--remount-ro"), "only the snapshot may stay writable");

  // The trusted host files are mounted read-only and exactly.
  assert.ok(args.includes(gateRoot), "the dispatch gate must be mounted");
  assert.ok(args.includes("/matrix-goal/guardian.mjs"), "the guardian must be mounted");
  assert.equal(
    args.filter((value) => value === "--ro-bind").length >= 2,
    true,
    "the gate and the guardian must be read-only binds",
  );

  // The environment is cleared of the host home and keeps the project's own
  // variables.
  assert.equal(envValue(args, "HOME"), "/nonexistent", "HOME must not exist inside the root");
  const isolatedPath = envValue(args, "PATH");
  assert.ok(isolatedPath.startsWith("/usr/bin:/bin"), "the base PATH must be preserved");
  const currentNode = goalRuntimeRealpath(process.execPath);
  const prefix = goalRuntimePrefix(currentNode, currentNode);
  if (prefix) {
    assert.ok(
      isolatedPath.split(":").includes(join(prefix, "bin")),
      "the trusted Node runtime must be reachable on the isolated PATH",
    );
  }
  assert.equal(envValue(args, "CI"), "1", "the project's own environment must survive");
});

test("the runtime prefix helper only accepts a matching distribution", () => {
  assert.equal(goalRuntimePrefix(null, "/opt/node/bin/npm"), null);
  assert.equal(goalRuntimePrefix("/usr/local/bin/node", "/opt/node/bin/npm"), null);
  assert.equal(goalRuntimePrefix("/opt/node/bin/node", "/opt/other/bin/npm"), null);
  assert.equal(goalRuntimePrefix("/usr/bin/node", "/usr/bin/npm"), null);
  assert.equal(
    goalRuntimePrefix("/opt/node/bin/node", "/opt/node/lib/node_modules/npm/bin/npm-cli.js"),
    "/opt/node",
  );
});

test("the runtime realpath helper reports an unreadable runtime", (t) => {
  const base = mkdtempSync(join(tmpdir(), "matrix-goal-runtime-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(goalRuntimeRealpath(join(base, "missing-node")), null);
  const file = join(base, "node");
  writeFileSync(file, "#!/bin/sh\n");
  assert.equal(goalRuntimeRealpath(file), file);
});
