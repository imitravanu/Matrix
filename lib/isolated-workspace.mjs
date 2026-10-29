// Private fixed-batch workspace leases: bounded copies for non-git roots and
// detached worktrees for supported clean repositories. No original working file is edited.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  cleanupWorkspaceSnapshot,
  createWorkspaceSnapshot,
  WORKSPACE_SNAPSHOT_LIMITS,
} from "./linux-snapshot.mjs";

const MAX_GIT_OUTPUT = 256 * 1024;
const GIT_LOCKS = new Map();

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function git(root, args, { input = undefined, raw = false } = {}) {
  try {
    const output = execFileSync(
      "git",
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-C",
        root,
        ...args,
      ],
      {
        encoding: raw ? null : "utf8",
        input,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeout: 5000,
        maxBuffer: MAX_GIT_OUTPUT,
        env: Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        ),
      },
    );
    // Git permits non-UTF-8 names. Replacing invalid bytes could cause
    // check-attr to inspect a different path and miss a filter, so fail closed.
    const text = raw
      ? new TextDecoder("utf-8", { fatal: true }).decode(output)
      : String(output ?? "");
    if (Buffer.byteLength(text) > MAX_GIT_OUTPUT) {
      return { ok: false, code: "truncated", error: "git output was truncated" };
    }
    return { ok: true, text: raw || !text.endsWith("\n") ? text : text.slice(0, -1) };
  } catch (error) {
    const truncated =
      error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      /max\s*buffer/i.test(error?.message ?? "");
    return {
      ok: false,
      code: truncated ? "truncated" : (error?.code ?? "git-failed"),
      status: error?.status,
      stderr: String(error?.stderr ?? ""),
      error: truncated ? "git output was truncated" : error.message,
    };
  }
}

// Git status is run with a private repository configuration and a frozen copy
// of the real index. Repository/global filter commands cannot be discovered by
// this Git process, even if their configuration or attributes change mid-run.
function isolatedGitStatus(root, head, gitInfo) {
  const shadow = mkdtempSync(join(tmpdir(), "matrix-git-inspect-"));
  let descriptor;
  try {
    const before = lstatSync(gitInfo.index, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32n * 1024n * 1024n) {
      throw new Error("Git index is not a supported bounded regular file");
    }
    descriptor = openSync(
      gitInfo.index,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("Git index changed while opening it");
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error("Git index was truncated while copying it");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, null) !== 0) {
      throw new Error("Git index grew while copying it");
    }
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(gitInfo.index, { bigint: true });
    if (
      bytes.length !== Number(opened.size) ||
      [after, current].some(
        (entry) =>
          entry.dev !== opened.dev ||
          entry.ino !== opened.ino ||
          entry.size !== opened.size ||
          entry.mtimeNs !== opened.mtimeNs ||
          entry.ctimeNs !== opened.ctimeNs,
      )
    ) {
      throw new Error("Git index changed while copying it");
    }
    mkdirSync(join(shadow, "refs", "heads"), { recursive: true });
    const sha256 = gitInfo.objectFormat === "sha256";
    if (!sha256 && gitInfo.objectFormat !== "sha1")
      throw new Error("Unsupported Git object format");
    writeFileSync(
      join(shadow, "config"),
      `[core]\nrepositoryformatversion = ${sha256 ? 1 : 0}\nbare = false\n${sha256 ? "[extensions]\nobjectFormat = sha256\n" : ""}`,
      { mode: 0o600 },
    );
    writeFileSync(join(shadow, "HEAD"), `${head}\n`, { mode: 0o600 });
    writeFileSync(join(shadow, "index"), bytes, { mode: 0o600 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    Object.assign(env, {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OBJECT_DIRECTORY: gitInfo.objects,
      GIT_OPTIONAL_LOCKS: "0",
    });
    const runShadow = (args) =>
      execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.attributesFile=/dev/null",
          `--git-dir=${shadow}`,
          `--work-tree=${root}`,
          ...args,
        ],
        {
          encoding: null,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 5000,
          maxBuffer: MAX_GIT_OUTPUT,
          env,
        },
      );
    const flags = new TextDecoder("utf-8", { fatal: true }).decode(
      runShadow(["ls-files", "-v", "-z"]),
    );
    if (
      flags &&
      (!flags.endsWith("\0") ||
        flags
          .split("\0")
          .slice(0, -1)
          .some((entry) => !entry.startsWith("H ")))
    ) {
      throw new Error("Git index flags can hide working-tree changes");
    }
    const output = new TextDecoder("utf-8", { fatal: true }).decode(
      runShadow(["status", "--porcelain=v1", "--untracked-files=all"]),
    );
    return { ok: true, text: output.trim() };
  } catch (error) {
    return { ok: false, error: error.message, code: error.code ?? "git-uncertain" };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(shadow, { recursive: true, force: true });
  }
}

// Parallel agents must not run Git status in a shared worktree: project
// discovery presents Git metadata as unavailable instead of spawning it.
export function refuseParallelGitMetadata() {
  const error = new Error("Git metadata is unavailable in isolated parallel discovery");
  error.code = "MATRIX_GIT_DISABLED";
  throw error;
}

function failure(code, error) {
  return { ok: false, code, error };
}

/** Serialize operations that mutate shared `.git/worktrees` administrative state. */
export function withSerializedGitMetadata(key, operation) {
  const previous = GIT_LOCKS.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  GIT_LOCKS.set(key, tail);
  void tail.then(() => {
    if (GIT_LOCKS.get(key) === tail) GIT_LOCKS.delete(key);
  });
  return run;
}

/**
 * Inspect freshness and eligibility without creating directories or changing git
 * metadata. Dirty, nested, unborn, truncated, and uncertain states fail closed.
 */
export function inspectIsolationRoot(workspace) {
  let root;
  try {
    root = realpathSync(resolve(workspace));
    if (!statSync(root).isDirectory())
      return failure("not-directory", "Workspace is not a directory");
  } catch (error) {
    return failure("workspace-unavailable", error.message);
  }

  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    const notRepository = top.status === 128 && /not a git repository/i.test(top.stderr);
    if (!notRepository) return failure("git-uncertain", `Cannot establish git state: ${top.error}`);
    if (existsSync(join(root, ".git"))) {
      return failure("git-uncertain", "A .git entry exists but its repository state is unreadable");
    }
    return { ok: true, kind: "copy", root, git: null };
  }

  let repoRoot;
  try {
    repoRoot = realpathSync(top.text);
  } catch (error) {
    return failure("git-uncertain", error.message);
  }
  if (repoRoot !== root) {
    return failure("nested-git", "Isolated git execution requires the repository top-level root");
  }

  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!head.ok) {
    const symbolic = git(root, ["symbolic-ref", "-q", "HEAD"]);
    if (head.status === 128 && symbolic.ok) {
      return failure("unborn-git", "Cannot isolate a repository with an unborn HEAD");
    }
    return failure("git-uncertain", `Cannot establish the base commit: ${head.error}`);
  }

  // Validate filename bytes without consulting executable filters. Split-index
  // metadata cannot be reproduced in the private inspection repository safely.
  const tracked = git(root, ["ls-files", "--cached", "-z"], { raw: true });
  if (!tracked.ok) return failure("git-uncertain", "Cannot inspect tracked files safely");
  const sharedIndex = git(root, ["rev-parse", "--shared-index-path"]);
  if (!sharedIndex.ok || sharedIndex.text) {
    return failure(
      "git-uncertain",
      "Split or unreadable Git indexes are not supported for isolation",
    );
  }
  const index = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const objects = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  const objectFormat = git(root, ["rev-parse", "--show-object-format"]);
  if (!index.ok || !objects.ok || !objectFormat.ok) {
    return failure("git-uncertain", "Cannot locate Git index or object storage safely");
  }
  const status = isolatedGitStatus(root, head.text, {
    index: index.text,
    objects: objects.text,
    objectFormat: objectFormat.text,
  });
  if (!status.ok)
    return failure("git-uncertain", `Cannot inspect Git status safely: ${status.error}`);
  if (status.text)
    return failure(
      "dirty-git",
      "Git worktree isolation requires a clean repository under sanitized inspection; custom normalization or ignore settings may require a copy",
    );

  const common = git(root, ["rev-parse", "--git-common-dir"]);
  if (!common.ok || !common.text)
    return failure("git-uncertain", "Cannot locate shared git metadata");
  const commonDir = resolve(root, common.text);
  return {
    ok: true,
    kind: "worktree",
    root,
    git: {
      repoRoot,
      head: head.text,
      commonDir,
      objects: objects.text,
      objectFormat: objectFormat.text,
    },
  };
}

function validateLocations(sourceRoot, scratchDir, matrixHome) {
  const scratch = resolve(scratchDir);
  if (inside(sourceRoot, scratch)) {
    throw new Error("Isolation scratch must be outside the original workspace");
  }
  if (matrixHome != null) {
    const home = resolve(matrixHome);
    if (inside(sourceRoot, home))
      throw new Error("MATRIX_HOME must be outside the original workspace");
    if (inside(home, scratch) || inside(scratch, home)) {
      throw new Error("Isolation scratch and MATRIX_HOME must not contain one another");
    }
  }
}

/** Create one lease. The returned cleanup method is idempotent and retryable. */
export async function createIsolatedWorkspaceLease(
  workspace,
  {
    kind = null,
    scratchDir = tmpdir(),
    matrixHome = null,
    limits = {},
    signal = null,
    snapshotImpl = createWorkspaceSnapshot,
    cleanupSnapshotImpl = cleanupWorkspaceSnapshot,
  } = {},
) {
  if (process.platform !== "linux") {
    throw new Error("Parallel workspace isolation currently requires Linux");
  }
  const inspected = inspectIsolationRoot(workspace);
  if (!inspected.ok) throw new Error(inspected.error);
  if (kind != null && kind !== inspected.kind) {
    throw new Error(
      `Isolation kind changed during setup: expected ${kind}, found ${inspected.kind}`,
    );
  }
  if (signal?.aborted) throw new Error("Workspace lease aborted before setup");
  validateLocations(inspected.root, scratchDir, matrixHome);
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const scratch = realpathSync(scratchDir);
  validateLocations(inspected.root, scratch, matrixHome);
  const container = mkdtempSync(join(scratch, "matrix-lease-"));
  chmodSync(container, 0o700);

  let snapshot = null;
  let lease = null;
  let cleaned = false;
  let cleanupPromise = null;
  let cleanupAttempts = 0;
  let lastCleanupError = null;
  let nestedCleanupError = null;
  let retryNestedCleanup = null;

  const cleanupNested = async () => {
    if (!nestedCleanupError) return null;
    if (typeof retryNestedCleanup !== "function") return nestedCleanupError;
    try {
      const result = await retryNestedCleanup();
      if (result?.ok) {
        nestedCleanupError = null;
        return null;
      }
      nestedCleanupError = result?.error || "snapshot cleanup failed without details";
    } catch (error) {
      nestedCleanupError = error.message;
    }
    return nestedCleanupError;
  };

  const cleanup = () => {
    if (cleaned) return Promise.resolve({ ok: true, retryable: false, error: null });
    if (cleanupPromise) return cleanupPromise;
    cleanupAttempts += 1;
    const operation = (async () => {
      const errors = [];
      const nestedError = await cleanupNested();
      if (nestedError) errors.push(`snapshot setup cleanup failed: ${nestedError}`);
      if (lease.kind === "worktree") {
        try {
          await withSerializedGitMetadata(lease.git.commonDir, () => {
            const removed = git(lease.sourceRoot, ["worktree", "remove", "--force", lease.root]);
            if (!removed.ok) {
              // Setup may fail before registration. Verify absence rather than
              // treating either a missing directory or a failed removal as proof.
              const listed = git(lease.sourceRoot, ["worktree", "list", "--porcelain", "-z"]);
              if (!listed.ok || listed.text.split("\0").includes(`worktree ${lease.root}`)) {
                throw new Error(`git worktree cleanup failed: ${removed.error}`);
              }
            }
          });
        } catch (error) {
          errors.push(error.message);
        }
      }
      if (snapshot && errors.length === 0) {
        try {
          const result = cleanupSnapshotImpl(snapshot);
          if (!result.ok) errors.push(result.error);
        } catch (error) {
          errors.push(error.message);
        }
      }

      if (errors.length === 0) {
        try {
          rmSync(container, { recursive: true, force: true });
        } catch (error) {
          errors.push(`lease cleanup failed: ${error.message}`);
        }
      }
      if (errors.length > 0) {
        lastCleanupError = errors.join("; ");
        return {
          ok: false,
          retryable: !nestedCleanupError || typeof retryNestedCleanup === "function",
          error: lastCleanupError,
        };
      }
      cleaned = true;
      lastCleanupError = null;
      return { ok: true, retryable: false, error: null };
    })();
    cleanupPromise = operation;
    void operation.then(() => {
      if (cleanupPromise === operation) cleanupPromise = null;
    });
    return operation;
  };

  try {
    if (inspected.kind === "copy") {
      snapshot = snapshotImpl(inspected.root, {
        scratchDir: container,
        matrixHome,
        limits,
        signal,
      });
      lease = {
        kind: "copy",
        root: snapshot.workspacePath,
        container,
        sourceRoot: inspected.root,
        git: null,
        setup: {
          kind: "copy",
          filtered: snapshot.stats.omittedEntries > 0 || snapshot.stats.unsupportedEntries > 0,
          exact: snapshot.stats.omittedEntries === 0 && snapshot.stats.unsupportedEntries === 0,
          omissions: snapshot.stats.omittedEntries,
          unsupportedEntries: snapshot.stats.unsupportedEntries,
          stats: { ...snapshot.stats },
        },
      };
    } else {
      const workspacePath = join(container, "workspace");
      lease = {
        kind: "worktree",
        root: workspacePath,
        container,
        sourceRoot: inspected.root,
        git: { ...inspected.git },
        setup: null,
      };
      await withSerializedGitMetadata(inspected.git.commonDir, () => {
        if (signal?.aborted) throw new Error("Workspace lease aborted before worktree setup");
        const fresh = inspectIsolationRoot(inspected.root);
        if (!fresh.ok || fresh.kind !== "worktree" || fresh.git.head !== inspected.git.head) {
          throw new Error("Git baseline changed before worktree setup");
        }
        const added = git(inspected.root, [
          "worktree",
          "add",
          "--detach",
          "--no-checkout",
          workspacePath,
          inspected.git.head,
        ]);
        if (!added.ok) throw new Error(`git worktree setup failed: ${added.error}`);
      });
      if (signal?.aborted) throw new Error("Workspace lease aborted before snapshot setup");
      const tracked = git(
        inspected.root,
        ["ls-tree", "-r", "-z", "--name-only", inspected.git.head],
        { raw: true },
      );
      if (!tracked.ok || (tracked.text && !tracked.text.endsWith("\0"))) {
        throw new Error("Cannot enumerate pinned Git tree safely");
      }
      const included = new Set();
      for (const path of tracked.text.split("\0").filter(Boolean)) {
        const parts = path.split("/");
        if (
          parts.length > WORKSPACE_SNAPSHOT_LIMITS.depth + 1 ||
          Buffer.byteLength(path) > 4096 ||
          parts.some((part) => !part || part === "." || part === "..")
        ) {
          throw new Error("Pinned Git tree contains an unsafe or overly deep path");
        }
        for (let index = 1; index <= parts.length; index += 1)
          included.add(parts.slice(0, index).join("/"));
      }
      const initialized = git(workspacePath, ["read-tree", inspected.git.head]);
      if (!initialized.ok) throw new Error(`git index setup failed: ${initialized.error}`);
      snapshot = snapshotImpl(inspected.root, {
        scratchDir: container,
        matrixHome,
        limits,
        signal,
        includePath: (path) => included.has(path),
      });
      const rootMode = statSync(snapshot.workspacePath).mode & 0o777;
      chmodSync(snapshot.workspacePath, 0o700);
      for (const name of readdirSync(snapshot.workspacePath)) {
        if (signal?.aborted) throw new Error("Workspace lease aborted while populating worktree");
        renameSync(join(snapshot.workspacePath, name), join(workspacePath, name));
      }
      chmodSync(workspacePath, rootMode);
      lease.setup = {
        kind: "worktree",
        filtered: true,
        exact: false,
        omissions: snapshot.stats.omittedEntries,
        unsupportedEntries: snapshot.stats.unsupportedEntries,
        detachedHead: inspected.git.head,
        stats: { ...snapshot.stats },
      };
    }

    lease.cleanup = cleanup;
    lease.cleanupMetadata = () => ({
      cleaned,
      attempts: cleanupAttempts,
      error: lastCleanupError,
      retryable: !cleaned && lastCleanupError != null,
    });
    return lease;
  } catch (error) {
    if (error.cleanupError) {
      nestedCleanupError = String(error.cleanupError);
      retryNestedCleanup = error.retryCleanup;
    }
    if (lease) {
      const result = await cleanup();
      if (!result.ok) {
        error.cleanupError = result.error;
        if (result.retryable) error.retryCleanup = cleanup;
        else delete error.retryCleanup;
      } else {
        delete error.cleanupError;
        delete error.retryCleanup;
      }
    } else {
      const retryCleanup = async () => {
        try {
          const nestedError = await cleanupNested();
          if (nestedError)
            return {
              ok: false,
              retryable: typeof retryNestedCleanup === "function",
              error: `snapshot setup cleanup failed: ${nestedError}`,
            };
          if (snapshot) {
            const result = cleanupSnapshotImpl(snapshot);
            if (!result.ok) return { ok: false, error: result.error };
          }
          rmSync(container, { recursive: true, force: true });
          return { ok: true, error: null };
        } catch (cleanupFailure) {
          return { ok: false, error: cleanupFailure.message };
        }
      };
      const result = await retryCleanup();
      if (!result.ok) {
        error.cleanupError = result.error;
        if (result.retryable !== false) error.retryCleanup = retryCleanup;
        else delete error.retryCleanup;
      } else {
        delete error.cleanupError;
        delete error.retryCleanup;
      }
    }
    throw error;
  }
}

export { WORKSPACE_SNAPSHOT_LIMITS };
