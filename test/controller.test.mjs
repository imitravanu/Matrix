import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createRunController } from "../lib/controller.mjs";
import { resolveModel } from "../lib/models.mjs";
import { detectProject } from "../lib/project.mjs";
import { backupFile, loadSession, runsDir, saveSession } from "../lib/session.mjs";
import { createTestPolicy } from "../lib/test-policy.mjs";
import { writeFileAtomic } from "../lib/workspace.mjs";
import { copyDemo, contentChunks, makeTempDir, sseResponse, toolCallChunks } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

function createController(options = {}) {
  return createRunController({
    ...options,
    testPolicy: options.testPolicy ?? createTestPolicy({ home: options.home, allowTests: true }),
  });
}

function envHome(t, home) {
  const previous = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.MATRIX_HOME;
    else process.env.MATRIX_HOME = previous;
  });
}

test("a controller run applies, records events and undoes to exact bytes", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const events = [];
  const controller = createController({ onEvent: (event) => events.push(event), home });
  t.after(() => controller.dispose());

  const outcome = await controller.start({
    task: TASK,
    project,
    model: { id: "local" },
    autoApprove: true,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "success");
  assert.equal(outcome.status, outcome.result.status);
  assert.equal(outcome.elapsedMs, outcome.result.elapsedMs);
  assert.equal(outcome.elapsedMs, outcome.result.metrics.elapsedMs);
  assert.equal(outcome.applied, 1);
  assert.equal(controller.canUndo(), true);
  assert.equal(controller.lastApplied().file, "src/processor.py");
  assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));
  assert.ok(events.some((event) => event.type === "applied"));
  const runId = outcome.runId;
  const logPath = join(runsDir(home), `${runId}.jsonl`);
  assert.equal(existsSync(logPath), true);
  const logged = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.ok(logged.some((event) => event.type === "proposal"));
  assert.ok(logged.every((event) => event.runId === runId));
  const loggedProposal = logged.find((event) => event.type === "proposal");
  assert.equal(
    "original" in loggedProposal.proposal,
    false,
    "run logs do not persist source pre-images",
  );
  const executionStart = logged.find((event) => event.type === "execution:start");
  assert.ok(executionStart, "controller verification has an execution start audit");
  const executionEnd = logged.find(
    (event) => event.type === "execution:end" && event.executionId === executionStart.executionId,
  );
  assert.ok(executionEnd, "controller verification has an execution end audit");
  assert.equal(executionStart.origin, "model-or-automatic");
  assert.equal(executionStart.testPlan.script, null);
  assert.equal(executionEnd.status, "verified");

  const undone = controller.undoLast();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.files, ["src/processor.py"]);
  assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(BUGGY));
  assert.equal(controller.canUndo(), false);
  assert.equal(controller.undoLast().ok, false);
  assert.ok(events.some((event) => event.type === "undo"));
});

test("two edits to one file coalesce so undo restores the pre-run bytes", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  const rounds = [
    () =>
      sseResponse(
        toolCallChunks("call_edit_1", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        }),
      ),
    () =>
      sseResponse(
        toolCallChunks("call_edit_2", "propose_edit", {
          path: "src/processor.py",
          start_line: 19,
          end_line: 20,
          replacement: "        # bounds fixed\n",
        }),
      ),
    () => sseResponse(contentChunks("Both edits applied.")),
  ];
  let index = 0;
  globalThis.fetch = async () => rounds[index++]();
  const controller = createController({ home });
  t.after(() => {
    controller.dispose();
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  const outcome = await controller.start({
    task: TASK,
    project,
    model: resolveModel("sonnet"),
    autoApprove: true,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.applied, 1, "coalesced undo entries are counted once");
  const applied = controller.lastApplied();
  const finalText = readFileSync(file, "utf8");
  assert.equal(applied.updatedText, finalText);
  assert.equal(applied.original, before);
  assert.equal(
    controller.undoLast().ok,
    true,
    "coalesced undo must not validate an intermediate fingerprint",
  );
  assert.equal(readFileSync(file, "utf8"), before);
});

test("undo refuses to overwrite a file changed after the patch", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const controller = createController({ home });
  t.after(() => controller.dispose());
  await controller.start({ task: TASK, project, model: { id: "local" }, autoApprove: true });
  const file = join(demo.workspace, "src", "processor.py");
  writeFileSync(file, `${readFileSync(file, "utf8")}\n# external edit\n`);
  const result = controller.undoLast();
  assert.equal(result.ok, false);
  assert.match(result.error, /changed after the patch/);
  assert.ok(readFileSync(file, "utf8").includes("# external edit"));
});

test("abort denies a waiting patch and leaves the workspace alone", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const events = [];
  let approvalSeen = false;
  const controller = createController({
    home,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval:request") approvalSeen = true;
    },
  });
  t.after(() => controller.dispose());
  const before = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  const run = controller.start({ task: TASK, project, model: { id: "local" }, autoApprove: false });
  const deadline = Date.now() + 5000;
  while (!approvalSeen && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(approvalSeen, true);
  assert.equal(controller.isWaitingForApproval(), true);
  assert.equal(controller.abort(), true);
  const outcome = await run;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.result.status, "aborted");
  assert.equal(outcome.result.aborted, true);
  assert.equal(outcome.applied, 0);
  assert.deepEqual(events.map((event) => event.type).slice(-4), [
    "metrics",
    "phase",
    "result",
    "done",
  ]);
  assert.ok(events.some((event) => event.type === "abort:requested"));
  assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8"), before);
});

test("a second concurrent run is rejected and clearUndo removes the stack", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const controller = createController({ home });
  t.after(() => controller.dispose());
  const first = controller.start({
    task: TASK,
    project,
    model: { id: "local" },
    autoApprove: true,
  });
  const second = await controller.start({
    task: TASK,
    project,
    model: { id: "local" },
    autoApprove: true,
  });
  assert.equal(second.ok, false);
  assert.match(second.error, /already active/);
  await first;
  assert.equal(controller.canUndo(), true);
  controller.clearUndo();
  assert.equal(controller.canUndo(), false);
});

test("a saved patch can re-arm undo after resume, but only for untouched bytes", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  const controller = createController({ home });
  t.after(() => controller.dispose());
  await controller.start({ task: TASK, project, model: { id: "local" }, autoApprove: true });
  const applied = controller.lastApplied();
  assert.equal(typeof applied.updatedText, "string");
  assert.equal(typeof applied.original, "string");

  const resumed = createController({ home });
  t.after(() => resumed.dispose());
  const otherRoot = join(demo.root, "not-this-workspace");
  assert.equal(resumed.restoreFromSession(applied, { root: otherRoot }), false);
  assert.equal(resumed.restoreFromSession(applied, { root: demo.workspace }), true);
  assert.equal(resumed.canUndo(), true);
  const undone = resumed.undoLast();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.files, ["src/processor.py"]);
  assert.equal(readFileSync(file, "utf8"), before);

  assert.equal(resumed.restoreFromSession({ ...applied, updatedText: "different" }), false);
  assert.equal(resumed.restoreFromSession({ ...applied, absPath: file }), false);
});

test("a later run that applies nothing preserves the previous undo stack", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  const controller = createController({ home });
  t.after(() => controller.dispose());

  await controller.start({ task: TASK, project, model: { id: "local" }, autoApprove: true });
  assert.equal(controller.canUndo(), true);
  const explanation = await controller.start({
    task: "Explain the overall architecture and the memory allocator",
    project,
    model: { id: "local" },
    autoApprove: true,
  });
  assert.equal(explanation.ok, true);
  assert.equal(explanation.applied, 0);
  assert.equal(controller.canUndo(), true, "the prior applied patch remains undoable");

  const undone = controller.undoLast();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.files, ["src/processor.py"]);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("restored session undo writes the backup's exact non-UTF-8 bytes", (t) => {
  const root = makeTempDir("matrix-undo-bytes-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  envHome(t, home);
  const file = join(root, "processor.py");
  const original = Buffer.concat([
    Buffer.from("# caf"),
    Buffer.from([0xe9]),
    Buffer.from("\ncontext = bounds[0:len(bounds) - 1]\n"),
  ]);
  writeFileSync(file, original);
  const backup = backupFile(file, { home });
  assert.ok(backup?.path);

  const updatedText = "caf\uFFFD\ncontext = bounds[0:len(bounds)]\n";
  writeFileSync(file, updatedText);
  const controller = createController({ home });
  t.after(() => controller.dispose());
  const restored = controller.restoreFromSession(
    {
      absPath: file,
      updatedText,
      original: "fallback text",
      backupPath: backup.path,
      file: "processor.py",
    },
    { root },
  );
  assert.equal(restored, true);
  const undone = controller.undoLast();
  assert.equal(undone.ok, true);
  assert.deepEqual(readFileSync(file), original);
});

test("undo fingerprinting rejects an external append beyond the old read cap", (t) => {
  const root = makeTempDir("matrix-undo-raw-fingerprint-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "large.txt");
  const updatedText = "x".repeat(512 * 1024);
  writeFileSync(file, updatedText);
  const controller = createController({ home: join(root, "home") });
  t.after(() => controller.dispose());
  assert.equal(
    controller.restoreFromSession({
      file: "large.txt",
      absPath: file,
      original: "",
      updatedText,
      backupPath: null,
      isCreation: true,
    }),
    true,
  );

  writeFileSync(file, "external", { flag: "a" });
  const undone = controller.undoLast();
  assert.equal(undone.ok, false);
  assert.match(undone.error, /changed after the patch/);
  assert.equal(readFileSync(file, "utf8"), updatedText + "external");
});

test("undoing a created file deletes it from disk", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const newFilePath = "src/new_module.py";
  const absNewPath = join(demo.workspace, newFilePath);
  writeFileSync(absNewPath, "print('hello')\n");
  const controller = createController({ home });
  t.after(() => controller.dispose());

  const armed = controller.restoreFromSession(
    {
      file: newFilePath,
      absPath: absNewPath,
      original: "",
      updatedText: "print('hello')\n",
      stats: { adds: 1, dels: 0, changed: 1 },
      backupPath: null,
      isCreation: true,
    },
    { root: demo.workspace },
  );
  assert.equal(armed, true);
  assert.equal(existsSync(absNewPath), true);
  assert.equal(controller.canUndo(), true);

  const undone = controller.undoLast();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.files, [newFilePath]);
  assert.equal(existsSync(absNewPath), false);
  assert.equal(controller.canUndo(), false);
});

test("applied, result and done observers see undo even when the agent fails after writing", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  const updated = `${before}\n# written before the injected failure\n`;
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  let round = 0;
  globalThis.fetch = async () => {
    if (round++ === 0) {
      return sseResponse(
        toolCallChunks("call_before_failure", "write_file", {
          path: "src/processor.py",
          content: updated,
        }),
      );
    }
    throw new Error("injected agent failure after write");
  };

  const observations = [];
  let controller;
  controller = createController({
    home,
    onEvent: (event) => {
      if (["applied", "result", "done"].includes(event.type)) {
        observations.push({
          type: event.type,
          canUndo: controller.canUndo(),
          undoRun: controller.getUndoRun(),
        });
      }
    },
  });
  t.after(() => {
    controller.dispose();
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  const outcome = await controller.start({
    task: "edit and then fail",
    project,
    model: resolveModel("sonnet"),
    autoApprove: true,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.result?.failure ?? "", /injected agent failure after write/);
  assert.deepEqual(
    observations.map((observation) => observation.type),
    ["applied", "result", "done"],
  );
  for (const observation of observations) {
    assert.equal(observation.canUndo, true, `${observation.type} must see current undo`);
    assert.equal(observation.undoRun?.runId, outcome.runId);
    assert.equal(observation.undoRun?.entries.length, 1);
    assert.equal(observation.undoRun?.entries[0].updatedText, updated);
  }
  assert.equal(readFileSync(file, "utf8"), updated);
  assert.equal(controller.undoLast().ok, true, "the failed run's write remains undoable");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("partial undo persists only pending entries and their backups for a resumed retry", (t) => {
  const root = makeTempDir("matrix-partial-undo-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  envHome(t, home);
  const aPath = join(root, "a.txt");
  const bPath = join(root, "b.txt");
  const aBefore = Buffer.concat([Buffer.from("before-a-"), Buffer.from([0xe9]), Buffer.from("\n")]);
  const bBefore = Buffer.from("before-b\n");
  writeFileSync(aPath, aBefore);
  writeFileSync(bPath, bBefore);
  const aBackup = backupFile(aPath, { home });
  const bBackup = backupFile(bPath, { home });
  writeFileSync(aPath, "after-a\n");
  writeFileSync(bPath, "after-b\n");

  let failA = true;
  const events = [];
  const controller = createController({
    home,
    onEvent: (event) => events.push(event),
    writeUndo: (path, content) => {
      if (path === aPath && failA) {
        failA = false;
        throw new Error("injected mid-undo failure");
      }
      return writeFileAtomic(path, content);
    },
  });
  t.after(() => controller.dispose());
  const armed = controller.restoreFromSession(
    {
      version: 1,
      runId: "run-partial",
      entries: [
        {
          file: "a.txt",
          absPath: aPath,
          original: "lossy fallback",
          updatedText: "after-a\n",
          backupPath: aBackup.path,
          isCreation: false,
        },
        {
          file: "b.txt",
          absPath: bPath,
          original: bBefore.toString("utf8"),
          updatedText: "after-b\n",
          backupPath: bBackup.path,
          isCreation: false,
        },
      ],
    },
    { root },
  );
  assert.equal(armed, true);

  const partial = controller.undoLast();
  assert.equal(partial.ok, false);
  assert.equal(partial.partial, true);
  assert.match(partial.error, /injected mid-undo failure/);
  assert.deepEqual(partial.restored, ["b.txt"]);
  assert.deepEqual(partial.pending, ["a.txt"]);
  assert.deepEqual(readFileSync(bPath), bBefore);
  assert.equal(readFileSync(aPath, "utf8"), "after-a\n");
  assert.equal(existsSync(aBackup.path), true, "the failed entry keeps its exact backup");
  assert.equal(existsSync(bBackup.path), false, "the restored entry releases its backup");
  assert.equal(controller.canUndo(), true);
  const partialEvent = events.find((event) => event.type === "undo");
  assert.equal(partialEvent?.ok, false);
  assert.deepEqual(partialEvent?.restored, ["b.txt"]);
  assert.deepEqual(partialEvent?.pending, ["a.txt"]);

  saveSession({ id: "partial", cwd: root, undoRun: controller.getUndoRun() }, { home });
  const loaded = loadSession("partial", { home });
  assert.equal(loaded.undoRun.entries.length, 1);
  assert.equal(loaded.undoRun.entries[0].file, "a.txt");
  assert.equal(loaded.undoRun.entries[0].backupPath, aBackup.path);

  const resumed = createController({ home });
  t.after(() => resumed.dispose());
  assert.equal(resumed.restoreFromSession(loaded.undoRun, { root }), true);
  const retried = resumed.undoLast();
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.files, ["a.txt"]);
  assert.deepEqual(readFileSync(aPath), aBefore, "retry still uses the untruncated backup bytes");
  assert.equal(resumed.canUndo(), false);
});

test("a complete coalesced multi-file undo run survives real save, load, resume and undo", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const processorPath = join(demo.workspace, "src", "processor.py");
  const otherPath = join(demo.workspace, "src", "other.py");
  const createdPath = join(demo.workspace, "src", "created.py");
  const processorBefore = readFileSync(processorPath, "utf8");
  const otherBefore = `VALUE = 1\n${"# exact recovery padding\n".repeat(300)}`;
  const processorFixed = processorBefore.replace(BUGGY, FIXED);
  const processorFirst = `${processorFixed}\n# first pass\n`;
  const processorFinal = `${processorFixed}\n# final pass\n`;
  const otherAfter = `${otherBefore}VALUE = 2\n`;
  const createdText = "CREATED = True\n";
  writeFileSync(otherPath, otherBefore);
  const project = detectProject(demo.workspace);

  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  const rounds = [
    () =>
      sseResponse(
        toolCallChunks("call_processor_1", "write_file", {
          path: "src/processor.py",
          content: processorFirst,
        }),
      ),
    () =>
      sseResponse(
        toolCallChunks("call_processor_2", "write_file", {
          path: "src/processor.py",
          content: processorFinal,
        }),
      ),
    () =>
      sseResponse(
        toolCallChunks("call_other", "write_file", { path: "src/other.py", content: otherAfter }),
      ),
    () =>
      sseResponse(
        toolCallChunks("call_created", "write_file", {
          path: "src/created.py",
          content: createdText,
        }),
      ),
    () => sseResponse(contentChunks("All writes are complete.")),
  ];
  let index = 0;
  globalThis.fetch = async () => rounds[index++]();
  const controller = createController({ home });
  t.after(() => {
    controller.dispose();
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  const outcome = await controller.start({
    task: "update two modules, create one, and coalesce repeated writes",
    project,
    model: resolveModel("sonnet"),
    autoApprove: true,
  });
  assert.equal(outcome.ok, true, outcome.result?.failure ?? outcome.error);
  assert.equal(outcome.applied, 3, "two writes to processor.py produce one ordered entry");
  const undoRun = controller.getUndoRun();
  assert.equal(undoRun.version, 1);
  assert.equal(undoRun.runId, outcome.runId);
  assert.deepEqual(
    undoRun.entries.map((entry) => entry.file),
    ["src/processor.py", "src/other.py", "src/created.py"],
  );
  assert.equal(undoRun.entries[0].original, processorBefore);
  assert.equal(undoRun.entries[0].updatedText, processorFinal);
  assert.ok(undoRun.entries[0].backupPath);
  assert.ok(undoRun.entries[1].backupPath);
  assert.equal(undoRun.entries[2].isCreation, true);
  assert.equal(undoRun.entries[2].backupPath, null);

  saveSession({ id: "multi-file", cwd: demo.workspace, undoRun }, { home });
  const loaded = loadSession("multi-file", { home });
  assert.equal(loaded.lastPatch, null);
  assert.equal(loaded.undoRun.entries.length, 3);
  assert.equal(
    loaded.undoRun.entries[1].original,
    otherBefore,
    "recovery bytes are not a truncated tool/transcript projection",
  );
  assert.equal(loaded.undoRun.entries[1].updatedText, otherAfter);

  const resumed = createController({ home });
  t.after(() => resumed.dispose());
  assert.equal(resumed.restoreFromSession(loaded.undoRun, { root: demo.workspace }), true);
  const undone = resumed.undoLast();
  assert.equal(undone.ok, true);
  assert.deepEqual(undone.files, ["src/created.py", "src/other.py", "src/processor.py"]);
  assert.equal(
    readFileSync(processorPath, "utf8"),
    processorBefore,
    "same-file coalescing restores pre-run bytes",
  );
  assert.equal(readFileSync(otherPath, "utf8"), otherBefore);
  assert.equal(existsSync(createdPath), false);
  assert.equal(resumed.getUndoRun(), null);

  saveSession({ ...loaded, undoRun: resumed.getUndoRun(), lastPatch: null }, { home });
  assert.equal(loadSession("multi-file", { home }).undoRun, null);
});

test("legacy lastPatch migrates only when creation semantics are unambiguous", (t) => {
  const root = makeTempDir("matrix-legacy-undo-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const file = join(root, "existing.txt");
  writeFileSync(file, "before\n");
  const backup = backupFile(file, { home });
  writeFileSync(file, "after\n");
  const legacy = {
    file: "existing.txt",
    absPath: file,
    original: "before\n",
    updatedText: "after\n",
    backupPath: backup.path,
  };
  const controller = createController({ home });
  t.after(() => controller.dispose());
  assert.equal(controller.restoreFromSession(legacy, { root }), true);
  assert.equal(controller.getUndoRun().version, 1);
  assert.equal(controller.getUndoRun().entries[0].isCreation, false);
  assert.equal(controller.undoLast().ok, true);
  assert.equal(readFileSync(file, "utf8"), "before\n");

  const ambiguousPath = join(root, "ambiguous.txt");
  writeFileSync(ambiguousPath, "created or emptied\n");
  assert.equal(
    controller.restoreFromSession(
      {
        file: "ambiguous.txt",
        absPath: ambiguousPath,
        original: "",
        updatedText: "created or emptied\n",
        backupPath: null,
      },
      { root },
    ),
    false,
  );
  assert.equal(controller.canUndo(), false);
  assert.equal(readFileSync(ambiguousPath, "utf8"), "created or emptied\n");
});

test("controller ok, elapsed time, and undo agree with an unverified agent result", async (t) => {
  const demo = copyDemo("matrix-controller-unverified-");
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const runner = join(demo.workspace, "unrecognized-runner.mjs");
  writeFileSync(runner, 'console.log("zero exit without a test summary");\n');
  const project = detectProject(demo.workspace);
  project.test = {
    file: process.execPath,
    args: [runner],
    cwd: demo.workspace,
    display: "node unrecognized-runner.mjs",
    framework: "generic",
  };
  const events = [];
  const controller = createController({ home, onEvent: (event) => events.push(event) });
  t.after(() => controller.dispose());
  const file = join(demo.workspace, "src", "processor.py");

  const outcome = await controller.start({
    task: TASK,
    project,
    model: { id: "local" },
    autoApprove: true,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "unverified");
  assert.equal(outcome.outcome, "unverified");
  assert.equal(outcome.result.status, outcome.status);
  assert.equal(outcome.result.ok, outcome.ok);
  assert.equal(outcome.result.verifyTests.processOk, true);
  assert.equal(outcome.result.verifyTests.verified, false);
  assert.equal(outcome.elapsedMs, outcome.result.elapsedMs);
  assert.equal(outcome.elapsedMs, outcome.result.metrics.elapsedMs);
  assert.equal(outcome.applied, 1);
  assert.equal(controller.canUndo(), true);
  assert.ok(readFileSync(file, "utf8").includes(FIXED));
  assert.deepEqual(events.map((event) => event.type).slice(-4), [
    "metrics",
    "phase",
    "result",
    "done",
  ]);

  assert.equal(controller.undoLast().ok, true);
  assert.ok(readFileSync(file, "utf8").includes(BUGGY));
});

test("fake repository secrets stay out of children, follow-up provider messages and run logs", async (t) => {
  const demo = copyDemo("matrix-controller-secret-redaction-");
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const sentinel = "fake-repository-secret-SEC001";
  const script = `
    if (process.env.MATRIX_TEST_SECRET) process.exit(90);
    console.log(${JSON.stringify(sentinel)});
    console.log("# pass 1\\n# fail 0\\n# duration_ms 1");
  `;
  project.test = {
    file: process.execPath,
    args: ["-e", script],
    cwd: demo.workspace,
    framework: "node --test",
    script,
    display: "node secret-redaction-fixture.mjs",
  };
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const previousSentinel = process.env.MATRIX_TEST_SECRET;
  process.env.OPENROUTER_API_KEY = "fake-provider-key-SEC001";
  process.env.MATRIX_TEST_SECRET = sentinel;
  const bodies = [];
  let round = 0;
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body);
    return round++ === 0
      ? sseResponse(toolCallChunks("call_secret_test", "run_tests", {}))
      : sseResponse(contentChunks("Verification complete."));
  };
  const controller = createController({ home });
  const outcome = await controller
    .start({
      task: "run tests",
      project,
      model: resolveModel("sonnet"),
    })
    .finally(() => {
      controller.dispose();
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousKey;
      if (previousSentinel === undefined) delete process.env.MATRIX_TEST_SECRET;
      else process.env.MATRIX_TEST_SECRET = previousSentinel;
    });
  assert.equal(outcome.ok, true, outcome.result?.failure ?? outcome.error);
  assert.equal(bodies.length, 2);
  assert.equal(
    bodies.some((body) => body.includes(sentinel)),
    false,
  );
  assert.equal(
    bodies.at(-1).includes("[redacted]"),
    true,
    "the provider receives only the redacted output projection",
  );
  const logText = readFileSync(join(runsDir(home), `${outcome.runId}.jsonl`), "utf8");
  assert.equal(logText.includes(sentinel), false);
  assert.equal(
    outcome.result.verifyTests.output.some((line) => line.includes(sentinel)),
    false,
  );
});

test("controller test denial is unverified, keeps undo, and never writes a start audit", async (t) => {
  const demo = copyDemo("matrix-controller-trust-denied-");
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const controller = createController({ home, testPolicy: createTestPolicy({ home }) });
  t.after(() => controller.dispose());
  const outcome = await controller.start({
    task: TASK,
    project,
    model: { id: "local" },
    autoApprove: true,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "unverified");
  assert.equal(outcome.result.verifyTests.trustStatus, "denied");
  assert.equal(outcome.result.verifyTests.processOk, false);
  assert.equal(outcome.applied, 1);
  assert.equal(
    controller.canUndo(),
    true,
    "test trust denial must not invalidate an offered edit undo",
  );
  const log = readFileSync(join(runsDir(home), `${outcome.runId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    log.some((event) => event.type === "execution:start"),
    false,
  );
  assert.equal(log.find((event) => event.type === "trust:decision").origin, "model-or-automatic");
  assert.equal(controller.undoLast().ok, true);
});
