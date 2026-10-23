import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createRunController } from "../lib/controller.mjs";
import { resolveModel } from "../lib/models.mjs";
import { detectProject } from "../lib/project.mjs";
import { backupFile, runsDir } from "../lib/session.mjs";
import { copyDemo, contentChunks, makeTempDir, sseResponse, toolCallChunks } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

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
  const controller = createRunController({ onEvent: (event) => events.push(event), home });
  t.after(() => controller.dispose());

  const outcome = await controller.start({ task: TASK, project, model: { id: "local" }, autoApprove: true });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.applied, 1);
  assert.equal(controller.canUndo(), true);
  assert.equal(controller.lastApplied().file, "src/processor.py");
  assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));
  assert.ok(events.some((event) => event.type === "applied"));
  const runId = outcome.runId;
  const logPath = join(runsDir(home), `${runId}.jsonl`);
  assert.equal(existsSync(logPath), true);
  const logged = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(logged.some((event) => event.type === "proposal"));
  assert.ok(logged.every((event) => event.runId === runId));

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
        })
      ),
    () =>
      sseResponse(
        toolCallChunks("call_edit_2", "propose_edit", {
          path: "src/processor.py",
          start_line: 19,
          end_line: 20,
          replacement: "        # bounds fixed\n",
        })
      ),
    () => sseResponse(contentChunks("Both edits applied.")),
  ];
  let index = 0;
  globalThis.fetch = async () => rounds[index++]();
  const controller = createRunController({ home });
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
  assert.equal(controller.undoLast().ok, true, "coalesced undo must not validate an intermediate fingerprint");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("undo refuses to overwrite a file changed after the patch", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const controller = createRunController({ home });
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
  const controller = createRunController({
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
  while (!approvalSeen && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(approvalSeen, true);
  assert.equal(controller.isWaitingForApproval(), true);
  assert.equal(controller.abort(), true);
  const outcome = await run;
  assert.equal(outcome.applied, 0);
  assert.ok(events.some((event) => event.type === "abort:requested"));
  assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8"), before);
});

test("a second concurrent run is rejected and clearUndo removes the stack", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const home = join(demo.root, "home");
  envHome(t, home);
  const project = detectProject(demo.workspace);
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  const first = controller.start({ task: TASK, project, model: { id: "local" }, autoApprove: true });
  const second = await controller.start({ task: TASK, project, model: { id: "local" }, autoApprove: true });
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
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  await controller.start({ task: TASK, project, model: { id: "local" }, autoApprove: true });
  const applied = controller.lastApplied();
  assert.equal(typeof applied.updatedText, "string");
  assert.equal(typeof applied.original, "string");

  const resumed = createRunController({ home });
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
  const controller = createRunController({ home });
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
  const controller = createRunController({ home });
  t.after(() => controller.dispose());
  const restored = controller.restoreFromSession(
    {
      absPath: file,
      updatedText,
      original: "fallback text",
      backupPath: backup.path,
      file: "processor.py",
    },
    { root }
  );
  assert.equal(restored, true);
  const undone = controller.undoLast();
  assert.equal(undone.ok, true);
  assert.deepEqual(readFileSync(file), original);
});
