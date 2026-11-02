import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";

import {
  bindProviderTarget,
  prepareProviderRequest,
  streamProviderChat,
} from "../lib/provider-transport.mjs";
import { appendRunEvent } from "../lib/session.mjs";
import {
  localForgeTarget,
  resolveProviderSelection,
  validateProviderConfig,
} from "../lib/provider-contracts.mjs";
import { makeTempDir } from "./helpers.mjs";

const MODEL = "Vendor/Model-X:Free";
const KEY_A = "sk-transport-alpha-canary";
const KEY_B = "sk-transport-beta-canary";

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

function sse(res, events, { status = 200, headers = {} } = {}) {
  if (status !== 200) {
    res.writeHead(status, { "content-type": "text/plain", ...headers });
    res.end(events);
    return;
  }
  res.writeHead(status, { "content-type": "text/event-stream", ...headers });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end("data: [DONE]\n\n");
}

async function collect(generator) {
  const events = [];
  for await (const event of generator) events.push(event);
  return events;
}

function targetFor(
  baseUrl,
  {
    id = "lab",
    auth = { type: "bearer", env: "LAB_API_KEY" },
    tokenLimitField = "max_tokens",
    includeUsage = false,
    path = "/team/v1",
  } = {},
) {
  const config = validateProviderConfig({
    schemaVersion: 1,
    providers: [
      {
        id,
        name: `${id} server`,
        baseUrl: `${baseUrl}${path}`,
        auth,
        request: { tokenLimitField, includeUsage },
        models: [{ id: MODEL }],
      },
    ],
  });
  return resolveProviderSelection({ providerId: id, modelQuery: MODEL, config }).target;
}

test("two profiles with the same wire model stay isolated by endpoint and key", async (t) => {
  const alpha = await startServer((req, res) =>
    sse(res, [{ choices: [{ delta: { content: "alpha" } }] }]),
  );
  const beta = await startServer((req, res) =>
    sse(res, [{ choices: [{ delta: { content: "beta" } }] }]),
  );
  t.after(() => Promise.all([alpha.close(), beta.close()]));

  const alphaTarget = targetFor(alpha.baseUrl, { id: "alpha" });
  const betaTarget = targetFor(beta.baseUrl, { id: "beta" });
  const env = { LAB_API_KEY: KEY_A, BETA_API_KEY: KEY_B };
  const betaProfile = resolveProviderSelection({
    providerId: "beta",
    modelQuery: MODEL,
    config: validateProviderConfig({
      schemaVersion: 1,
      providers: [
        {
          id: "beta",
          baseUrl: `${beta.baseUrl}/team/v1`,
          auth: { type: "bearer", env: "BETA_API_KEY" },
          models: [{ id: MODEL }],
        },
      ],
    }),
  }).target;

  const [alphaEvents, betaEvents] = await Promise.all([
    collect(streamProviderChat({ target: alphaTarget, env, messages: [] })),
    collect(streamProviderChat({ target: betaProfile, env, messages: [] })),
  ]);
  assert.deepEqual(
    alphaEvents.map((event) => event.type),
    ["content", "done"],
  );
  assert.deepEqual(
    betaEvents.map((event) => event.type),
    ["content", "done"],
  );

  assert.equal(alpha.requests.length, 1);
  assert.equal(beta.requests.length, 1);
  assert.equal(alpha.requests[0].url, "/team/v1/chat/completions");
  assert.equal(beta.requests[0].url, "/team/v1/chat/completions");
  assert.equal(alpha.requests[0].headers.authorization, `Bearer ${KEY_A}`);
  assert.equal(beta.requests[0].headers.authorization, `Bearer ${KEY_B}`);
  assert.equal(JSON.parse(alpha.requests[0].body).model, MODEL);
  assert.equal(JSON.parse(beta.requests[0].body).model, MODEL);
  assert.equal(betaTarget.modelId, MODEL);
});

test("the request payload is closed and honors the frozen request options", async (t) => {
  const server = await startServer((req, res) =>
    sse(res, [{ choices: [{ delta: { content: "ok" } }] }]),
  );
  t.after(() => server.close());

  const target = targetFor(server.baseUrl, {
    tokenLimitField: "max_completion_tokens",
    includeUsage: false,
  });
  const env = { LAB_API_KEY: KEY_A };
  const prepared = prepareProviderRequest(target, {
    env,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1" }] },
      { role: "tool", content: "result", tool_call_id: "call-1" },
    ],
    maxTokens: 321,
  });

  assert.equal(prepared.endpoint, `${server.baseUrl}/team/v1/chat/completions`);
  assert.equal(prepared.headers.Authorization, `Bearer ${KEY_A}`);
  assert.deepEqual(Object.keys(prepared.payload).sort(), [
    "max_completion_tokens",
    "messages",
    "model",
    "stream",
  ]);
  assert.equal(prepared.payload.model, MODEL);
  assert.equal(prepared.payload.max_completion_tokens, 321);
  assert.equal(prepared.payload.messages.length, 3);
  assert.equal(prepared.payload.messages[1].tool_calls[0].id, "call-1");
  assert.equal("max_tokens" in prepared.payload, false);
  assert.equal("stream_options" in prepared.payload, false);

  await collect(streamProviderChat({ target, env, messages: [] }));
  const request = server.requests[0];
  assert.equal(request.headers["http-referer"], undefined);
  assert.equal(request.headers["x-title"], undefined);
  assert.equal(request.headers["x-openrouter"], undefined);
  const body = JSON.parse(request.body);
  assert.deepEqual(Object.keys(body).sort(), [
    "max_completion_tokens",
    "messages",
    "model",
    "stream",
  ]);
});

test("includeUsage adds exactly the optional usage request", async (t) => {
  const server = await startServer((req, res) =>
    sse(res, [
      { choices: [{ delta: { content: "ok" } }] },
      { usage: { prompt_tokens: 2, completion_tokens: 3 } },
    ]),
  );
  t.after(() => server.close());

  const target = targetFor(server.baseUrl, { includeUsage: true });
  const events = await collect(
    streamProviderChat({ target, env: { LAB_API_KEY: KEY_A }, messages: [] }),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["content", "done"],
  );
  assert.deepEqual(events[1].usage, { prompt_tokens: 2, completion_tokens: 3 });

  const body = JSON.parse(server.requests[0].body);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("auth none sends no Authorization header", async (t) => {
  const server = await startServer((req, res) =>
    sse(res, [{ choices: [{ delta: { content: "ok" } }] }]),
  );
  t.after(() => server.close());

  const target = targetFor(server.baseUrl, { auth: { type: "none" } });
  const events = await collect(streamProviderChat({ target, messages: [] }));
  assert.deepEqual(
    events.map((event) => event.type),
    ["content", "done"],
  );
  assert.equal(server.requests[0].headers.authorization, undefined);
});

test("a redirect never forwards the key to another origin", async (t) => {
  const destination = await startServer((req, res) =>
    sse(res, [{ choices: [{ delta: { content: "should not happen" } }] }]),
  );
  const origin = await startServer((req, res) => {
    res.writeHead(302, { location: `${destination.baseUrl}/stolen` });
    res.end("moved");
  });
  t.after(() => Promise.all([origin.close(), destination.close()]));

  const target = targetFor(origin.baseUrl);
  const events = await collect(
    streamProviderChat({ target, env: { LAB_API_KEY: KEY_A }, messages: [] }),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error, /HTTP 302/);
  assert.equal(events[0].error.includes(KEY_A), false);
  assert.equal(destination.requests.length, 0, "the redirect destination must see zero requests");
  assert.equal(origin.requests.length, 1);
});

test("a missing key fails before any network activity", async (t) => {
  const server = await startServer((req, res) =>
    sse(res, [{ choices: [{ delta: { content: "should not happen" } }] }]),
  );
  t.after(() => server.close());

  const target = targetFor(server.baseUrl);
  const events = await collect(
    streamProviderChat({ target, env: { LAB_API_KEY: "  " }, messages: [] }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error, /requires env LAB_API_KEY/);
  assert.equal(server.requests.length, 0);
  assert.throws(
    () => prepareProviderRequest(target, { env: {} }),
    (error) => error.code === "PROVIDER_MISSING_KEY",
  );
});

test("an echoed key in a provider error body is redacted", async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(401, { "content-type": "text/plain" });
    res.end(`invalid api key ${KEY_A}`);
  });
  t.after(() => server.close());

  const target = targetFor(server.baseUrl);
  const events = await collect(
    streamProviderChat({ target, env: { LAB_API_KEY: KEY_A }, messages: [] }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error, /HTTP 401/);
  assert.match(events[0].error, /\[redacted\]/);
  assert.equal(events[0].error.includes(KEY_A), false);
});

test("cancellation ends one terminal error and releases the connection", async (t) => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
    // Deliberately never end the stream.
  });
  t.after(() => server.close());

  const target = targetFor(server.baseUrl);
  const controller = new AbortController();
  const events = [];
  for await (const event of streamProviderChat({
    target,
    env: { LAB_API_KEY: KEY_A },
    messages: [],
    signal: controller.signal,
    idleTimeoutMs: 5000,
    totalTimeoutMs: 5000,
  })) {
    events.push(event);
    if (event.type === "content") controller.abort();
  }

  assert.deepEqual(
    events.map((event) => event.type),
    ["content", "error"],
  );
  assert.match(events[1].error, /aborted/i);
  assert.equal(server.requests.length, 1);
});

test("explicit built-in binding freezes its own endpoint and credential policy", (t) => {
  const openrouter = resolveProviderSelection({
    providerId: "openrouter",
    modelQuery: "sonnet",
  }).target;
  const bound = bindProviderTarget(openrouter, {
    OPENROUTER_API_KEY: ` ${KEY_A} `,
    MATRIX_API_BASE: "http://127.0.0.1:9/v1",
    MATRIX_API_KEY: "must-not-be-used",
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.credential, KEY_A);
  assert.equal(bound.endpoint, "https://openrouter.ai/api/v1/chat/completions");

  const ollama = resolveProviderSelection({
    providerId: "ollama",
    modelQuery: "llama3.2",
  }).target;
  const local = bindProviderTarget(ollama, {
    OLLAMA_HOST: "http://127.0.0.1:11434/",
    OLLAMA_API_KEY: "  ",
  });
  assert.equal(local.ok, true);
  assert.equal(local.credential, "ollama");
  assert.equal(local.endpoint, "http://127.0.0.1:11434/v1/chat/completions");

  const home = makeTempDir("matrix-builtin-key-");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const missing = bindProviderTarget(openrouter, { OPENROUTER_API_KEY: " " });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /requires OPENROUTER_API_KEY/);

  const localTarget = bindProviderTarget({ kind: "local" }, {});
  assert.equal(localTarget.ok, false);
  assert.match(localTarget.error, /custom or built-in target/);
  const noEndpoint = bindProviderTarget({ kind: "builtin", providerId: "matrix" }, {});
  assert.equal(noEndpoint.ok, false);
  assert.match(noEndpoint.error, /no explicit built-in endpoint/);
});

test("built-in targets are refused instead of guessed", async () => {
  const events = await collect(streamProviderChat({ target: localForgeTarget(), messages: [] }));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.match(events[0].error, /custom resolved target/);
});

test("target validation refuses missing kind, baseUrl and transport", () => {
  const target = targetFor("http://127.0.0.1:1");
  assert.throws(
    () => prepareProviderRequest(null, {}),
    (error) => error.code === "PROVIDER_UNSUPPORTED_TRANSPORT",
  );
  assert.throws(
    () => prepareProviderRequest({ ...target, baseUrl: null }, {}),
    (error) =>
      error.code === "PROVIDER_UNSUPPORTED_TRANSPORT" && /chat-completions/.test(error.message),
  );
  assert.throws(
    () => prepareProviderRequest({ ...target, transport: "local" }, {}),
    (error) => error.code === "PROVIDER_UNSUPPORTED_TRANSPORT",
  );
});

test("optional payload fields stay available without widening the closed shape", () => {
  const target = targetFor("http://127.0.0.1:1");
  const prepared = prepareProviderRequest(target, {
    env: { LAB_API_KEY: KEY_A },
    systemPrompt: "system instructions",
    messages: [
      { role: "user", content: "hello", name: "alice" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1" }] },
      { role: "tool", content: "result", tool_call_id: "call-1" },
    ],
    temperature: 0.2,
    tools: [{ type: "function", function: { name: "read_file" } }],
    toolChoice: "auto",
    maxTokens: 99,
  });

  assert.equal(prepared.payload.messages[0].role, "system");
  assert.equal(prepared.payload.messages[0].content, "system instructions");
  assert.equal(prepared.payload.messages[1].name, "alice");
  assert.deepEqual(prepared.payload.messages[2].tool_calls, [{ id: "call-1" }]);
  assert.equal(prepared.payload.messages[3].tool_call_id, "call-1");
  assert.equal(prepared.payload.temperature, 0.2);
  assert.equal(prepared.payload.tool_choice, "auto");
  assert.equal(prepared.payload.tools.length, 1);
  assert.equal(prepared.payload.max_tokens, 99);
});

test("HTTP error bodies echoing encoded credentials are redacted before display", async (t) => {
  const quoted = `sk-review/leak+canary:42`;
  const server = await startServer((req, res) => {
    const body = [
      `rejected key ${encodeURIComponent(quoted)}`,
      `json ${JSON.stringify(quoted).slice(1, -1)}`,
      `b64 ${Buffer.from(quoted, "utf8").toString("base64")}`,
    ].join(" | ");
    sse(res, body, { status: 400 });
  });
  t.after(() => server.close());

  const events = await collect(
    streamProviderChat({
      target: targetFor(server.baseUrl),
      env: { LAB_API_KEY: quoted },
      messages: [],
      maxRetries: 0,
    }),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  const message = events[0].error;
  for (const form of [
    quoted,
    encodeURIComponent(quoted),
    JSON.stringify(quoted).slice(1, -1),
    Buffer.from(quoted, "utf8").toString("base64"),
  ]) {
    assert.equal(message.includes(form), false, `credential form leaked: ${message}`);
  }
  for (let index = 0; index + 4 <= quoted.length; index++) {
    assert.equal(message.includes(quoted.slice(index, index + 4)), false, "key fragment leaked");
  }
});

test("a credential past the display boundary leaves no visible prefix", async (t) => {
  const quoted = "sk-boundary-canary-value";
  const server = await startServer((req, res) => {
    sse(res, "y".repeat(155) + quoted, { status: 400 });
  });
  t.after(() => server.close());

  const events = await collect(
    streamProviderChat({
      target: targetFor(server.baseUrl),
      env: { LAB_API_KEY: quoted },
      messages: [],
      maxRetries: 0,
    }),
  );
  assert.equal(events[0].type, "error");
  for (let index = 0; index + 4 <= quoted.length; index++) {
    assert.equal(
      events[0].error.includes(quoted.slice(index, index + 4)),
      false,
      `prefix leaked: ${events[0].error}`,
    );
  }
});

test("a short credential is still redacted from provider errors", async (t) => {
  const server = await startServer((req, res) => {
    sse(res, "bad key abc.", { status: 401 });
  });
  t.after(() => server.close());

  const events = await collect(
    streamProviderChat({
      target: targetFor(server.baseUrl),
      env: { LAB_API_KEY: "abc" },
      messages: [],
      maxRetries: 0,
    }),
  );
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.includes("key abc"), false);
  assert.match(events[0].error, /\[redacted\]/);
});

test("a credential in the Content-Type header is withheld, not truncated into view", async (t) => {
  const key = "sk-header-canary-value";
  const server = await startServer((req, res) => {
    res.writeHead(200, { "content-type": `${"x".repeat(70)}${key}`, "content-length": "0" });
    res.end();
  });
  t.after(() => server.close());

  const events = await collect(
    streamProviderChat({
      target: targetFor(server.baseUrl),
      env: { LAB_API_KEY: key },
      messages: [],
      maxRetries: 0,
    }),
  );
  assert.equal(events[0].type, "error");
  assert.match(events[0].error, /non-SSE success response/);
  for (let index = 0; index + 4 <= key.length; index++) {
    assert.equal(events[0].error.includes(key.slice(index, index + 4)), false, "header leaked");
  }
});

test("a credential echoed in a provider error code is redacted with the message", async (t) => {
  const key = "sk-code-canary-value";
  const server = await startServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ error: { message: "denied", code: key } })}\n\n`);
    res.end();
  });
  t.after(() => server.close());

  const events = await collect(
    streamProviderChat({
      target: targetFor(server.baseUrl),
      env: { LAB_API_KEY: key },
      messages: [],
      maxRetries: 0,
    }),
  );
  assert.equal(events[0].type, "error");
  for (let index = 0; index + 4 <= key.length; index++) {
    assert.equal(events[0].error.includes(key.slice(index, index + 4)), false, "code leaked");
  }
});

test("a header credential cannot reappear through the persisted run-log projection", async (t) => {
  const key = "sk-header-persist-canary";
  const server = await startServer((req, res) => {
    res.writeHead(200, { "content-type": `${"x".repeat(70)}${key}`, "content-length": "0" });
    res.end();
  });
  const home = makeTempDir("matrix-header-log-");
  t.after(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  });

  const events = await collect(
    streamProviderChat({
      target: targetFor(server.baseUrl),
      env: { LAB_API_KEY: key },
      messages: [],
      maxRetries: 0,
    }),
  );
  const path = appendRunEvent("run-20261101-a1b2c3", events[0], { home, secretValues: [key] });
  assert.equal(typeof path, "string");
  const raw = readFileSync(path, "utf8");
  for (let index = 0; index + 4 <= key.length; index++) {
    assert.equal(raw.includes(key.slice(index, index + 4)), false, "persisted projection leaked");
  }
});
