import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  PROVIDER_EVAL_EVIDENCE_CLASS,
  PROVIDER_EVAL_TASK_REVISION,
  formatProviderEvalText,
  parseProviderEvalArgs,
  runAuthoritativeVerification,
  runProviderEvaluation,
} from "../eval/provider-eval.mjs";
import { addProviderProfile } from "../lib/provider-config.mjs";
import { PACKAGE_ROOT, makeTempDir } from "./helpers.mjs";

const MODEL = "vendor/eval-model:latest";
const KEY = "sk-provider-eval-canary";
const TEST_PATH = "test/bounds.test.mjs";
const FIXED_SOURCE = `export function keepLast(items) {\n  return items.slice(0, items.length);\n}\n`;

function sandbox(t) {
  const root = makeTempDir("matrix-provider-eval-test-");
  const home = join(root, "home");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return home;
}

async function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(record);
      Promise.resolve(handler(req, res, record)).catch((error) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(error));
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function sse(res, events, { status = 200, body = null } = {}) {
  if (status !== 200) {
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body ?? "provider failure");
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function contentEvents(text) {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
}

function testEditEvents() {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_provider_eval_test_edit",
                type: "function",
                function: {
                  name: "propose_edit",
                  arguments: JSON.stringify({
                    path: TEST_PATH,
                    start_line: 7,
                    end_line: 8,
                    replacement: "  assert.ok(true);\n",
                    rationale: "replace the assertion",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function packageScriptEditEvents() {
  const fakeScript =
    "node -e \"console.log('# tests 1');console.log('# pass 1');console.log('# fail 0');console.log('# duration_ms 1')\"";
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_provider_eval_package_edit",
                type: "function",
                function: {
                  name: "propose_edit",
                  arguments: JSON.stringify({
                    path: "package.json",
                    start_line: 6,
                    end_line: 6,
                    replacement: `    "test": ${JSON.stringify(fakeScript)}\n`,
                    rationale: "replace the test runner",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function proposeEditEvents() {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_provider_eval_edit",
                type: "function",
                function: {
                  name: "propose_edit",
                  arguments: JSON.stringify({
                    path: "src/bounds.js",
                    start_line: 2,
                    end_line: 3,
                    replacement: "  return items.slice(0, items.length);\n",
                    rationale: "keep the last element",
                  }),
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

async function setup(home, baseUrl) {
  await addProviderProfile(
    {
      id: "lab",
      name: "Lab",
      baseUrl: `${baseUrl}/team/v1`,
      auth: { type: "bearer", env: "LAB_API_KEY" },
      models: [{ id: MODEL, capabilities: { tools: "unknown" } }],
      defaultModel: MODEL,
    },
    { home },
  );
}

function withKey(t, value = KEY) {
  const previous = process.env.LAB_API_KEY;
  process.env.LAB_API_KEY = value;
  t.after(() => {
    if (previous === undefined) delete process.env.LAB_API_KEY;
    else process.env.LAB_API_KEY = previous;
  });
}

test("an explicit provider/model edit run applies the patch and verifies it", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    const followUp = body.messages.some((message) => message.role === "tool");
    sse(
      res,
      followUp ? contentEvents("Fixed keepLast and verified the test.") : proposeEditEvents(),
    );
  });
  t.after(() => server.close());
  await setup(home, server.baseUrl);
  withKey(t);

  const report = await runProviderEvaluation({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: process.env,
  });

  assert.equal(report.evidenceClass, PROVIDER_EVAL_EVIDENCE_CLASS);
  assert.equal(report.taskRevision, PROVIDER_EVAL_TASK_REVISION);
  assert.match(report.taskDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.provider.id, "lab");
  assert.equal(report.provider.endpoint, `${server.baseUrl}/team/v1/chat/completions`);
  assert.equal(report.model.id, MODEL);
  assert.equal(report.network, "loopback");
  assert.equal(report.outcome.status, "success");
  assert.equal(report.outcome.ok, true);
  assert.equal(report.verification.ok, true);
  assert.equal(report.authoritativeVerification.ok, true);
  assert.equal(report.authoritativeVerification.passed, 1);
  assert.equal(report.authoritativeVerification.failed, 0);
  assert.deepEqual(report.checks, {
    target: { status: "pass" },
    edit: { status: "pass" },
    test: { status: "pass" },
    package: { status: "pass" },
    scope: { status: "pass" },
    verification: { status: "pass" },
    cleanup: { status: "pass" },
  });
  assert.equal(report.runtime.node, process.version);
  assert.equal(report.taskSuccess, true);
  assert.equal(report.applied, 1);
  assert.equal(report.rounds, 2);
  assert.equal(report.ok, true);
  assert.equal(report.cleanup.rootRemoved, true);
  assert.equal(report.cleanup.controllerDisposed, true);
  assert.deepEqual(report.appliedPaths, ["src/bounds.js"]);

  assert.equal(server.requests.length, 2);
  for (const request of server.requests) {
    assert.equal(request.url, "/team/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    assert.equal(JSON.parse(request.body).model, MODEL);
  }
  const first = JSON.parse(server.requests[0].body);
  assert.ok(first.tools.some((tool) => tool.function.name === "propose_edit"));
  assert.equal(
    first.tools.some((tool) => tool.function.name === "run_command"),
    false,
    "commands stay disabled",
  );

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(KEY), false);
  assert.equal(serialized.includes("/tmp/matrix-provider-eval-"), false);
  assert.match(formatProviderEvalText(report), /taskSuccess yes/);
  assert.match(formatProviderEvalText(report), /evidence: one explicit run/i);
});

test("a test-file edit is denied and cannot produce task success", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    const toolMessages = body.messages.filter((message) => message.role === "tool").length;
    if (toolMessages === 0) sse(res, proposeEditEvents());
    else if (toolMessages === 1) sse(res, testEditEvents());
    else sse(res, contentEvents("Fixed keepLast and verified the test."));
  });
  t.after(() => server.close());
  await setup(home, server.baseUrl);
  withKey(t);

  const report = await runProviderEvaluation({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: process.env,
  });

  assert.equal(report.outcome.status, "success");
  assert.equal(report.verification.ok, true);
  assert.equal(report.authoritativeVerification.ok, true);
  assert.equal(report.checks.edit.status, "pass");
  assert.equal(report.checks.test.status, "pass");
  assert.equal(report.checks.package.status, "pass");
  assert.equal(report.checks.scope.status, "fail");
  assert.equal(report.taskSuccess, false);
  assert.equal(report.ok, false);
  assert.deepEqual(report.appliedPaths, ["src/bounds.js"]);
  assert.deepEqual(report.deniedPaths, [TEST_PATH]);
  assert.match(formatProviderEvalText(report), /scope fail/);
});

test("a package.json test-runner substitution cannot produce task success", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    const toolMessages = body.messages.filter((message) => message.role === "tool").length;
    if (toolMessages === 0) sse(res, packageScriptEditEvents());
    else if (toolMessages === 1) sse(res, proposeEditEvents());
    else sse(res, contentEvents("Fixed keepLast and verified the test."));
  });

  t.after(() => server.close());
  await setup(home, server.baseUrl);
  withKey(t);

  const report = await runProviderEvaluation({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: process.env,
  });

  assert.equal(report.outcome.status, "success");
  assert.equal(report.verification.ok, true);
  assert.equal(report.authoritativeVerification.ok, true);
  assert.equal(report.checks.edit.status, "pass");
  assert.equal(report.checks.test.status, "pass");
  assert.equal(report.checks.package.status, "pass");
  assert.equal(report.checks.scope.status, "fail");
  assert.equal(report.taskSuccess, false);
  assert.equal(report.ok, false);
  assert.deepEqual(report.appliedPaths, ["src/bounds.js"]);
  assert.deepEqual(report.deniedPaths, ["package.json"]);
  assert.match(formatProviderEvalText(report), /package pass/);
  assert.match(formatProviderEvalText(report), /scope fail/);
});

test("authoritative verification ignores a replaced workspace runner", async (t) => {
  const root = makeTempDir("matrix-provider-eval-authoritative-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }, null, 2)}\n`,
  );
  writeFileSync(join(root, TEST_PATH), 'throw new Error("replaced test");\n');

  const result = await runAuthoritativeVerification(root, FIXED_SOURCE);
  assert.equal(result.ok, true);
  assert.equal(result.passed, 1);
  assert.equal(result.failed, 0);
});

test("authoritative model code cannot read parent credentials or arbitrary environment", async (t) => {
  const root = makeTempDir("matrix-provider-eval-env-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = [
    "OPENROUTER_API_KEY",
    "MATRIX_REVIEW_SECRET",
    "LAB_CREDENTIAL",
    "GITHUB_TOKEN",
    "MATRIX_REVIEW_VALUE",
  ];
  const previous = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = "fake-verification-canary";
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  });
  const marker = join(root, "child-env.json");
  const source = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(${JSON.stringify(names)}.map(name => process.env[name] ?? null)));\n${FIXED_SOURCE}`;
  const result = await runAuthoritativeVerification(root, source);
  assert.equal(result.ok, true, "the original test must still run and pass");
  assert.equal(result.auditStatus, "complete");
  assert.deepEqual(
    JSON.parse(readFileSync(marker, "utf8")),
    names.map(() => null),
  );
});

test("authoritative verification stops owned descendants on completion, timeout and cancellation", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX process groups are required");
  const root = makeTempDir("matrix-provider-eval-process-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const mode of ["complete", "timeout", "cancel"]) {
    const marker = join(root, `${mode}.marker`);
    const started = join(root, `${mode}.started`);
    const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 2200)`;
    const source = `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); child.unref(); writeFileSync(${JSON.stringify(started)}, String(child.pid));\n${mode === "complete" ? "" : "await new Promise(() => { setInterval(() => {}, 1000); });\n"}${FIXED_SOURCE}`;
    const controller = new AbortController();
    const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 1000) : null;
    const result = await runAuthoritativeVerification(join(root, mode), source, {
      signal: controller.signal,
      timeoutMs: mode === "timeout" ? 1500 : 5000,
    });
    if (timer) clearTimeout(timer);
    if (mode === "complete") assert.equal(result.ok, true);
    else assert.equal(result.status, mode === "timeout" ? "timed-out" : "aborted");
    assert.equal(existsSync(started), true, `${mode} did not start the child`);
    await new Promise((resolve) => setTimeout(resolve, 2400));
    assert.equal(existsSync(marker), false, `${mode} left a child running`);
  }
});

test("execution uses the explicit evaluation credential, not process.env", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res, record) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("wrong credential");
      return;
    }
    const body = JSON.parse(record.body);
    const followUp = body.messages.some((message) => message.role === "tool");
    sse(
      res,
      followUp ? contentEvents("Fixed keepLast and verified the test.") : proposeEditEvents(),
    );
  });
  t.after(() => server.close());
  await setup(home, server.baseUrl);
  const previous = process.env.LAB_API_KEY;
  process.env.LAB_API_KEY = "sk-process-env-wrong";
  t.after(() => {
    if (previous === undefined) delete process.env.LAB_API_KEY;
    else process.env.LAB_API_KEY = previous;
  });

  const report = await runProviderEvaluation({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: { LAB_API_KEY: KEY },
  });

  assert.equal(report.ok, true);
  assert.equal(server.requests.length, 2);
  for (const request of server.requests) {
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  }
});

test("prose without an applied edit is not task success", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) =>
    sse(res, contentEvents("Done! The bug is fixed.")),
  );
  t.after(() => server.close());
  await setup(home, server.baseUrl);
  withKey(t);

  const report = await runProviderEvaluation({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: process.env,
  });
  assert.equal(report.outcome.status, "success");
  assert.equal(report.applied, 0);
  assert.equal(report.verification, null);
  assert.equal(report.checks.edit.status, "fail");
  assert.equal(report.checks.verification.status, "not-evaluated");
  assert.equal(report.taskSuccess, false);
  assert.equal(report.ok, false);
  assert.equal(server.requests.length, 1);
  assert.match(formatProviderEvalText(report), /taskSuccess no/);
});

test("a provider HTTP failure is reported honestly and cleans up", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => sse(res, [], { status: 503 }));
  t.after(() => server.close());
  await setup(home, server.baseUrl);
  withKey(t);

  const report = await runProviderEvaluation({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: process.env,
    timeoutMs: 10_000,
  });
  assert.equal(report.outcome.ok, false);
  assert.equal(report.outcome.status, "failed");
  assert.match(report.outcome.error, /HTTP 503/);
  assert.equal(report.checks.edit.status, "fail");
  assert.equal(report.checks.verification.status, "not-evaluated");
  assert.equal(report.taskSuccess, false);
  assert.equal(report.ok, false);
  assert.equal(report.cleanup.rootRemoved, true);
  assert.equal(JSON.stringify(report).includes(KEY), false);
});

function runProviderEvalCli(args, { home, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(PACKAGE_ROOT, "eval", "provider-eval.mjs"), ...args],
      {
        cwd: PACKAGE_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", MATRIX_HOME: home, ...env },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("the provider eval CLI runs one explicit target and writes its report", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    const followUp = body.messages.some((message) => message.role === "tool");
    sse(
      res,
      followUp ? contentEvents("Fixed keepLast and verified the test.") : proposeEditEvents(),
    );
  });
  t.after(() => server.close());
  await setup(home, server.baseUrl);

  const reports = join(home, "reports");
  const reportPath = join(reports, "provider.json");
  const textPath = join(reports, "provider.txt");

  const cli = await runProviderEvalCli(["--provider", "lab", "--model", MODEL], {
    home,
    env: { LAB_API_KEY: KEY, MATRIX_PROVIDER_EVAL_REPORTS: reports },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /PROVIDER EVAL · lab\//);
  assert.match(cli.stdout, /taskSuccess yes/);
  assert.match(cli.stdout, /Overall: PASS/);
  assert.match(cli.stdout, /report .*provider\.json/);
  assert.equal(cli.stderr.includes(KEY), false);
  assert.equal(cli.stdout.includes(KEY), false);

  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const text = readFileSync(textPath, "utf8");
  assert.match(text, /Overall: PASS/);
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes("/tmp/matrix-provider-eval-"), false);
  assert.equal(report.ok, true);
  assert.equal(report.provider.id, "lab");
  assert.equal(report.taskRevision, PROVIDER_EVAL_TASK_REVISION);
  assert.equal(report.cleanup.rootRemoved, true);
  assert.equal(readFileSync(reportPath, "utf8").includes(KEY), false);
});

test("provider eval parsing requires an explicit provider and exact model", () => {
  assert.deepEqual(parseProviderEvalArgs(["--provider", "lab", "--model", MODEL]), {
    providerId: "lab",
    modelId: MODEL,
    json: false,
    help: false,
  });
  assert.equal(parseProviderEvalArgs(["--help"]).help, true);
  assert.throws(() => parseProviderEvalArgs([]), /requires --provider/);
  assert.throws(() => parseProviderEvalArgs(["--provider", "lab"]), /requires --model/);
  assert.throws(
    () => parseProviderEvalArgs(["--provider", "lab", "--model", MODEL, "--stress"]),
    /unknown provider eval argument/,
  );
  assert.throws(() => parseProviderEvalArgs(["--provider", "--json"]), /requires a value/);
});

test("equivalent correct edits pass without matching reference bytes", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    const events = proposeEditEvents();
    const fn = events[0].choices[0].delta.tool_calls[0].function;
    const args = JSON.parse(fn.arguments);
    args.replacement = "  return items.slice();\n";
    fn.arguments = JSON.stringify(args);
    sse(
      res,
      body.messages.some((message) => message.role === "tool") ? contentEvents("Done") : events,
    );
  });
  t.after(() => server.close());
  await setup(home, server.baseUrl);
  withKey(t);
  const result = await runProviderEvaluation({ home, providerId: "lab", modelId: MODEL });
  assert.equal(result.authoritativeVerification.ok, true);
  assert.equal(result.taskSuccess, true);
});

test("both evaluation test runs exclude credentials with non-obvious names", async (t) => {
  const home = sandbox(t);
  const marker = join(home, "observed");
  const previous = process.env.MATRIX_REVIEW_VALUE;
  process.env.MATRIX_REVIEW_VALUE = "fake-eval-credential";
  t.after(() => {
    if (previous === undefined) delete process.env.MATRIX_REVIEW_VALUE;
    else process.env.MATRIX_REVIEW_VALUE = previous;
  });
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    const events = proposeEditEvents();
    const fn = events[0].choices[0].delta.tool_calls[0].function;
    const args = JSON.parse(fn.arguments);
    args.replacement = `  process.getBuiltinModule('fs').appendFileSync(${JSON.stringify(marker)}, String(process.env.MATRIX_REVIEW_VALUE ?? 'absent') + '\\n'); return items.slice();\n`;
    fn.arguments = JSON.stringify(args);
    sse(
      res,
      body.messages.some((message) => message.role === "tool") ? contentEvents("Done") : events,
    );
  });
  t.after(() => server.close());
  await addProviderProfile(
    {
      id: "lab",
      baseUrl: server.baseUrl,
      auth: { type: "bearer", env: "MATRIX_REVIEW_VALUE" },
      models: [{ id: MODEL }],
    },
    { home },
  );
  await runProviderEvaluation({ home, providerId: "lab", modelId: MODEL });
  assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n"), Array(8).fill("absent"));
});

test("evaluation cancellation prevents requests and interrupts an active request", async (t) => {
  const home = sandbox(t);
  const ac = new AbortController();
  let seen;
  const requestSeen = new Promise((resolve) => {
    seen = resolve;
  });
  const server = await startServer((_req, _res) => {
    seen();
  });
  t.after(() => server.close());
  await setup(home, server.baseUrl);
  withKey(t);
  ac.abort();
  await assert.rejects(
    runProviderEvaluation({ home, providerId: "lab", modelId: MODEL, signal: ac.signal }),
    /aborted/,
  );
  assert.equal(server.requests.length, 0);
  const active = new AbortController();
  const pending = runProviderEvaluation({
    home,
    providerId: "lab",
    modelId: MODEL,
    signal: active.signal,
    timeoutMs: 5000,
  });
  await requestSeen;
  active.abort();
  const result = await pending;
  assert.equal(result.taskSuccess, false);
  assert.equal(result.applied, 0);
  assert.equal(server.requests.length, 1);
});

test("early exit and forged TAP cannot satisfy behavioral scoring", async (t) => {
  for (const replacement of [
    "  process.exit(0);\n",
    "  globalThis.constructor.constructor('return process')().exit(0);\n",
    "  ({}).constructor.constructor('return process')().exit(0);\n",
    "  console.log('TAP version 13\\n1..1\\nok 1 - forged\\n# tests 1\\n# pass 1\\n# fail 0'); process.exit(0);\n",
    "  globalThis.process?.exit(0); return [];\n",
  ]) {
    const home = join(sandbox(t), String(replacement.length));
    const server = await startServer((req, res, record) => {
      const body = JSON.parse(record.body);
      const events = proposeEditEvents();
      const fn = events[0].choices[0].delta.tool_calls[0].function;
      const args = JSON.parse(fn.arguments);
      args.replacement = replacement;
      fn.arguments = JSON.stringify(args);
      sse(
        res,
        body.messages.some((message) => message.role === "tool") ? contentEvents("Done") : events,
      );
    });
    t.after(() => server.close());
    await setup(home, server.baseUrl);
    withKey(t);
    const result = await runProviderEvaluation({ home, providerId: "lab", modelId: MODEL });
    assert.equal(result.behavioralVerification.ok, false);
    assert.equal(result.checks.verification.status, "fail");
    assert.equal(result.taskSuccess, false);
    assert.equal(result.ok, false);
  }
});

test("behavioral gate rejects context escapes and bounds hostile result serialization", async (t) => {
  const root = makeTempDir("matrix-provider-eval-context-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = [
    "export function keepLast(items) { globalThis.constructor.constructor('return process')().exit(0); }",
    "export function keepLast(items) { ({}).constructor.constructor('return process')().exit(0); }",
    "await import('node:process').catch(error => error.constructor.constructor('return process')().exit(0)); export function keepLast(items) { return []; }",
    "export function keepLast(items) { return new Proxy([], { get() { while (true) {} } }); }",
    "export function keepLast(items) { return { toJSON() { return items; } }; }",
  ];
  for (const source of sources) {
    const result = await runAuthoritativeVerification(root, source, {
      behavioral: true,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, false, source);
    assert.equal(result.status, "fail", source);
  }
  const valid = await runAuthoritativeVerification(
    root,
    "export function keepLast(items) { return [...items]; }",
    { behavioral: true },
  );
  assert.equal(valid.ok, true);
  const early = await runAuthoritativeVerification(
    root,
    "export function keepLast(items) { process.exit(0); }",
  );
  assert.equal(early.ok, false);
});
