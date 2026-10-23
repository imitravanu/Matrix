import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectProject } from "../lib/project.mjs";
import { runLocalAgent } from "../lib/local-agent.mjs";
import { DEMO_ROOT, copyDemo } from "./helpers.mjs";

const TASK = "Fix the off-by-one in the bounds slice in src/processor.py";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

function withMatrixHome(home, fn) {
  const previous = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = home;
  return Promise.resolve(fn()).finally(() => {
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
    })
  );
  assert.ok(proposal);
  assert.equal(proposal.file, "src/processor.py");
  assert.match(proposal.patch, /-.*len\(bounds\) - 1/);
  assert.match(proposal.patch, /\+.*len\(bounds\)\]/);
  assert.equal(result.error, false);
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
  for (const type of ["run:start", "plan", "proposal", "approval:request", "approval:result", "applied", "verify:start", "verify:end", "result", "done"]) {
    assert.ok(types.includes(type), `missing ${type}`);
  }
  assert.ok(types.at(-1) === "done" || types.at(-1) === "metrics");
  const demoSource = readFileSync(join(DEMO_ROOT, "src", "processor.py"), "utf8");
  assert.ok(demoSource.includes(BUGGY), "the checked-in demo must remain pristine");
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
    })
  );
  assert.equal(result.editFile.status, "denied");
  assert.equal(result.editFile.backupPath, null);
  assert.match(result.summary, /denied/i);
  assert.match(result.summary, /file unchanged/i);
  assert.equal(result.verifyTests, null);
  assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8"), before);
  assert.equal(events.some((event) => event.type === "applied"), false);
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
    })
  );
  assert.equal(result.error, false);
  assert.equal(result.editFile, null);
  assert.equal(result.verifyTests, null);
  assert.match(result.content, /No files were modified/);
  assert.match(result.summary, /analysis/i);
  assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(BUGGY), true);
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
    })
  );
  assert.equal(result.editFile.status, "applied");
  assert.equal(events.some((event) => event.type === "approval:request"), false);
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
    })
  );
  assert.equal(result.error, true);
  assert.match(result.content, /truncated|reads are capped/i);
  assert.equal(readFileSync(file, "utf8"), large);
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
  assert.equal(project.files.some((entry) => entry.rel === "src/linked.py"), false);
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
    })
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
    })
  );
  assert.equal(result.error, true);
  assert.match(result.content, /changed after it was read/i);
  assert.equal(readFileSync(file, "utf8"), changed);
});
