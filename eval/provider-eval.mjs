#!/usr/bin/env node

// ============================================================================
// Opt-in provider evaluation.
//
// This is deliberately separate from the default `npm run eval` profile. It
// runs one small, deterministic coding task through the real controller and
// model agent against one explicitly selected provider/model target. The
// workspace, controller home and backups live in a temporary tree. Nothing is
// sent to a provider unless the caller passes --provider and --model.
//
// A pass is evidence for this one run only. It is not availability, quality,
// pricing, context-length or latency evidence, and it never changes the
// reviewed default evaluation baseline.
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createRunController } from "../lib/controller.mjs";
import { createLinuxBwrapBackend } from "../lib/linux-bwrap.mjs";
import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from "../lib/linux-snapshot.mjs";
import { runTests } from "../lib/process.mjs";
import { detectProject } from "../lib/project.mjs";
import { loadProviderConfig } from "../lib/provider-config.mjs";
import { isExplicitBuiltinProvider, resolveProviderSelection } from "../lib/provider-contracts.mjs";
import { bindProviderTarget } from "../lib/provider-transport.mjs";
import { redactSecrets, truncateText } from "../lib/redaction.mjs";
import { matrixHome } from "../lib/session.mjs";
import { createTestPolicy } from "../lib/test-policy.mjs";
import { pickerModelFromTarget } from "../src/provider-picker.mjs";
import { canonicalJson, sha256 } from "./versions.mjs";

export const PROVIDER_EVAL_SCHEMA_VERSION = 1;
export const PROVIDER_EVAL_TASK_REVISION = "prv105-provider-edit-v4";
export const PROVIDER_EVAL_EVIDENCE_CLASS = "opt-in-provider";

const TASK = "Fix keepLast in src/bounds.js so it keeps the last element. Do not edit the test.";
const BUGGY_SOURCE = `export function keepLast(items) {\n  return items.slice(0, items.length - 1);\n}\n`;
const TEST_PATH = "test/bounds.test.mjs";
const PACKAGE_PATH = "package.json";
const ALLOWED_EDIT_PATH = "src/bounds.js";
const AUTHORITATIVE_TEST_TIMEOUT_MS = 30_000;
const TEST_SOURCE = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  "",
  'import { keepLast } from "../src/bounds.js";',
  "",
  'test("keeps the last element", () => {',
  "  assert.deepEqual(keepLast([]), []);",
  "  assert.deepEqual(keepLast([1]), [1]);",
  "  assert.deepEqual(keepLast([1, 2]), [1, 2]);",
  '  assert.deepEqual(keepLast(["a", "b", "c"]), ["a", "b", "c"]);',
  "});",
  "",
].join("\n");
const PACKAGE_SOURCE = `${JSON.stringify(
  { name: "matrix-provider-eval", private: true, type: "module", scripts: { test: "node --test" } },
  null,
  2,
)}\n`;
const FILES = Object.freeze({
  "package.json": PACKAGE_SOURCE,
  "src/bounds.js": BUGGY_SOURCE,
  [TEST_PATH]: TEST_SOURCE,
});
const TASK_DIGEST = sha256(
  canonicalJson({ revision: PROVIDER_EVAL_TASK_REVISION, task: TASK, files: FILES }),
);

function safeText(value, secret, maxChars = 300) {
  return truncateText(redactSecrets(String(value ?? ""), [secret]), maxChars);
}

function isLoopbackEndpoint(endpoint) {
  try {
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function compactUsage(usage, secret) {
  if (!usage || typeof usage !== "object") return null;
  const number = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
  const tokens =
    usage.provenance === "unavailable"
      ? null
      : {
          prompt: number(usage.prompt_tokens),
          completion: number(usage.completion_tokens),
          total: number(usage.total_tokens),
          cached: number(usage.cached_tokens),
        };
  return {
    provenance: safeText(usage.provenance ?? "unavailable", secret, 40),
    costProvenance: safeText(usage.costProvenance ?? "unavailable", secret, 40),
    costComplete: usage.costComplete === true,
    cost: number(usage.cost),
    tokens,
    rounds: {
      total: number(usage.rounds?.total),
      provider: number(usage.rounds?.provider),
      estimated: number(usage.rounds?.estimated),
      unavailable: number(usage.rounds?.unavailable),
    },
  };
}

function compactVerification(verification, secret) {
  if (!verification || typeof verification !== "object") return null;
  return {
    status: safeText(
      verification.verificationStatus ??
        (verification.ok === true ? "verified" : verification.ok === false ? "failed" : "unknown"),
      secret,
      40,
    ),
    ok: verification.ok === true,
    verified: verification.verified === true,
    passed: Number.isFinite(verification.passed) ? verification.passed : null,
    failed: Number.isFinite(verification.failed) ? verification.failed : null,
    skipped: verification.skipped === true,
    timedOut: verification.timedOut === true,
    aborted: verification.aborted === true,
    summary: verification.summary ? safeText(verification.summary, secret) : null,
  };
}

function writeWorkspace(workspace) {
  for (const [rel, text] of Object.entries(FILES)) {
    const path = join(workspace, rel);
    mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    writeFileSync(path, text, { mode: 0o640 });
  }
}

function readWorkspaceFile(workspace, rel) {
  try {
    return readFileSync(join(workspace, rel), "utf8");
  } catch {
    return null;
  }
}

function normalizeWorkspacePath(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    return null;
  }
  return normalized;
}

function jsonLiteral(value) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Scoring tests are generated in the evaluator process and delivered over
// stdin. The authoritative source therefore lives at no predictable path that
// the workspace process can pre-create, replace, or turn into a FIFO. The
// submitted bytes still evaluate only inside a null-prototype VM context with
// no imports or Node APIs; assertions, the completion token and result
// comparison remain in the host realm.
function authoritativeTestSource(source, completionToken, behavioral) {
  const invokeBinding = `__matrix_invoke_${randomBytes(16).toString("hex")}`;
  const submittedLiteral = jsonLiteral(source ?? BUGGY_SOURCE);
  return (
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { createContext, SourceTextModule, runInContext } from "node:vm";',
      "",
      "const context = createContext(Object.create(null), {",
      "  codeGeneration: { strings: false, wasm: false },",
      "});",
      "runInContext(`delete globalThis.console;`, context);",
      "",
      "// Capture the scoring intrinsics before submitted code evaluates. The",
      "// factory closes over them and over the candidate it is given.",
      "const invokeFactory = runInContext(",
      "  `(() => {",
      "    const encodeResult = JSON.stringify;",
      "    const isArrayResult = Array.isArray;",
      "    const isSafeInteger = Number.isSafeInteger;",
      "    return (candidate) => (value) => {",
      "      const result = candidate(value);",
      '      if (!isArrayResult(result)) throw new Error("array required");',
      "      const count = result.length;",
      '      if (!isSafeInteger(count) || count < 0 || count > 1000) throw new Error("invalid result length");',
      '      let out = "[";',
      "      for (let index = 0; index < count; index += 1) {",
      '        if (index > 0) out += ",";',
      "        const item = result[index];",
      "        const type = typeof item;",
      '        if (type === "string") {',
      '          if (item.length > 1024) throw new Error("string too large");',
      "          out += encodeResult(item);",
      '        } else if (type === "number" || type === "boolean") {',
      "          out += encodeResult(item);",
      "        } else if (item === null) {",
      '          out += "null";',
      "        } else {",
      '          throw new Error("non-primitive element");',
      "        }",
      '        if (out.length > 8192) throw new Error("result too large");',
      "      }",
      '      out += "]";',
      "      return out;",
      "    };",
      "  })()`,",
      "  context,",
      "  { timeout: 1000 },",
      ");",
      "",
      `const submittedSource = ${submittedLiteral};`,
      "const submitted = new SourceTextModule(submittedSource, {",
      "  context,",
      "  importModuleDynamically: () => {",
      '    throw runInContext(`new Error("imports unavailable")`, context);',
      "  },",
      "});",
      "await submitted.link(() => {",
      '  throw new Error("imports are unavailable for this pure-function task");',
      "});",
      "await submitted.evaluate({ timeout: 1000 });",
      "const candidate = submitted.namespace.keepLast;",
      'if (typeof candidate !== "function") throw new Error("keepLast is not an exported function");',
      "",
      "// The candidate is captured in this closure, not stored in a mutable",
      "// global. The invocation wrapper is installed under a random,",
      "// non-configurable name so submitted code cannot replace either one.",
      "const invoker = invokeFactory(candidate);",
      `const invokeBinding = ${jsonLiteral(invokeBinding)};`,
      "Object.defineProperty(context, invokeBinding, {",
      "  value: invoker,",
      "  writable: false,",
      "  configurable: false,",
      "  enumerable: false,",
      "});",
      "",
      "function keepLast(items) {",
      '  if (!Array.isArray(items) || items.length > 1000) throw new Error("invalid input array");',
      "  for (const item of items) {",
      "    const type = typeof item;",
      '    if (type !== "string" && type !== "number" && type !== "boolean" && item !== null) {',
      '      throw new Error("invalid input element");',
      "    }",
      "  }",
      "  const literal = JSON.stringify(items);",
      "  const encoded = runInContext(`${invokeBinding}(${literal})`, context, { timeout: 1000 });",
      '  if (typeof encoded !== "string") throw new Error("result serialization failed");',
      "  const parsed = JSON.parse(encoded);",
      '  if (!Array.isArray(parsed)) throw new Error("array required");',
      "  return parsed;",
      "}",
      "",
      `test(${jsonLiteral(
        behavioral ? "completed behavioral assertions" : "keeps the last element",
      )}, () => {`,
      "  assert.deepEqual(keepLast([]), []);",
      "  assert.deepEqual(keepLast([1]), [1]);",
      "  assert.deepEqual(keepLast([1, 2]), [1, 2]);",
      '  assert.deepEqual(keepLast(["a", "b", "c"]), ["a", "b", "c"]);',
      `  console.log(${jsonLiteral(completionToken)});`,
      "});",
      "",
    ].join("\n") + "\n"
  );
}

export async function runAuthoritativeVerification(
  root,
  source,
  { signal, timeoutMs = AUTHORITATIVE_TEST_TIMEOUT_MS, home = null, behavioral = false } = {},
) {
  const completionToken = `matrix-behavior-complete-${randomBytes(24).toString("hex")}`;
  let completed = false;
  let directory;
  try {
    mkdirSync(root, { recursive: true, mode: 0o750 });
    directory = mkdtempSync(join(root, "authoritative-"));
  } catch {
    return {
      ok: false,
      status: "fail",
      passed: null,
      failed: null,
      skipped: null,
      timedOut: false,
      error: "authoritative fixture directory could not be created",
    };
  }

  // The test source never touches disk. It is generated here and written to
  // the child's stdin, so the workspace process has no authoritative fixture
  // to pre-create, replace, or turn into a FIFO before scoring runs.
  const testSource = authoritativeTestSource(source, completionToken, behavioral);

  // The child executes model-written code inside the host test module. Supply
  // only the variables needed to launch Node, give it a disposable home, and
  // run it through the shared trusted test path: exact-plan authorization,
  // sanitized environment, bounded output, cancellation and trust/execution
  // audits all apply here. The environment is deliberately allowlisted rather
  // than derived from the parent, so arbitrary provider or repository
  // variables cannot be observed.
  const environment = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    HOME: directory,
    TMPDIR: directory,
    NO_COLOR: "1",
  };
  const auditHome = home ?? join(directory, "home");
  const plan = {
    file: process.execPath,
    args: ["--experimental-vm-modules", "--test-reporter=tap", "--input-type=module", "-"],
    cwd: directory,
    framework: "node --test",
    display: "node --test (inline authoritative source via stdin)",
  };
  const policy = createTestPolicy({
    home: auditHome,
    headless: true,
    allowTests: true,
  });
  try {
    const result = await runTests(plan, {
      policy,
      home: auditHome,
      cwd: directory,
      env: environment,
      input: testSource,
      timeoutMs,
      signal,
      cleanupProcessGroup: true,
      onLine: (line) => {
        const trimmed = line.trim();
        if (trimmed === completionToken || trimmed === `# ${completionToken}`) {
          completed = true;
        }
      },
    });
    const passed = Number.isFinite(result.passed) ? result.passed : null;
    const failed = Number.isFinite(result.failed) ? result.failed : null;
    const timedOut = result.timedOut === true;
    const aborted = result.aborted === true;
    const ok =
      result.ok === true &&
      !timedOut &&
      !aborted &&
      passed !== null &&
      passed > 0 &&
      failed === 0 &&
      completed;
    return {
      ok,
      status: ok ? "pass" : aborted ? "aborted" : timedOut ? "timed-out" : "fail",
      passed,
      failed,
      skipped: null,
      timedOut,
      aborted,
      signal: result.signal ?? null,
      auditStatus: result.auditStatus ?? null,
      outputTruncated: Boolean(
        result.outputTruncated || result.stdoutTruncated || result.stderrTruncated,
      ),
      error: ok
        ? null
        : timedOut
          ? "authoritative test timed out"
          : aborted
            ? "authoritative test aborted"
            : !completed
              ? "verification assertions did not complete (early exit or unhandled termination)"
              : result.trustReason
                ? result.trustReason
                : result.error
                  ? "authoritative test process failed"
                  : "authoritative verification did not pass",
    };
  } catch {
    return {
      ok: false,
      status: "fail",
      passed: null,
      failed: null,
      skipped: null,
      timedOut: false,
      aborted: false,
      signal: null,
      auditStatus: null,
      outputTruncated: false,
      error: "authoritative test execution failed",
    };
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // The owning temp root is removed by the caller; residue stays visible there.
    }
  }
}

function withWatchdog(pending, controller, timeoutMs) {
  let timer;
  return Promise.race([
    pending,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`provider eval watchdog fired after ${timeoutMs} ms`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function requireProviderEvalSandbox(sandbox) {
  const status = await sandbox.probe();
  if (!status.available) {
    throw new Error(`provider evaluation requires the Linux test sandbox: ${status.reason}`);
  }
}

/**
 * Run one explicit provider/model through the real controller on a temporary
 * fixture. Preflight failures (unknown provider, missing key, Local Forge)
 * throw before any request; a provider/agent failure is returned honestly.
 */
export async function runProviderEvaluation({
  home = matrixHome(),
  providerId,
  modelId,
  env = process.env,
  timeoutMs = 60_000,
  signal = null,
  onEvent = null,
} = {}) {
  if (signal?.aborted) throw new Error("provider evaluation aborted");
  if (typeof providerId !== "string" || !providerId) {
    throw new Error("provider evaluation requires a provider id");
  }
  if (typeof modelId !== "string" || !modelId.trim()) {
    throw new Error("provider evaluation requires an exact model id");
  }

  const loaded = loadProviderConfig({ home });
  if (loaded.status === "invalid") throw loaded.error;
  if (
    !isExplicitBuiltinProvider(providerId) &&
    !loaded.config.providers.some((profile) => profile.id === providerId)
  ) {
    throw new Error(`unknown provider "${providerId}"`);
  }
  const target = resolveProviderSelection({
    providerId,
    modelQuery: modelId,
    config: loaded.config,
  }).target;
  if (!target || target.kind === "local") {
    throw new Error(
      `provider "${providerId}" is local; the default offline eval covers Local Forge`,
    );
  }
  const binding = bindProviderTarget(target, env);
  if (!binding.ok) throw new Error(binding.error);
  const sandbox = createLinuxBwrapBackend();
  await requireProviderEvalSandbox(sandbox);
  if (signal?.aborted) throw new Error("provider evaluation aborted");
  const secret = binding.credential;
  const endpoint = binding.endpoint;

  const root = mkdtempSync(join(tmpdir(), "matrix-provider-eval-"));
  const workspace = join(root, "workspace");
  const controllerHome = join(root, "home");
  mkdirSync(workspace, { recursive: true, mode: 0o750 });
  mkdirSync(controllerHome, { recursive: true, mode: 0o700 });
  let controller = null;
  let rootRemoved = false;
  let disposed = false;
  let outcome = null;
  let error = null;
  // A holder keeps the post-run read visible to the report below without
  // tripping no-useless-assignment on a finally-block assignment.
  const finalState = { source: null, sourceBytes: null, testSource: null, packageSource: null };
  const deniedPaths = new Set();
  let authoritative;
  let behavioral;
  let abortRun = null;
  const events = [];
  let pendingApprovedSource = null;
  let appliedApprovedSource = null;
  const startedAt = new Date().toISOString();
  try {
    writeWorkspace(workspace);
    controller = createRunController({
      home: controllerHome,
      headless: true,
      allowTests: true,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "approval:request") {
          // The workspace is disposable, but the task only authorizes the one
          // source edit. Deny anything else so a model cannot rewrite the test
          // runner, fixture, or an unrelated path. A denial is recorded and
          // fails the scope check even when the final bytes stay intact.
          const requestedPath = normalizeWorkspacePath(event.proposal?.file);
          pendingApprovedSource = null;
          if (requestedPath === ALLOWED_EDIT_PATH) {
            if (typeof event.proposal?.updatedText === "string") {
              pendingApprovedSource = event.proposal.updatedText;
            }
            queueMicrotask(() => controller?.approve(signal?.aborted ? "n" : "y"));
          } else {
            deniedPaths.add(requestedPath ?? "<unknown>");
            queueMicrotask(() => controller?.approve("n"));
          }
        }
        if (event.type === "applied") {
          appliedApprovedSource =
            normalizeWorkspacePath(event.file) === ALLOWED_EDIT_PATH ? pendingApprovedSource : null;
          pendingApprovedSource = null;
        }
        if (onEvent) onEvent(event);
      },
    });
    abortRun = () => controller?.abort();
    signal?.addEventListener("abort", abortRun, { once: true });
    if (signal?.aborted) throw new Error("provider evaluation aborted");
    outcome = await withWatchdog(
      controller.start({
        task: TASK,
        project: detectProject(workspace),
        model: pickerModelFromTarget(target),
        providerTarget: target,
        providerBinding: binding,
        testEnv: {
          PATH: process.env.PATH,
          SYSTEMROOT: process.env.SYSTEMROOT,
          HOME: controllerHome,
          TMPDIR: controllerHome,
          NO_COLOR: "1",
        },
        testProcessRunner: async (options) => {
          // The fixed evaluation task only runs its own detected test plan.
          // Copy it before starting any workspace code; the namespace has no
          // host process visibility or network and all writes are disposable.
          const snapshot = createWorkspaceSnapshot(workspace, { signal: options.signal });
          let run;
          let cleanup;
          try {
            run = await sandbox.execute(
              {
                workspace: snapshot.sourceRoot,
                cwd: snapshot.sourceRoot,
                executable: options.file,
                argv: options.args,
                command: options.display,
              },
              snapshot,
              {
                timeoutMs: options.timeoutMs,
                signal: options.signal,
                onLine: options.onLine,
              },
            );
          } finally {
            cleanup = cleanupWorkspaceSnapshot(snapshot);
          }
          if (!cleanup.ok || run.unavailable) {
            throw new Error("isolated provider test execution or cleanup failed");
          }
          return run;
        },
        autoApprove: false,
      }),
      controller,
      timeoutMs,
    );
  } catch (caught) {
    error = caught;
  } finally {
    if (abortRun) signal?.removeEventListener("abort", abortRun);
    try {
      finalState.sourceBytes = readFileSync(join(workspace, ALLOWED_EDIT_PATH));
      finalState.source = finalState.sourceBytes.toString("utf8");
    } catch {
      finalState.sourceBytes = null;
    }
    finalState.testSource = readWorkspaceFile(workspace, TEST_PATH);
    finalState.packageSource = readWorkspaceFile(workspace, PACKAGE_PATH);
    authoritative = await runAuthoritativeVerification(root, finalState.source, { signal });
    behavioral = await runAuthoritativeVerification(root, finalState.source, {
      signal,
      behavioral: true,
    });
    try {
      controller?.dispose();
      disposed = true;
    } catch {
      // A disposal failure must not hide the run evidence below.
    }
    try {
      rmSync(root, { recursive: true, force: true });
      rootRemoved = !existsSync(root);
    } catch {
      // The leftover directory is reported by the cleanup check below.
    }
  }

  // The model agent exposes the verification as `verifyTests` on its public
  // result; older/other callers use `verification`. Accept both projections.
  const verification = compactVerification(
    outcome?.result?.verification ?? outcome?.result?.verifyTests,
    secret,
  );
  const appliedPaths = [
    ...new Set(
      events
        .filter((event) => event.type === "applied")
        .map(
          (event) =>
            normalizeWorkspacePath(event.file) ??
            (event.absPath ? normalizeWorkspacePath(basename(event.absPath)) : null),
        )
        .filter((value) => typeof value === "string"),
    ),
  ];
  const testIntact = finalState.testSource === TEST_SOURCE && !appliedPaths.includes(TEST_PATH);
  const packageIntact =
    finalState.packageSource === PACKAGE_SOURCE && !appliedPaths.includes(PACKAGE_PATH);
  const scopeIntact =
    deniedPaths.size === 0 && appliedPaths.every((path) => path === ALLOWED_EDIT_PATH);
  const agentVerificationOk = verification?.ok === true;
  const authoritativeOk = authoritative?.ok === true && behavioral?.ok === true;
  const verificationStatus =
    !verification && appliedPaths.length === 0
      ? "not-evaluated"
      : agentVerificationOk && authoritativeOk
        ? "pass"
        : "fail";
  const checks = {
    target: { status: "pass" },
    edit: {
      status:
        appliedPaths.includes(ALLOWED_EDIT_PATH) &&
        appliedApprovedSource !== null &&
        finalState.sourceBytes?.equals(Buffer.from(appliedApprovedSource, "utf8")) &&
        authoritativeOk
          ? "pass"
          : "fail",
    },
    test: { status: testIntact ? "pass" : "fail" },
    package: { status: packageIntact ? "pass" : "fail" },
    scope: { status: scopeIntact ? "pass" : "fail" },
    verification: { status: verificationStatus },
    cleanup: { status: rootRemoved && disposed ? "pass" : "fail" },
  };
  const taskSuccess =
    Boolean(outcome?.ok) &&
    checks.edit.status === "pass" &&
    checks.test.status === "pass" &&
    checks.package.status === "pass" &&
    checks.scope.status === "pass" &&
    checks.verification.status === "pass" &&
    checks.cleanup.status === "pass";
  const finishReason = outcome?.result?.finishReason ?? null;
  const report = {
    schemaVersion: PROVIDER_EVAL_SCHEMA_VERSION,
    evidenceClass: PROVIDER_EVAL_EVIDENCE_CLASS,
    evidence:
      "One explicit opt-in coding run only; no availability, quality, pricing, context-length or latency claim.",
    taskRevision: PROVIDER_EVAL_TASK_REVISION,
    taskDigest: TASK_DIGEST,
    provider: {
      id: safeText(target.providerId, secret, 80),
      name: safeText(target.providerName, secret, 120),
      kind: target.kind,
      endpoint: safeText(endpoint, secret, 300),
      configDigest: target.configDigest ? safeText(target.configDigest, secret, 64) : null,
    },
    model: {
      id: safeText(target.modelId, secret, 512),
      name: safeText(target.modelName, secret, 200),
    },
    auth: {
      type: target.auth?.type ?? null,
      env: target.auth?.type === "bearer" ? safeText(target.auth.env, secret, 80) : null,
    },
    network: isLoopbackEndpoint(endpoint) ? "loopback" : "remote",
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    startedAt,
    elapsedMs: Number.isFinite(outcome?.elapsedMs) ? outcome.elapsedMs : null,
    outcome: {
      ok: outcome?.ok === true,
      status: safeText(outcome?.status ?? (error ? "failed" : "unknown"), secret, 40),
      error: outcome?.error
        ? safeText(outcome.error, secret)
        : outcome?.result?.failure
          ? safeText(outcome.result.failure, secret)
          : error
            ? safeText(error.message, secret)
            : null,
    },
    verification,
    authoritativeVerification: authoritative,
    behavioralVerification: behavioral,
    checks,
    taskSuccess,
    applied: Number.isFinite(outcome?.applied) ? outcome.applied : appliedPaths.length,
    appliedPaths: appliedPaths.slice(0, 20),
    deniedPaths: [...deniedPaths].sort().slice(0, 20),
    rounds: Number.isFinite(outcome?.result?.metrics?.rounds)
      ? outcome.result.metrics.rounds
      : null,
    toolCalls: Number.isFinite(outcome?.result?.metrics?.toolCalls)
      ? outcome.result.metrics.toolCalls
      : null,
    finishReason: finishReason ? safeText(finishReason, secret, 40) : null,
    usage: compactUsage(outcome?.result?.metrics?.usage, secret),
    cleanup: {
      rootRemoved,
      controllerDisposed: disposed,
    },
    ok: false,
  };
  report.ok = report.outcome.ok && report.taskSuccess && report.cleanup.rootRemoved;
  return report;
}

export function formatProviderEvalText(report) {
  const lines = [
    `PROVIDER EVAL · ${report.provider.id}/${report.model.id}`,
    `  task ${report.taskRevision} · digest ${report.taskDigest.slice(0, 12)} · ${report.network}`,
    `  outcome ${report.outcome.status} · taskSuccess ${report.taskSuccess ? "yes" : "no"} · verification ${report.verification?.status ?? "none"} · rounds ${report.rounds ?? "n/a"} · applied ${report.applied}`,
    `  checks edit ${report.checks.edit.status} · test ${report.checks.test.status} · package ${report.checks.package.status} · scope ${report.checks.scope.status} · verification ${report.checks.verification.status} · cleanup ${report.checks.cleanup.status}`,
    `  authoritative ${report.authoritativeVerification?.status ?? "none"} · passed ${report.authoritativeVerification?.passed ?? "?"} · failed ${report.authoritativeVerification?.failed ?? "?"} · audit ${report.authoritativeVerification?.auditStatus ?? "none"}`,
    `  provider ${report.provider.id} · endpoint ${report.provider.endpoint} · config ${(report.provider.configDigest ?? "none").slice(0, 12)}`,
  ];
  if (report.usage) {
    const tokens = report.usage.tokens;
    lines.push(
      tokens
        ? `  usage ${report.usage.provenance} · prompt ${tokens.prompt ?? "?"} · completion ${tokens.completion ?? "?"} · total ${tokens.total ?? "?"} · cost ${report.usage.cost ?? "unknown"}`
        : `  usage ${report.usage.provenance} · token counts unavailable · cost ${report.usage.cost ?? "unknown"}`,
    );
  }
  if (report.outcome.error) lines.push(`  error ${report.outcome.error}`);
  lines.push(
    "  Evidence: one explicit run; not availability, quality, pricing, context-length or latency evidence.",
    `  Overall: ${report.ok ? "PASS" : "FAIL"}`,
  );
  return `${lines.join("\n")}\n`;
}

export function parseProviderEvalArgs(argv = []) {
  const options = { providerId: null, modelId: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--provider" || argument === "--model") {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      if (argument === "--provider") options.providerId = argv[index];
      else options.modelId = argv[index];
    } else if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown provider eval argument: ${argument}`);
  }
  if (!options.help) {
    if (!options.providerId) throw new Error("provider eval requires --provider <id>");
    if (!options.modelId) throw new Error("provider eval requires --model <exact-id>");
  }
  return options;
}

export function providerEvalReportPaths(directory = null) {
  // Tests and embedders may isolate generated evidence; a real run defaults to
  // the gitignored reports directory beside this module.
  const override = directory ?? ((process.env.MATRIX_PROVIDER_EVAL_REPORTS || "").trim() || null);
  const base = override || fileURLToPath(new URL("./reports/", import.meta.url));
  return {
    directory: base,
    json: join(base, "provider.json"),
    text: join(base, "provider.txt"),
  };
}

export function writeProviderEvalReport(report) {
  const paths = providerEvalReportPaths();
  mkdirSync(paths.directory, { recursive: true });
  writeFileSync(paths.json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(paths.text, formatProviderEvalText(report), { mode: 0o644 });
  return paths;
}

function usage() {
  return `Usage: node eval/provider-eval.mjs --provider <id> --model <exact-id> [--json]

Runs one explicit opt-in coding task through the real controller against the
selected provider/model. The workspace is temporary and auto-approved; no
repository contents are sent. Default \`npm run eval\` remains offline.
`;
}

async function main() {
  const options = parseProviderEvalArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await runProviderEvaluation({
    providerId: options.providerId,
    modelId: options.modelId,
    home: matrixHome(),
  });
  const paths = writeProviderEvalReport(report);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${formatProviderEvalText(report)}  report ${paths.json}\n`,
  );
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`PROVIDER EVAL ERROR: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
