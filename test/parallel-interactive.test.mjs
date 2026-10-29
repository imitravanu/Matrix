import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runParallelInteractive } from "../lib/parallel-interactive.mjs";
import { loadSession } from "../lib/session.mjs";
import { copyDemo, patchEnv, waitFor } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";

test("interactive review independently approves agents, resolves conflicts and denies combined test trust", async (t) => {
  const demo = copyDemo("matrix-interactive-parallel-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  t.after(() => {
    restore();
    demo.cleanup();
  });
  let output = "";
  const prompts = [];
  const result = await runParallelInteractive({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    jobs: [{ task: TASK }, { task: TASK }],
    write: (text) => {
      output += text;
    },
    ask: async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("Choose")) return "agent-01";
      if (prompt.startsWith("Integrate")) return "y";
      if (prompt.startsWith("Run this")) return "n";
      const relevant = output.slice(output.lastIndexOf(" approval ") - 20);
      return relevant.includes(" test approval ") ? "n" : "y";
    },
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.result.integrationStatus, "integrated");
  assert.match(output, /independent isolated agents/);
  assert.match(output, /agent-01.*edit approval/);
  assert.match(output, /agent-02.*edit approval/);
  assert.match(output, /Conflict: "src\/processor.py"/);
  assert.match(output, /Combined test trust/);
  assert.match(output, /Result workspace:/);
  assert.ok(prompts.some((prompt) => prompt.startsWith("Integrate")));
  assert.ok(
    readFileSync(join(result.result.resultWorkspace, "src", "processor.py"), "utf8").includes(
      "bounds[0:len(bounds)]",
    ),
  );
  const saved = loadSession(result.result.recoverySessionId, {
    home,
    cwd: result.result.resultWorkspace,
  });
  assert.equal(saved.undoRun.entries.length, 1);
});

test("cancellation while waiting for an agent decision leaves the original untouched", async (t) => {
  const demo = copyDemo("matrix-interactive-abort-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  t.after(() => {
    restore();
    demo.cleanup();
  });
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  const abort = new AbortController();
  const result = await runParallelInteractive({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    signal: abort.signal,
    jobs: [{ task: TASK }, { task: TASK }],
    write: () => {},
    ask: async () => {
      abort.abort();
      return "y";
    },
  });
  assert.equal(result.status, "aborted");
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
});

test("a review output failure after integration still returns the retained recovery location", async (t) => {
  const demo = copyDemo("matrix-interactive-trust-error-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  t.after(() => {
    restore();
    demo.cleanup();
  });
  let output = "";
  let failedOnce = false;
  const result = await runParallelInteractive({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
    write: (text) => {
      if (!failedOnce && text.startsWith("Combined verification:")) {
        failedOnce = true;
        throw new Error("terminal output failed");
      }
      output += text;
    },
    ask: async (prompt) => {
      if (prompt.startsWith("Choose")) return "agent-01";
      if (prompt.startsWith("Integrate")) return "y";
      return "n";
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.result.error, "terminal output failed");
  assert.ok(existsSync(result.result.resultWorkspace));
  assert.ok(result.result.recoverySessionId);
  assert.match(output, /FINAL RESULT/);
  assert.match(output, /Recovery session:/);
  assert.match(output, /terminal output failed/);
});

test("denying final integration preserves the original even after child edits were approved", async (t) => {
  const demo = copyDemo("matrix-interactive-integration-deny-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  t.after(() => {
    restore();
    demo.cleanup();
  });
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  const result = await runParallelInteractive({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
    write: () => {},
    ask: async (prompt) => {
      if (prompt.startsWith("Choose")) return "agent-01";
      return "n";
    },
  });
  assert.equal(result.status, "denied");
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
});

test("abort during final integration review cannot be converted into approval", async (t) => {
  const demo = copyDemo("matrix-interactive-final-abort-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  t.after(() => {
    restore();
    demo.cleanup();
  });
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  const abort = new AbortController();
  const result = await runParallelInteractive({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    signal: abort.signal,
    jobs: [
      { task: TASK, autoApprove: true },
      { task: TASK, autoApprove: true },
    ],
    write: () => {},
    ask: async (prompt) => {
      if (prompt.startsWith("Choose")) return "agent-01";
      if (prompt.startsWith("Integrate")) {
        abort.abort();
        return "y";
      }
      return "n";
    },
  });
  assert.equal(result.status, "aborted");
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
});

test("abort interrupts a pending review callback even if it never resolves", async (t) => {
  const demo = copyDemo("matrix-interactive-hung-review-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home });
  t.after(() => {
    restore();
    demo.cleanup();
  });
  const original = readFileSync(join(demo.workspace, "src", "processor.py"));
  const cancellation = new AbortController();
  let requested = false;
  const execution = runParallelInteractive({
    root: demo.workspace,
    home,
    scratchDir: join(demo.root, "scratch"),
    signal: cancellation.signal,
    jobs: [{ task: TASK }, { task: TASK }],
    write: () => {},
    ask: () => {
      requested = true;
      return new Promise(() => {});
    },
  });
  assert.ok(await waitFor(() => requested));
  cancellation.abort();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("abort did not settle")), 3000);
  });
  t.after(() => clearTimeout(timer));
  const result = await Promise.race([execution, timeout]);
  clearTimeout(timer);
  assert.equal(result.status, "aborted");
  assert.deepEqual(readFileSync(join(demo.workspace, "src", "processor.py")), original);
});
