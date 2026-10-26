import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  COMMAND_PLAN_LIMITS,
  COMMAND_POLICY_IDENTITY,
  commandPlanAudit,
  createCommandPolicy,
  inspectCommandPlan,
} from "../lib/command-policy.mjs";
import { makeTempDir } from "./helpers.mjs";

function temp(t) {
  const root = makeTempDir("matrix-command-policy-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function inlinePlan(root, source = "process.exit(0)") {
  return { executable: process.execPath, argv: ["-e", source], cwd: root, script: source };
}

test("command inspection canonicalizes exact executable/argv/cwd and hashes all identities", (t) => {
  const root = temp(t);
  mkdirSync(join(root, "sub"));
  const first = inspectCommandPlan(inlinePlan(root), { workspace: root });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.plan.executable, realpathSync(process.execPath));
  assert.equal(first.plan.cwd, realpathSync(root));
  assert.equal(first.plan.policyIdentity, COMMAND_POLICY_IDENTITY);
  assert.match(first.plan.planHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.plan.argv, ["-e", "process.exit(0)"]);
  assert.equal(first.plan.scripts[0].kind, "inline");
  const audit = commandPlanAudit(first.plan);
  assert.equal(audit.script, undefined, "audits retain hashes, not eval bytes");
  assert.match(audit.argv[1], /^\[inline-script sha256:[a-f0-9]{64}\]$/);
  assert.equal(JSON.stringify(audit).includes("process.exit(0)"), false);

  const changed = [
    inlinePlan(root, "process.exit(1)"),
    { ...inlinePlan(root), argv: ["-e", "process.exit(0)", "--literal"] },
    { ...inlinePlan(root), cwd: join(root, "sub") },
  ];
  for (const candidate of changed) {
    const inspected = inspectCommandPlan(candidate, { workspace: root });
    assert.equal(inspected.ok, true, inspected.error);
    assert.notEqual(inspected.plan.planHash, first.plan.planHash);
  }
  const otherPolicy = inspectCommandPlan(inlinePlan(root), {
    workspace: root,
    policyIdentity: "matrix.other-policy",
  });
  assert.notEqual(otherPolicy.plan.planHash, first.plan.planHash);
});

test("strict plans reject shells options, traversal, malformed argv and unsupported executables", (t) => {
  const root = temp(t);
  const base = inlinePlan(root);
  const invalid = [
    { ...base, shell: true },
    { ...base, env: { PATH: "/tmp" } },
    { ...base, network: true },
    { ...base, executable: "node" },
    { ...base, cwd: join(root, "..") },
    { ...base, argv: ["-e", null] },
    { ...base, argv: ["-e", "bad\0argument"] },
    { ...base, argv: Array.from({ length: COMMAND_PLAN_LIMITS.argv + 1 }, () => "x") },
    { ...base, argv: ["-e", "x".repeat(COMMAND_PLAN_LIMITS.argumentBytes + 1)] },
    { executable: "/etc/passwd", argv: [], cwd: root },
  ];
  for (const candidate of invalid) {
    assert.equal(inspectCommandPlan(candidate, { workspace: root }).ok, false);
  }
  const undeclared = { ...base };
  delete undeclared.script;
  assert.match(
    inspectCommandPlan(undeclared, { workspace: root }).error,
    /requires an exact inline script/,
  );
  assert.match(
    inspectCommandPlan({ ...base, script: "different" }, { workspace: root }).error,
    /exactly match|does not match/,
  );
});

test("only the exact current Node runtime is allowed outside /usr and the workspace", (t) => {
  const root = temp(t);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const current = inspectCommandPlan(inlinePlan(workspace), { workspace });
  assert.equal(current.ok, true, current.error);
  assert.equal(current.plan.executable, realpathSync(process.execPath));

  mkdirSync(join(root, "lookalike-bin"));
  const lookalike = join(root, "lookalike-bin", "node");
  writeFileSync(lookalike, "#!/bin/sh\nprintf lookalike\n", { mode: 0o755 });
  chmodSync(lookalike, 0o755);
  const rejected = inspectCommandPlan(
    { executable: lookalike, argv: [], cwd: workspace },
    { workspace },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "executable-outside-runtime");
  assert.notEqual(realpathSync(lookalike), realpathSync(process.execPath));
});

test("file scripts hash exact bytes and reject symlinks, traversal and missing argv references", (t) => {
  const root = temp(t);
  const script = join(root, "script.mjs");
  writeFileSync(script, "process.exit(0)\n");
  const plan = {
    executable: process.execPath,
    argv: ["script.mjs"],
    cwd: root,
    scriptFile: "script.mjs",
  };
  const first = inspectCommandPlan(plan, { workspace: root });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.plan.scriptFile.bytes, 16);
  assert.equal(first.plan.scriptFile.content, "process.exit(0)\n");
  assert.equal(JSON.stringify(commandPlanAudit(first.plan)).includes("process.exit(0)"), false);
  writeFileSync(script, "process.exit(1)\n");
  const changed = inspectCommandPlan(plan, { workspace: root });
  assert.notEqual(changed.plan.planHash, first.plan.planHash);
  assert.equal(inspectCommandPlan({ ...plan, argv: ["other.mjs"] }, { workspace: root }).ok, false);
  symlinkSync(script, join(root, "link.mjs"));
  assert.equal(
    inspectCommandPlan({ ...plan, scriptFile: "link.mjs" }, { workspace: root }).ok,
    false,
  );
  assert.equal(
    inspectCommandPlan({ ...plan, scriptFile: "../outside.mjs" }, { workspace: root }).ok,
    false,
  );
});

test("capability enablement and one-shot approval are separate, with no persistent approval", async (t) => {
  const root = temp(t);
  const plan = inlinePlan(root);
  let prompts = 0;
  const disabled = createCommandPolicy({
    requestApproval: () => {
      prompts += 1;
      return true;
    },
  });
  const denied = await disabled.authorize(plan, { workspace: root });
  assert.equal(denied.code, "capability-disabled");
  assert.equal(prompts, 0);

  const policy = createCommandPolicy({ enabled: true, requestApproval: () => "once" });
  const approved = await policy.authorize(plan, { workspace: root });
  assert.equal(approved.ok, true, approved.reason);
  assert.equal(approved.decision, "interactive-once");
  assert.equal((await policy.authorize(plan, { workspace: root })).code, "approval-replayed");

  const persistent = createCommandPolicy({ enabled: true, requestApproval: () => "always" });
  assert.match(
    (await persistent.authorize(plan, { workspace: root })).reason,
    /one exact command once/,
  );
});

test("headless accepts only an exact one-shot hash and edit/test trust carries no authority", async (t) => {
  const root = temp(t);
  const plan = inlinePlan(root);
  const { plan: descriptor } = inspectCommandPlan(plan, { workspace: root });
  const missing = createCommandPolicy({
    enabled: true,
    headless: true,
    autoApprove: true,
    allowTests: true,
    yes: true,
  });
  assert.equal(
    (await missing.authorize(plan, { workspace: root })).code,
    "headless-approval-required",
  );
  const malformed = createCommandPolicy({ enabled: true, headless: true, approvedPlanHash: "ABC" });
  assert.equal(
    (await malformed.authorize(plan, { workspace: root })).code,
    "approval-hash-malformed",
  );
  const mismatch = createCommandPolicy({
    enabled: true,
    headless: true,
    approvedPlanHash: "0".repeat(64),
  });
  assert.equal(
    (await mismatch.authorize(plan, { workspace: root })).code,
    "approval-hash-mismatch",
  );

  const exact = createCommandPolicy({
    enabled: true,
    headless: true,
    approvedPlanHash: descriptor.planHash,
  });
  assert.equal((await exact.authorize(plan, { workspace: root })).ok, true);
  assert.equal((await exact.authorize(plan, { workspace: root })).code, "approval-replayed");
});

test("workspace executable identity and bytes are pinned across the approval window", async (t) => {
  const root = temp(t);
  const executable = join(root, "tool.sh");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(executable, 0o755);
  const plan = { executable, argv: [], cwd: root };
  const first = inspectCommandPlan(plan, { workspace: root });
  assert.equal(first.ok, true, first.error);
  assert.match(first.plan.executableFile.sha256, /^[a-f0-9]{64}$/);

  const policy = createCommandPolicy({
    enabled: true,
    requestApproval: () => {
      const replacement = join(root, "replacement.sh");
      writeFileSync(replacement, "#!/bin/sh\nexit 23\n", { mode: 0o755 });
      chmodSync(replacement, 0o755);
      renameSync(replacement, executable);
      return true;
    },
  });
  const raced = await policy.authorize(plan, { workspace: root });
  assert.equal(raced.ok, false);
  assert.equal(raced.code, "approval-window-changed");
  assert.equal(readFileSync(executable, "utf8"), "#!/bin/sh\nexit 23\n");
  const changed = inspectCommandPlan(plan, { workspace: root });
  assert.notEqual(changed.plan.planHash, first.plan.planHash);
  assert.notEqual(changed.plan.executableFile.sha256, first.plan.executableFile.sha256);
  assert.notEqual(changed.plan.executableFile.ino, first.plan.executableFile.ino);
});

test("approval-window argv, cwd and declared script changes require a fresh decision", async (t) => {
  const root = temp(t);
  for (const kind of ["argv", "cwd", "inline", "file"]) {
    const plan =
      kind === "file"
        ? {
            executable: process.execPath,
            argv: ["script.mjs"],
            cwd: root,
            scriptFile: "script.mjs",
          }
        : inlinePlan(root);
    if (kind === "file") writeFileSync(join(root, "script.mjs"), "process.exit(0)\n");
    const policy = createCommandPolicy({
      enabled: true,
      requestApproval: () => {
        if (kind === "argv") plan.argv = [...plan.argv, "changed"];
        if (kind === "cwd") {
          mkdirSync(join(root, "changed-cwd"), { recursive: true });
          plan.cwd = "changed-cwd";
        }
        if (kind === "inline") {
          plan.argv[1] = "process.exit(9)";
          plan.script = "process.exit(9)";
        }
        if (kind === "file") writeFileSync(join(root, "script.mjs"), "process.exit(8)\n");
        return true;
      },
    });
    const result = await policy.authorize(plan, { workspace: root });
    assert.equal(result.ok, false, kind);
    assert.equal(result.code, "approval-window-changed", kind);
  }
});
