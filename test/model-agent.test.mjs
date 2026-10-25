import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseToolArgs, runModelAgent } from "../lib/model-agent.mjs";
import { estimateCost, resolveModel } from "../lib/models.mjs";
import { detectProject } from "../lib/project.mjs";
import { TEST_ORIGIN, createTestPolicy, withTestExecutionContext } from "../lib/test-policy.mjs";
import {
  DEMO_ROOT,
  PROVIDER_ENVIRONMENT_KEYS,
  copyDemo,
  contentChunks,
  sseResponse,
  toolCallChunks,
} from "./helpers.mjs";

const TASK = "Fix the off-by-one in src/processor.py and verify it";
const BUGGY = "context = bounds[0:len(bounds) - 1]";
const FIXED = "context = bounds[0:len(bounds)]";

function withEnv(values, fn) {
  const testHome = mkdtempSync(join(tmpdir(), "matrix-model-home-"));
  const scoped = {
    ...Object.fromEntries(PROVIDER_ENVIRONMENT_KEYS.map((key) => [key, undefined])),
    MATRIX_HOME: testHome,
    ...values,
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(scoped)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Provider fixtures explicitly authorize their exact test plan without
  // persisting trust or writing audits/backups into the developer's home.
  const policy = createTestPolicy({ home: testHome, headless: true, allowTests: true });
  return Promise.resolve()
    .then(() => withTestExecutionContext({ home: testHome, origin: TEST_ORIGIN.MODEL, policy }, fn))
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(testHome, { recursive: true, force: true });
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
        }),
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
      }),
    );
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(requests[0].body.model, "anthropic/claude-sonnet-4.6");
    assert.equal(requests[0].body.stream, true);
    assert.ok(Array.isArray(requests[0].body.tools));
    assert.ok(requests[0].body.tools.some((tool) => tool.function.name === "propose_edit"));
    assert.match(requests[0].body.messages[0].content, /demo-project/);
    assert.equal(requests[0].body.messages.at(-1).role, "user");
    assert.ok(
      requests[1].body.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "call_read",
      ),
    );
    assert.ok(
      requests[2].body.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === "call_edit",
      ),
    );

    assert.ok(approvalProposal);
    assert.equal(approvalProposal.file, "src/processor.py");
    assert.deepEqual(approvalProposal.stats, { adds: 1, dels: 1, changed: 2 });
    assert.equal(result.error, false);
    assert.equal(result.ok, true);
    assert.equal(result.status, "success");
    assert.equal(result.outcome, "success");
    assert.equal(result.mode, "remote");
    assert.equal(result.elapsedMs, result.metrics.elapsedMs);
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
    assert.equal(result.usage.provenance, "provider");
    assert.equal(result.usage.costProvenance, "estimated");
    assert.equal(result.metrics.usageProvenance, "provider");
    assert.equal(result.metrics.costProvenance, "estimated");
    assert.equal(result.metrics.rounds, 3);
    assert.match(result.reasoning, /inspect the bounds/);
    assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));
    const types = events.map((event) => event.type);
    for (const type of [
      "run:start",
      "plan",
      "tool:start",
      "tool:end",
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
    assert.ok(events.some((event) => event.type === "thought" && event.text));
    assert.deepEqual(types.slice(-4), ["metrics", "phase", "result", "done"]);
    assert.ok(readFileSync(join(DEMO_ROOT, "src", "processor.py"), "utf8").includes(BUGGY));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("mixed provider and missing usage rounds retain token and cost provenance", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const model = resolveModel("sonnet");
  const previousFetch = globalThis.fetch;
  const firstRound = toolCallChunks("call_usage", "list_files", { limit: 1 });
  firstRound[firstRound.length - 1] = {
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.01 },
  };
  const { fetchMock } = fakeOpenRouter([
    () => sseResponse(firstRound),
    () =>
      sseResponse([
        { choices: [{ delta: { content: "Done, but this provider round omitted usage." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "list one file and report mixed usage",
        project,
        model,
        onEvent: (event) => events.push(event),
      }),
    );
    const usage = result.usage;
    assert.equal(result.error, false);
    assert.equal(usage.provenance, "mixed");
    assert.equal(usage.costProvenance, "mixed");
    assert.equal(usage.costComplete, true);
    assert.deepEqual(usage.rounds, { total: 2, provider: 1, estimated: 1, unavailable: 0 });
    assert.deepEqual(usage.costRounds, { provider: 1, estimated: 1, unavailable: 0 });
    assert.equal(usage.provider.prompt_tokens, 100);
    assert.equal(usage.provider.completion_tokens, 10);
    assert.equal(usage.provider.cost, 0.01);
    assert.ok(usage.estimated.prompt_tokens > 0);
    assert.ok(usage.estimated.completion_tokens > 0);
    assert.ok(usage.estimated.cost > 0);
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens"]) {
      assert.equal(usage[key], usage.provider[key] + usage.estimated[key]);
    }
    assert.equal(result.cost, 0.01 + usage.estimated.cost);
    assert.equal(usage.cost, result.cost);
    assert.equal(result.costProvenance, "mixed");
    assert.equal(result.metrics.cost, result.cost);
    assert.equal(result.metrics.providerCost, 0.01);
    assert.equal(result.metrics.estimatedCost, usage.estimated.cost);
    assert.deepEqual(result.metrics.usage, usage);
    assert.match(result.summary, /tokens \(mixed\).*\(mixed\)/);

    const usageEvents = events.filter((event) => event.type === "usage");
    assert.equal(usageEvents.length, 2);
    assert.equal(usageEvents[0].usage.provenance, "provider");
    assert.equal(usageEvents[0].usage.costProvenance, "provider");
    assert.deepEqual(usageEvents[1].usage, usage);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("provider-reported charges including zero replace registry estimates", async (t) => {
  for (const charge of [0.006, 0]) {
    const demo = copyDemo();
    t.after(() => demo.cleanup());
    const project = detectProject(demo.workspace);
    const model = resolveModel("sonnet");
    const previousFetch = globalThis.fetch;
    const providerUsage = {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      total_tokens: 2_000_000,
      cost: charge,
    };
    const { fetchMock } = fakeOpenRouter([
      () =>
        sseResponse([
          { choices: [{ delta: { content: "Provider charged this round." } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { usage: providerUsage },
        ]),
    ]);
    globalThis.fetch = fetchMock;
    try {
      const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
        runModelAgent({ task: "report provider cost", project, model }),
      );
      assert.equal(result.cost, charge);
      assert.equal(result.usage.cost, charge);
      assert.equal(result.usage.provenance, "provider");
      assert.equal(result.usage.costProvenance, "provider");
      assert.equal(result.usage.costComplete, true);
      assert.equal(result.usage.provider.cost, charge);
      assert.equal(result.usage.estimated.cost, 0);
      assert.equal(result.metrics.costProvenance, "provider");
      assert.equal(result.metrics.providerCost, charge);
      assert.equal(result.metrics.estimatedCost, 0);
      assert.notEqual(result.cost, estimateCost(model, providerUsage));
    } finally {
      globalThis.fetch = previousFetch;
    }
  }
});

test("estimated usage with unknown registry pricing leaves cost unavailable", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const model = { ...resolveModel("sonnet"), pricing: null };
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse([
        { choices: [{ delta: { content: "No usage or reliable price is available." } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
  ]);
  globalThis.fetch = fetchMock;
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({ task: "report unknown cost", project, model }),
    );
    assert.equal(result.usage.provenance, "estimated");
    assert.equal(result.usage.costProvenance, "unavailable");
    assert.equal(result.cost, null);
    assert.equal(result.metrics.cost, null);
    assert.equal(result.metrics.costComplete, false);
    assert.deepEqual(result.usage.costRounds, { provider: 0, estimated: 0, unavailable: 1 });
    assert.match(result.summary, /tokens \(estimated\).*cost unavailable/);
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
        }),
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
      }),
    );
    assert.equal(result.error, false);
    assert.equal(result.ok, true);
    assert.equal(result.status, "denied");
    assert.equal(result.failure, null);
    assert.equal(result.editFile.status, "denied");
    assert.equal(result.editFile.backupPath, null);
    assert.equal(result.verifyTests, null);
    assert.equal(result.toolCards.find((card) => card.name === "propose_edit")?.ok, false);
    assert.equal(
      events.find((event) => event.type === "tool:end" && event.id === "call_edit")?.ok,
      false,
    );
    assert.equal(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8"), before);
    assert.equal(
      events.some((event) => event.type === "applied"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "verify:start"),
      false,
    );
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
        }),
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
        }),
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
      }),
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
        }),
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
      }),
    );
    assert.equal(result.editFile.status, "applied");
    assert.equal(result.verifyTests.passed, 4);
    assert.equal(
      events.some((event) => event.type === "approval:request"),
      false,
    );
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
        }),
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
      }),
    );
    assert.equal(result.error, true);
    assert.ok(result.failure);
    assert.equal(
      events.some((event) => event.type === "applied"),
      false,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool:end" &&
          event.ok === false &&
          /changed after it was read/.test(event.summary),
      ),
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
        }),
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
      }),
    );
    assert.equal(result.error, true);
    assert.ok(result.failure);
    assert.equal(
      events.some((event) => event.type === "approval:request"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "applied"),
      false,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool:end" && event.ok === false && /reads are capped/.test(event.summary),
      ),
    );
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
        }),
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
      }),
    );
    assert.equal(result.error, true);
    assert.ok(result.failure);
    assert.equal(result.editFile, null);
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool:end" && event.ok === false && /not valid UTF-8/i.test(event.summary),
      ),
    );
    assert.equal(
      events.some((event) => event.type === "applied"),
      false,
    );
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
        }),
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
      }),
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
      }),
    );
    assert.equal(result.error, true);
    assert.match(result.content, /Model run failed/);
    assert.match(result.content, /HTTP 401/);
    assert.equal(result.editFile, null);
    assert.equal(result.usage.provenance, "unavailable");
    assert.equal(result.usage.costProvenance, "unavailable");
    assert.equal(result.cost, null);
    assert.equal(result.metrics.cost, null);
    assert.equal(result.metrics.costComplete, false);
    assert.ok(events.some((event) => event.type === "error"));
    assert.equal(
      events.some((event) => event.type === "applied"),
      false,
    );
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
      runModelAgent({ task: "explain", project, model: resolveModel("sonnet") }),
    );
    assert.equal(called, false);
    assert.equal(result.error, true);
    assert.match(result.content, /No OpenRouter API key/);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(home, { recursive: true, force: true });
  }
});

test("parseToolArgs is strict and never rewrites source-like strings", () => {
  assert.deepEqual(parseToolArgs("{}"), {});
  assert.deepEqual(parseToolArgs(""), {});
  assert.deepEqual(parseToolArgs(null), {});
  assert.deepEqual(parseToolArgs('{"path": "src/processor.py"}'), { path: "src/processor.py" });

  const source = "const marker = ',}';";
  const valid = JSON.stringify({ path: "src/helper.py", content: source });
  assert.deepEqual(parseToolArgs(valid), { path: "src/helper.py", content: source });
  assert.throws(() => parseToolArgs(`${valid.slice(0, -1)},}`), SyntaxError);
  assert.throws(() => parseToolArgs(`\`\`\`json\n${valid}\n\`\`\``), SyntaxError);
  assert.throws(() => parseToolArgs(`Sure, calling tool: ${valid} right now.`), SyntaxError);
});

test("parallel no-index tool calls keep distinct identities across argument fragments", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const firstArgs = JSON.stringify({ filter: "src/", limit: 1 });
  const secondArgs = JSON.stringify({ filter: "no-such-file", limit: 2 });
  const firstSplit = Math.floor(firstArgs.length / 2);
  const secondSplit = Math.floor(secondArgs.length / 2);
  const { fetchMock, requests } = fakeOpenRouter([
    () =>
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: "no_index_a",
                    type: "function",
                    function: { name: "list_files", arguments: firstArgs.slice(0, firstSplit) },
                  },
                  {
                    id: "no_index_b",
                    type: "function",
                    function: { name: "list_files", arguments: secondArgs.slice(0, secondSplit) },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { function: { arguments: firstArgs.slice(firstSplit) } },
                  { function: { arguments: secondArgs.slice(secondSplit) } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    () => sseResponse(contentChunks("Listed both filters independently.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "list two filters in parallel",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, false);
    assert.equal(result.metrics.toolCalls, 2);
    const starts = events.filter((event) => event.type === "tool:start");
    assert.deepEqual(
      starts.map((event) => event.id),
      ["no_index_a", "no_index_b"],
    );
    assert.deepEqual(
      starts.map((event) => event.args.filter),
      ["src/", "no-such-file"],
    );
    const assistant = requests[1].body.messages.find((message) => message.role === "assistant");
    assert.deepEqual(
      assistant.tool_calls.map((call) => call.id),
      ["no_index_a", "no_index_b"],
    );
    const replies = requests[1].body.messages.filter((message) => message.role === "tool");
    assert.deepEqual(
      replies.map((message) => message.tool_call_id),
      ["no_index_a", "no_index_b"],
    );
    assert.equal(JSON.parse(replies[0].content).count, 1);
    assert.equal(JSON.parse(replies[1].content).count, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("null, scalar, and array arguments return protocol errors before labels or dispatch", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const invalidArguments = ["null", "42", "[]"];
  const { fetchMock, requests } = fakeOpenRouter([
    () =>
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: invalidArguments.map((args, index) => ({
                  index,
                  id: `invalid_args_${index}`,
                  type: "function",
                  function: { name: "search_repo", arguments: args },
                })),
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    () => sseResponse(contentChunks("The tool calls were invalid; no search ran.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "exercise malformed tool schemas",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, false);
    assert.doesNotMatch(result.content, /Model run failed|TypeError/);
    const starts = events.filter((event) => event.type === "tool:start");
    assert.equal(starts.length, 3);
    assert.ok(starts.every((event) => event.label === "search_repo (invalid args)"));
    assert.ok(starts.every((event) => Object.keys(event.args).length === 0));
    const ends = events.filter((event) => event.type === "tool:end");
    assert.equal(ends.length, 3);
    assert.ok(
      ends.every((event) => event.ok === false && /expected a JSON object/.test(event.summary)),
    );
    const replies = requests[1].body.messages.filter((message) => message.role === "tool");
    assert.deepEqual(
      replies.map((message) => message.tool_call_id),
      invalidArguments.map((_, index) => `invalid_args_${index}`),
    );
    for (const reply of replies) {
      const parsed = JSON.parse(reply.content);
      assert.equal(parsed.status, "error");
      assert.match(parsed.error, /expected a JSON object/);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("oversized tool results are bounded valid JSON with explicit truncation metadata", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  project.files = Array.from({ length: 200 }, (_, index) => ({
    rel: `${"long-directory/".repeat(12)}file-${String(index).padStart(3, "0")}.py`,
    path: join(demo.workspace, `file-${index}.py`),
    language: "Python",
    size: 1000,
  }));
  project.fileCount = project.files.length;
  const previousFetch = globalThis.fetch;
  const { fetchMock, requests } = fakeOpenRouter([
    () => sseResponse(toolCallChunks("call_large_result", "list_files", { limit: 200 })),
    () => sseResponse(contentChunks("The result was too large and was truncated safely.")),
  ]);
  globalThis.fetch = fetchMock;
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({ task: "list everything", project, model: resolveModel("sonnet") }),
    );
    assert.equal(result.error, false);
    const reply = requests[1].body.messages.find((message) => message.role === "tool");
    assert.ok(Buffer.byteLength(reply.content) <= 24_000);
    const parsed = JSON.parse(reply.content);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.truncation.limit_bytes, 24_000);
    assert.ok(parsed.truncation.original_bytes > 24_000);
    assert.ok(parsed.truncation.preview_bytes > 0);
    assert.ok(parsed.truncation.omitted_bytes > 0);
    assert.equal(typeof parsed.preview, "string");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("write_file creates a new file through approval gate with unified diff", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const model = resolveModel("sonnet");
  const previousFetch = globalThis.fetch;
  const newFilePath = "src/helper.py";
  const newFileContent = "def helper():\n    return 42\n";

  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_write", "write_file", {
          path: newFilePath,
          content: newFileContent,
          rationale: "create helper module",
        }),
      ),
    () => sseResponse(contentChunks("I created helper.py.")),
  ]);
  globalThis.fetch = fetchMock;
  try {
    let proposalSeen = null;
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "Create helper.py",
        project,
        model,
        requestApproval: async (proposal) => {
          proposalSeen = proposal;
          return "y";
        },
      }),
    );
    assert.equal(result.error, false);
    assert.ok(proposalSeen);
    assert.equal(proposalSeen.file, "src/helper.py");
    assert.equal(proposalSeen.isCreation, true);
    assert.ok(proposalSeen.patch.includes("+def helper():"));
    assert.equal(readFileSync(join(demo.workspace, newFilePath), "utf8"), newFileContent);
    assert.ok(project.files.some((f) => f.rel === newFilePath));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("remote read_file refuses sensitive files without forwarding their contents", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  writeFileSync(join(demo.workspace, ".env"), "MATRIX_FAKE_SECRET=canary-value\n");
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock, requests } = fakeOpenRouter([
    () => sseResponse(toolCallChunks("call_secret", "read_file", { path: ".env" })),
    () => sseResponse(contentChunks("done")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "inspect the environment file",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      }),
    );
    const end = events.find((event) => event.type === "tool:end" && event.id === "call_secret");
    assert.equal(end?.ok, false);
    assert.match(end?.summary ?? "", /sensitive file/);
    for (const request of requests) {
      assert.equal(JSON.stringify(request.body).includes("canary-value"), false);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("write_file refuses to classify an existing unreadable file as a creation", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const target = join(demo.workspace, "existing.txt");
  const original = Buffer.from([0x41, 0x00, 0x42]);
  writeFileSync(target, original);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_existing", "write_file", {
          path: "existing.txt",
          content: "replacement",
        }),
      ),
    () => sseResponse(contentChunks("done")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  let approvals = 0;
  try {
    await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "overwrite the file",
        project,
        model: resolveModel("sonnet"),
        requestApproval: async () => {
          approvals += 1;
          return "y";
        },
        onEvent: (event) => events.push(event),
      }),
    );
    assert.deepEqual(readFileSync(target), original);
    assert.equal(approvals, 0);
    assert.equal(
      events.some((event) => event.type === "proposal"),
      false,
    );
    const end = events.find((event) => event.type === "tool:end" && event.id === "call_existing");
    assert.equal(end?.ok, false);
    assert.match(end?.summary ?? "", /binary file|refusing to edit/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("write_file creation revalidation rejects a file that appears during approval", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const target = join(demo.workspace, "appearing.txt");
  const original = Buffer.from([0x41, 0x00, 0x42]);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_appearing", "write_file", {
          path: "appearing.txt",
          content: "replacement",
        }),
      ),
    () => sseResponse(contentChunks("done")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "create the file",
        project,
        model: resolveModel("sonnet"),
        requestApproval: async () => {
          writeFileSync(target, original);
          return "y";
        },
        onEvent: (event) => events.push(event),
      }),
    );
    assert.deepEqual(readFileSync(target), original);
    assert.equal(
      events.some((event) => event.type === "applied"),
      false,
    );
    const end = events.find((event) => event.type === "tool:end" && event.id === "call_appearing");
    assert.equal(end?.ok, false);
    assert.match(end?.summary ?? "", /already exists/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("run_command is disabled without spawning or bypassing the write gate", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const model = resolveModel("sonnet");
  const previousFetch = globalThis.fetch;
  const target = join(demo.workspace, "denied-target.txt");

  const { fetchMock, requests } = fakeOpenRouter([
    () =>
      sseResponse(toolCallChunks("call_cmd1", "run_command", { command: "echo 'hello matrix'" })),
    () =>
      sseResponse(
        toolCallChunks("call_cmd2", "run_command", {
          command: "printf changed > denied-target.txt",
        }),
      ),
    () => sseResponse(contentChunks("done")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "run commands",
        project,
        model,
        requestApproval: async () => {
          throw new Error("commands must not reach an edit approval or spawn");
        },
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, false);
    for (const id of ["call_cmd1", "call_cmd2"]) {
      const end = events.find((event) => event.type === "tool:end" && event.id === id);
      assert.ok(end);
      assert.equal(end.ok, false);
      assert.match(end.summary, /command execution disabled/);
    }
    assert.equal(
      events.some((event) => event.type === "command:start"),
      false,
    );
    assert.equal(existsSync(target), false);
    for (const request of requests) {
      assert.equal(
        request.body.tools.some((tool) => tool.function.name === "run_command"),
        false,
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a single oversized argument block returns a bounded protocol error", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock, requests } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_oversized_args", "list_files", { filter: "x".repeat(40_000) }),
      ),
    () => sseResponse(contentChunks("The call exceeded its argument budget.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "exercise the per-call argument limit",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, false);
    const end = events.find((event) => event.type === "tool:end");
    assert.equal(end.ok, false);
    assert.match(end.summary, /tool argument budget exhausted \(32768 bytes per call\)/);
    const assistant = requests[1].body.messages.find((message) => message.role === "assistant");
    assert.equal(assistant.tool_calls[0].function.arguments, "{}");
    const reply = requests[1].body.messages.find((message) => message.role === "tool");
    assert.equal(JSON.parse(reply.content).status, "blocked");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("per-response argument budgets block only excess calls without dispatching them", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock, requests } = fakeOpenRouter([
    () =>
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: Array.from({ length: 3 }, (_, index) => ({
                  index,
                  id: `response_args_${index}`,
                  type: "function",
                  function: {
                    name: "list_files",
                    arguments: JSON.stringify({
                      filter: `${index}-${"x".repeat(30_000)}`,
                      limit: 1,
                    }),
                  },
                })),
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    () => sseResponse(contentChunks("The third argument block exceeded the response budget.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "exercise response argument limits",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, false);
    const ends = events.filter((event) => event.type === "tool:end");
    assert.equal(ends.filter((event) => event.ok).length, 2);
    assert.equal(ends.at(-1).id, "response_args_2");
    assert.equal(ends.at(-1).ok, false);
    assert.match(ends.at(-1).summary, /per-response argument budget/);
    const replies = requests[1].body.messages.filter((message) => message.role === "tool");
    assert.equal(JSON.parse(replies[2].content).status, "blocked");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the total argument budget spans rounds and stops further model requests", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const rounds = Array.from(
    { length: 5 },
    (_, round) => () =>
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: Array.from({ length: 2 }, (_, index) => ({
                  index,
                  id: `total_args_${round}_${index}`,
                  type: "function",
                  function: {
                    name: "list_files",
                    arguments: JSON.stringify({
                      filter: `${round}-${index}-${"x".repeat(30_000)}`,
                      limit: 1,
                    }),
                  },
                })),
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
  );
  const { fetchMock, requests } = fakeOpenRouter(rounds);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "exercise the run-wide argument limit",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, true);
    assert.match(result.failure, /total tool argument budget/);
    assert.equal(requests.length, 5);
    const ends = events.filter((event) => event.type === "tool:end");
    assert.equal(ends.filter((event) => event.ok).length, 8);
    assert.equal(ends.filter((event) => event.ok === false).length, 2);
    assert.match(ends.at(-1).summary, /total tool argument budget/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the tool budget stops execution at 24 calls and returns an incomplete result", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const chunks = Array.from({ length: 25 }, (_, index) => ({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index,
              id: `budget_${index}`,
              type: "function",
              function: { name: "list_files", arguments: "{}" },
            },
          ],
        },
      },
    ],
  }));
  const { fetchMock } = fakeOpenRouter([() => sseResponse(chunks)]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "list until the budget is exceeded",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, true);
    assert.equal(result.ok, false);
    assert.equal(result.status, "budgetExhausted");
    assert.equal(result.budgetExhausted, true);
    assert.match(result.failure, /24-call tool budget/);
    assert.equal(result.metrics.toolCalls, 24);
    assert.equal(events.filter((event) => event.type === "tool:start").length, 24);
    const blocked = events.find((event) => event.type === "tool:end" && event.id === "budget_24");
    assert.equal(blocked?.ok, false);
    assert.match(blocked?.summary ?? "", /budget exhausted/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("prompt context budgets fail before an oversized request reaches the provider", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return sseResponse(contentChunks("must not be requested"));
  };
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "this prompt cannot fit",
        project,
        model: { ...resolveModel("sonnet"), context: 128 },
      }),
    );
    assert.equal(result.error, true);
    assert.match(result.failure, /context budget exhausted/);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("follow-up prompt context budgets include prior assistant and tool messages", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  project.files = Array.from({ length: 200 }, (_, index) => ({
    rel: `${"context-directory/".repeat(12)}file-${index}.py`,
    path: join(demo.workspace, `file-${index}.py`),
    language: "Python",
    size: 1000,
  }));
  project.fileCount = project.files.length;
  const previousFetch = globalThis.fetch;
  const { fetchMock, requests } = fakeOpenRouter([
    () => sseResponse(toolCallChunks("call_context_growth", "list_files", { limit: 200 })),
  ]);
  globalThis.fetch = fetchMock;
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "grow the prompt beyond its context",
        project,
        model: { ...resolveModel("sonnet"), context: 5000 },
      }),
    );
    assert.equal(result.error, true);
    assert.match(result.failure, /context budget exhausted/);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("two runs share only bounded previous user/assistant turns through extraContext", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const model = resolveModel("sonnet");
  const previousFetch = globalThis.fetch;
  const firstTask = "Remember the conversation marker ALPHA";
  const secondTask = "What marker came before?";
  const { fetchMock, requests } = fakeOpenRouter([
    () => sseResponse(contentChunks("The previous answer is ALPHA.")),
    () => sseResponse(contentChunks("The marker was ALPHA.")),
  ]);
  globalThis.fetch = fetchMock;
  try {
    const first = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({ task: firstTask, project, model }),
    );
    const olderTurns = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `old-${index}-${"x".repeat(4500)}`,
    }));
    const extraContext = [
      ...olderTurns,
      { role: "system", content: "system-history-must-not-cross-runs" },
      { role: "user", content: firstTask },
      { role: "assistant", content: first.content },
      { role: "tool", content: "tool-history-must-not-cross-runs" },
      // A UI that already appended the current prompt must not duplicate it.
      { role: "user", content: secondTask },
    ];
    const second = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({ task: secondTask, project, model, extraContext }),
    );
    assert.equal(second.error, false);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].body.messages.slice(1), [{ role: "user", content: firstTask }]);

    const payload = requests[1].body.messages;
    const forwarded = payload.slice(1, -1);
    assert.ok(forwarded.length > 0);
    assert.ok(forwarded.length <= 12);
    assert.ok(
      forwarded.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) <= 32 * 1024,
    );
    assert.ok(forwarded.every((message) => ["user", "assistant"].includes(message.role)));
    assert.equal(forwarded.at(-1).content, first.content);
    assert.ok(forwarded.some((message) => message.content.includes("[context truncated]")));
    assert.deepEqual(payload.at(-1), { role: "user", content: secondTask });
    assert.equal(payload.filter((message) => message.content === secondTask).length, 1);
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(
      serialized,
      /system-history-must-not-cross-runs|tool-history-must-not-cross-runs/,
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("per-response context budgets reject oversized model output before dispatch", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () => sseResponse([{ choices: [{ delta: { content: "x".repeat(140_000) } }] }]),
  ]);
  globalThis.fetch = fetchMock;
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "return an oversized response",
        project,
        model: resolveModel("sonnet"),
      }),
    );
    assert.equal(result.error, true);
    assert.match(result.failure, /per-response context budget/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("explicit failed run_tests feeds a bounded healing round and can recover", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock, requests } = fakeOpenRouter([
    () => sseResponse(toolCallChunks("call_explicit_failure", "run_tests", {})),
    () =>
      sseResponse(
        toolCallChunks("call_explicit_fix", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        }),
      ),
    () => sseResponse(contentChunks("I fixed the failure reported by run_tests.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "Run tests and repair the failure",
        project,
        model: resolveModel("sonnet"),
        autoApprove: true,
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, false);
    assert.equal(result.ok, true);
    assert.equal(result.verifyTests.passed, 4);
    assert.equal(requests.length, 3);
    assert.equal(events.filter((event) => event.type === "verify:start").length, 2);
    assert.equal(
      events.filter((event) => event.type === "phase" && event.phase === "healing").length,
      1,
    );
    const failureReply = requests[1].body.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "call_explicit_failure",
    );
    assert.equal(JSON.parse(failureReply.content).status, "failed");
    assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("explicit verification healing stops after two follow-up opportunities", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock, requests } = fakeOpenRouter([
    () => sseResponse(toolCallChunks("call_repeat_test_1", "run_tests", {})),
    () => sseResponse(toolCallChunks("call_repeat_test_2", "run_tests", {})),
    () => sseResponse(toolCallChunks("call_repeat_test_3", "run_tests", {})),
    () => sseResponse(contentChunks("No fourth model round should be needed.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "Keep running the failing tests",
        project,
        model: resolveModel("sonnet"),
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "failed");
    assert.equal(requests.length, 3);
    assert.equal(events.filter((event) => event.type === "verify:start").length, 3);
    assert.equal(
      events.filter((event) => event.type === "phase" && event.phase === "healing").length,
      2,
    );
    assert.match(result.content, /2 bounded healing attempts/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("autonomous self-healing loop feeds test failure traceback back to model for automatic recovery", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const model = resolveModel("sonnet");
  const previousFetch = globalThis.fetch;

  // Round 1: Model proposes a broken edit that makes pytest fail
  // Round 2: Model finishes round with content -> calls.length === 0 -> auto-verify fails!
  //          Self-healing loop triggers -> user message with traceback fed into messages
  // Round 3: Model receives traceback, proposes correct edit
  // Round 4: Model finishes round with content -> calls.length === 0 -> auto-verify passes!
  const { fetchMock, requests } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_bad_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:0]\n",
          rationale: "erroneous empty slice",
        }),
      ),
    () => sseResponse(contentChunks("I made the change.")),
    () =>
      sseResponse(
        toolCallChunks("call_fix_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
          rationale: "correct bounds slice after seeing test failure",
        }),
      ),
    () => sseResponse(contentChunks("I corrected the slice after the test failure.")),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "Fix processor.py",
        project,
        model,
        autoApprove: true,
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(result.error, false);
    // Verified tests ultimately passed
    assert.equal(result.verifyTests.ok, true);
    assert.equal(result.verifyTests.passed, 4);
    assert.equal(result.verifyTests.failed, 0);

    // Verify self-healing phase was emitted
    const healEvent = events.find((e) => e.type === "phase" && e.phase === "healing");
    assert.ok(healEvent, "should have emitted healing phase");
    assert.match(healEvent.detail, /Self-healing attempt 1\/2/);

    // Verify the feedback message sent to OpenRouter in round 3 contains the test failure
    assert.ok(requests.length >= 3);
    const round3Messages = requests[2].body.messages;
    const feedbackTurn = round3Messages.find(
      (m) => m.role === "user" && m.content.includes("AUTOMATIC VERIFICATION FAILED"),
    );
    assert.ok(feedbackTurn, "round 3 prompt should include test failure feedback");
    assert.match(feedbackTurn.content, /failure traceback/);

    // Verify file on disk is fixed
    assert.ok(readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(FIXED));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("failed automatic verification after an edit keeps interactive undo guidance", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_unhealed_edit", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:0]\n",
        }),
      ),
    () => sseResponse(contentChunks("The edit is complete, but verification will fail.")),
  ]);
  globalThis.fetch = fetchMock;
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "Apply a broken edit",
        project,
        model: resolveModel("sonnet"),
        autoApprove: true,
        maxRounds: 2,
        recoveryMode: "interactive",
      }),
    );
    assert.equal(result.status, "failed");
    assert.equal(result.budgetExhausted, false);
    assert.equal(result.recovery.mode, "interactive");
    assert.match(result.content, /Alt\+U or \/undo/);
    assert.doesNotMatch(result.content, /headless run has no interactive undo/);
    assert.equal(result.recovery.edits[0].file, "src/processor.py");
    assert.equal(result.recovery.edits[0].isCreation, false);
    assert.ok(result.recovery.edits[0].backupPath);
    assert.ok(
      readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes("bounds[0:0]"),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a provider failure after an applied edit gives honest headless recovery", async (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock } = fakeOpenRouter([
    () =>
      sseResponse(
        toolCallChunks("call_before_failure", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]\n",
        }),
      ),
    () =>
      sseResponse(
        toolCallChunks("call_intermediate_failure", "propose_edit", {
          path: "src/processor.py",
          start_line: 20,
          end_line: 21,
          replacement: "        context = bounds[0:len(bounds)]  # intermediate state\n",
        }),
      ),
    () => new Response("provider stopped", { status: 401 }),
  ]);
  globalThis.fetch = fetchMock;
  try {
    const { result, backupText } = await withEnv({ OPENROUTER_API_KEY: "test-key" }, async () => {
      const run = await runModelAgent({
        task: "Apply an edit before the provider fails",
        project,
        model: resolveModel("sonnet"),
        autoApprove: true,
        recoveryMode: "headless",
      });
      return {
        result: run,
        backupText: readFileSync(run.recovery.edits[0].backupPath, "utf8"),
      };
    });
    assert.equal(result.error, true);
    assert.equal(result.status, "failed");
    assert.match(result.content, /Model run failed:.*HTTP 401/s);
    assert.match(result.content, /headless run has no interactive undo/);
    assert.match(result.content, /backup paths/);
    assert.doesNotMatch(result.content, /Alt\+U|\/undo/);
    assert.equal(result.recovery.mode, "headless");
    assert.equal(result.recovery.edits.length, 1);
    assert.equal(result.recovery.edits[0].file, "src/processor.py");
    assert.ok(result.content.includes(result.recovery.edits[0].backupPath));
    assert.equal(result.content.includes(result.applied.backupPath), false);
    assert.ok(backupText.includes(BUGGY));
    assert.ok(
      readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(
        "# intermediate state",
      ),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function outcomeDemo(t, testSource) {
  const demo = copyDemo("matrix-model-outcome-");
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

async function runProcessOutcome(t, { automatic, testSource, testTimeoutMs, abort = false }) {
  const { project, file } = outcomeDemo(t, testSource);
  const previousFetch = globalThis.fetch;
  const rounds = automatic
    ? [
        () =>
          sseResponse(
            toolCallChunks(`call_edit_${automatic}`, "propose_edit", {
              path: "src/processor.py",
              start_line: 20,
              end_line: 21,
              replacement: "        context = bounds[0:len(bounds)]\n",
            }),
          ),
        () => sseResponse(contentChunks("The model round is complete.")),
        () => sseResponse(contentChunks("unexpected model round")),
      ]
    : [
        () => sseResponse(toolCallChunks("call_explicit_test", "run_tests", {})),
        () => sseResponse(contentChunks("unexpected model round")),
      ];
  const { fetchMock, requests } = fakeOpenRouter(rounds);
  globalThis.fetch = fetchMock;
  const abortController = new AbortController();
  const events = [];
  let result;
  try {
    result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: TASK,
        project,
        model: resolveModel("sonnet"),
        autoApprove: automatic,
        signal: abortController.signal,
        testTimeoutMs,
        onEvent: (event) => {
          events.push(event);
          if (abort && event.type === "verify:start") abortController.abort();
        },
      }),
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  return { result, requests, events, file };
}

function assertTerminalEventOrder(events) {
  assert.deepEqual(events.map((event) => event.type).slice(-4), [
    "metrics",
    "phase",
    "result",
    "done",
  ]);
}

test("remote explicit and automatic unrecognized verification are both terminal and unverified", async (t) => {
  for (const automatic of [false, true]) {
    const { result, requests, events, file } = await runProcessOutcome(t, {
      automatic,
      testSource: 'console.log("zero exit without a test summary");\n',
    });
    assert.equal(result.status, "unverified");
    assert.equal(result.outcome, "unverified");
    assert.equal(result.ok, false);
    assert.equal(result.error, false);
    assert.equal(result.verifyTests.processOk, true);
    assert.equal(result.verifyTests.verified, false);
    assert.equal(result.verifyTests.verificationStatus, "unverified");
    assert.equal(
      requests.length,
      automatic ? 2 : 1,
      "no model round may follow terminal verification",
    );
    assert.equal(events.filter((event) => event.type === "verify:start").length, 1);
    assert.equal(result.elapsedMs, result.metrics.elapsedMs);
    assert.ok(readFileSync(file, "utf8").includes(automatic ? FIXED : BUGGY));
    assertTerminalEventOrder(events);
  }
});

test("remote explicit and automatic timeouts stop further work with applied edits intact", async (t) => {
  for (const automatic of [false, true]) {
    const { result, requests, events, file } = await runProcessOutcome(t, {
      automatic,
      testSource: "setInterval(() => {}, 1000);\n",
      testTimeoutMs: 40,
    });
    assert.equal(result.status, "timedOut");
    assert.equal(result.outcome, "timedOut");
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    assert.equal(result.verifyTests.verificationStatus, "timedOut");
    assert.equal(requests.length, automatic ? 2 : 1, "no model round may follow a timeout");
    assert.equal(events.filter((event) => event.type === "verify:start").length, 1);
    assert.ok(readFileSync(file, "utf8").includes(automatic ? FIXED : BUGGY));
    assertTerminalEventOrder(events);
  }
});

test("remote explicit and automatic aborts never start another model round or process", async (t) => {
  for (const automatic of [false, true]) {
    const { result, requests, events, file } = await runProcessOutcome(t, {
      automatic,
      testSource: "setInterval(() => {}, 1000);\n",
      abort: true,
    });
    assert.equal(result.status, "aborted");
    assert.equal(result.outcome, "aborted");
    assert.equal(result.ok, false);
    assert.equal(result.aborted, true);
    assert.equal(result.error, true);
    assert.equal(result.verifyTests.aborted, true);
    assert.match(result.failure, /aborted/);
    assert.equal(requests.length, automatic ? 2 : 1, "no model round may follow an abort");
    assert.equal(events.filter((event) => event.type === "verify:start").length, 1);
    assert.ok(readFileSync(file, "utf8").includes(automatic ? FIXED : BUGGY));
    if (automatic) assert.match(result.content, /undo/);
    else assert.doesNotMatch(result.content, /undo/);
    assertTerminalEventOrder(events);
  }
});

test("round exhaustion reports the actual round count and a budget outcome", async (t) => {
  const demo = copyDemo("matrix-model-round-budget-");
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const previousFetch = globalThis.fetch;
  const { fetchMock, requests } = fakeOpenRouter([
    () => sseResponse(toolCallChunks("call_only_round", "list_files", { limit: 1 })),
  ]);
  globalThis.fetch = fetchMock;
  const events = [];
  try {
    const result = await withEnv({ OPENROUTER_API_KEY: "test-key" }, () =>
      runModelAgent({
        task: "list one file",
        project,
        model: resolveModel("sonnet"),
        maxRounds: 1,
        onEvent: (event) => events.push(event),
      }),
    );
    assert.equal(requests.length, 1);
    assert.equal(result.metrics.rounds, 1);
    assert.equal(result.status, "budgetExhausted");
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.ok, false);
    assert.match(result.failure, /1-round tool limit/);
    assert.equal(result.elapsedMs, result.metrics.elapsedMs);
    assertTerminalEventOrder(events);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
