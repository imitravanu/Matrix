import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getOpenRouterKey,
  isOpenRouterAvailable,
  streamOpenRouter,
} from "../lib/openrouter.mjs";
import { contentChunks, sseResponse, toolCallChunks } from "./helpers.mjs";

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

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

test("streamOpenRouter parses a real SSE stream and sends the right payload", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return sseResponse([
      { choices: [{ delta: { reasoning: "checking the bounds" } }] },
      { choices: [{ delta: { content: "The slice is " } }] },
      ...toolCallChunks("call_1", "read_file", { path: "src/processor.py" }).slice(0, 3),
      { choices: [{ delta: { content: "off by one." } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    ]);
  };
  try {
    const events = await withEnv({ OPENROUTER_API_KEY: "test-key-never-print" }, () =>
      collect(
        streamOpenRouter({
          model: "anthropic/claude-sonnet-4.6",
          messages: [
            { role: "system", content: "ignored system is duplicated?" },
            { role: "user", content: "read it" },
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_0", type: "function", function: { name: "x", arguments: "{}" } }],
            },
            { role: "tool", tool_call_id: "call_0", content: "ok" },
          ],
          systemPrompt: "You are Matrix.",
          maxTokens: 99,
          temperature: 0.2,
          reasoning: { max_tokens: 300 },
          tools: [{ type: "function", function: { name: "read_file" } }],
          toolChoice: "auto",
          provider: { sort: "throughput" },
        })
      )
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(requests[0].init.method, "POST");
    assert.equal(requests[0].init.headers.Authorization, "Bearer test-key-never-print");
    const body = requests[0].body;
    assert.equal(body.model, "anthropic/claude-sonnet-4.6");
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 99);
    assert.equal(body.temperature, 0.2);
    assert.deepEqual(body.reasoning, { max_tokens: 300 });
    assert.deepEqual(body.tool_choice, "auto");
    assert.deepEqual(body.provider, { sort: "throughput" });
    assert.deepEqual(body.messages[0], { role: "system", content: "You are Matrix." });
    assert.deepEqual(body.messages[1], { role: "system", content: "ignored system is duplicated?" });
    assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "call_0", content: "ok" });
    assert.deepEqual(body.stream_options, { include_usage: true });

    const types = events.map((event) => event.type);
    assert.deepEqual(types, ["reasoning", "content", "tool_call", "tool_call", "finish", "content", "finish", "done"]);
    assert.equal(events[0].text, "checking the bounds");
    assert.equal(events[1].text, "The slice is ");
    assert.equal(events[2].type, "tool_call");
    assert.equal(events[2].id, "call_1");
    assert.equal(events[2].name, "read_file");
    assert.ok(events[2].arguments.startsWith('{"path"'));
    assert.ok(events[3].arguments.endsWith("}"));
    assert.equal(events[4].reason, "tool_calls");
    assert.equal(events[6].reason, "stop");
    assert.deepEqual(events[7].usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("streamOpenRouter yields exactly one done for a normal content stream", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(contentChunks("hello"));
  try {
    const events = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
      collect(streamOpenRouter({ messages: [{ role: "user", content: "hi" }] }))
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
    assert.equal(events.find((event) => event.type === "content").text, "hello");
    assert.equal(events.at(-1).type, "done");
    assert.ok(events.at(-1).usage);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("streamOpenRouter ignores comments and malformed chunks", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    sseResponse([
      ": keepalive",
      { choices: [{ delta: { content: "a" } }] },
      { not: "a choice" },
      { choices: [{ delta: { content: "b" } }] },
    ]);
  try {
    const events = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
      collect(streamOpenRouter({ messages: [{ role: "user", content: "hi" }] }))
    );
    assert.equal(events.filter((event) => event.type === "content").map((event) => event.text).join(""), "ab");
    assert.equal(events.filter((event) => event.type === "done").length, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("streamOpenRouter surfaces HTTP and provider errors honestly", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  try {
    const http = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
      collect(streamOpenRouter({ messages: [] }))
    );
    assert.equal(http.length, 1);
    assert.equal(http[0].type, "error");
    assert.match(http[0].error, /HTTP 401: unauthorized/);
  } finally {
    globalThis.fetch = previousFetch;
  }

  globalThis.fetch = async () => sseResponse([{ error: { code: 402, message: "no credits" } }]);
  try {
    const provider = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
      collect(streamOpenRouter({ messages: [] }))
    );
    assert.equal(provider.length, 1);
    assert.equal(provider[0].type, "error");
    assert.match(provider[0].error, /Provider error 402: no credits/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("streamOpenRouter handles network errors and aborts without throwing", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    const network = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
      collect(streamOpenRouter({ messages: [] }))
    );
    assert.equal(network[0].type, "error");
    assert.match(network[0].error, /Network error: offline/);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = async () => sseResponse(contentChunks("never read"));
  try {
    const aborted = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
      collect(streamOpenRouter({ messages: [], signal: controller.signal }))
    );
    assert.equal(aborted[0].type, "error");
    assert.match(aborted[0].error, /aborted by user/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the documented credentials file key is accepted", async () => {
  const home = mkdtempSync(join(tmpdir(), "matrix-keyfile-"));
  try {
    mkdirSync(join(home, ".matrix"));
    writeFileSync(join(home, ".matrix", "credentials.json"), JSON.stringify({ openrouterApiKey: "file-key" }));
    const key = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () => getOpenRouterKey());
    assert.equal(key, "file-key");

    writeFileSync(join(home, ".matrix", "credentials.json"), JSON.stringify({ apiKey: "legacy-key" }));
    const legacy = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () => getOpenRouterKey());
    assert.equal(legacy, "legacy-key");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing key fails honestly and never reaches fetch", async () => {
  const home = mkdtempSync(join(tmpdir(), "matrix-nokey-"));
  const previousFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return sseResponse(contentChunks("should not happen"));
  };
  try {
    const key = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () => getOpenRouterKey());
    assert.equal(key, null);
    const available = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () => isOpenRouterAvailable());
    assert.equal(available, false);
    const events = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () =>
      collect(streamOpenRouter({ messages: [] }))
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "error");
    assert.match(events[0].error, /No OpenRouter API key/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(home, { recursive: true, force: true });
  }
});
