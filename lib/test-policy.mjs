// ============================================================================
// Repository-test trust policy.
//
// Test plans are executable code, not passive project metadata. A workspace and
// its exact executable + argv + current package script hash must be approved
// before a child starts. The policy is deliberately independent of edit
// approval: `--yes` for edits is not test trust, and no OS sandbox is implied.
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

import { matrixHome } from "./session.mjs";

export const TEST_ORIGIN = Object.freeze({
  USER: "user-/test",
  MODEL: "model-or-automatic",
});

const STORE_VERSION = 1;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_WORKSPACES = 100;
const MAX_PLANS_PER_WORKSPACE = 20;
const MAX_ARGS = 128;
const MAX_ARG_CHARS = 32 * 1024;
const MAX_SCRIPT_CHARS = 256 * 1024;
const contextStorage = new AsyncLocalStorage();

const hash = (value) => createHash("sha256").update(value).digest("hex");
const emptyStore = () => ({ version: STORE_VERSION, workspaces: {} });

function privateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

function trustPath(home) {
  return join(home, "trust", "test-plans.json");
}

function readStore(home) {
  const path = trustPath(home);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return emptyStore();
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed?.version !== STORE_VERSION ||
      !parsed.workspaces ||
      typeof parsed.workspaces !== "object"
    ) {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}

function writeStore(home, store) {
  const path = trustPath(home);
  privateDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(store), { mode: 0o600 });
    renameSync(temp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // The partial private temp file may not exist.
    }
    return false;
  }
}

function pruneStore(store) {
  const workspaces = Object.entries(store.workspaces)
    .sort((a, b) => Number(b[1]?.approvedAt ?? 0) - Number(a[1]?.approvedAt ?? 0))
    .slice(0, MAX_WORKSPACES);
  store.workspaces = Object.fromEntries(
    workspaces.map(([id, workspace]) => {
      const plans = Object.entries(workspace?.plans ?? {})
        .sort((a, b) => Number(b[1]?.approvedAt ?? 0) - Number(a[1]?.approvedAt ?? 0))
        .slice(0, MAX_PLANS_PER_WORKSPACE);
      return [
        id,
        {
          workspace: String(workspace?.workspace ?? ""),
          approvedAt: Number(workspace?.approvedAt ?? 0),
          plans: Object.fromEntries(plans),
        },
      ];
    }),
  );
}

function updateStore(home, update) {
  // Re-read and merge immediately before each synchronous write so independent
  // policy instances do not intentionally replace unrelated trust decisions.
  const store = readStore(home);
  update(store);
  pruneStore(store);
  return writeStore(home, store);
}

function executableCandidates(file, cwd, env) {
  if (file.includes("/") || file.includes("\\")) return [resolve(cwd, file)];
  const extensions =
    process.platform === "win32"
      ? String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  const dirs = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);
  const candidates = [];
  for (const dir of dirs) {
    for (const extension of extensions) {
      candidates.push(join(dir, `${file}${extension.toLowerCase()}`));
      if (process.platform === "win32" && extension.toLowerCase() !== extension) {
        candidates.push(join(dir, `${file}${extension.toUpperCase()}`));
      }
    }
  }
  return candidates;
}

function resolveExecutable(file, cwd, env) {
  for (const candidate of executableCandidates(file, cwd, env)) {
    try {
      if (!statSync(candidate).isFile()) continue;
      if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function quoted(value) {
  const text = String(value);
  return text.length > 0 && !/[\s"']/.test(text) ? text : JSON.stringify(text);
}

function commandFor(executable, args) {
  return [executable, ...args].map(quoted).join(" ");
}

function packageScripts(cwd) {
  const path = join(cwd, "package.json");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES)
    throw new Error("package.json is missing or too large to approve safely");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const test = manifest?.scripts?.test;
  if (typeof test !== "string" || !test.trim())
    throw new Error("package.json no longer has a test script");
  if (test.length > MAX_SCRIPT_CHARS) throw new Error("test script is too large to approve safely");
  const scripts = { test };
  for (const name of ["pretest", "posttest"]) {
    const value = manifest.scripts?.[name];
    if (value == null) continue;
    if (typeof value !== "string" || value.length > MAX_SCRIPT_CHARS) {
      throw new Error(`${name} script is too large or invalid to approve safely`);
    }
    scripts[name] = value;
  }
  return scripts;
}

/**
 * Resolve fresh execution metadata. In particular, npm's pretest/test/posttest
 * strings are re-read from package.json rather than trusting a stale index.
 * Nothing in this function spawns a process.
 */
export function inspectTestPlan(plan, { cwd = null, env = process.env } = {}) {
  try {
    if (!plan || typeof plan.file !== "string" || !plan.file.trim()) {
      return { ok: false, error: "test plan has no executable" };
    }
    const args = (plan.args ?? []).map(String);
    if (
      !Array.isArray(plan.args ?? []) ||
      args.length > MAX_ARGS ||
      args.some((arg) => arg.length > MAX_ARG_CHARS)
    ) {
      return { ok: false, error: "test plan argv is invalid or too large to approve safely" };
    }
    const requestedCwd = cwd ?? plan.cwd ?? process.cwd();
    const workspace = realpathSync(resolve(requestedCwd));
    if (!statSync(workspace).isDirectory())
      return { ok: false, error: "test workspace is not a directory" };

    const executable = resolveExecutable(plan.file, workspace, env);
    if (!executable)
      return { ok: false, error: `test executable not found or not executable: ${plan.file}` };

    const isNpm = /^(?:npm|npm\.cmd)$/i.test(plan.file);
    let scripts = null;
    let script = null;
    if (isNpm) {
      scripts = packageScripts(workspace);
      script = scripts.test;
    } else if (plan.script != null) {
      script = String(plan.script);
      if (script.length > MAX_SCRIPT_CHARS)
        return { ok: false, error: "test script is too large to approve safely" };
      scripts = { test: script };
    }

    const scriptHash = scripts ? hash(JSON.stringify(scripts)) : null;
    const workspaceHash = hash(workspace);
    const planHash = hash(
      JSON.stringify({
        version: 1,
        workspaceHash,
        executable,
        args,
        cwd: workspace,
        scriptHash,
      }),
    );
    const descriptor = {
      requestedExecutable: plan.file,
      executable,
      args: Object.freeze(args),
      cwd: workspace,
      workspace,
      workspaceHash,
      command: commandFor(executable, args),
      script,
      scripts: scripts ? Object.freeze(scripts) : null,
      scriptHash,
      planHash,
      framework: plan.framework ?? "generic",
    };
    return { ok: true, plan: Object.freeze(descriptor) };
  } catch (error) {
    return { ok: false, error: `cannot inspect test plan: ${error.message}` };
  }
}

/** Allowlisted execution fields; intentionally excludes environment and output. */
export function testPlanAudit(plan) {
  if (!plan) return null;
  return {
    executable: plan.executable,
    requestedExecutable: plan.requestedExecutable,
    argv: [...plan.args],
    cwd: plan.cwd,
    command: plan.command,
    script: plan.script,
    scripts: plan.scripts ? { ...plan.scripts } : null,
    scriptHash: plan.scriptHash,
    planHash: plan.planHash,
    workspaceHash: plan.workspaceHash,
  };
}

export function redactTestPlan(plan, redactor) {
  const audit = testPlanAudit(plan);
  if (!audit) return null;
  const redact = (value) => (typeof value === "string" ? redactor.text(value) : value);
  return {
    ...audit,
    executable: redact(audit.executable),
    requestedExecutable: redact(audit.requestedExecutable),
    argv: audit.argv.map(redact),
    cwd: redact(audit.cwd),
    command: redact(audit.command),
    script: redact(audit.script),
    scripts: audit.scripts
      ? Object.fromEntries(
          Object.entries(audit.scripts).map(([key, value]) => [key, redact(value)]),
        )
      : null,
  };
}

function approvalDecision(value) {
  if (value === "once") return { approved: true, persist: false };
  if (value === true || ["y", "yes", "a", "always", "approve", "approved"].includes(value)) {
    return { approved: true, persist: true };
  }
  return { approved: false, persist: false };
}

function makePolicy(options, sharedState) {
  const home = options.home ?? matrixHome();
  const headless = Boolean(options.headless);
  const allowStored = options.allowStored ?? !headless;
  const allowTests = Boolean(options.allowTests);
  const requestApproval = options.requestApproval ?? null;

  /** @param {{plan?: *, cwd?: string|null, env?: NodeJS.ProcessEnv, origin?: string, signal?: AbortSignal|null}} [options] */
  const authorize = async ({
    plan,
    cwd = null,
    env = process.env,
    origin = TEST_ORIGIN.USER,
    signal = null,
  } = {}) => {
    const inspected = inspectTestPlan(plan, { cwd, env });
    if (!inspected.ok) return { ok: false, reason: inspected.error, plan: null };
    const descriptor = inspected.plan;
    const denied = (reason) => ({ ok: false, reason, plan: descriptor, origin });
    if (signal?.aborted) return denied("aborted while waiting for test trust");

    // A headless run needs a per-invocation allow decision by default. Stored
    // interactive trust is used only when an embedding caller explicitly opts
    // into it with allowStored: true.
    if (allowTests) {
      const identity = { workspaceHash: descriptor.workspaceHash, planHash: descriptor.planHash };
      if (
        sharedState.allowed &&
        (sharedState.allowed.workspaceHash !== identity.workspaceHash ||
          sharedState.allowed.planHash !== identity.planHash)
      ) {
        return denied(
          "the dedicated test allow flag covers only the first exact test plan in this invocation",
        );
      }
      sharedState.allowed = identity;
      return {
        ok: true,
        plan: descriptor,
        origin,
        decision: "allow-flag",
        grants: ["workspace", "test-plan"],
      };
    }

    if (headless && !allowStored) {
      return denied(
        "headless test execution requires the dedicated --allow-tests decision for this exact plan",
      );
    }

    const store = readStore(home);
    const workspace = store.workspaces[descriptor.workspaceHash];
    const workspaceTrusted = allowStored && workspace?.workspace === descriptor.workspace;
    const planTrusted =
      allowStored && workspaceTrusted && Boolean(workspace?.plans?.[descriptor.planHash]);

    if (workspaceTrusted && planTrusted) {
      return { ok: true, plan: descriptor, origin, decision: "stored", grants: [] };
    }

    if (signal?.aborted) return denied("aborted while waiting for test trust");
    if (typeof requestApproval !== "function") {
      return denied(
        workspaceTrusted
          ? "test plan or script hash is not trusted; interactive approval is required"
          : "workspace is not trusted for test execution; interactive approval is required",
      );
    }

    const request = (kind) => ({
      kind,
      origin,
      headless,
      workspace: descriptor.workspace,
      workspaceHash: descriptor.workspaceHash,
      command: descriptor.command,
      executable: descriptor.executable,
      argv: [...descriptor.args],
      script: descriptor.script,
      scripts: descriptor.scripts ? { ...descriptor.scripts } : null,
      scriptHash: descriptor.scriptHash,
      planHash: descriptor.planHash,
      plan: descriptor,
      signal,
    });

    const grants = [];
    if (!workspaceTrusted) {
      let raw;
      try {
        raw = await requestApproval(request("workspace"));
      } catch {
        return denied("workspace trust approval failed; test execution was not started");
      }
      const decision = approvalDecision(raw);
      if (!decision.approved) return denied("workspace trust was denied");
      if (signal?.aborted) return denied("aborted while waiting for test trust");
      grants.push(decision.persist ? "workspace" : "workspace-once");
      if (decision.persist) {
        if (
          !updateStore(home, (next) => {
            next.workspaces[descriptor.workspaceHash] = {
              workspace: descriptor.workspace,
              approvedAt: Date.now(),
              plans: next.workspaces[descriptor.workspaceHash]?.plans ?? {},
            };
          })
        )
          return denied("workspace trust could not be persisted; test execution was not started");
      }
    }

    if (!planTrusted) {
      let raw;
      try {
        raw = await requestApproval(request("test-plan"));
      } catch {
        return denied("test-plan approval failed; test execution was not started");
      }
      const decision = approvalDecision(raw);
      if (!decision.approved) return denied("test plan or script hash was denied");
      if (signal?.aborted) return denied("aborted while waiting for test trust");
      grants.push(decision.persist ? "test-plan" : "test-plan-once");
      if (decision.persist) {
        if (
          !updateStore(home, (next) => {
            const current = next.workspaces[descriptor.workspaceHash];
            next.workspaces[descriptor.workspaceHash] = {
              workspace: descriptor.workspace,
              approvedAt: current?.approvedAt ?? Date.now(),
              plans: {
                ...(current?.plans ?? {}),
                [descriptor.planHash]: { approvedAt: Date.now() },
              },
            };
          })
        )
          return denied("test-plan trust could not be persisted; test execution was not started");
      }
    }

    return {
      ok: true,
      plan: descriptor,
      origin,
      decision: grants.some((grant) => grant.endsWith("once")) ? "once" : "callback",
      grants,
    };
  };

  return {
    authorize,
    withRequestApproval(callback) {
      return makePolicy({ ...options, requestApproval: callback }, sharedState);
    },
  };
}

export function createTestPolicy(options = {}) {
  return makePolicy(options, { allowed: null });
}

/** Propagate one policy/audit identity through agent calls without changing tool schemas. */
export function withTestExecutionContext(context, callback) {
  const parent = contextStorage.getStore() ?? {};
  const inheritedSecrets = parent.secretValues ?? [];
  const ownSecrets = context.secretValues ?? [];
  return contextStorage.run(
    {
      ...parent,
      ...context,
      secretValues: [...inheritedSecrets, ...ownSecrets],
    },
    callback,
  );
}

export function currentTestExecutionContext() {
  return contextStorage.getStore() ?? null;
}

/** Test-only/introspection helper for checking store permissions without exposing approvals. */
export function testTrustStorePath(home = matrixHome()) {
  return trustPath(home);
}
