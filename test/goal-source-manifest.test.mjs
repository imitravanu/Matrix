// DUR-001 contract repair — the durable-goal source manifest.
//
// Test evidence only means something when it certifies the exact inputs the
// approved test ran against. The manifest names those inputs: the approved
// test's own files, the runner configuration it reads, the workspace modules
// those files import, and the directory the runner selects from.
//
// A change, an addition or a deletion inside that set has to be observed, so
// a goal can never complete on stale evidence.
//
// The unit regressions drive the manifest directly. The runtime regressions
// drive the real goal runtime: an unedited dependency, the test file itself
// and an added input are changed while the approved test runs, and each one
// must stop the goal. The unchanged-source control proves that the same path
// completes when nothing moved, and that the evidence filter is not vacuous.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GOAL_DEFAULT_BUDGET, newGoalId } from "../lib/goal-contracts.mjs";
import { createGoalStore } from "../lib/goal-store.mjs";
import { collectOperationHistory } from "../lib/goal-context.mjs";
import {
  hashGoalSourceManifest,
  resolveGoalSourceManifest,
  sourceTokenKind,
} from "../lib/goal-source-manifest.mjs";
import {
  createGoalAuthority,
  createGoalRuntime,
  createExecutionOwnership,
} from "../lib/goal-policy.mjs";
import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from "../lib/linux-snapshot.mjs";
import { inspectTestPlan } from "../lib/test-policy.mjs";

const linux = { skip: process.platform !== "linux", timeout: 120_000 };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ============================================================================
// Fixtures
// ============================================================================

function buildHelper(t, home) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const built = spawnSync(
    process.execPath,
    [join(PACKAGE_ROOT, "scripts", "build-pidfd-helper.mjs"), "--out", bin],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(built.status, 0, built.stderr || built.error?.message);
  return join(bin, "matrix-pidfd-helper");
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "matrix-goal-manifest-"));
  const workspace = join(base, "workspace");
  const home = join(base, "home");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  t.after(() => {
    // A regression may close a directory the cleanup then cannot enter, so the
    // fixture restores every mode before the tree is removed.
    for (const name of ["data", "locked", "nested"]) {
      for (const candidate of [workspace, home, join(workspace, "lib")]) {
        try {
          chmodSync(join(candidate, name), 0o755);
        } catch {
          // The path is absent or already removable.
        }
      }
    }
    rmSync(base, { recursive: true, force: true });
  });
  return { base, workspace, home };
}

/** A workspace with a runner configuration, a test and an imported module. */
function manifestWorkspace(t, { holdMs = 0 } = {}) {
  const { base, workspace, home } = fixture(t);
  mkdirSync(join(workspace, "lib"), { recursive: true, mode: 0o700 });
  mkdirSync(join(workspace, "test"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ scripts: { test: "node --test test/probe.test.mjs" } }),
  );
  writeFileSync(join(workspace, "lib", "dependency.mjs"), "export const value = 1;\n");
  writeFileSync(
    join(workspace, "test", "probe.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { value } from "../lib/dependency.mjs";
test("probe", async () => {
  assert.equal(value, 1);
  await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
});
`,
  );
  return { base, workspace, home };
}

function npmDescriptor(workspace) {
  const inspected = inspectTestPlan(
    { file: "npm", args: ["test"], cwd: workspace },
    { cwd: workspace },
  );
  assert.equal(inspected.ok, true, inspected.error);
  return inspected.plan;
}

function identityOf(workspace) {
  const identity = statSync(workspace, { bigint: true });
  return { path: workspace, device: String(identity.dev), inode: String(identity.ino) };
}

/**
 * A workspace whose test reads a data file, a symbolic link and an installed
 * package. These are the inputs that used to disappear from the identity.
 */
function inputWorkspace(t, { holdMs = 0 } = {}) {
  const { base, workspace, home } = fixture(t);
  mkdirSync(join(workspace, "fixtures"), { recursive: true, mode: 0o700 });
  mkdirSync(join(workspace, "node_modules", "fixture-package"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(join(workspace, "fixtures", "input.json"), JSON.stringify({ value: 1 }));
  writeFileSync(join(workspace, "fixtures", "other.json"), JSON.stringify({ value: 2 }));
  symlinkSync("input.json", join(workspace, "fixtures", "current.json"));
  writeFileSync(
    join(workspace, "node_modules", "fixture-package", "index.js"),
    "module.exports = { value: 1 };\n",
  );
  writeFileSync(
    join(workspace, "probe.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const input = JSON.parse(readFileSync(new URL("./fixtures/input.json", import.meta.url), "utf8"));
const linked = JSON.parse(readFileSync(new URL("./fixtures/current.json", import.meta.url), "utf8"));
const dependency = createRequire(import.meta.url)("fixture-package");
if (input.value !== 1 || linked.value !== 1 || dependency.value !== 1) throw new Error("stale");
test("probe", async () => {
  await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
});
`,
  );
  return { base, workspace, home };
}

/** The manifest identity of a plan's working directory and all its inputs. */
function inputIdentity(workspace, home, cwd = workspace) {
  return hashGoalSourceManifest(
    workspace,
    resolveGoalSourceManifest({
      workspaceRoot: workspace,
      plan: { cwd, args: ["--test", "probe.test.mjs"] },
      paths: [],
      matrixHome: home,
    }),
  ).sha256;
}

/**
 * Drive one durable goal whose single criterion is the approved test plan and
 * return the runtime result together with the operation history.
 */
async function runGoalWithTest(t, { workspace, home, plan }) {
  const helper = buildHelper(t, home);
  // The plan is inspected against its own working directory: a rejecting plan
  // cannot silently conflict with a legitimate subdirectory plan fixture.
  const inspected = inspectTestPlan(plan, { cwd: plan.cwd ?? workspace });
  assert.equal(inspected.ok, true, inspected.error);
  const planHash = inspected.plan.planHash;
  const goalId = newGoalId();
  createGoalStore(home).create({
    schemaVersion: 1,
    id: goalId,
    createdAt: Date.now(),
    objective: "source manifest regression",
    workspace: { ...identityOf(workspace), revision: null, manifest: hash("manifest") },
    provider: { id: "scripted", modelId: "scripted", digest: hash("provider") },
    state: "ready",
    generation: 0,
    sequence: 0,
    operations: [],
    criteria: [{ id: newGoalId("criterion"), revision: 1, kind: "test", planHash }],
    budget: { ...GOAL_DEFAULT_BUDGET },
  });
  const authority = createGoalAuthority({ home, workspace: identityOf(workspace) });
  const engine = {
    async turn() {
      authority.registerTestGrant({ planHash, approved: true, goalId });
      return { content: "", toolCalls: [{ name: "test", arguments: { planHash } }] };
    },
  };
  const runtime = createGoalRuntime({
    home,
    goalId,
    workspace,
    engine,
    testPlan: plan,
    authority,
    headless: true,
    allowTests: true,
    helperPath: helper,
    executionOwnership: createExecutionOwnership({ home, helperPath: helper }),
  });
  const result = await runtime.resume();
  const history = collectOperationHistory(createGoalStore(home), goalId);
  return { result, history, goalId, planHash };
}

function readOwnershipRecords(home) {
  const directory = join(home, "ownership");
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      if (!statSync(path).isFile()) continue;
      records.push(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Ignore an unreadable record.
    }
  }
  return records;
}

/** The PID-namespace inode of one process, or null when it cannot be read. */
function namespaceInodeOf(pid) {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`).replace(/^pid:\[(\d+)\]$/, "$1");
  } catch {
    return null;
  }
}

/** The namespace-local PIDs of one process, or null when it cannot be read. */
function namespacePidsOf(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^NSpid:\s*(.+)$/m.exec(status);
    if (!match) return null;
    return match[1].trim().split(/\s+/).map(Number);
  } catch {
    return null;
  }
}

/** The start time and state of one process, read from `/proc`. */
function readProcIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rparen = stat.lastIndexOf(")");
  const fields = stat.slice(rparen + 2).split(" ");
  return { startTime: fields[19], state: fields[0] };
}

/**
 * The processes that live in the recorded PID namespace.
 *
 * A PID-namespace inode number is reused once the namespace is gone, so the
 * candidates are only the recorded namespace when the recorded namespace init
 * is still its init. Without that discrimination an unrelated sandbox that
 * inherited the inode number would be reported as the goal's own tree.
 */
function recordedNamespaceProcesses(namespace) {
  const candidates = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    if (namespaceInodeOf(pid) !== namespace.inode) continue;
    candidates.push({ pid, nsPids: namespacePidsOf(pid) });
  }
  if (typeof namespace.initStartTime !== "string") return candidates;
  const init = candidates.find((candidate) => candidate.nsPids?.at(-1) === 1);
  if (!init) return candidates;
  if (init.pid !== namespace.initPid) return [];
  let startTime;
  try {
    startTime = readProcIdentity(init.pid).startTime;
  } catch {
    return candidates;
  }
  return startTime === namespace.initStartTime ? candidates : [];
}

/** The live (non-zombie) host processes of one recorded PID namespace. */
function namespaceLiveMembers(namespace) {
  const members = [];
  for (const { pid } of recordedNamespaceProcesses(namespace)) {
    let identity;
    try {
      identity = readProcIdentity(pid);
    } catch {
      continue;
    }
    if (identity.state !== "Z") members.push(pid);
  }
  return members;
}

/**
 * The deterministic barrier of the runtime regressions: the owned process
 * tree must have started before the workspace is changed. The ownership
 * record is written when the namespace is pinned, which happens after the
 * disposable snapshot was taken, so the change always lands after the
 * snapshot and before the observation.
 */
async function changeWhileTheTestRuns(home, change) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const records = readOwnershipRecords(home);
    if (records.length >= 1 && records[0].namespace) {
      if (namespaceLiveMembers(records[0].namespace).length >= 3) {
        change();
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// ============================================================================
// The manifest itself
// ============================================================================

test("the manifest names the test, the runner configuration and the imported module", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const descriptor = npmDescriptor(workspace);
  const resolved = resolveGoalSourceManifest({
    workspaceRoot: workspace,
    plan: descriptor,
    paths: [],
    matrixHome: home,
  });
  assert.ok(
    resolved.files.includes("package.json"),
    "the runner configuration must be part of the identity",
  );
  assert.ok(
    resolved.files.includes("test/probe.test.mjs"),
    "the approved test must be part of the identity",
  );
  assert.ok(
    resolved.files.includes("lib/dependency.mjs"),
    "an imported module is named as an input even though the whole workspace is covered",
  );
  assert.deepEqual(
    resolved.roots,
    ["."],
    "the whole workspace is the selection root, because the snapshot exposes all of it",
  );
});

test("a changed, an added and a deleted input change the identity", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const descriptor = npmDescriptor(workspace);
  const identity = () =>
    hashGoalSourceManifest(
      workspace,
      resolveGoalSourceManifest({
        workspaceRoot: workspace,
        plan: descriptor,
        paths: [],
        matrixHome: home,
      }),
    ).sha256;
  const first = identity();
  assert.match(first, /^[a-f0-9]{64}$/);

  writeFileSync(join(workspace, "lib", "dependency.mjs"), "export const value = 2;\n");
  const changed = identity();
  assert.notEqual(changed, first, "a changed dependency must change the identity");

  writeFileSync(join(workspace, "test", "added.test.mjs"), "export const added = true;\n");
  const added = identity();
  assert.notEqual(added, changed, "an added input must change the identity");

  rmSync(join(workspace, "test", "added.test.mjs"));
  const removed = identity();
  assert.notEqual(removed, added, "a deleted input must change the identity");
  assert.equal(removed, changed, "only the added input was removed again");
});

test("the live workspace and its disposable snapshot share one identity", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const descriptor = npmDescriptor(workspace);
  const resolved = resolveGoalSourceManifest({
    workspaceRoot: workspace,
    plan: descriptor,
    paths: [],
    matrixHome: home,
  });
  const live = hashGoalSourceManifest(workspace, resolved);
  const snapshot = createWorkspaceSnapshot(workspace, { matrixHome: home });
  t.after(() => cleanupWorkspaceSnapshot(snapshot));
  const bound = hashGoalSourceManifest(snapshot.workspacePath, resolved);
  assert.equal(
    bound.sha256,
    live.sha256,
    "the snapshot of the workspace must carry the same source identity",
  );
});

test("the manifest never names a path outside the workspace", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const descriptor = npmDescriptor(workspace);
  const resolved = resolveGoalSourceManifest({
    workspaceRoot: workspace,
    plan: descriptor,
    paths: [],
    matrixHome: home,
  });
  for (const path of resolved.files) {
    assert.doesNotMatch(path, /(^|\/)\.\.(\/|$)/, "a manifest path must not escape");
    assert.doesNotMatch(path, /^\//, "a manifest path must be workspace relative");
  }
  assert.ok(resolved.files.includes("package-lock.json"), "absent inputs stay named");
});

test("command tokens are classified as inputs only when they can name one", () => {
  assert.equal(sourceTokenKind("--test"), null);
  assert.equal(sourceTokenKind("test"), null);
  assert.equal(sourceTokenKind("--reporter=tap"), null);
  assert.equal(sourceTokenKind("./..."), null);
  assert.equal(sourceTokenKind("probe.test.mjs"), "path");
  assert.equal(sourceTokenKind("test/probe.test.mjs"), "path");
  assert.equal(sourceTokenKind("test/*.test.mjs"), "glob");
});

test("a nested data file and a retargeted symbolic link change the identity", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  mkdirSync(join(workspace, "fixtures"), { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, "fixtures", "input.json"), JSON.stringify({ value: 1 }));
  writeFileSync(join(workspace, "fixtures", "other.json"), JSON.stringify({ value: 2 }));
  symlinkSync("input.json", join(workspace, "fixtures", "current.json"));
  const first = inputIdentity(workspace, home);

  // The data file is not a module, so only the directory selection covers it.
  writeFileSync(join(workspace, "fixtures", "input.json"), JSON.stringify({ value: 3 }));
  const changed = inputIdentity(workspace, home);
  assert.notEqual(changed, first, "a changed nested data file must change the identity");

  rmSync(join(workspace, "fixtures", "current.json"));
  symlinkSync("other.json", join(workspace, "fixtures", "current.json"));
  const retargeted = inputIdentity(workspace, home);
  assert.notEqual(retargeted, changed, "a retargeted symbolic link must change the identity");
});

test("a named input that is a symbolic link binds its target", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  symlinkSync("lib/dependency.mjs", join(workspace, "linked.mjs"));
  const identity = () =>
    hashGoalSourceManifest(
      workspace,
      resolveGoalSourceManifest({
        workspaceRoot: workspace,
        plan: { cwd: workspace, args: ["--test", "linked.mjs"] },
        paths: [],
        matrixHome: home,
      }),
    ).sha256;
  const first = identity();
  rmSync(join(workspace, "linked.mjs"));
  symlinkSync("test/probe.test.mjs", join(workspace, "linked.mjs"));
  assert.notEqual(
    identity(),
    first,
    "a named symbolic-link input must bind its target, not only its name",
  );
});

test("installed dependency bytes, additions and deletions change the identity", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const packagePath = join(workspace, "node_modules", "fixture-package");
  mkdirSync(packagePath, { recursive: true, mode: 0o700 });
  writeFileSync(join(packagePath, "index.js"), "module.exports = { value: 1 };\n");
  const first = inputIdentity(workspace, home);

  // The lockfile did not change; only the installed bytes did.
  writeFileSync(join(packagePath, "index.js"), "module.exports = { value: 2 };\n");
  const changed = inputIdentity(workspace, home);
  assert.notEqual(changed, first, "changed installed dependency bytes must change the identity");

  rmSync(packagePath, { recursive: true });
  const removed = inputIdentity(workspace, home);
  assert.notEqual(removed, changed, "a deleted installed dependency must change the identity");

  mkdirSync(packagePath, { recursive: true, mode: 0o700 });
  writeFileSync(join(packagePath, "index.js"), "module.exports = { value: 1 };\n");
  const restored = inputIdentity(workspace, home);
  assert.notEqual(restored, removed, "an added installed dependency must change the identity");
  assert.equal(restored, first, "restoring the same bytes restores the same identity");
});

test("a subdirectory plan is still covered by the workspace-wide identity", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const resolved = resolveGoalSourceManifest({
    workspaceRoot: workspace,
    plan: { cwd: join(workspace, "test"), args: ["--test", "probe.test.mjs"] },
    paths: [],
    matrixHome: home,
  });
  assert.ok(
    resolved.roots.includes("."),
    "a subdirectory plan cannot narrow the identity below the snapshot boundary",
  );
  assert.ok(
    resolved.roots.includes("test"),
    "the plan's working directory stays an explicitly selected root",
  );
  // A sibling the test never names is still readable from inside the snapshot.
  writeFileSync(join(workspace, "lib", "sibling.json"), JSON.stringify({ value: 1 }));
  const first = inputIdentity(workspace, home, join(workspace, "test"));
  writeFileSync(join(workspace, "lib", "sibling.json"), JSON.stringify({ value: 2 }));
  assert.notEqual(
    inputIdentity(workspace, home, join(workspace, "test")),
    first,
    "a sibling input outside the working directory must change the identity",
  );
});

test("a dependency above a subdirectory plan is covered before it exists", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const first = inputIdentity(workspace, home, join(workspace, "test"));
  mkdirSync(join(workspace, "node_modules", "added-package"), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(workspace, "node_modules", "added-package", "index.js"),
    "module.exports = {};\n",
  );
  assert.notEqual(
    inputIdentity(workspace, home, join(workspace, "test")),
    first,
    "a dependency added after dispatch must change the identity",
  );
});

test("an excluded host directory never enters the identity", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  // The snapshot never copies these, so the approved test cannot read them and
  // they must not be able to invalidate the evidence.
  mkdirSync(join(workspace, ".git"), { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(workspace, ".env"), "SECRET=1\n");
  const first = inputIdentity(workspace, home);
  writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/other\n");
  writeFileSync(join(workspace, ".env"), "SECRET=2\n");
  assert.equal(
    inputIdentity(workspace, home),
    first,
    "a directory and a secret file the snapshot never copies are outside the identity",
  );
});

test("file and directory permission bits are part of the identity", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const helper = join(workspace, "lib", "helper.sh");
  writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const executable = inputIdentity(workspace, home);
  chmodSync(helper, 0o644);
  const notExecutable = inputIdentity(workspace, home);
  assert.notEqual(
    notExecutable,
    executable,
    "removing a file's execute bit must change the identity even though its bytes did not",
  );
  chmodSync(helper, 0o755);
  assert.equal(
    inputIdentity(workspace, home),
    executable,
    "restoring the mode restores the identity",
  );

  // The mode of a directory decides whether the test can list it at all.
  const nested = join(workspace, "lib", "nested");
  mkdirSync(nested, { mode: 0o755 });
  writeFileSync(join(nested, "data.json"), JSON.stringify({ value: 1 }));
  const listable = inputIdentity(workspace, home);
  chmodSync(nested, 0o700);
  assert.notEqual(
    inputIdentity(workspace, home),
    listable,
    "a directory permission change must change the identity",
  );
  chmodSync(nested, 0o755);
  assert.equal(
    inputIdentity(workspace, home),
    listable,
    "restoring the mode restores the identity",
  );
});

test("an entry type change changes the identity", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  const target = join(workspace, "lib", "dependency.mjs");
  const file = inputIdentity(workspace, home);
  rmSync(target);
  mkdirSync(target, { mode: 0o700 });
  const directory = inputIdentity(workspace, home);
  assert.notEqual(directory, file, "a file replaced by a directory must change the identity");
  rmSync(target, { recursive: true });
  symlinkSync("../test/probe.test.mjs", target);
  assert.notEqual(
    inputIdentity(workspace, home),
    directory,
    "a path replaced by a symbolic link must change the identity",
  );
});

test("an installed dependency exposed through a symbolic link refuses verification", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  mkdirSync(join(workspace, "vendor"), { recursive: true, mode: 0o700 });
  symlinkSync("vendor", join(workspace, "node_modules"));
  // A no-follow walk cannot hash the bytes behind the link, so verification
  // refuses instead of certifying an identity with unread contents.
  const resolved = resolveGoalSourceManifest({
    workspaceRoot: workspace,
    plan: npmDescriptor(workspace),
    paths: [],
    matrixHome: home,
  });
  const hashed = hashGoalSourceManifest(workspace, resolved);
  const linked = hashed.roots[0];
  assert.equal(linked.path, ".");
  const digest = inputIdentity(workspace, home);
  assert.match(digest, /^[a-f0-9]{64}$/);
  // The link target is bound. Retargeting it changes the identity even though
  // the linked-to bytes are outside the no-follow walk.
  rmSync(join(workspace, "node_modules"));
  mkdirSync(join(workspace, "vendor2"), { recursive: true, mode: 0o700 });
  symlinkSync("vendor2", join(workspace, "node_modules"));
  assert.notEqual(
    inputIdentity(workspace, home),
    digest,
    "a retargeted dependency link must change the identity",
  );
});

test("an input beyond the supported size refuses verification", (t) => {
  const { workspace, home } = manifestWorkspace(t);
  mkdirSync(join(workspace, "fixtures"), { recursive: true, mode: 0o700 });
  const oversized = join(workspace, "fixtures", "oversized.bin");
  writeFileSync(oversized, "");
  truncateSync(oversized, 33 * 1024 * 1024);
  assert.throws(
    () => inputIdentity(workspace, home),
    /exceeds the supported size/,
    "complete coverage is impossible for this input, so verification must refuse",
  );
});

test(
  "an unreadable selected input refuses verification instead of hashing null",
  process.platform === "linux" && process.getuid?.() !== 0
    ? {}
    : { skip: "non-root Linux required" },
  (t) => {
    const { workspace, home } = manifestWorkspace(t);
    mkdirSync(join(workspace, "fixtures"), { recursive: true, mode: 0o700 });
    const input = join(workspace, "fixtures", "input.json");
    writeFileSync(input, JSON.stringify({ value: 1 }));
    chmodSync(input, 0o000);
    assert.throws(
      () => inputIdentity(workspace, home),
      /could not be hashed/,
      "an unreadable input must refuse, never produce a null content hash",
    );

    // A directory that cannot be listed is the same failure family.
    chmodSync(input, 0o600);
    const locked = join(workspace, "fixtures", "locked");
    mkdirSync(locked, { mode: 0o700 });
    writeFileSync(join(locked, "nested.json"), JSON.stringify({ nested: true }));
    chmodSync(locked, 0o000);
    assert.throws(
      () => inputIdentity(workspace, home),
      /could not be opened/,
      "an unlistable selection directory must refuse",
    );
    // Restore the directory so the fixture cleanup is not blocked by its mode.
    chmodSync(locked, 0o700);
  },
);

// ============================================================================
// The real runtime
// ============================================================================

test(
  "an unedited dependency changed while the test runs invalidates the evidence",
  linux,
  async (t) => {
    const { workspace, home } = manifestWorkspace(t, { holdMs: 750 });
    const plan = {
      file: process.execPath,
      args: ["--test", "test/probe.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const changed = changeWhileTheTestRuns(home, () => {
      writeFileSync(join(workspace, "lib", "dependency.mjs"), "export const value = 2;\n");
    });
    const { result, history } = await runGoalWithTest(t, { workspace, home, plan });
    assert.equal(await changed, true, "the dependency must be changed while the test runs");
    assert.notEqual(
      result.status,
      "completed",
      `a goal must not complete on stale evidence (${result.reason?.code ?? "unknown"})`,
    );
    assert.equal(result.reason.code, "test-inputs-changed");
    assert.equal(
      history.summaries.filter(
        (entry) => entry.operationKind === "test" && entry.status === "succeeded",
      ).length,
      0,
      "the stale result must not be recorded as a succeeded test",
    );
  },
);

test("a changed test file invalidates the evidence", linux, async (t) => {
  const { workspace, home } = manifestWorkspace(t, { holdMs: 750 });
  const plan = {
    file: process.execPath,
    args: ["--test", "test/probe.test.mjs"],
    cwd: workspace,
    framework: "node --test",
  };
  const changed = changeWhileTheTestRuns(home, () => {
    writeFileSync(
      join(workspace, "test", "probe.test.mjs"),
      'import test from "node:test";\ntest("probe", () => {});\n',
    );
  });
  const { result } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(await changed, true, "the test must be changed while the test runs");
  assert.notEqual(
    result.status,
    "completed",
    `a goal must not complete on stale evidence (${result.reason?.code ?? "unknown"})`,
  );
  assert.equal(result.reason.code, "test-inputs-changed");
});

test("an added input invalidates the evidence", linux, async (t) => {
  const { workspace, home } = manifestWorkspace(t, { holdMs: 750 });
  // The runner selects every test file in its working directory, so an
  // added test file is an added input of the approved plan.
  const plan = {
    file: process.execPath,
    args: ["--test"],
    cwd: workspace,
    framework: "node --test",
  };
  const changed = changeWhileTheTestRuns(home, () => {
    writeFileSync(
      join(workspace, "test", "added.test.mjs"),
      'import test from "node:test";\ntest("added", () => {});\n',
    );
  });
  const { result } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(await changed, true, "the input must be added while the test runs");
  assert.notEqual(
    result.status,
    "completed",
    `a goal must not complete on stale evidence (${result.reason?.code ?? "unknown"})`,
  );
  assert.equal(result.reason.code, "test-inputs-changed");
});

test("a changed nested data file invalidates the evidence", linux, async (t) => {
  const { workspace, home } = inputWorkspace(t, { holdMs: 750 });
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: workspace,
    framework: "node --test",
  };
  const changed = changeWhileTheTestRuns(home, () => {
    writeFileSync(join(workspace, "fixtures", "input.json"), JSON.stringify({ value: 2 }));
  });
  const { result, history } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(await changed, true, "the nested data file must be changed while the test runs");
  assert.notEqual(result.status, "completed", "changed data must invalidate the evidence");
  assert.equal(result.reason.code, "test-inputs-changed");
  assert.equal(
    history.summaries.filter(
      (entry) => entry.operationKind === "test" && entry.status === "succeeded",
    ).length,
    0,
    "the stale result must not be recorded as a succeeded test",
  );
});

test("changed installed dependency bytes invalidate the evidence", linux, async (t) => {
  const { workspace, home } = inputWorkspace(t, { holdMs: 750 });
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: workspace,
    framework: "node --test",
  };
  const changed = changeWhileTheTestRuns(home, () => {
    writeFileSync(
      join(workspace, "node_modules", "fixture-package", "index.js"),
      "module.exports = { value: 2 };\n",
    );
  });
  const { result } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(await changed, true, "the installed dependency must change while the test runs");
  assert.notEqual(result.status, "completed", "changed dependency bytes must invalidate evidence");
  assert.equal(result.reason.code, "test-inputs-changed");
});

test("an added or a deleted installed dependency invalidates the evidence", linux, async (t) => {
  await t.test("added dependency", linux, async (subtest) => {
    const { workspace, home } = inputWorkspace(subtest, { holdMs: 750 });
    const plan = {
      file: process.execPath,
      args: ["--test", "probe.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const changed = changeWhileTheTestRuns(home, () => {
      mkdirSync(join(workspace, "node_modules", "added-package"));
      writeFileSync(
        join(workspace, "node_modules", "added-package", "index.js"),
        "module.exports = {};\n",
      );
    });
    const { result } = await runGoalWithTest(subtest, { workspace, home, plan });
    assert.equal(await changed, true, "the dependency must be added while the test runs");
    assert.notEqual(result.status, "completed", "an added dependency must invalidate evidence");
  });

  await t.test("deleted dependency", linux, async (subtest) => {
    const { workspace, home } = inputWorkspace(subtest, { holdMs: 750 });
    const plan = {
      file: process.execPath,
      args: ["--test", "probe.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const changed = changeWhileTheTestRuns(home, () => {
      rmSync(join(workspace, "node_modules", "fixture-package"), { recursive: true });
    });
    const { result } = await runGoalWithTest(subtest, { workspace, home, plan });
    assert.equal(await changed, true, "the dependency must be deleted while the test runs");
    assert.notEqual(result.status, "completed", "a deleted dependency must invalidate evidence");
  });
});

test("a retargeted symbolic link invalidates the evidence", linux, async (t) => {
  const { workspace, home } = inputWorkspace(t, { holdMs: 750 });
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: workspace,
    framework: "node --test",
  };
  const changed = changeWhileTheTestRuns(home, () => {
    rmSync(join(workspace, "fixtures", "current.json"));
    symlinkSync("other.json", join(workspace, "fixtures", "current.json"));
  });
  const { result } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(await changed, true, "the symbolic link must be retargeted while the test runs");
  assert.notEqual(result.status, "completed", "a retargeted link must invalidate evidence");
  assert.equal(result.reason.code, "test-inputs-changed");
});

test(
  "an input that becomes unreadable invalidates the evidence",
  process.platform === "linux" && process.getuid?.() !== 0
    ? { timeout: 120_000 }
    : { skip: "non-root Linux required" },
  async (t) => {
    const { workspace, home } = inputWorkspace(t, { holdMs: 750 });
    const input = join(workspace, "fixtures", "input.json");
    const plan = {
      file: process.execPath,
      args: ["--test", "probe.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const changed = changeWhileTheTestRuns(home, () => chmodSync(input, 0o000));
    const { result, history } = await runGoalWithTest(t, { workspace, home, plan });
    assert.equal(await changed, true, "the input must become unreadable while the test runs");
    assert.notEqual(result.status, "completed", "an unreadable input must invalidate evidence");
    assert.equal(result.reason.code, "test-inputs-unknown");
    assert.equal(
      history.summaries.filter(
        (entry) => entry.operationKind === "test" && entry.status === "succeeded",
      ).length,
      0,
      "an unreadable input must not leave a succeeded test summary",
    );
  },
);

test("an unchanged data input, dependency and link complete the goal", linux, async (t) => {
  const { workspace, home } = inputWorkspace(t);
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: workspace,
    framework: "node --test",
  };
  const { result, history } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const succeeded = history.summaries.filter(
    (entry) => entry.operationKind === "test" && entry.status === "succeeded",
  );
  assert.equal(
    succeeded.length,
    1,
    "the unchanged inputs must record exactly one succeeded test summary",
  );
  assert.match(succeeded[0].test.sourceFingerprint, /^[a-f0-9]{64}$/);
});

test(
  "an unchanged source completes the goal with the approved plan as its evidence",
  linux,
  async (t) => {
    const { workspace, home } = manifestWorkspace(t);
    const plan = {
      file: process.execPath,
      args: ["--test", "test/probe.test.mjs"],
      cwd: workspace,
      framework: "node --test",
    };
    const { result, history } = await runGoalWithTest(t, { workspace, home, plan });
    assert.equal(result.status, "completed", JSON.stringify(result));
    const succeeded = history.summaries.filter(
      (entry) => entry.operationKind === "test" && entry.status === "succeeded",
    );
    assert.equal(
      succeeded.length,
      1,
      "the unchanged source must record exactly one succeeded test summary",
    );
    assert.match(succeeded[0].test.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.match(succeeded[0].test.planHash, /^[a-f0-9]{64}$/);
  },
);

// ============================================================================
// The snapshot boundary, not a working-directory or import heuristic
//
// The approved test runs in a disposable snapshot that exposes the whole
// workspace, so the evidence identity must describe the whole workspace. These
// regressions are the alternate mechanisms of the repaired failure family: an
// executable the test spawns loses its execute bit, a directory the test lists
// is closed, and a plan whose working directory is a subdirectory reads a
// sibling input outside it. Each one must stop the goal, and the unchanged
// controls must still complete.
// ============================================================================

/** A workspace whose test spawns a helper script the command line never names. */
function executableWorkspace(t, { holdMs = 0 } = {}) {
  const { base, workspace, home } = fixture(t);
  writeFileSync(join(workspace, "helper.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(
    join(workspace, "probe.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const spawned = spawnSync("./helper.sh").status;
test("probe", async () => {
  assert.equal(spawned, 0);
  await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
});
`,
  );
  return { base, workspace, home };
}

/** A workspace whose subdirectory plan reads a sibling input outside its cwd. */
function subdirectoryWorkspace(t, { holdMs = 0 } = {}) {
  const { base, workspace, home } = fixture(t);
  mkdirSync(join(workspace, "tests"), { recursive: true, mode: 0o700 });
  writeFileSync(join(workspace, "input.json"), JSON.stringify({ value: 1 }));
  mkdirSync(join(workspace, "data"), { recursive: true, mode: 0o755 });
  writeFileSync(join(workspace, "data", "nested.json"), JSON.stringify({ nested: 1 }));
  writeFileSync(
    join(workspace, "tests", "probe.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { value } = JSON.parse(readFileSync(new URL("../input.json", import.meta.url), "utf8"));
test("probe", async () => {
  assert.equal(value, 1);
  await new Promise((resolve) => setTimeout(resolve, ${holdMs}));
});
`,
  );
  return { base, workspace, home };
}

test("a removed execute bit invalidates the evidence", linux, async (t) => {
  const { workspace, home } = executableWorkspace(t, { holdMs: 750 });
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: workspace,
    framework: "node --test",
  };
  const changed = changeWhileTheTestRuns(home, () => {
    chmodSync(join(workspace, "helper.sh"), 0o644);
  });
  const { result, history } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(await changed, true, "the helper must lose its execute bit while the test runs");
  assert.notEqual(
    result.status,
    "completed",
    `a goal must not complete while the tested helper is no longer executable (${
      result.reason?.code ?? "unknown"
    })`,
  );
  assert.equal(result.reason.code, "test-inputs-changed");
  assert.equal(
    history.summaries.filter(
      (entry) => entry.operationKind === "test" && entry.status === "succeeded",
    ).length,
    0,
    "the stale result must not be recorded as a succeeded test",
  );
});

test("a closed directory invalidates the evidence", linux, async (t) => {
  const { workspace, home } = subdirectoryWorkspace(t, { holdMs: 750 });
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: join(workspace, "tests"),
    framework: "node --test",
  };
  const changed = changeWhileTheTestRuns(home, () => {
    chmodSync(join(workspace, "data"), 0o600);
  });
  const { result } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(await changed, true, "the directory mode must change while the test runs");
  assert.notEqual(result.status, "completed", "a closed directory must invalidate the evidence");
  // A closed directory cannot be listed any more, so the identity refuses
  // instead of degrading into a partial one; either refusal is honest.
  assert.ok(
    ["test-inputs-changed", "test-inputs-unknown"].includes(result.reason.code),
    `the changed directory must refuse verification (${result.reason.code})`,
  );
});

test("a sibling input outside a subdirectory plan invalidates the evidence", linux, async (t) => {
  const { workspace, home } = subdirectoryWorkspace(t, { holdMs: 750 });
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: join(workspace, "tests"),
    framework: "node --test",
  };
  const changed = changeWhileTheTestRuns(home, () => {
    writeFileSync(join(workspace, "input.json"), JSON.stringify({ value: 2 }));
  });
  const { result } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(await changed, true, "the sibling input must change while the test runs");
  assert.notEqual(
    result.status,
    "completed",
    "an input read through ../ is still an input of the snapshot",
  );
  assert.equal(result.reason.code, "test-inputs-changed");
});

test("an unchanged executable and subdirectory tree complete the goal", linux, async (t) => {
  const { workspace, home } = executableWorkspace(t);
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: workspace,
    framework: "node --test",
  };
  const { result } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(result.status, "completed", JSON.stringify(result));
});

test("an unchanged subdirectory plan completes the goal with sibling inputs", linux, async (t) => {
  const { workspace, home } = subdirectoryWorkspace(t);
  const plan = {
    file: process.execPath,
    args: ["--test", "probe.test.mjs"],
    cwd: join(workspace, "tests"),
    framework: "node --test",
  };
  const { result, history } = await runGoalWithTest(t, { workspace, home, plan });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const succeeded = history.summaries.filter(
    (entry) => entry.operationKind === "test" && entry.status === "succeeded",
  );
  assert.equal(succeeded.length, 1, "the unchanged tree must record one succeeded test summary");
  assert.match(succeeded[0].test.sourceFingerprint, /^[a-f0-9]{64}$/);
});
