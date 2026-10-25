import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectProject } from "../lib/project.mjs";
import { runLocalAgent } from "../lib/local-agent.mjs";
import { createTestPolicy, withTestExecutionContext } from "../lib/test-policy.mjs";
import { DEMO_ROOT, copyDemo, makeTempDir } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

function withMatrixHome(home, fn) {
  const previous = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = home;
  const policy = createTestPolicy({ home, allowTests: true });
  return withTestExecutionContext({ home, policy }, fn).finally(() => {
    if (previous === undefined) delete process.env.MATRIX_HOME;
    else process.env.MATRIX_HOME = previous;
  });
}

test("Local Forge proposes, applies and verifies a real fix", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const events = [];
  let proposal = null;
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      requestApproval: async (next) => {
        proposal = next;
        return "y";
      },
      onEvent: (event) => events.push(event),
    }),
  );
  assert.ok(proposal);
  assert.equal(proposal.file, "src/processor.py");
  assert.match(proposal.patch, /-.*len\(bounds\) - 1/);
  assert.match(proposal.patch, /\+.*len\(bounds\)\]/);
  assert.equal(result.error, false);
  assert.equal(result.ok, true);
  assert.equal(result.status, "success");
  assert.equal(result.outcome, "success");
  assert.equal(result.mode, "local");
  assert.equal(result.elapsedMs, result.metrics.elapsedMs);
  assert.equal(result.editFile.path, "src/processor.py");
  assert.equal(result.editFile.status, "applied");
  assert.deepEqual(result.editFile.stats, { adds: 1, dels: 1, changed: 2 });
  assert.equal(result.verifyTests.passed, 4);
  assert.equal(result.verifyTests.failed, 0);
  assert.equal(result.verifyTests.ok, true);
  assert.match(result.summary, /applied src\/processor\.py/);
  const source = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  assert.ok(source.includes(FIXED));
  assert.ok(!source.includes(BUGGY));
  assert.ok(result.editFile.backupPath);
  assert.equal(existsSync(result.editFile.backupPath), true);
  const types = events.map((event) => event.type);
  for (const type of [
    "run:start",
    "plan",
    "proposal",
    "approval:request",
    "approval:result",
    "applied",
    "verify:start",
    "verify:end",
    "result",
    "done",
  ]) {
    assert.ok(types.includes(type), `missing ${type}`);
  }
  assert.deepEqual(types.slice(-4), ["metrics", "phase", "result", "done"]);
  const demoSource = readFileSync(join(DEMO_ROOT, "src", "processor.py"), "utf8");
  assert.ok(demoSource.includes(BUGGY), "the checked-in demo must remain pristine");
});

test("Local Forge applies an approved rename with a coherent plan", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const file = join(demo.workspace, "src", "processor.py");
  writeFileSync(file, readFileSync(file, "utf8").replace(BUGGY, FIXED));
  const project = detectProject(demo.workspace);
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: "rename context to window_context in src/processor.py",
      project,
      requestApproval: async () => "y",
    }),
  );
  assert.equal(result.error, false);
  assert.equal(result.editFile.status, "applied");
  assert.equal(result.verifyTests.ok, true);
  assert.equal(result.plan.length, 5);
  assert.ok(result.plan.every((step) => step.status === "done"));
  const source = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  assert.match(source, /window_context = bounds/);
  assert.doesNotMatch(source, /\bcontext = bounds/);
});

test("denying the patch leaves bytes untouched and says so", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const before = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  const events = [];
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      requestApproval: async () => "n",
      onEvent: (event) => events.push(event),
    }),
  );
  assert.equal(result.editFile.status, "denied");
  assert.equal(result.ok, true);
  assert.equal(result.status, "denied");
  assert.equal(result.error, false);
  assert.equal(result.failure, null);
  assert.equal(result.editFile.backupPath, null);
  assert.match(result.summary, /denied/i);
  assert.match(result.summary, /file unchanged/i);
  assert.equal(result.verifyTests, null);
  assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8"), before);
  assert.equal(
    events.some((event) => event.type === "applied"),
    false,
  );
});

test("an ungrounded request answers honestly instead of inventing a change", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: "Explain the overall architecture and the memory allocator",
      project,
      requestApproval: async () => "y",
    }),
  );
  assert.equal(result.error, false);
  assert.equal(result.editFile, null);
  assert.equal(result.verifyTests, null);
  assert.match(result.content, /No files were modified/);
  assert.match(result.summary, /analysis/i);
  assert.equal(
    readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(BUGGY),
    true,
  );
});

test("autoApprove applies without ever opening a gate", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const events = [];
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      autoApprove: true,
      requestApproval: async () => {
        throw new Error("requestApproval should not run when autoApprove is true");
      },
      onEvent: (event) => events.push(event),
    }),
  );
  assert.equal(result.editFile.status, "applied");
  assert.equal(
    events.some((event) => event.type === "approval:request"),
    false,
  );
  assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));
});

test("Local Forge refuses to edit a file whose read was truncated", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const file = join(demo.workspace, "src", "processor.py");
  const source = readFileSync(file, "utf8");
  const large = `${source}\n${"x".repeat(600 * 1024)}\n`;
  writeFileSync(file, large);
  const project = detectProject(demo.workspace);
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      autoApprove: true,
    }),
  );
  assert.equal(result.error, true);
  assert.match(result.content, /truncated|reads are capped/i);
  assert.equal(result.metrics.scopeParses, 0, "a guaranteed edit rejection skips scope parsing");
  assert.equal(readFileSync(file, "utf8"), large);
});

test("Local Forge refuses to edit non-UTF-8 files", async (t) => {
  const root = makeTempDir("matrix-invalid-utf8-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const file = join(root, "src", "processor.py");
  const bytes = Buffer.concat([
    Buffer.from("# caf"),
    Buffer.from([0xe9]),
    Buffer.from("\ncontext = bounds[0:len(bounds) - 1]\n"),
  ]);
  writeFileSync(file, bytes);
  const project = detectProject(root);
  const result = await withMatrixHome(join(root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      autoApprove: true,
    }),
  );
  assert.equal(result.error, true);
  assert.match(result.content, /not valid UTF-8/i);
  assert.equal(result.editFile, null);
  assert.deepEqual(readFileSync(file), bytes);
});

test("Local Forge does not rewrite slice examples inside strings", async (t) => {
  const root = makeTempDir("matrix-string-slice-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const file = join(root, "src", "items.js");
  const source = 'const note = "use items.slice(0, items.length - 1) to trim";\n';
  writeFileSync(file, source);
  const project = detectProject(root);
  const result = await withMatrixHome(join(root, "home"), () =>
    runLocalAgent({
      task: "Fix the off-by-one in src/items.js",
      project,
      autoApprove: true,
    }),
  );
  assert.equal(result.error, false);
  assert.equal(result.editFile, null);
  assert.match(result.failure, /No grounded off-by-one/i);
  assert.equal(readFileSync(file, "utf8"), source);
});

test("Local Forge refuses to write through a symlink that escapes the workspace", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const outside = join(demo.root, "outside");
  mkdirSync(outside);
  const outsideFile = join(outside, "linked.py");
  writeFileSync(outsideFile, `${BUGGY}\n`);
  const link = join(demo.workspace, "src", "linked.py");
  symlinkSync(outsideFile, link);

  const project = detectProject(demo.workspace);
  assert.equal(
    project.files.some((entry) => entry.rel === "src/linked.py"),
    false,
  );
  // Simulate a stale index entry so the containment check is exercised even if
  // the walker did not notice the link.
  project.files.push({
    path: link,
    rel: "src/linked.py",
    name: "linked.py",
    size: 200,
    ext: ".py",
    language: "python",
    mtimeMs: Date.now(),
  });
  project.fileCount += 1;

  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: "Fix the off-by-one in src/linked.py",
      project,
      autoApprove: true,
    }),
  );
  assert.equal(result.error, true);
  assert.match(result.content, /escapes workspace/i);
  assert.equal(readFileSync(outsideFile, "utf8"), `${BUGGY}\n`);
});

test("Local Forge revalidates the file after approval before writing", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  const changed = `${before}\n# edited while the approval gate was open\n`;
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      requestApproval: async () => {
        writeFileSync(file, changed);
        return "y";
      },
    }),
  );
  assert.equal(result.error, true);
  assert.match(result.content, /changed after it was read/i);
  assert.equal(readFileSync(file, "utf8"), changed);
});

test("no-hit candidate scans perform no scope parses and label budgeted search", async (t) => {
  const root = makeTempDir("matrix-local-no-parse-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const path = join(root, "src", "plain.js");
  writeFileSync(path, "export const value = 1;\n");
  const project = detectProject(root);
  const indexed = project.files.find((file) => file.rel === "src/plain.js");
  project.files = Array.from({ length: 405 }, (_, index) => ({
    ...indexed,
    rel: `src/plain-${index}.js`,
    name: `plain-${index}.js`,
  }));
  project.fileCount = project.files.length;

  const result = await withMatrixHome(join(root, "home"), () =>
    runLocalAgent({
      task: "fix the off-by-one in the bounds slice",
      project,
      autoApprove: true,
    }),
  );
  assert.equal(result.editFile, null);
  assert.match(result.failure, /No grounded off-by-one/i);
  assert.equal(result.metrics.scopeParses, 0);
  assert.match(result.content, /Search is partial \(file-budget\)/);
});

test("truncated read-only scope cards are explicitly labelled partial", async (t) => {
  const root = makeTempDir("matrix-local-partial-scope-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  const path = join(root, "src", "large.py");
  writeFileSync(path, "def visible():\n    needle = 1\n");
  const project = detectProject(root);
  // Simulate a file growing after indexing: read-only context may be shown,
  // but neither the search nor the scope chain may claim to be complete.
  writeFileSync(path, `    # ${"x".repeat(600 * 1024)}\n`, { flag: "a" });
  const result = await withMatrixHome(join(root, "home"), () =>
    runLocalAgent({ task: "explain needle", project }),
  );
  assert.equal(result.error, false);
  assert.equal(result.readFile.partial, true);
  assert.match(result.readFile.scope, /visible/);
  assert.match(result.readFile.scope, /partial scope/);
  assert.match(result.content, /Search is partial \(truncated-read\)/);
  assert.equal(result.metrics.scopeParses, 1);
});

test("only the winning fix candidate receives a structural scope parse", async (t) => {
  const root = makeTempDir("matrix-local-lazy-parse-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "ordinary.py"), "value = 1\n");
  writeFileSync(join(root, "src", "buggy.py"), "context = bounds[0:len(bounds) - 1]\n");
  const project = detectProject(root);
  const result = await withMatrixHome(join(root, "home"), () =>
    runLocalAgent({
      task: "fix the off-by-one in the bounds slice",
      project,
      requestApproval: async () => "n",
    }),
  );
  assert.equal(result.editFile.status, "denied");
  assert.equal(result.editFile.path, "src/buggy.py");
  assert.equal(result.metrics.scopeParses, 1);
  assert.equal(result.metrics.scopeNodes, 0);
});

test("candidate work observes cancellation before reading or parsing", async (t) => {
  const root = makeTempDir("matrix-local-search-abort-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "buggy.py"), "context = bounds[0:len(bounds) - 1]\n");
  const project = detectProject(root);
  const controller = new AbortController();
  const result = await withMatrixHome(join(root, "home"), () =>
    runLocalAgent({
      task: "fix the off-by-one in the bounds slice",
      project,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "tool:start" && event.id === "search") controller.abort();
      },
    }),
  );
  assert.equal(result.status, "aborted");
  assert.equal(result.aborted, true);
  assert.equal(result.editFile, null);
  assert.equal(result.metrics.scopeParses, 0);
});

function outcomeDemo(t, testSource) {
  const demo = copyDemo("matrix-local-outcome-");
  t.after(() => demo.cleanup());
  const runner = join(demo.workspace, "outcome-runner.mjs");
  writeFileSync(runner, testSource);
  const project = detectProject(demo.workspace);
  project.test = {
    file: process.execPath,
    args: [runner],
    cwd: demo.workspace,
    display: "node outcome-runner.mjs",
    framework: "generic",
  };
  return { demo, project, file: join(demo.workspace, "src", "processor.py") };
}

function assertTerminalEventOrder(events) {
  assert.deepEqual(events.map((event) => event.type).slice(-4), [
    "metrics",
    "phase",
    "result",
    "done",
  ]);
}

test("Local Forge reports unrecognized zero-exit verification without losing the applied edit", async (t) => {
  const { demo, project, file } = outcomeDemo(
    t,
    'console.log("runner returned no recognized summary");\n',
  );
  const events = [];
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      autoApprove: true,
      onEvent: (event) => events.push(event),
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "unverified");
  assert.equal(result.outcome, "unverified");
  assert.equal(result.error, false);
  assert.equal(result.editFile.status, "applied");
  assert.equal(result.verifyTests.processOk, true);
  assert.equal(result.verifyTests.verified, false);
  assert.equal(result.verifyTests.verificationStatus, "unverified");
  assert.match(result.failure, /unrecognized test output/);
  assert.ok(readFileSync(file, "utf8").includes(FIXED));
  assert.ok(result.editFile.backupPath);
  assert.equal(result.elapsedMs, result.metrics.elapsedMs);
  assertTerminalEventOrder(events);
});

test("Local Forge distinguishes verification timeout and preserves the edit", async (t) => {
  const { demo, project, file } = outcomeDemo(t, "setInterval(() => {}, 1000);\n");
  const events = [];
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      autoApprove: true,
      testTimeoutMs: 40,
      onEvent: (event) => events.push(event),
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "timedOut");
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.equal(result.verifyTests.verificationStatus, "timedOut");
  assert.equal(result.verifyTests.timedOut, true);
  assert.equal(result.editFile.status, "applied");
  assert.ok(readFileSync(file, "utf8").includes(FIXED));
  assertTerminalEventOrder(events);
});

test("Local Forge aborts after the process await without another verification", async (t) => {
  const { demo, project, file } = outcomeDemo(t, "setInterval(() => {}, 1000);\n");
  const abortController = new AbortController();
  const events = [];
  let verifyStarts = 0;
  const result = await withMatrixHome(join(demo.root, "home"), () =>
    runLocalAgent({
      task: TASK,
      project,
      autoApprove: true,
      signal: abortController.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "verify:start") {
          verifyStarts += 1;
          abortController.abort();
        }
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, "aborted");
  assert.equal(result.outcome, "aborted");
  assert.equal(result.aborted, true);
  assert.equal(result.error, true);
  assert.match(result.failure, /Run aborted/);
  assert.equal(result.verifyTests.aborted, true);
  assert.equal(verifyStarts, 1);
  assert.ok(readFileSync(file, "utf8").includes(FIXED));
  assert.match(result.content, /undo/);
  assertTerminalEventOrder(events);
});
