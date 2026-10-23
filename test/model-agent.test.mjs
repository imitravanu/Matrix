import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseToolArgs, runModelAgent } from "../lib/model-agent.mjs";
import { resolveModel } from "../lib/models.mjs";
import { detectProject } from "../lib/project.mjs";
import { DEMO_ROOT, copyDemo, contentChunks, sseResponse, toolCallChunks } from "./helpers.mjs";

const TASK = "Fix the off-by-one in src/processor.py and verify it";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

function withEnv(values, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function fakeOpenRouter(rounds) {
  const requests = [];
  let index = 0;
  const fetchMock = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const round = rounds[index] ?? rounds.at(-1);
    index += 1;
    return round();
  };
  return { fetchMock, requests, seen: () => index };
}

test("a mocked OpenRouter loop reads, proposes, applies and auto-verifies", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const model = resolveModel("sonnet");
  const previousFetch = globalThis.fetch;
  let approvalProposal = null;
  const { fetchMock, requests } = fakeOpenRouter([
    () =>
      sseResponse([
        { choices: [{ delta: { reasoning: "I should inspect the bounds code first." } }] },
        ...toolCallChunks("call_read", "read_file", {
          path: "src/processor.py",
          start_line: 17,
          end_line: 23,
        }),
      ]),
    () =>
      sseResponse(
        toolCallChunks("call_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
          rationale: "include the last valid element",
        })
      ),
    () => sseResponse(contentChunks("I fixed the bounds slice.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model,
        requestApproval: async (proposal) => {
          approvalProposal = proposal;
          return "y";
        },
        onEvent: (event) => events.push(event),
      })
    );
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(requests[0].body.model, "anthropic/claude-sonnet-4.6");
    assert.equal(requests[0].body.stream, true);
    assert.ok(Array.isArray(requests[0].body.tools));
    assert.ok(requests[0].body.tools.some((tool) => tool.function.name === "propose_edit"));
    assert.match(requests[0].body.messages[0].content, /demo-project/);
    assert.equal(requests[0].body.messages.at(-1).role, "user");
    assert.ok(requests[1].body.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_read"));
    assert.ok(requests[2].body.messages.some((message) => message.role === "tool" && message.tool_call_id === "call_edit"));

    assert.ok(approvalProposal);
    assert.equal(approvalProposal.file, "src/processor.py");
    assert.deepEqual(approvalProposal.stats, { adds: 1, dels: 1, changed: 2 });
    assert.equal(result.error, false);
    assert.ok(result.content.includes("I fixed the bounds slice."));
    assert.match(result.content, /Automatic verification/);
    assert.equal(result.editFile.status, "applied");
    assert.equal(result.editFile.stats.adds, 1);
    assert.equal(result.verifyTests.passed, 4);
    assert.equal(result.verifyTests.failed, 0);
    assert.equal(result.verifyTests.ok, true);
    assert.ok(result.usage.prompt_tokens > 0);
    assert.ok(result.usage.completion_tokens > 0);
    assert.ok(result.cost > 0);
    assert.equal(result.metrics.rounds, 3);
    assert.match(result.reasoning, /inspect the bounds/);
    assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));
    const types = events.map((event) => event.type);
    for (const type of ["run:start", "plan", "tool:start", "tool:end", "proposal", "approval:request", "approval:result", "applied", "verify:start", "verify:end", "result", "done"]) {
      assert.ok(types.includes(type), `missing ${type}`);
    }
    assert.ok(events.some((event) => event.type === "thought" && event.text));
    assert.ok(readFileSync(join(DEMO_ROOT, "src", "processor.py"), "utf8").includes(BUGGY));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a denied model patch is never written and never verified", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const before = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        })
      ),
    () => sseResponse(contentChunks("Understood; I left the file alone.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model: resolveModel("sonnet"),
        requestApproval: async () => "n",
        onEvent: (event) => events.push(event),
      })
    );
    assert.equal(result.error, false);
    assert.equal(result.editFile.status, "denied");
    assert.equal(result.editFile.backupPath, null);
    assert.equal(result.verifyTests, null);
    assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8"), before);
    assert.equal(events.some((event) => event.type === "applied"), false);
    assert.equal(events.some((event) => event.type === "verify:start"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a denied follow-up edit on the same file is not reported as applied", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  let approvals = 0;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_edit_one", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        })
      ),
    () =>
      sseResponse(
        toolCallChunks("call_edit_two", "propose_edit", {
          path: "src/processor.py",
          start_line: 21,
          end_line: 22,
          replacement: [
            "        lo = bounds[0]",
            "        return bounds[-1] if len(context) == len(bounds) else lo",
            "        # denied follow-up",
            "",
          ].join("\n"),
        })
      ),
    () => sseResponse(contentChunks("Applied the first edit; left the follow-up alone.")),
  ]);
  globalThis.fetch = fetchMock;
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model: resolveModel("sonnet"),
        requestApproval: async () => {
          approvals += 1;
          return approvals === 1 ? "y" : "n";
        },
      })
    );
    assert.equal(approvals, 2);
    assert.equal(result.editFile.status, "denied");
    assert.equal(result.editFile.backupPath, null);
    assert.match(result.editFile.patch, /denied follow-up/);
    assert.match(result.applied.patch, /context = bounds\[0:len\(bounds\)\]/);
    const source = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
    assert.ok(source.includes(FIXED));
    assert.equal(source.includes("denied follow-up"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("auto-approve skips the gate but still verifies a real edit", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        })
      ),
    () => sseResponse(contentChunks("Applied.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model: resolveModel("sonnet"),
        autoApprove: true,
        requestApproval: async () => {
          throw new Error("gate should not open");
        },
        onEvent: (event) => events.push(event),
      })
    );
    assert.equal(result.editFile.status, "applied");
    assert.equal(result.verifyTests.passed, 4);
    assert.equal(events.some((event) => event.type === "approval:request"), false);
    assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a model edit is revalidated after the approval gate", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const file = join(demo.workspace, "src", "processor.py");
  const before = readFileSync(file, "utf8");
  const changed = `${before}\n# changed while waiting\n`;
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        })
      ),
    () => sseResponse(contentChunks("The write was refused.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model: resolveModel("sonnet"),
        requestApproval: async () => {
          writeFileSync(file, changed);
          return "y";
        },
        onEvent: (event) => events.push(event),
      })
    );
    assert.equal(result.error, false);
    assert.equal(events.some((event) => event.type === "applied"), false);
    assert.ok(
      events.some(
        (event) => event.type === "tool:end" && event.ok === false && /changed after it was read/.test(event.summary)
      )
    );
    assert.equal(readFileSync(file, "utf8"), changed);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a model cannot edit a file whose read was truncated", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const file = join(demo.workspace, "src", "processor.py");
  const source = readFileSync(file, "utf8");
  const large = `${source}\n${"x".repeat(600 * 1024)}\n`;
  writeFileSync(file, large);
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        })
      ),
    () => sseResponse(contentChunks("I refused to edit the truncated file.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model: resolveModel("sonnet"),
        autoApprove: true,
        onEvent: (event) => events.push(event),
      })
    );
    assert.equal(result.error, false);
    assert.equal(events.some((event) => event.type === "approval:request"), false);
    assert.equal(events.some((event) => event.type === "applied"), false);
    assert.ok(events.some((event) => event.type === "tool:end" && event.ok === false && /reads are capped/.test(event.summary)));
    assert.equal(readFileSync(file, "utf8"), large);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a model cannot edit a non-UTF-8 file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "matrix-model-utf8-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"), { recursive: true });
  const file = join(root, "src", "processor.py");
  const original = Buffer.concat([
    Buffer.from("# caf"),
    Buffer.from([0xe9]),
    Buffer.from("\ncontext = bounds[0:len(bounds) - 1]\n"),
  ]);
  writeFileSync(file, original);
  const project = detectProject(root);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 2,
          end_line: 3,
          replacement: "context = bounds[0:len(bounds)]\n",
        })
      ),
    () => sseResponse(contentChunks("I refused to edit the non-UTF-8 file.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model: resolveModel("sonnet"),
        autoApprove: true,
        onEvent: (event) => events.push(event),
      })
    );
    assert.equal(result.error, false);
    assert.equal(result.editFile, null);
    assert.ok(
      events.some(
        (event) => event.type === "tool:end" && event.ok === false && /not valid UTF-8/i.test(event.summary)
      )
    );
    assert.equal(events.some((event) => event.type === "applied"), false);
    assert.deepEqual(readFileSync(file), original);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("auto-verify runs even when the model tested before editing", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () => sseResponse(toolCallChunks("call_test", "run_tests", {})),
    () =>
      sseResponse(
        toolCallChunks("call_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        })
      ),
    () => sseResponse(contentChunks("Done.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model: resolveModel("sonnet"),
        autoApprove: true,
        onEvent: (event) => events.push(event),
      })
    );
    assert.equal(result.verifyTests.passed, 4);
    assert.equal(events.filter((event) => event.type === "verify:start").length, 2);
    assert.match(result.content, /Automatic verification/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("an HTTP error becomes an honest failed result, never a fake success", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("invalid key", { status: 401 });
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "bad" }, () =>
      runModelAgent({
        task: "explain",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      })
    );
    assert.equal(result.error, true);
    assert.match(result.content, /Model run failed/);
    assert.match(result.content, /HTTP 401/);
    assert.equal(result.editFile, null);
    assert.ok(events.some((event) => event.type === "error"));
    assert.equal(events.some((event) => event.type === "applied"), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a missing key fails before any network request", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const home = mkdtempSync(join(tmpdir(), "matrix-model-nokey-"));
  const previousFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return sseResponse(contentChunks("nope"));
  };
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () =>
      runModelAgent({ task: "explain", project, model: resolveModel("sonnet") })
    );
    assert.equal(called, false);
    assert.equal(result.error, true);
    assert.match(result.content, /No OpenRouter API key/);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("parseToolArgs handles valid JSON, markdown fences, trailing commas, and noise", () => {
  assert.deepEqual(parseToolArgs("{}"), {});
  assert.deepEqual(parseToolArgs(""), {});
  assert.deepEqual(parseToolArgs(null), {});
  assert.deepEqual(parseToolArgs('{"path": "src/processor.py"}'), { path: "src/processor.py" });
  assert.deepEqual(
    parseToolArgs('```json\n{"path": "src/processor.py", "start_line": 10,}\n```'),
    { path: "src/processor.py", start_line: 10 }
  );
  assert.deepEqual(
    parseToolArgs('Sure, calling tool: {"query": "bounds",} right now.'),
    { query: "bounds" }
  );
});
