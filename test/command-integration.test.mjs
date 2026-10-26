import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  RUN_SANDBOXED_COMMAND_TOOL_SCHEMA,
  TOOL_SCHEMAS,
  runModelAgent,
  toolSchemasFor,
} from "../lib/model-agent.mjs";
import { createCommandPolicy, inspectCommandPlan } from "../lib/command-policy.mjs";
import { resolveModel } from "../lib/models.mjs";
import { detectProject } from "../lib/project.mjs";
import { runsDir, saveSession, sessionsDir } from "../lib/session.mjs";
import { sessionSnapshot } from "../src/session-codec.mjs";
import {
  PROVIDER_ENVIRONMENT_KEYS,
  contentChunks,
  makeTempDir,
  patchEnv,
  sseResponse,
  toolCallChunks,
} from "./helpers.mjs";

function workspace(t) {
  const root = makeTempDir("matrix-command-integration-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "workspace");
  const home = join(root, "home");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "command-fixture" }));
  writeFileSync(join(work, "sentinel.txt"), "live-original");
  return { root, workspace: work, home, project: detectProject(work) };
}

function providerEnv(t, home) {
  const restore = patchEnv({
    ...Object.fromEntries(PROVIDER_ENVIRONMENT_KEYS.map((key) => [key, undefined])),
    OPENROUTER_API_KEY: "test-key",
    MATRIX_HOME: home,
    HOME: home,
  });
  t.after(restore);
}

function mockProvider(t, rounds) {
  const previous = globalThis.fetch;
  const requests = [];
  let index = 0;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const round = rounds[index] ?? rounds.at(-1);
    index += 1;
    return round();
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  return requests;
}

function interactiveCapability(f, requestApproval, runId = "command-interactive") {
  return {
    enabled: true,
    headless: false,
    home: f.home,
    runId,
    policyFactory: () => createCommandPolicy({ enabled: true, requestApproval }),
  };
}

function inlinePlan(f, script) {
  return { executable: process.execPath, argv: ["-e", script], cwd: f.workspace, script };
}

function toolMessage(request, id) {
  return request.body.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === id,
  );
}

test("the optional strict command schema is dynamic and included in context accounting", async (t) => {
  const f = workspace(t);
  providerEnv(t, f.home);
  const model = { ...resolveModel("sonnet"), context: 4096 };
  const capability = interactiveCapability(f, () => "y", "command-schema");
  assert.equal(TOOL_SCHEMAS.length, 6);
  assert.equal(toolSchemasFor(null), TOOL_SCHEMAS);
  assert.equal(toolSchemasFor(capability).length, 7);
  assert.deepEqual(Object.keys(RUN_SANDBOXED_COMMAND_TOOL_SCHEMA.function.parameters.properties), [
    "executable",
    "argv",
    "cwd",
    "script",
    "scriptFile",
  ]);
  assert.equal(RUN_SANDBOXED_COMMAND_TOOL_SCHEMA.function.parameters.additionalProperties, false);
  assert.deepEqual(RUN_SANDBOXED_COMMAND_TOOL_SCHEMA.function.parameters.required, [
    "executable",
    "argv",
    "cwd",
  ]);

  const plainRequests = mockProvider(t, [() => sseResponse(contentChunks("plain"))]);
  const plain = await runModelAgent({ task: "answer", project: f.project, model });
  assert.equal(plain.ok, true);
  const enabledRequests = mockProvider(t, [() => sseResponse(contentChunks("enabled"))]);
  const enabled = await runModelAgent({
    task: "answer",
    project: f.project,
    model,
    commandCapability: capability,
  });
  assert.equal(enabled.ok, true);
  const plainTools = plainRequests[0].body.tools;
  const enabledTools = enabledRequests[0].body.tools;
  assert.equal(
    plainTools.some((tool) => tool.function.name === "run_sandboxed_command"),
    false,
  );
  assert.equal(
    enabledTools.some((tool) => tool.function.name === "run_sandboxed_command"),
    true,
  );
  assert.deepEqual(enabledTools, toolSchemasFor(capability));
  assert.ok(
    plainRequests[0].body.max_tokens > enabledRequests[0].body.max_tokens,
    "the same dynamic schema must reduce the completion budget",
  );

  const enabledPromptTokens = model.context - enabledRequests[0].body.max_tokens;
  globalThis.fetch = async () => {
    throw new Error("provider must not be called when the dynamic schema exhausts context");
  };
  const exhausted = await runModelAgent({
    task: "answer",
    project: f.project,
    model: { ...model, context: enabledPromptTokens },
    commandCapability: capability,
  });
  assert.equal(exhausted.budgetExhausted, true);
  assert.match(exhausted.failure, /context budget exhausted/);
});

test("fresh interactive approvals execute inline/file plans without persisting script bytes", async (t) => {
  const f = workspace(t);
  providerEnv(t, f.home);
  const inlineMarker = "INLINE-APPROVAL-ONLY-CANARY-ADV002";
  const fileMarker = "FILE-APPROVAL-ONLY-CANARY-ADV002";
  const inline = `/* ${inlineMarker} */ require("node:fs").writeFileSync("created.txt", "snapshot"); console.log("inline-ok test-key");`;
  const fileSource = `// ${fileMarker}\nconsole.log("file-ok");\n`;
  writeFileSync(join(f.workspace, "script.mjs"), fileSource);
  const inlineCall = inlinePlan(f, inline);
  const fileCall = {
    executable: process.execPath,
    argv: ["script.mjs"],
    cwd: f.workspace,
    scriptFile: "script.mjs",
  };
  const requests = mockProvider(t, [
    () => sseResponse(toolCallChunks("call_inline", "run_sandboxed_command", inlineCall)),
    () => sseResponse(toolCallChunks("call_file", "run_sandboxed_command", fileCall)),
    () => sseResponse(contentChunks("both sandbox commands finished")),
  ]);
  const approvals = [];
  let factories = 0;
  const capability = {
    ...interactiveCapability(
      f,
      (request) => {
        approvals.push(request);
        return "y";
      },
      "command-success",
    ),
  };
  const originalFactory = capability.policyFactory;
  capability.policyFactory = () => {
    factories += 1;
    return originalFactory();
  };
  const result = await runModelAgent({
    task: "run two exact commands",
    project: f.project,
    model: resolveModel("sonnet"),
    commandCapability: capability,
    onEvent: () => {},
  });

  assert.equal(result.status, "success", result.failure);
  assert.equal(factories, 2);
  assert.equal(approvals.length, 2);
  assert.equal(approvals[0].script, inline);
  assert.equal(approvals[1].scriptFile.content, fileSource);
  assert.notEqual(approvals[0].planHash, approvals[1].planHash);
  assert.match(approvals[0].planHash, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(join(f.workspace, "created.txt")), false);
  assert.equal(readFileSync(join(f.workspace, "sentinel.txt"), "utf8"), "live-original");
  assert.equal(result.commands.length, 2);
  for (const [index, command] of result.commands.entries()) {
    assert.equal(command.executionOk, true);
    assert.equal(command.commandStatus, "succeeded");
    assert.equal(command.processOk, true);
    assert.equal(command.auditStatus, "complete");
    assert.equal(command.cleanupStatus, "complete");
    assert.equal(command.liveWorkspaceChanged, false);
    assert.equal(command.writes, "discarded");
    assert.equal(command.undo, "not-applicable");
    assert.equal(result.toolCards[index].ok, true);
  }
  assert.match(result.commands[0].stdout, /inline-ok \[redacted\]/);
  assert.match(result.commands[1].stdout, /file-ok/);
  const providerResult = JSON.parse(toolMessage(requests[1], "call_inline").content);
  assert.equal(providerResult.executionOk, true);
  assert.equal(providerResult.audit.decision, true);
  assert.equal(providerResult.audit.start, true);
  assert.equal(providerResult.audit.end, true);
  for (const request of requests) assert.deepEqual(request.body.tools, toolSchemasFor(capability));

  const snapshot = sessionSnapshot({
    project: f.project,
    history: [result],
    model: resolveModel("sonnet"),
    tokenStats: result.usage,
    metrics: result.metrics,
    undoRun: null,
    cwd: f.workspace,
    sessionId: "command-session",
    elapsedMs: result.elapsedMs,
  });
  const saved = saveSession(snapshot, { home: f.home });
  assert.equal(saved.ok, true);
  const persisted = [
    JSON.stringify(result),
    readFileSync(join(runsDir(f.home), "command-success.jsonl"), "utf8"),
    readFileSync(join(sessionsDir(f.home), "command-session.json"), "utf8"),
  ];
  for (const projection of persisted) {
    assert.equal(projection.includes(inlineMarker), false);
    assert.equal(projection.includes(fileMarker), false);
    assert.equal(projection.includes(inline), false);
    assert.equal(projection.includes(fileSource), false);
  }
  assert.match(result.toolCards[0].args.script, /^\[inline-script sha256:[a-f0-9]{64}\]$/);
  assert.equal(result.toolCards[1].args.scriptFile, "script.mjs");
});

test("model tool success distinguishes denied ok:true and real process failure", async (t) => {
  for (const kind of ["denied", "failed"]) {
    const f = workspace(t);
    providerEnv(t, f.home);
    const source = kind === "denied" ? 'console.log("must-not-run")' : "process.exit(7)";
    const call = inlinePlan(f, source);
    const requests = mockProvider(t, [
      () => sseResponse(toolCallChunks(`call_${kind}`, "run_sandboxed_command", call)),
      () => sseResponse(contentChunks(`${kind} command reported`)),
    ]);
    const result = await runModelAgent({
      task: `exercise ${kind}`,
      project: f.project,
      model: resolveModel("sonnet"),
      commandCapability: interactiveCapability(
        f,
        () => (kind === "denied" ? "n" : "y"),
        `command-${kind}`,
      ),
    });
    const command = result.commands[0];
    const card = result.toolCards.find((item) => item.id === `call_${kind}`);
    const providerResult = JSON.parse(toolMessage(requests[1], `call_${kind}`).content);
    assert.equal(command.executionOk, false);
    assert.equal(command.processOk, false);
    assert.equal(card.ok, false);
    assert.equal(providerResult.commandStatus, kind);
    assert.equal(providerResult.cleanupStatus, kind === "denied" ? "not-applicable" : "complete");
    if (kind === "denied") {
      assert.equal(command.ok, true, "denial is a clean shared outcome, not execution success");
      assert.equal(command.status, "denied");
      assert.equal(command.audit.start, false);
      assert.equal(command.stdout, "");
      assert.equal(result.status, "denied");
      assert.equal(result.ok, true);
    } else {
      assert.equal(command.code, 7);
      assert.equal(command.auditStatus, "complete");
      assert.equal(result.status, "failed");
      assert.equal(result.ok, false);
    }
  }
});

test("missing headless approval and model-selected execution options fail closed", async (t) => {
  for (const kind of ["schema-absent", "headless-unapproved", "model-options"]) {
    const f = workspace(t);
    providerEnv(t, f.home);
    const source = `require("node:fs").writeFileSync("unauthorized-${kind}.txt", "no")`;
    const base = inlinePlan(f, source);
    const call =
      kind === "model-options"
        ? {
            ...base,
            env: { PATH: "/tmp" },
            network: true,
            backend: "unsandboxed",
            timeoutMs: 1,
            home: "/tmp/model-home",
            hooks: { beforeStartAudit: "model" },
          }
        : base;
    const runId = `command-${kind}`;
    mockProvider(t, [
      () => sseResponse(toolCallChunks(`call_${kind}`, "run_sandboxed_command", call)),
      () => sseResponse(contentChunks(`${kind} denied`)),
    ]);
    let prompts = 0;
    const capability =
      kind === "schema-absent"
        ? null
        : kind === "headless-unapproved"
          ? {
              enabled: true,
              headless: true,
              home: f.home,
              runId,
              policy: createCommandPolicy({ enabled: true, headless: true }),
            }
          : interactiveCapability(
              f,
              () => {
                prompts += 1;
                return "y";
              },
              runId,
            );
    const result = await runModelAgent({
      task: `attempt ${kind}`,
      project: f.project,
      model: resolveModel("sonnet"),
      autoApprove: true,
      requestApproval: async () => "y",
      commandCapability: capability,
    });
    const command = result.commands[0];
    assert.equal(command.executionOk, false);
    assert.equal(command.processOk, false);
    assert.equal(result.toolCards[0].ok, false);
    assert.equal(
      command.reason,
      kind === "schema-absent"
        ? "capability-disabled"
        : kind === "headless-unapproved"
          ? "headless-approval-required"
          : "plan-malformed",
    );
    assert.equal(prompts, 0);
    assert.equal(existsSync(join(f.workspace, `unauthorized-${kind}.txt`)), false);
    assert.equal(JSON.stringify(result).includes(source), false);
  }
});

test("one headless policy authorizes one exact hash and denies an identical replay", async (t) => {
  const f = workspace(t);
  providerEnv(t, f.home);
  const call = inlinePlan(f, 'console.log("headless-once")');
  const inspected = inspectCommandPlan(call, { workspace: f.workspace });
  assert.equal(inspected.ok, true, inspected.error);
  const policy = createCommandPolicy({
    enabled: true,
    headless: true,
    approvedPlanHash: inspected.plan.planHash,
  });
  const requests = mockProvider(t, [
    () => sseResponse(toolCallChunks("call_first", "run_sandboxed_command", call)),
    () => sseResponse(toolCallChunks("call_replay", "run_sandboxed_command", call)),
    () => sseResponse(contentChunks("headless replay denied")),
  ]);
  const result = await runModelAgent({
    task: "try a replay",
    project: f.project,
    model: resolveModel("sonnet"),
    commandCapability: {
      enabled: true,
      headless: true,
      home: f.home,
      runId: "command-headless-replay",
      policy,
    },
  });
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].executionOk, true);
  assert.equal(result.commands[0].stdout, "headless-once\n");
  assert.equal(result.commands[1].commandStatus, "denied");
  assert.equal(result.commands[1].reason, "approval-replayed");
  assert.equal(result.commands[1].processOk, false);
  assert.equal(result.commands[1].audit.start, false);
  assert.equal(result.toolCards[1].ok, false);
  assert.equal(JSON.parse(toolMessage(requests[2], "call_replay").content).executionOk, false);
});

test("bounded provider/tool-card command results retain output and audit semantics", async (t) => {
  const f = workspace(t);
  providerEnv(t, f.home);
  const source = `
    for (let index = 0; index < 450; index++) console.log("line " + index);
    process.stdout.write("x".repeat(140000) + "TAIL\\n");
    process.stderr.write("e".repeat(140000) + "ERRTAIL\\n");
  `;
  const call = {
    ...inlinePlan(f, source),
    argv: [
      "-e",
      source,
      ...Array.from({ length: 22 }, (_, index) => `${index}:${"a".repeat(900)}`),
    ],
  };
  const requests = mockProvider(t, [
    () => sseResponse(toolCallChunks("call_output", "run_sandboxed_command", call)),
    () => sseResponse(contentChunks("bounded output reported")),
  ]);
  const result = await runModelAgent({
    task: "exercise output bounds",
    project: f.project,
    model: resolveModel("sonnet"),
    commandCapability: interactiveCapability(f, () => "y", "command-output"),
  });
  const command = result.commands[0];
  const serialized = toolMessage(requests[1], "call_output").content;
  const providerResult = JSON.parse(serialized);
  assert.ok(Buffer.byteLength(serialized) <= 24_000);
  assert.equal(providerResult.commandStatus, "succeeded");
  assert.equal(providerResult.executionOk, true);
  assert.equal(providerResult.processOk, true);
  assert.equal(providerResult.auditStatus, "complete");
  assert.equal(providerResult.cleanupStatus, "complete");
  assert.equal(providerResult.outputTruncated, true);
  assert.equal(providerResult.stdoutTruncated, true);
  assert.equal(providerResult.stderrTruncated, true);
  assert.ok(providerResult.outputLineCount >= 452);
  assert.equal(providerResult.lines.length, 24);
  assert.equal(command.outputTruncated, true);
  assert.equal(command.stdout.endsWith("TAIL\n"), true);
  assert.equal(command.stderr.endsWith("ERRTAIL\n"), true);
  assert.equal(result.toolCards[0].data.outputTruncated, true);
});
