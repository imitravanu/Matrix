import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  PROBE_LIMITS,
  normalizeProbeChecks,
  probeProvider,
  probeStorePath,
  readProbeRecord,
  readProbeRecords,
} from "../lib/provider-probe.mjs";
import { formatProviderProbe } from "../lib/provider-commands.mjs";
import {
  addProviderProfile,
  loadProviderConfig,
  providerCacheGeneration,
} from "../lib/provider-config.mjs";
import { targetDigest } from "../lib/provider-contracts.mjs";
import { makeTempDir } from "./helpers.mjs";

const MODEL = "Vendor/Model-X:latest";
const KEY = "sk-live-canary-never-store";

function sandbox(t) {
  const root = makeTempDir("matrix-provider-probe-");
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
      Promise.resolve(handler(req, res, record, requests)).catch((error) => {
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

function contentEvent(text) {
  return { choices: [{ delta: { content: text } }] };
}

function finishEvent(reason = "stop") {
  return { choices: [{ delta: {}, finish_reason: reason }] };
}

async function setupProfile(home, baseUrl) {
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
  return loadProviderConfig({ home }).config.providers[0];
}

test("a synthetic text and tool round trip passes and stays bounded", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    if (!body.tools) {
      sse(res, [
        contentEvent("pong"),
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        },
      ]);
      return;
    }
    if (body.messages.some((message) => message.role === "tool")) {
      sse(res, [
        contentEvent("observed"),
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
        },
      ]);
      return;
    }
    // Fragment the tool name/arguments exactly like a real stream.
    sse(res, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_probe/1:α",
                  type: "function",
                  function: { name: "matrix_probe_noop", arguments: '{"note":' },
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
              tool_calls: [{ index: 0, function: { arguments: '"probe"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      },
    ]);
  });
  t.after(() => server.close());
  const profile = await setupProfile(home, server.baseUrl);

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text,tools",
    env: { LAB_API_KEY: KEY },
  });

  assert.equal(report.ok, true);
  assert.equal(report.cancelled, false);
  assert.deepEqual(report.requestedChecks, ["text", "tools"]);
  assert.deepEqual(report.actualChecks, ["text", "tools"]);
  assert.equal(report.checks.text.status, "pass");
  assert.equal(report.checks.text.contentChars, 4);
  assert.equal(report.checks.tools.status, "pass");
  assert.equal(report.requests, 3);
  assert.equal(report.recorded, true);
  assert.equal(report.usage.prompt_tokens, 21);
  assert.equal(report.usage.completion_tokens, 6);
  assert.equal(report.usage.total_tokens, 27);
  assert.equal(report.usageComplete, true);

  assert.equal(server.requests.length, 3);
  for (const request of server.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/team/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${KEY}`);
    const body = JSON.parse(request.body);
    assert.equal(body.model, MODEL);
    assert.equal(body.max_tokens, PROBE_LIMITS.completionTokens);
    assert.equal(body.stream, true);
  }
  const textBody = JSON.parse(server.requests[0].body);
  assert.equal(textBody.tools, undefined);
  assert.match(textBody.messages[0].content, /single word pong/);
  const toolBody = JSON.parse(server.requests[1].body);
  assert.equal(toolBody.tools[0].function.name, "matrix_probe_noop");
  assert.equal(
    toolBody.messages.some((message) => /processor|bounds|repo/i.test(message.content ?? "")),
    false,
  );
  const followUp = JSON.parse(server.requests[2].body);
  assert.equal(followUp.messages.at(-1).role, "tool");
  assert.equal(followUp.messages.at(-1).tool_call_id, "call_probe/1:α");
  assert.equal(followUp.messages.at(-2).tool_calls[0].id, "call_probe/1:α");

  const path = probeStorePath(home, "lab");
  assert.equal(report.recordPath, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const raw = readFileSync(path, "utf8");
  assert.equal(raw.includes(KEY), false);
  const record = readProbeRecord(home, profile, MODEL);
  assert.equal(record.modelId, MODEL);
  assert.equal(record.checks.text.status, "pass");
  assert.equal(record.checks.tools.status, "pass");
  assert.equal(record.digest, undefined, "the projection does not repeat the digest");
});

test("an ignored tool call fails the tool check and is recorded", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) =>
    sse(res, [contentEvent("I cannot use tools"), finishEvent()]),
  );
  t.after(() => server.close());
  const profile = await setupProfile(home, server.baseUrl);

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.text.status, "pass");
  assert.equal(report.checks.tools.status, "fail");
  assert.match(report.checks.tools.error, /ignored the synthetic tool/);
  assert.equal(report.requests, 2);
  assert.equal(report.recorded, true);
  assert.equal(readProbeRecord(home, profile, MODEL).checks.tools.status, "fail");
});

test("schema-invalid tool arguments fail without a follow-up request", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    if (!body.tools) {
      sse(res, [contentEvent("pong"), finishEvent()]);
      return;
    }
    sse(res, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_bad",
                  function: { name: "matrix_probe_noop", arguments: '{"note":123}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
  });
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(report.checks.tools.status, "fail");
  assert.match(report.checks.tools.error, /not valid for the declared schema/);
  assert.equal(server.requests.length, 2);
});

test("HTTP failures retry zero times and still produce an honest record", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => sse(res, [], { status: 503 }));
  t.after(() => server.close());
  const profile = await setupProfile(home, server.baseUrl);

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: ["text", "tools"],
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.text.status, "fail");
  assert.equal(report.checks.tools.status, "fail");
  assert.match(report.checks.text.error, /HTTP 503/);
  assert.equal(report.requests, 2, "one request per started check, no retries");
  assert.equal(server.requests.length, 2);
  assert.equal(readProbeRecord(home, profile, MODEL).checks.text.status, "fail");
});

test("a caller cancellation sends nothing and records nothing", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => sse(res, [contentEvent("pong")]));
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);
  const controller = new AbortController();
  controller.abort();

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: { LAB_API_KEY: KEY },
    signal: controller.signal,
  });
  assert.equal(report.ok, false);
  assert.equal(report.cancelled, true);
  assert.deepEqual(report.actualChecks, []);
  assert.equal(report.requests, 0);
  assert.equal(report.recorded, false);
  assert.equal(server.requests.length, 0);
  assert.equal(existsSync(probeStorePath(home, "lab")), false);
});

test("the total deadline fails the check inside the bound and records it", async (t) => {
  const home = sandbox(t);
  const server = await startServer(() => {
    // Never answer: the probe deadline must tear the request down.
  });
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);
  const started = Date.now();

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    env: { LAB_API_KEY: KEY },
    timeoutMs: 150,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.text.status, "fail");
  assert.match(report.checks.text.error, /timed out|cancelled/i);
  assert.equal(report.checks.tools.status, "not-evaluated");
  assert.deepEqual(report.actualChecks, ["text"]);
  assert.ok(Date.now() - started < 5_000, "the probe deadline is not the 45s idle default");
  assert.equal(report.recorded, true);
});

test("a changed endpoint invalidates every recorded badge", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => sse(res, [contentEvent("pong"), finishEvent()]));
  t.after(() => server.close());
  const profile = await setupProfile(home, server.baseUrl);
  const first = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(first.recorded, true);
  assert.equal(readProbeRecords(home, profile).length, 1);

  const configPath = join(home, "providers.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.providers[0].baseUrl = `${server.baseUrl}/other/v1`;
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const changed = loadProviderConfig({ home }).config.providers[0];

  assert.equal(targetDigest(changed) === targetDigest(profile), false);
  assert.deepEqual(readProbeRecords(home, changed), []);
  assert.equal(readProbeRecord(home, changed, MODEL), null);
});

test("the store keeps the latest record per model and evicts the oldest", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => sse(res, [contentEvent("pong"), finishEvent()]));
  t.after(() => server.close());
  const profile = await setupProfile(home, server.baseUrl);
  const digest = targetDigest(profile);
  const records = Array.from({ length: PROBE_LIMITS.models }, (_, index) => ({
    modelId: `model-${String(index).padStart(3, "0")}`,
    digest,
    testedAt: index + 1,
    requestedChecks: ["text"],
    checks: { text: { status: "pass", error: null } },
    usage: null,
  }));
  mkdirSync(join(home, "provider-cache"), { recursive: true });
  writeFileSync(
    probeStorePath(home, "lab"),
    JSON.stringify({
      version: 1,
      providerId: "lab",
      digest,
      generation: providerCacheGeneration(home, "lab"),
      records,
    }),
    { mode: 0o600 },
  );

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: "model-new",
    checks: "text",
    env: { LAB_API_KEY: KEY },
    now: () => 1_000,
  });
  assert.equal(report.recorded, true);
  const stored = readProbeRecords(home, profile);
  assert.equal(stored.length, PROBE_LIMITS.models);
  assert.ok(stored.some((record) => record.modelId === "model-new"));
  assert.equal(
    stored.some((record) => record.modelId === "model-000"),
    false,
    "the oldest record is evicted explicitly",
  );
  assert.ok(
    Buffer.byteLength(readFileSync(probeStorePath(home, "lab"), "utf8")) <= PROBE_LIMITS.storeBytes,
  );
});

test("a symlinked store is never followed and a canary file survives", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => sse(res, [contentEvent("pong"), finishEvent()]));
  t.after(() => server.close());
  const profile = await setupProfile(home, server.baseUrl);
  const canary = join(home, "canary.txt");
  writeFileSync(canary, "do not read\n");
  mkdirSync(join(home, "provider-cache"), { recursive: true });
  symlinkSync(canary, probeStorePath(home, "lab"));

  assert.deepEqual(readProbeRecords(home, profile), []);
  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(report.recorded, true);
  assert.equal(readFileSync(canary, "utf8"), "do not read\n");
  assert.equal(statSync(probeStorePath(home, "lab")).isFile(), true);
  assert.equal(readProbeRecords(home, profile).length, 1);
});

test("a built-in target uses its own endpoint and a fixed digest", async (t) => {
  const home = sandbox(t);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const toolRound = body.tools && !body.messages.some((message) => message.role === "tool");
    const events = toolRound
      ? [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_builtin",
                      function: { name: "matrix_probe_noop", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]
      : [contentEvent("pong"), finishEvent()];
    const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(`${text}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const report = await probeProvider({
    home,
    providerId: "openrouter",
    modelId: "vendor/Any-Model:free",
    env: { OPENROUTER_API_KEY: KEY },
    fetchImpl,
  });
  assert.equal(report.ok, true);
  assert.equal(report.providerId, "openrouter");
  assert.equal(report.modelId, "vendor/Any-Model:free");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].body.model, "vendor/Any-Model:free");
  assert.match(report.digest, /^[a-f0-9]{64}$/);
  const stored = JSON.parse(readFileSync(probeStorePath(home, "openrouter"), "utf8"));
  assert.equal(stored.providerId, "openrouter");
  assert.equal(stored.digest, report.digest);
  assert.equal(readFileSync(probeStorePath(home, "openrouter"), "utf8").includes(KEY), false);
});

test("local, unknown, missing-key and malformed-checks selections fail before any request", async (t) => {
  const home = sandbox(t);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("", { status: 200 });
  };
  await assert.rejects(
    probeProvider({ home, providerId: "matrix", modelId: "local", fetchImpl }),
    /local and cannot be probed/,
  );
  await assert.rejects(
    probeProvider({ home, providerId: "absent", modelId: MODEL, fetchImpl }),
    /unknown provider/,
  );
  await setupProfile(home, "http://127.0.0.1:9");
  await assert.rejects(
    probeProvider({ home, providerId: "lab", modelId: MODEL, env: {}, fetchImpl }),
    /requires env LAB_API_KEY/,
  );
  await assert.rejects(
    probeProvider({
      home,
      providerId: "lab",
      modelId: MODEL,
      checks: "text,vision",
      env: { LAB_API_KEY: KEY },
      fetchImpl,
    }),
    /unknown probe check "vision"/,
  );
  assert.equal(calls, 0);
});

test("unexpected tool names are redacted from results, output and storage", async (t) => {
  const home = sandbox(t);
  const secret = 'sk-probe+"canary"/needle';
  const variants = [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)];
  let toolName = variants[0];
  const server = await startServer((req, res) => {
    sse(res, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_bad_name",
                  function: { name: toolName, arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
  });
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);

  for (const variant of variants) {
    toolName = variant;
    const report = await probeProvider({
      home,
      providerId: "lab",
      modelId: MODEL,
      checks: "tools",
      env: { LAB_API_KEY: secret },
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.tools.status, "fail");
    assert.match(report.checks.tools.error, /unexpected tool/);
    assert.equal(report.requests, 1);
    const artifacts = [
      JSON.stringify(report),
      formatProviderProbe(report),
      readFileSync(probeStorePath(home, "lab"), "utf8"),
    ];
    for (const artifact of artifacts) {
      assert.equal(artifact.includes(secret), false);
      assert.equal(artifact.includes(variant), false);
    }
  }
});

test("a tool follow-up must answer instead of calling tools again or ending bare", async (t) => {
  const home = sandbox(t);
  let mode = "repeat";
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    const followUp = body.messages.some((message) => message.role === "tool");
    if (!followUp) {
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_round_trip",
                    function: { name: "matrix_probe_noop", arguments: '{"note":"probe"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
      return;
    }
    if (mode === "repeat") {
      sse(res, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_again",
                    function: { name: "matrix_probe_noop", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]);
    } else if (mode === "bare") {
      sse(res, []);
    } else if (mode === "length") {
      sse(res, [contentEvent("partial"), finishEvent("length")]);
    } else {
      sse(res, [finishEvent("stop")]);
    }
  });
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);

  const cases = [
    ["repeat", /another tool call/],
    ["bare", /did not complete cleanly/],
    ["length", /did not complete cleanly/],
    ["empty", /returned no text/],
  ];
  for (const [name, pattern] of cases) {
    mode = name;
    const report = await probeProvider({
      home,
      providerId: "lab",
      modelId: MODEL,
      checks: "tools",
      env: { LAB_API_KEY: KEY },
    });
    assert.equal(report.checks.tools.status, "fail", name);
    assert.match(report.checks.tools.error, pattern, name);
    assert.equal(report.requests, 2, name);
  }
});

test("partial usage stays unknown and is labeled incomplete", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) =>
    sse(res, [
      contentEvent("pong"),
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { completion_tokens: 2 },
      },
    ]),
  );
  t.after(() => server.close());
  const profile = await setupProfile(home, server.baseUrl);

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text",
    env: { LAB_API_KEY: KEY },
  });
  assert.deepEqual(report.usage, { completion_tokens: 2 });
  assert.equal("prompt_tokens" in report.usage, false);
  assert.equal("total_tokens" in report.usage, false);
  assert.equal(report.usageComplete, false);
  assert.match(formatProviderProbe(report), /usage completion 2 · partial/);
  const record = readProbeRecord(home, profile, MODEL);
  assert.deepEqual(record.usage, { completion_tokens: 2 });
  assert.equal(record.usageComplete, false);
});

test("a provider redirect is surfaced and never followed", async (t) => {
  const home = sandbox(t);
  const target = await startServer((req, res) => sse(res, [contentEvent("leak"), finishEvent()]));
  const origin = await startServer((req, res) => {
    res.writeHead(302, { location: `${target.baseUrl}/v1/chat/completions` });
    res.end();
  });
  t.after(() => Promise.all([target.close(), origin.close()]));
  await setupProfile(home, origin.baseUrl);

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.text.error, /HTTP 302/);
  assert.equal(origin.requests.length, 1);
  assert.equal(target.requests.length, 0, "the credential never follows a redirect");
});

test("an abrupt disconnect fails the check without hanging or inventing success", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(contentEvent("partial"))}\n\n`);
    res.destroy();
  });
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.text.status, "fail");
  assert.match(
    report.checks.text.error,
    /stream|network|closed|terminated|incomplete|socket|aborted/i,
  );
  assert.equal(report.requests, 1);
  assert.equal(report.recorded, true);
});

test("an oversized SSE event is rejected at the shared parser bound", async (t) => {
  const home = sandbox(t);
  const server = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(contentEvent("x".repeat(1024 * 1024 + 2048)))}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);

  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(report.ok, false);
  assert.match(report.checks.text.error, /exceeded/i);
  assert.equal(report.requests, 1);
});

test("malformed tool-call ids and oversized arguments fail before the follow-up", async (t) => {
  const home = sandbox(t);
  let mode = "control-id";
  const server = await startServer((req, res) => {
    const id = mode === "control-id" ? "bad\nid-canary" : "call_bounded";
    const args = mode === "control-id" ? "{}" : "x".repeat(5_000);
    sse(res, [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id,
                  function: { name: "matrix_probe_noop", arguments: args },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);
  });
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);

  const control = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "tools",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(control.checks.tools.status, "fail");
  assert.match(control.checks.tools.error, /not a bounded wire id/);
  assert.equal(control.requests, 1);
  // The canary is unique; a bare "bad" substring would collide with random
  // hexadecimal digest characters in the stored JSON.
  assert.equal(readFileSync(probeStorePath(home, "lab"), "utf8").includes("id-canary"), false);

  mode = "oversized-arguments";
  const oversized = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "tools",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(oversized.checks.tools.status, "fail");
  assert.match(oversized.checks.tools.error, /exceeded the probe bound/);
  assert.equal(oversized.requests, 1);
  assert.equal(server.requests.length, 2, "no follow-up was sent for either case");
});

test("fragmented over-limit arguments stop before DONE or the deadline", async (t) => {
  const home = sandbox(t);
  let closeResponse;
  const closed = new Promise((resolve) => {
    closeResponse = resolve;
  });
  let closeTimer;
  const server = await startServer((req, res, record) => {
    const body = JSON.parse(record.body);
    if (!body.tools) {
      sse(res, [contentEvent("pong"), finishEvent()]);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.on("error", () => {});
    res.on("close", () => closeResponse());
    // Each fragment is below the bound; only the cumulative call is not. The
    // response deliberately has no DONE event and stays open until cancelled.
    for (let index = 0; index < 100; index += 1) {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fragmented",
                    function: { name: "matrix_probe_noop", arguments: "x".repeat(1024) },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
    }
  });
  t.after(() => server.close());
  await setupProfile(home, server.baseUrl);

  const startedAt = Date.now();
  const report = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "tools",
    env: { LAB_API_KEY: KEY },
    timeoutMs: 4_000,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(report.checks.tools.status, "fail");
  assert.match(report.checks.tools.error, /exceeded the probe bound/);
  assert.ok(elapsed < 2_000, `probe returned after ${elapsed} ms instead of stopping at the bound`);
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      closeTimer = setTimeout(
        () => reject(new Error("server did not observe reader cancellation")),
        2_000,
      );
    }),
  ]);
  clearTimeout(closeTimer);
  assert.equal(report.requests, 1);
  assert.equal(server.requests.length, 1);
});

test("malformed usage fields stay unknown instead of becoming numbers", async (t) => {
  const home = sandbox(t);
  let usage = { prompt_tokens: "5", completion_tokens: -2, total_tokens: 1.5 };
  const server = await startServer((req, res) =>
    sse(res, [contentEvent("pong"), { choices: [{ delta: {}, finish_reason: "stop" }], usage }]),
  );
  t.after(() => server.close());
  const profile = await setupProfile(home, server.baseUrl);

  const invalid = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text",
    env: { LAB_API_KEY: KEY },
  });
  assert.equal(invalid.usage, null);
  assert.equal(invalid.usageComplete, null);

  usage = { prompt_tokens: 5, completion_tokens: "2", total_tokens: 1.5 };
  const mixed = await probeProvider({
    home,
    providerId: "lab",
    modelId: MODEL,
    checks: "text",
    env: { LAB_API_KEY: KEY },
  });
  assert.deepEqual(mixed.usage, { prompt_tokens: 5 });
  assert.equal(mixed.usageComplete, false);
  assert.deepEqual(readProbeRecord(home, profile, MODEL).usage, { prompt_tokens: 5 });
});

test("check parsing is ordered, de-duplicated and rejects an empty list", () => {
  assert.deepEqual(normalizeProbeChecks(), ["text", "tools"]);
  assert.deepEqual(normalizeProbeChecks("tools, text,tools"), ["tools", "text"]);
  assert.deepEqual(normalizeProbeChecks(["tools"]), ["tools"]);
  assert.throws(() => normalizeProbeChecks(""), /at least one check/);
});
