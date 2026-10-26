// Strict, one-shot approval for executable-plus-argv command plans.
// This module never spawns a process and never accepts shell/environment/network options.

import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  closeSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const COMMAND_PLAN_VERSION = 1;
export const COMMAND_POLICY_IDENTITY = "matrix.run_sandboxed_command.v1";
export const COMMAND_ORIGIN = "run_sandboxed_command";
export const COMMAND_PLAN_LIMITS = Object.freeze({
  argv: 64,
  argumentBytes: 16 * 1024,
  argvBytes: 48 * 1024,
  pathBytes: 4096,
  inlineScriptBytes: 256 * 1024,
  fileScriptBytes: 256 * 1024,
  workspaceExecutableBytes: 32 * 1024 * 1024,
});

const INPUT_FIELDS = new Set(["executable", "argv", "cwd", "script", "scriptFile"]);
const HASH = /^[a-f0-9]{64}$/;
const EVAL_FLAGS = new Map([
  ["sh", new Set(["-c"])],
  ["bash", new Set(["-c"])],
  ["dash", new Set(["-c"])],
  ["zsh", new Set(["-c"])],
  ["node", new Set(["-e", "--eval"])],
  ["nodejs", new Set(["-e", "--eval"])],
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["perl", new Set(["-e", "-E"])],
  ["ruby", new Set(["-e"])],
  ["php", new Set(["-r"])],
]);

const hash = (value) => createHash("sha256").update(value).digest("hex");
const failure = (code, error, plan = null) => ({ ok: false, code, error, plan });

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pathText(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty path without NUL bytes`);
  }
  if (Buffer.byteLength(value) > COMMAND_PLAN_LIMITS.pathBytes) {
    throw new Error(`${label} exceeds its byte budget`);
  }
  return value;
}

function canonicalDirectory(path, label) {
  const canonical = realpathSync(resolve(pathText(path, label)));
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory`);
  return canonical;
}

function currentNodeExecutable() {
  try {
    return realpathSync(process.execPath);
  } catch {
    return null;
  }
}

function identity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left, right) {
  return Object.keys(identity(left)).every((key) => identity(left)[key] === identity(right)[key]);
}

function readRegularFile(path, maximumBytes, label = "script file") {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`${label} is not a regular file`);
  if (before.size > maximumBytes) throw new Error(`${label} exceeds its byte budget`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error(`${label} identity changed while it was being opened`);
    }
    const chunks = [];
    let total = 0;
    while (total <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
      const bytes = readSync(fd, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      chunks.push(chunk.subarray(0, bytes));
      total += bytes;
    }
    if (total > maximumBytes) throw new Error(`${label} exceeds its byte budget`);
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (!sameIdentity(opened, after) || !sameIdentity(opened, current)) {
      throw new Error(`${label} changed while its approved bytes were being read`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}

function quoted(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function evalArgument(executable, argv) {
  const flags = EVAL_FLAGS.get(basename(executable));
  if (!flags) return null;
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (flags.has(argv[index])) return { flag: argv[index], value: argv[index + 1] };
  }
  return null;
}

function validateScripts(input, executable, argv, workspace, cwd) {
  if (input.script != null && input.scriptFile != null) {
    throw new Error("declare either inline script or scriptFile, not both");
  }
  const scripts = [];
  let inline = null;
  let file = null;
  const evaluated = evalArgument(executable, argv);

  if (input.script != null) {
    if (typeof input.script !== "string" || input.script.includes("\0")) {
      throw new Error("inline script must be text without NUL bytes");
    }
    const bytes = Buffer.from(input.script, "utf8");
    if (bytes.length > COMMAND_PLAN_LIMITS.inlineScriptBytes) {
      throw new Error("inline script exceeds its byte budget");
    }
    if (!argv.includes(input.script)) {
      throw new Error("inline script declaration must exactly match one literal argv element");
    }
    if (evaluated && evaluated.value !== input.script) {
      throw new Error("inline script declaration does not match the interpreter eval argument");
    }
    inline = input.script;
    scripts.push({ kind: "inline", bytes: bytes.length, sha256: hash(bytes) });
  } else if (evaluated) {
    throw new Error(`interpreter ${evaluated.flag} requires an exact inline script declaration`);
  }

  if (input.scriptFile != null) {
    const requested = pathText(input.scriptFile, "scriptFile");
    const lexical = isAbsolute(requested) ? resolve(requested) : resolve(workspace, requested);
    if (!isInside(workspace, lexical))
      throw new Error("scriptFile traverses outside the workspace");
    const canonical = realpathSync(lexical);
    if (!isInside(workspace, canonical) || canonical !== lexical) {
      throw new Error("scriptFile must be a direct regular workspace path without symlinks");
    }
    const bytes = readRegularFile(canonical, COMMAND_PLAN_LIMITS.fileScriptBytes);
    if (!isUtf8(bytes)) throw new Error("scriptFile must contain valid UTF-8 for exact approval");
    const referenced = argv.some((argument) => {
      if (!argument || argument.includes("\0")) return false;
      const candidate = isAbsolute(argument) ? resolve(argument) : resolve(cwd, argument);
      return candidate === canonical;
    });
    if (!referenced) throw new Error("scriptFile must be referenced by one literal argv element");
    file = Object.freeze({
      path: canonical,
      relative: relative(workspace, canonical),
      bytes: bytes.length,
      sha256: hash(bytes),
      content: bytes.toString("utf8"),
    });
    scripts.push({
      kind: "file",
      path: canonical,
      relative: file.relative,
      bytes: bytes.length,
      sha256: file.sha256,
    });
  }

  return { inline, file, scripts };
}

/**
 * Canonicalize and freshly inspect a command plan. No PATH lookup, shell parsing,
 * ambient environment, network choice, or model-selected resource option exists.
 */
export function inspectCommandPlan(
  input,
  { workspace, policyIdentity = COMMAND_POLICY_IDENTITY } = {},
) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return failure("plan-malformed", "command plan must be an object");
    }
    for (const key of Object.keys(input)) {
      if (!INPUT_FIELDS.has(key)) {
        return failure("plan-malformed", `unsupported command plan field: ${key}`);
      }
    }
    if (typeof policyIdentity !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(policyIdentity)) {
      return failure("policy-identity-invalid", "command policy identity is invalid");
    }
    const root = canonicalDirectory(workspace, "workspace");
    const requestedCwd = pathText(input.cwd, "cwd");
    const lexicalCwd = isAbsolute(requestedCwd)
      ? resolve(requestedCwd)
      : resolve(root, requestedCwd);
    const cwd = realpathSync(lexicalCwd);
    if (!statSync(cwd).isDirectory())
      return failure("cwd-invalid", "command cwd is not a directory");
    if (!isInside(root, cwd)) return failure("cwd-outside", "command cwd is outside the workspace");

    const requestedExecutable = pathText(input.executable, "executable");
    if (!isAbsolute(requestedExecutable)) {
      return failure("executable-not-absolute", "command executable must be an absolute path");
    }
    const executable = realpathSync(requestedExecutable);
    if (!statSync(executable).isFile()) {
      return failure("executable-invalid", "command executable is not a regular file");
    }
    accessSync(executable, constants.X_OK);
    const workspaceExecutable = isInside(root, executable);
    const publicRuntimeExecutable = isInside("/usr", executable);
    if (
      !publicRuntimeExecutable &&
      !workspaceExecutable &&
      executable !== currentNodeExecutable()
    ) {
      return failure(
        "executable-outside-runtime",
        "command executable must resolve inside /usr, the workspace snapshot, or the exact current Node runtime",
      );
    }
    let executableFile = null;
    if (workspaceExecutable) {
      const bytes = readRegularFile(
        executable,
        COMMAND_PLAN_LIMITS.workspaceExecutableBytes,
        "workspace executable",
      );
      const current = lstatSync(executable);
      executableFile = Object.freeze({
        bytes: bytes.length,
        sha256: hash(bytes),
        dev: String(current.dev),
        ino: String(current.ino),
        mode: current.mode & 0o777,
        mtimeMs: current.mtimeMs,
        ctimeMs: current.ctimeMs,
      });
    }

    if (!Array.isArray(input.argv) || input.argv.length > COMMAND_PLAN_LIMITS.argv) {
      return failure("argv-invalid", "command argv is missing or exceeds its count budget");
    }
    let argvBytes = 0;
    for (const argument of input.argv) {
      if (typeof argument !== "string" || argument.includes("\0")) {
        return failure(
          "argv-invalid",
          "every command argv element must be literal text without NUL",
        );
      }
      const bytes = Buffer.byteLength(argument);
      if (bytes > COMMAND_PLAN_LIMITS.argumentBytes) {
        return failure("argv-too-large", "a command argv element exceeds its byte budget");
      }
      argvBytes += bytes;
    }
    if (argvBytes > COMMAND_PLAN_LIMITS.argvBytes) {
      return failure("argv-too-large", "command argv exceeds its total byte budget");
    }
    const argv = Object.freeze([...input.argv]);
    const declared = validateScripts(input, executable, argv, root, cwd);
    const scripts = Object.freeze(declared.scripts.map((script) => Object.freeze({ ...script })));
    const workspaceHash = hash(root);
    const scriptsHash = scripts.length > 0 ? hash(JSON.stringify(scripts)) : null;
    const planHash = hash(
      JSON.stringify({
        version: COMMAND_PLAN_VERSION,
        policyIdentity,
        workspace: root,
        executable,
        executableFile,
        argv,
        cwd,
        scripts,
      }),
    );
    const descriptor = {
      version: COMMAND_PLAN_VERSION,
      requestedExecutable,
      executable,
      executableFile,
      argv,
      cwd,
      workspace: root,
      workspaceHash,
      policyIdentity,
      command: [executable, ...argv].map(quoted).join(" "),
      script: declared.inline,
      scriptFile: declared.file,
      scripts,
      scriptsHash,
      planHash,
    };
    return { ok: true, plan: Object.freeze(descriptor) };
  } catch (error) {
    return failure("plan-inspection-failed", `cannot inspect command plan: ${error.message}`);
  }
}

/** Allowlisted, bounded audit metadata; deliberately excludes environment/output/script bytes. */
export function commandPlanAudit(plan) {
  if (!plan) return null;
  const inline = plan.scripts.find((script) => script.kind === "inline");
  const placeholder = inline ? `[inline-script sha256:${inline.sha256}]` : null;
  const argv = plan.argv.map((argument) =>
    inline && argument === plan.script ? placeholder : argument,
  );
  return {
    version: plan.version,
    executable: plan.executable,
    executableFile: plan.executableFile ? { ...plan.executableFile } : null,
    argv,
    cwd: plan.cwd,
    workspace: plan.workspace,
    workspaceHash: plan.workspaceHash,
    policyIdentity: plan.policyIdentity,
    command: [plan.executable, ...argv].map(quoted).join(" "),
    scripts: plan.scripts.map((script) => ({ ...script })),
    scriptsHash: plan.scriptsHash,
    planHash: plan.planHash,
  };
}

function approvedOnce(value) {
  return value === true || ["once", "y", "yes", "approve", "approved"].includes(value);
}

const APPROVAL_ABORTED = Symbol("approval-aborted");

function awaitApproval(callback, request, signal) {
  if (!signal) return Promise.resolve().then(() => callback(request));
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(APPROVAL_ABORTED);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (complete) => (value) => {
      signal.removeEventListener("abort", onAbort);
      complete(value);
    };
    Promise.resolve()
      .then(() => callback(request))
      .then(finish(resolve), finish(reject));
  });
}

/**
 * Create an independent capability + one-shot approval policy. No stored trust,
 * edit --yes state, allowTests flag, or ambient auto-approval is consulted.
 */
export function createCommandPolicy({
  enabled = false,
  headless = false,
  approvedPlanHash = null,
  requestApproval = null,
  policyIdentity = COMMAND_POLICY_IDENTITY,
} = {}) {
  const state = { pending: false, consumed: null };

  return {
    policyIdentity,
    async authorize(input, { workspace, signal = null } = {}) {
      const inspected = inspectCommandPlan(input, { workspace, policyIdentity });
      if (!inspected.ok) return { ...inspected, reason: inspected.error };
      const plan = inspected.plan;
      const deny = (code, reason) => ({ ok: false, code, reason, plan });
      if (signal?.aborted) return deny("aborted", "aborted before command approval");
      if (enabled !== true) {
        return deny("capability-disabled", "run_sandboxed_command capability is not enabled");
      }
      if (
        approvedPlanHash != null &&
        (typeof approvedPlanHash !== "string" || !HASH.test(approvedPlanHash))
      ) {
        return deny(
          "approval-hash-malformed",
          "approved command plan hash must be 64 lowercase hex characters",
        );
      }
      if (state.consumed)
        return deny("approval-replayed", "one-shot command approval was already consumed");
      if (state.pending)
        return deny("approval-replayed", "one-shot command approval is already in progress");
      if (headless && approvedPlanHash == null) {
        return deny(
          "headless-approval-required",
          "headless command execution requires an exact one-shot approvedPlanHash",
        );
      }
      if (approvedPlanHash != null && approvedPlanHash !== plan.planHash) {
        return deny(
          "approval-hash-mismatch",
          "command plan does not match the exact approved plan hash",
        );
      }
      if (approvedPlanHash == null && typeof requestApproval !== "function") {
        return deny("approval-required", "interactive per-command approval is required");
      }

      state.pending = true;
      try {
        let decision = approvedPlanHash == null ? "interactive-once" : "plan-hash";
        if (approvedPlanHash == null) {
          let raw;
          try {
            raw = await awaitApproval(
              requestApproval,
              {
                kind: "sandboxed-command",
                origin: COMMAND_ORIGIN,
                headless: Boolean(headless),
                executable: plan.executable,
                argv: [...plan.argv],
                cwd: plan.cwd,
                workspace: plan.workspace,
                command: plan.command,
                script: plan.script,
                scriptFile: plan.scriptFile,
                scripts: plan.scripts.map((script) => ({ ...script })),
                scriptsHash: plan.scriptsHash,
                planHash: plan.planHash,
                policyIdentity,
                plan,
                signal,
              },
              signal,
            );
          } catch {
            return deny("approval-failed", "command approval failed; execution was not started");
          }
          if (raw === APPROVAL_ABORTED)
            return deny("aborted", "aborted while waiting for command approval");
          if (!approvedOnce(raw)) {
            return deny(
              "approval-denied",
              raw === "a" || raw === "always"
                ? "persistent command approval is unsupported; approve one exact command once"
                : "exact command plan was denied",
            );
          }
        } else if (headless) {
          decision = "headless-plan-hash";
        }
        if (signal?.aborted) return deny("aborted", "aborted while waiting for command approval");

        // Close the approval-window race against every hashed field and declared byte.
        const fresh = inspectCommandPlan(input, { workspace, policyIdentity });
        if (!fresh.ok || fresh.plan.planHash !== plan.planHash) {
          return deny(
            "approval-window-changed",
            "command plan or declared script bytes changed while approval was being decided",
          );
        }
        state.consumed = plan.planHash;
        return { ok: true, plan: fresh.plan, decision };
      } finally {
        state.pending = false;
      }
    },
  };
}
