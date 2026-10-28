import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { createIsolatedWorkspaceLease, inspectIsolationRoot } from "../lib/isolated-workspace.mjs";
import { cleanupWorkspaceSnapshot } from "../lib/linux-snapshot.mjs";
import { makeTempDir, patchEnv } from "./helpers.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function fixture(t, prefix = "matrix-isolation-") {
  const root = makeTempDir(prefix);
  const workspace = join(root, "workspace");
  const scratch = join(root, "scratch");
  const home = join(root, "home");
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, scratch, home };
}

function initRepository(workspace) {
  git(workspace, "init", "-q");
  git(workspace, "config", "user.email", "matrix-fixture@example.invalid");
  git(workspace, "config", "user.name", "Matrix Fixture");
  writeFileSync(join(workspace, "tracked.txt"), "base\n");
  git(workspace, "add", "tracked.txt");
  git(workspace, "commit", "-q", "-m", "fixture base");
}

test("copy leases preserve bytes, modes, and symlink targets while reporting filtered omissions", async (t) => {
  const { workspace, scratch, home } = fixture(t);
  writeFileSync(join(workspace, "executable.txt"), "original\n", { mode: 0o751 });
  symlinkSync("executable.txt", join(workspace, "alias.txt"));
  writeFileSync(join(workspace, ".env"), "fixture-only-secret\n");
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());

  assert.equal(lease.kind, "copy");
  assert.notEqual(lease.root, workspace);
  assert.equal(readFileSync(join(lease.root, "executable.txt"), "utf8"), "original\n");
  assert.equal(readlinkSync(join(lease.root, "alias.txt")), "executable.txt");
  assert.equal(statMode(join(lease.root, "executable.txt")), 0o751);
  assert.equal(existsSync(join(lease.root, ".env")), false);
  assert.equal(lease.setup.filtered, true);
  assert.equal(lease.setup.exact, false);
  assert.ok(lease.setup.omissions >= 1);

  writeFileSync(join(lease.root, "executable.txt"), "isolated\n");
  assert.equal(readFileSync(join(workspace, "executable.txt"), "utf8"), "original\n");
  assert.equal(readlinkSync(join(workspace, "alias.txt")), "executable.txt");
  const first = await lease.cleanup();
  const second = await lease.cleanup();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(existsSync(lease.container), false);
});

test("copy limits fail honestly and cleanup failures are retryable without false success", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-isolation-retry-");
  writeFileSync(join(workspace, "a.txt"), "a\n");
  writeFileSync(join(workspace, "b.txt"), "b\n");
  mkdirSync(scratch);
  await assert.rejects(
    createIsolatedWorkspaceLease(workspace, {
      scratchDir: scratch,
      matrixHome: home,
      limits: { entries: 1 },
    }),
    /entry budget/,
  );
  assert.deepEqual(readdirSync(scratch), []);

  let injected = true;
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
    cleanupSnapshotImpl(snapshot) {
      if (injected) {
        injected = false;
        return { ok: false, error: "injected cleanup failure" };
      }
      return cleanupWorkspaceSnapshot(snapshot);
    },
  });
  t.after(() => lease.cleanup());
  const failed = await lease.cleanup();
  assert.equal(failed.ok, false);
  assert.equal(failed.retryable, true);
  assert.match(failed.error, /injected/);
  assert.equal(existsSync(lease.root), true);
  const retried = await lease.cleanup();
  assert.equal(retried.ok, true);
  assert.equal(lease.cleanupMetadata().attempts, 2);
  assert.equal(existsSync(lease.container), false);
});

test("clean repositories get detached worktrees and cleanup removes shared metadata", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-worktree-");
  initRepository(workspace);
  const inspected = inspectIsolationRoot(workspace);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.kind, "worktree");

  const [first, second] = await Promise.all([
    createIsolatedWorkspaceLease(workspace, { scratchDir: scratch, matrixHome: home }),
    createIsolatedWorkspaceLease(workspace, { scratchDir: scratch, matrixHome: home }),
  ]);
  t.after(() => Promise.all([first.cleanup(), second.cleanup()]));
  assert.equal(first.kind, "worktree");
  assert.equal(second.kind, "worktree");
  assert.notEqual(first.root, second.root);
  assert.equal(git(first.root, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
  assert.equal(first.setup.detachedHead, inspected.git.head);
  writeFileSync(join(first.root, "tracked.txt"), "first isolated change\n");
  writeFileSync(join(second.root, "tracked.txt"), "second isolated change\n");
  assert.equal(readFileSync(join(workspace, "tracked.txt"), "utf8"), "base\n");
  assert.equal(git(workspace, "status", "--porcelain"), "");

  assert.equal((await first.cleanup()).ok, true);
  assert.equal((await second.cleanup()).ok, true);
  const worktrees = git(workspace, "worktree", "list", "--porcelain");
  assert.equal(worktrees.includes(first.root), false);
  assert.equal(worktrees.includes(second.root), false);
  assert.equal(readFileSync(join(workspace, "tracked.txt"), "utf8"), "base\n");
});

test("worktree setup does not run repository hooks and missing worktrees still clean metadata", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-worktree-hooks-");
  initRepository(workspace);
  const marker = join(root, "hook-ran");
  const hook = join(workspace, ".git", "hooks", "post-checkout");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o755);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(existsSync(marker), false, "setup must not execute repository hooks");
  rmSync(lease.root, { recursive: true, force: true });
  const result = await lease.cleanup();
  assert.equal(result.ok, true, result.error);
  assert.equal(git(workspace, "worktree", "list", "--porcelain").includes(lease.root), false);
});

test("git isolation does not run configured clean or checkout filters", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-filter-hook-");
  initRepository(workspace);
  writeFileSync(join(workspace, ".gitattributes"), "tracked.txt filter=fixture\n");
  git(workspace, "add", ".gitattributes");
  git(workspace, "commit", "-q", "-m", "filter attribute fixture");
  const marker = join(root, "filter-ran");
  const filter = join(root, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(filter, 0o755);
  git(workspace, "config", "filter.fixture.clean", filter);
  git(workspace, "config", "filter.fixture.smudge", filter);
  const inspected = inspectIsolationRoot(workspace);
  assert.equal(inspected.ok, true);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(readFileSync(join(lease.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal(
    existsSync(marker),
    false,
    "Git inspection and worktree setup must not execute configured filters",
  );
  assert.equal((await lease.cleanup()).ok, true);
});

test("dirty, nested, and unborn git states fail before scratch side effects", async (t) => {
  const dirty = fixture(t, "matrix-dirty-repo-");
  initRepository(dirty.workspace);
  writeFileSync(join(dirty.workspace, "untracked.txt"), "do not hide baseline dirt\n");
  assert.equal(inspectIsolationRoot(dirty.workspace).code, "dirty-git");
  await assert.rejects(
    createIsolatedWorkspaceLease(dirty.workspace, { scratchDir: dirty.scratch }),
    /clean repository/,
  );
  assert.equal(existsSync(dirty.scratch), false);

  const nested = fixture(t, "matrix-nested-repo-");
  initRepository(nested.workspace);
  mkdirSync(join(nested.workspace, "sub"));
  writeFileSync(join(nested.workspace, "sub", "tracked.txt"), "nested\n");
  git(nested.workspace, "add", "sub/tracked.txt");
  git(nested.workspace, "commit", "-q", "-m", "nested fixture");
  assert.equal(inspectIsolationRoot(join(nested.workspace, "sub")).code, "nested-git");
  await assert.rejects(
    createIsolatedWorkspaceLease(join(nested.workspace, "sub"), { scratchDir: nested.scratch }),
    /top-level/,
  );
  assert.equal(existsSync(nested.scratch), false);

  const unborn = fixture(t, "matrix-unborn-repo-");
  git(unborn.workspace, "init", "-q");
  assert.equal(inspectIsolationRoot(unborn.workspace).code, "unborn-git");
  await assert.rejects(
    createIsolatedWorkspaceLease(unborn.workspace, { scratchDir: unborn.scratch }),
    /unborn HEAD/,
  );
  assert.equal(existsSync(unborn.scratch), false);
});

function statMode(path) {
  return statSync(path).mode & 0o777;
}

test("git isolation disables configured filesystem monitor commands", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-fsmonitor-");
  initRepository(workspace);
  const marker = join(root, "monitor-ran");
  const monitor = join(root, "monitor.sh");
  writeFileSync(monitor, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  chmodSync(monitor, 0o755);
  git(workspace, "config", "core.fsmonitor", monitor);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(existsSync(marker), false, "inspection must not execute a repository fsmonitor");
  assert.equal((await lease.cleanup()).ok, true);
});

test("filter inspection handles tracked names with whitespace and newlines", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-filter-name-");
  initRepository(workspace);
  const name = " odd name\n.txt";
  writeFileSync(join(workspace, name), "content\n");
  git(workspace, "add", name);
  git(workspace, "commit", "-q", "-m", "unusual tracked filename");
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(readFileSync(join(lease.root, name), "utf8"), "content\n");
  assert.equal((await lease.cleanup()).ok, true);
});

test("literal filter names matching Git's sentinel labels are never executed", async (t) => {
  for (const name of ["unspecified", "unset"]) {
    const { root, workspace, scratch, home } = fixture(t, `matrix-filter-${name}-`);
    initRepository(workspace);
    writeFileSync(join(workspace, ".gitattributes"), `tracked.txt filter=${name}\n`);
    git(workspace, "add", ".gitattributes");
    git(workspace, "commit", "-q", "-m", "filter sentinel fixture");
    const marker = join(root, "filter-ran");
    const filter = join(root, "filter.sh");
    writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
    chmodSync(filter, 0o755);
    git(workspace, "config", `filter.${name}.smudge`, filter);
    const lease = await createIsolatedWorkspaceLease(workspace, {
      scratchDir: scratch,
      matrixHome: home,
    });
    t.after(() => lease.cleanup());
    assert.equal(existsSync(marker), false);
    assert.equal((await lease.cleanup()).ok, true);
  }
});

test(
  "non-UTF-8 tracked names fail closed before worktree creation",
  { skip: process.platform === "win32" },
  async (t) => {
    const { workspace, scratch, home } = fixture(t, "matrix-filter-invalid-name-");
    initRepository(workspace);
    const name = Buffer.concat([Buffer.from(`${workspace}/invalid-`), Buffer.from([0xff])]);
    writeFileSync(name, "tracked\n");
    git(workspace, "add", "--all");
    git(workspace, "commit", "-q", "-m", "invalid byte name fixture");
    const inspected = inspectIsolationRoot(workspace);
    assert.equal(inspected.ok, false);
    assert.match(inspected.error, /tracked files safely/);
    await assert.rejects(
      createIsolatedWorkspaceLease(workspace, { scratchDir: scratch, matrixHome: home }),
      /tracked files safely/,
    );
    assert.equal(existsSync(scratch), false);
  },
);

test("an unreferenced Git filter does not block a normal clean worktree", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-unused-filter-");
  initRepository(workspace);
  const marker = join(root, "filter-ran");
  const filter = join(root, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(filter, 0o755);
  git(workspace, "config", "filter.unused.clean", filter);
  git(workspace, "config", "filter.unused.smudge", filter);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(join(lease.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal((await lease.cleanup()).ok, true);
});

test("Git configuration changes during status and worktree setup cannot launch filters", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-git-config-race-");
  initRepository(workspace);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const marker = join(root, "filter-ran");
  const injected = join(root, "injected");
  const filter = join(root, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(filter, 0o755);
  const wrapperDir = join(root, "wrapper");
  mkdirSync(wrapperDir);
  const wrapper = join(wrapperDir, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh
case " $* " in
  *" status --porcelain=v1 "*)
    if [ ! -e '${injected}' ]; then
      printf 'tracked.txt filter=race\n' > '${workspace}/.git/info/attributes'
      '${realGit}' -C '${workspace}' config filter.race.clean '${filter}'
      '${realGit}' -C '${workspace}' config filter.race.smudge '${filter}'
      touch '${injected}'
    fi ;;
esac
exec '${realGit}' "$@"
`,
  );
  chmodSync(wrapper, 0o755);
  const restore = patchEnv({ PATH: `${wrapperDir}:${process.env.PATH}` });
  t.after(restore);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(existsSync(injected), true, "the fixture changed Git config during inspection");
  assert.equal(existsSync(marker), false, "the raced filter must not run");
  assert.equal(readFileSync(join(lease.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal((await lease.cleanup()).ok, true);
  assert.equal(existsSync(marker), false);
});

test("Git configuration changes immediately before worktree creation cannot launch filters", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-git-add-race-");
  initRepository(workspace);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const marker = join(root, "filter-ran");
  const injected = join(root, "injected");
  const filter = join(root, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(filter, 0o755);
  const wrapperDir = join(root, "wrapper");
  mkdirSync(wrapperDir);
  const wrapper = join(wrapperDir, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh
case " $* " in
  *" worktree add "*)
    if [ ! -e '${injected}' ]; then
      printf 'tracked.txt filter=race\n' > '${workspace}/.git/info/attributes'
      '${realGit}' -C '${workspace}' config filter.race.clean '${filter}'
      '${realGit}' -C '${workspace}' config filter.race.smudge '${filter}'
      touch '${injected}'
    fi ;;
esac
exec '${realGit}' "$@"
`,
  );
  chmodSync(wrapper, 0o755);
  const restore = patchEnv({ PATH: `${wrapperDir}:${process.env.PATH}` });
  t.after(restore);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(
    existsSync(injected),
    true,
    "the fixture changed Git config immediately before worktree creation",
  );
  assert.equal(existsSync(marker), false, "the raced filter must not run");
  assert.equal(readFileSync(join(lease.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal((await lease.cleanup()).ok, true);
  assert.equal(existsSync(marker), false);
});

test("assume-unchanged and skip-worktree flags cannot hide a dirty baseline", async (t) => {
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const { workspace, scratch, home } = fixture(t, "matrix-index-hidden-");
    initRepository(workspace);
    git(workspace, "update-index", flag, "tracked.txt");
    writeFileSync(join(workspace, "tracked.txt"), "hidden modification\n");
    const inspected = inspectIsolationRoot(workspace);
    assert.equal(inspected.ok, false);
    assert.match(inspected.error, /index flags/);
    await assert.rejects(
      createIsolatedWorkspaceLease(workspace, { scratchDir: scratch, matrixHome: home }),
      /index flags/,
    );
    assert.equal(existsSync(scratch), false);
  }
});

test("worktree snapshot cleanup failures are visible and retryable after Git metadata removal", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-worktree-snapshot-retry-");
  initRepository(workspace);
  let failOnce = true;
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
    cleanupSnapshotImpl(snapshot) {
      if (failOnce) {
        failOnce = false;
        return { ok: false, error: "injected snapshot cleanup failure" };
      }
      return cleanupWorkspaceSnapshot(snapshot);
    },
  });
  t.after(() => lease.cleanup());
  const failed = await lease.cleanup();
  assert.equal(failed.ok, false);
  assert.equal(failed.retryable, true);
  assert.match(failed.error, /injected snapshot/);
  assert.equal(git(workspace, "worktree", "list", "--porcelain").includes(lease.root), false);
  assert.equal(existsSync(lease.container), true);
  assert.equal((await lease.cleanup()).ok, true);
  assert.equal(existsSync(lease.container), false);
});

test("private Git status refuses unstaged and staged tracked changes", async (t) => {
  for (const staged of [false, true]) {
    const { workspace, scratch, home } = fixture(t, "matrix-private-git-dirty-");
    initRepository(workspace);
    writeFileSync(join(workspace, "tracked.txt"), "dirty\n");
    if (staged) git(workspace, "add", "tracked.txt");
    const inspected = inspectIsolationRoot(workspace);
    assert.equal(inspected.ok, false);
    assert.equal(inspected.code, "dirty-git");
    await assert.rejects(
      createIsolatedWorkspaceLease(workspace, { scratchDir: scratch, matrixHome: home }),
      /clean repository/,
    );
    assert.equal(existsSync(scratch), false);
  }
});

test("split Git indexes fail closed before creating a worktree", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-git-split-index-");
  initRepository(workspace);
  git(workspace, "update-index", "--split-index");
  const inspected = inspectIsolationRoot(workspace);
  assert.equal(inspected.ok, false);
  assert.match(inspected.error, /Split or unreadable Git indexes/);
  await assert.rejects(
    createIsolatedWorkspaceLease(workspace, { scratchDir: scratch, matrixHome: home }),
    /Split or unreadable/,
  );
  assert.equal(existsSync(scratch), false);
});

test("Git worktrees use bounded snapshots and report ignored and sensitive omissions honestly", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-git-snapshot-content-");
  initRepository(workspace);
  writeFileSync(join(workspace, ".gitignore"), "cache.txt\n.env\n");
  git(workspace, "add", ".gitignore");
  git(workspace, "commit", "-q", "-m", "ignore fixture");
  writeFileSync(join(workspace, "cache.txt"), "ignored local data\n");
  writeFileSync(join(workspace, ".env"), "fixture secret\n");
  git(workspace, "add", "-f", ".env");
  git(workspace, "commit", "-q", "-m", "tracked sensitive name fixture");
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(
    existsSync(join(lease.root, "cache.txt")),
    false,
    "ignored files must not enter Git worktrees",
  );
  assert.equal(existsSync(join(lease.root, ".env")), false);
  assert.equal(lease.setup.filtered, true);
  assert.ok(lease.setup.omissions >= 2, ".git and .env were omitted");
  assert.equal((await lease.cleanup()).ok, true);
});

test("linked Git worktrees can be safely inspected and isolated", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-linked-worktree-");
  initRepository(workspace);
  const linked = join(root, "linked");
  git(workspace, "worktree", "add", "--detach", linked, "HEAD");
  const lease = await createIsolatedWorkspaceLease(linked, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(lease.kind, "worktree");
  assert.equal(readFileSync(join(lease.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal((await lease.cleanup()).ok, true);
});

test("SHA-256 Git repositories can be safely inspected and isolated", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-sha256-repo-");
  try {
    git(workspace, "init", "-q", "--object-format=sha256");
  } catch {
    t.skip("installed Git lacks SHA-256 repository support");
    return;
  }
  git(workspace, "config", "user.email", "matrix-fixture@example.invalid");
  git(workspace, "config", "user.name", "Matrix Fixture");
  writeFileSync(join(workspace, "tracked.txt"), "base\n");
  git(workspace, "add", "tracked.txt");
  git(workspace, "commit", "-q", "-m", "sha256 fixture");
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.match(lease.setup.detachedHead, /^[a-f0-9]{64}$/);
  assert.equal(readFileSync(join(lease.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal((await lease.cleanup()).ok, true);
});

test("unsupported platforms fail before isolation side effects", (t) => {
  const { workspace, scratch } = fixture(t, "matrix-unsupported-platform-");
  const moduleUrl = new URL("../lib/isolated-workspace.mjs", import.meta.url).href;
  const script = `Object.defineProperty(process, "platform", { value: "darwin" });
    const { createIsolatedWorkspaceLease } = await import(${JSON.stringify(moduleUrl)});
    try { await createIsolatedWorkspaceLease(${JSON.stringify(workspace)}, { scratchDir: ${JSON.stringify(scratch)} }); process.exitCode = 2; }
    catch (error) { if (!/requires Linux/.test(error.message)) process.exitCode = 3; }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
  assert.equal(existsSync(scratch), false);
});

test("Git environment configuration cannot inject a filter into isolation", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-git-env-filter-");
  initRepository(workspace);
  writeFileSync(join(workspace, ".gitattributes"), "tracked.txt filter=fixture\n");
  git(workspace, "add", ".gitattributes");
  git(workspace, "commit", "-q", "-m", "filter fixture");
  const marker = join(root, "filter-ran");
  const filter = join(root, "filter.sh");
  writeFileSync(filter, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  chmodSync(filter, 0o755);
  const restore = patchEnv({
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "filter.fixture.clean",
    GIT_CONFIG_VALUE_0: filter,
    GIT_CONFIG_KEY_1: "filter.fixture.smudge",
    GIT_CONFIG_VALUE_1: filter,
  });
  t.after(restore);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(existsSync(marker), false);
  assert.equal((await lease.cleanup()).ok, true);
  assert.equal(existsSync(marker), false);
});

test("overly deep pinned Git paths fail without leaving registered worktrees", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-git-deep-tree-");
  initRepository(workspace);
  let directory = workspace;
  for (let index = 0; index < 50; index += 1) {
    directory = join(directory, `d${index}`);
    mkdirSync(directory);
  }
  writeFileSync(join(directory, "leaf.txt"), "content\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-q", "-m", "deep tree fixture");
  await assert.rejects(
    createIsolatedWorkspaceLease(workspace, { scratchDir: scratch, matrixHome: home }),
    /overly deep path/,
  );
  const worktrees = git(workspace, "worktree", "list", "--porcelain");
  assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1);
  assert.deepEqual(readdirSync(scratch), []);
});

test("Git replacement refs cannot expose ignored files through the pinned-tree allowlist", async (t) => {
  const { workspace, scratch, home } = fixture(t, "matrix-git-replace-");
  initRepository(workspace);
  writeFileSync(join(workspace, ".gitignore"), "secret.txt\n");
  git(workspace, "add", ".gitignore");
  git(workspace, "commit", "-q", "-m", "ignore fixture");
  const original = git(workspace, "rev-parse", "HEAD");
  writeFileSync(join(workspace, "secret.txt"), "fixture secret\n");
  git(workspace, "add", "-f", "secret.txt");
  git(workspace, "commit", "-q", "-m", "replacement tree fixture");
  const replacement = git(workspace, "rev-parse", "HEAD");
  git(workspace, "reset", "--hard", original);
  writeFileSync(join(workspace, "secret.txt"), "fixture secret\n");
  git(workspace, "replace", original, replacement);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(existsSync(join(lease.root, "secret.txt")), false);
  assert.equal(readFileSync(join(lease.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal((await lease.cleanup()).ok, true);
});

test("Git workspace names ending in whitespace remain intact", async (t) => {
  const root = makeTempDir("matrix-git-trailing-space-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace ");
  mkdirSync(workspace);
  initRepository(workspace);
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: join(root, "scratch"),
    matrixHome: join(root, "home"),
  });
  t.after(() => lease.cleanup());
  assert.equal(lease.sourceRoot, workspace);
  assert.equal(readFileSync(join(lease.root, "tracked.txt"), "utf8"), "base\n");
  assert.equal((await lease.cleanup()).ok, true);
});

test("Git submodule contents are not copied into parent worktrees", async (t) => {
  const { root, workspace, scratch, home } = fixture(t, "matrix-git-submodule-");
  initRepository(workspace);
  const child = join(root, "child");
  mkdirSync(child);
  initRepository(child);
  git(workspace, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "sub");
  git(workspace, "commit", "-q", "-am", "add submodule fixture");
  const lease = await createIsolatedWorkspaceLease(workspace, {
    scratchDir: scratch,
    matrixHome: home,
  });
  t.after(() => lease.cleanup());
  assert.equal(existsSync(join(lease.root, "sub", "tracked.txt")), false);
  assert.equal((await lease.cleanup()).ok, true);
});
