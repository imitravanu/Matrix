import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getApiEndpoint,
  getOpenRouterKey,
  isOpenRouterAvailable,
  streamOpenRouter,
} from "../lib/openrouter.mjs";
import { PROVIDER_ENVIRONMENT_KEYS } from "./helpers.mjs";

const textEncoder = new TextEncoder();

function asTestBytes(value) {
  return typeof value === "string" ? textEncoder.encode(value) : value;
}

function byteResponse(
  chunks,
  { status = 200, contentType = "text/event-stream", headers = {}, close = true, onCancel } = {},
) {
  const bytes = chunks.map(asTestBytes);
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index < bytes.length) controller.enqueue(bytes[index++]);
      else if (close) controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
  return new Response(body, {
    status,
    headers: { ...(contentType === null ? {} : { "content-type": contentType }), ...headers },
  });
}

function sseResponse(chunks, options = {}) {
  const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  return byteResponse([...events, "data: [DONE]\n\n"], options);
}

function toolCallChunks(id, name, args) {
  const json = JSON.stringify(args);
  const split = Math.max(1, Math.floor(json.length / 2));
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: json.slice(0, split) },
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
            tool_calls: [{ index: 0, function: { arguments: json.slice(split) } }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } },
  ];
}

function contentChunks(text) {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 } },
  ];
}

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, due: now + Math.max(0, delay), id });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    flush,
    async advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers.values()]
          .filter((timer) => timer.due <= target)
          .sort((left, right) => left.due - right.due || left.id - right.id)[0];
        if (!next) break;
        now = next.due;
        timers.delete(next.id);
        next.callback();
        await flush();
      }
      now = target;
      await flush();
    },
    pending() {
      return timers.size;
    },
  };
}

function readerResponse(
  reader,
  { status = 200, contentType = "text/event-stream", headers = {} } = {},
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      ...(contentType === null ? {} : { "content-type": contentType }),
      ...headers,
    }),
    body: { getReader: () => reader },
  };
}

function stalledReader({ onRead, onCancel } = {}) {
  let rejectRead = null;
  return {
    read() {
      onRead?.();
      return new Promise((resolve, reject) => {
        rejectRead = reject;
      });
    },
    cancel() {
      onCancel?.();
      rejectRead?.(new Error("late read rejection after cancellation"));
      return Promise.reject(new Error("late cancellation rejection"));
    },
    releaseLock() {},
  };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

function withEnv(values, fn) {
  const scoped = {
    ...Object.fromEntries(PROVIDER_ENVIRONMENT_KEYS.map((key) => [key, undefined])),
    ...values,
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(scoped)) {
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
              tool_calls: [
                { id: "call_0", type: "function", function: { name: "x", arguments: "{}" } },
              ],
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
        }),
      ),
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
    assert.deepEqual(body.messages[1], {
      role: "system",
      content: "ignored system is duplicated?",
    });
    assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "call_0", content: "ok" });
    assert.deepEqual(body.stream_options, { include_usage: true });

    const types = events.map((event) => event.type);
    assert.deepEqual(types, [
      "reasoning",
      "content",
      "tool_call",
      "tool_call",
      "finish",
      "content",
      "finish",
      "done",
    ]);
    assert.equal(events[0].text, "checking the bounds");
    assert.equal(events[1].text, "The slice is ");
    assert.equal(events[2].type, "tool_call");
    assert.equal(events[2].id, "call_1");
    assert.equal(events[2].name, "read_file");
    assert.equal(events[2].index, 0);
    assert.equal(events[3].index, 0);
    assert.ok(events[2].arguments.startsWith('{"path"'));
    assert.ok(events[3].arguments.endsWith("}"));
    assert.equal(events[4].reason, "tool_calls");
    assert.equal(events[6].reason, "stop");
    assert.deepEqual(events[7].usage, {
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("streamOpenRouter gives unindexed parallel deltas stable assembly keys", async () => {
  await withEnv({ OPENROUTER_API_KEY: "k" }, async () => {
    const events = await collect(
      streamOpenRouter({
        messages: [],
        fetchImpl: async () =>
          sseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { id: "call_a", function: { name: "list_files", arguments: '{"filter":' } },
                      { id: "call_b", function: { name: "list_files", arguments: '{"filter":' } },
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
                      { function: { arguments: '"a"}' } },
                      { function: { arguments: '"b"}' } },
                    ],
                  },
                },
              ],
            },
          ]),
      }),
    );
    const calls = events.filter((event) => event.type === "tool_call");
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.index === null));
    assert.notEqual(calls[0].key, calls[1].key);
    assert.equal(calls[2].key, calls[0].key);
    assert.equal(calls[3].key, calls[1].key);
  });
});

test("streamOpenRouter yields exactly one done for a normal content stream", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(contentChunks("hello"));
  try {
    const events = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
      collect(streamOpenRouter({ messages: [{ role: "user", content: "hi" }] })),
    );
    assert.equal(events.filter((event) => event.type === "done").length, 1);
    assert.equal(events.find((event) => event.type === "content").text, "hello");
    assert.equal(events.at(-1).type, "done");
    assert.ok(events.at(-1).usage);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("streamOpenRouter ignores comments and events without choices", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    byteResponse([
      ": keepalive\n\n",
      `data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`,
      `data: ${JSON.stringify({ not: "a choice" })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "b" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  try {
    const events = await withEnv({ OPENROUTER_API_KEY: "k" }, () =>
      collect(streamOpenRouter({ messages: [{ role: "user", content: "hi" }] })),
    );
    assert.equal(
      events
        .filter((event) => event.type === "content")
        .map((event) => event.text)
        .join(""),
      "ab",
    );
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
      collect(streamOpenRouter({ messages: [] })),
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
      collect(streamOpenRouter({ messages: [] })),
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
      collect(streamOpenRouter({ messages: [] })),
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
      collect(streamOpenRouter({ messages: [], signal: controller.signal })),
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
    writeFileSync(
      join(home, ".matrix", "credentials.json"),
      JSON.stringify({ openrouterApiKey: "file-key" }),
    );
    const key = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () =>
      getOpenRouterKey(),
    );
    assert.equal(key, "file-key");

    writeFileSync(
      join(home, ".matrix", "credentials.json"),
      JSON.stringify({ apiKey: "legacy-key" }),
    );
    const legacy = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () =>
      getOpenRouterKey(),
    );
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
    const key = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () =>
      getOpenRouterKey(),
    );
    assert.equal(key, null);
    const available = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () =>
      isOpenRouterAvailable(),
    );
    assert.equal(available, false);
    const events = await withEnv({ OPENROUTER_API_KEY: undefined, HOME: home }, () =>
      collect(streamOpenRouter({ messages: [] })),
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

test("provider endpoints and credentials stay bound to the selected provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "matrix-provider-routing-"));
  const baseEnv = {
    HOME: home,
    OPENROUTER_API_KEY: "fake-openrouter-key",
    MATRIX_API_KEY: "fake-matrix-key",
    OPENAI_API_KEY: "fake-openai-key",
    OLLAMA_API_KEY: undefined,
    MATRIX_API_BASE: undefined,
    OPENAI_BASE_URL: undefined,
    OLLAMA_HOST: "http://ollama.invalid:11434",
  };
  try {
    await withEnv(baseEnv, () => {
      assert.equal(
        getApiEndpoint("anthropic/claude-sonnet-4.6"),
        "https://openrouter.ai/api/v1/chat/completions",
      );
      assert.equal(getOpenRouterKey("anthropic/claude-sonnet-4.6"), "fake-openrouter-key");
      assert.equal(
        getApiEndpoint("OLLAMA/llama3.2"),
        "http://ollama.invalid:11434/v1/chat/completions",
      );
      assert.equal(getOpenRouterKey("OLLAMA/llama3.2"), "ollama");
    });
    await withEnv({ ...baseEnv, MATRIX_API_BASE: "http://matrix.invalid/v1" }, () => {
      assert.equal(
        getApiEndpoint("anthropic/claude-sonnet-4.6"),
        "http://matrix.invalid/v1/chat/completions",
      );
      assert.equal(getOpenRouterKey("anthropic/claude-sonnet-4.6"), "fake-matrix-key");
      assert.equal(
        getApiEndpoint("ollama/llama3.2"),
        "http://ollama.invalid:11434/v1/chat/completions",
      );
      assert.equal(getOpenRouterKey("ollama/llama3.2"), "ollama");
    });
    await withEnv({ ...baseEnv, OPENAI_BASE_URL: "http://openai.invalid/v1" }, () => {
      assert.equal(
        getApiEndpoint("anthropic/claude-sonnet-4.6"),
        "http://openai.invalid/v1/chat/completions",
      );
      assert.equal(getOpenRouterKey("anthropic/claude-sonnet-4.6"), "fake-openai-key");
      assert.equal(
        getApiEndpoint("ollama/llama3.2"),
        "http://ollama.invalid:11434/v1/chat/completions",
      );
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ollama local models route to local daemon with zero external credentials", async () => {
  const model = "ollama/qwen2.5-coder";
  await withEnv({ OPENROUTER_API_KEY: undefined }, () => {
    assert.equal(getApiEndpoint(model), "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(isOpenRouterAvailable(model), true);
    assert.equal(getOpenRouterKey(model), "ollama");
  });

  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return sseResponse([
      { choices: [{ delta: { content: "local ollama response" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  };
  try {
    const events = await withEnv({ OPENROUTER_API_KEY: undefined }, () =>
      collect(
        streamOpenRouter({
          model,
          messages: [{ role: "user", content: "hello" }],
        }),
      ),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(requests[0].body.model, "qwen2.5-coder");
    assert.ok(events.some((e) => e.type === "content" && e.text.includes("local ollama response")));
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("raw SSE survives CRLF, optional spaces, multiline data, UTF-8, and arbitrary byte splits", async () => {
  const raw =
    'data:{"choices":\r\n' +
    'data: [{"delta":{"content":"A🌊"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"!"}}]}\r\n\r\n' +
    "data:[DONE]";
  const bytes = textEncoder.encode(raw);
  const chunkings = [[bytes]];
  for (let split = 0; split <= bytes.byteLength; split += 1) {
    chunkings.push([bytes.subarray(0, split), bytes.subarray(split)]);
  }
  chunkings.push(Array.from(bytes, (_, index) => bytes.subarray(index, index + 1)));

  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      for (const chunks of chunkings) {
        const events = await collect(
          streamOpenRouter({
            messages: [],
            fetchImpl: async () => byteResponse(chunks),
          }),
        );
        assert.equal(
          events
            .filter((event) => event.type === "content")
            .map((event) => event.text)
            .join(""),
          "A🌊!",
        );
        assert.deepEqual(events.at(-1), { type: "done" });
        assert.equal(events.filter((event) => event.type === "error").length, 0);
      }
    },
  );
});

test("malformed JSON and non-SSE success responses are errors and cancel the body", async () => {
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      let malformedCancelled = false;
      const malformed = await collect(
        streamOpenRouter({
          messages: [],
          fetchImpl: async () =>
            byteResponse(['data: {"choices": [}\n\ndata: [DONE]\n\n'], {
              close: false,
              onCancel: () => {
                malformedCancelled = true;
              },
            }),
        }),
      );
      assert.equal(malformed.at(-1).type, "error");
      assert.match(malformed.at(-1).error, /Malformed SSE JSON/);
      assert.equal(
        malformed.some((event) => event.type === "done"),
        false,
      );
      assert.equal(malformedCancelled, true);

      let nonSseCancelled = false;
      const nonSse = await collect(
        streamOpenRouter({
          messages: [],
          fetchImpl: async () =>
            byteResponse(["data: [DONE]\n\n"], {
              contentType: "application/json",
              close: false,
              onCancel: () => {
                nonSseCancelled = true;
              },
            }),
        }),
      );
      assert.deepEqual(nonSse.length, 1);
      assert.equal(nonSse[0].type, "error");
      assert.match(nonSse[0].error, /non-SSE success response/);
      assert.equal(nonSseCancelled, true);
    },
  );
});

test("a truncated stream retains valid events but cannot finish cleanly", async () => {
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      const events = await collect(
        streamOpenRouter({
          messages: [],
          fetchImpl: async () =>
            byteResponse([
              `data: ${JSON.stringify({ choices: [{ delta: { content: "kept" } }] })}\n\n`,
              'data: {"choices":[{"delta":{"content":"final"}}]}',
            ]),
        }),
      );
      assert.deepEqual(
        events.filter((event) => event.type === "content").map((event) => event.text),
        ["kept", "final"],
      );
      assert.equal(events.at(-1).type, "error");
      assert.match(events.at(-1).error, /ended before the \[DONE\] event/);
      assert.equal(
        events.some((event) => event.type === "done"),
        false,
      );
    },
  );
});

test("HTTP error bodies and pending SSE events have hard byte budgets", async () => {
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      let errorCancelled = false;
      const http = await collect(
        streamOpenRouter({
          messages: [],
          maxRetries: 0,
          maxErrorBodyBytes: 8,
          fetchImpl: async () =>
            byteResponse(["123456789-secret-tail"], {
              status: 500,
              contentType: "text/plain",
              close: false,
              onCancel: () => {
                errorCancelled = true;
              },
            }),
        }),
      );
      assert.equal(http.length, 1);
      assert.match(http[0].error, /HTTP 500: 12345678/);
      assert.doesNotMatch(http[0].error, /secret-tail/);
      assert.equal(errorCancelled, true);

      let eventCancelled = false;
      const event = await collect(
        streamOpenRouter({
          messages: [],
          maxEventBytes: 24,
          fetchImpl: async () =>
            byteResponse([`data: ${"x".repeat(100)}`], {
              close: false,
              onCancel: () => {
                eventCancelled = true;
              },
            }),
        }),
      );
      assert.equal(event.length, 1);
      assert.equal(event[0].type, "error");
      assert.match(event[0].error, /24-byte buffer limit/);
      assert.equal(eventCancelled, true);
    },
  );
});

test("returning early from the async generator cancels and releases the active reader", async () => {
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      let cancelled = 0;
      let released = 0;
      let reads = 0;
      const reader = {
        async read() {
          reads += 1;
          if (reads > 1) return new Promise(() => {});
          return {
            done: false,
            value: textEncoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`,
            ),
          };
        },
        cancel() {
          cancelled += 1;
          return Promise.resolve();
        },
        releaseLock() {
          released += 1;
        },
      };
      const stream = streamOpenRouter({
        messages: [],
        fetchImpl: async () => readerResponse(reader),
      });
      assert.deepEqual(await stream.next(), {
        done: false,
        value: { type: "content", text: "first" },
      });
      await stream.return();
      assert.equal(cancelled, 1);
      assert.equal(released, 1);
    },
  );
});

test("connection, idle-stream, and total deadlines settle and cancel stalled operations", async () => {
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      const connectClock = createFakeClock();
      let rejectFetch;
      let fetchSignal;
      let fetches = 0;
      const connecting = collect(
        streamOpenRouter({
          messages: [],
          clock: connectClock,
          connectTimeoutMs: 25,
          totalTimeoutMs: 1000,
          fetchImpl: (url, init) => {
            fetches += 1;
            fetchSignal = init.signal;
            return new Promise((resolve, reject) => {
              rejectFetch = reject;
            });
          },
        }),
      );
      await connectClock.flush();
      assert.equal(fetches, 1);
      await connectClock.advance(25);
      const connectEvents = await connecting;
      assert.equal(connectEvents.length, 1);
      assert.equal(connectEvents[0].type, "error");
      assert.match(connectEvents[0].error, /Connection deadline exceeded after 25 ms/);
      assert.equal(fetchSignal.aborted, true);
      rejectFetch(new Error("late fetch rejection"));
      await connectClock.flush();
      assert.equal(connectClock.pending(), 0);

      const idleClock = createFakeClock();
      let idleCancelled = 0;
      const idling = collect(
        streamOpenRouter({
          messages: [],
          clock: idleClock,
          idleTimeoutMs: 30,
          totalTimeoutMs: 1000,
          fetchImpl: async () =>
            readerResponse(stalledReader({ onCancel: () => (idleCancelled += 1) })),
        }),
      );
      await idleClock.flush();
      await idleClock.advance(30);
      const idleEvents = await idling;
      assert.equal(idleEvents.length, 1);
      assert.match(idleEvents[0].error, /Stream idle deadline exceeded after 30 ms/);
      assert.equal(idleCancelled, 1);
      assert.equal(idleClock.pending(), 0);

      const totalClock = createFakeClock();
      let totalCancelled = 0;
      const totaling = collect(
        streamOpenRouter({
          messages: [],
          clock: totalClock,
          idleTimeoutMs: 10_000,
          totalTimeoutMs: 75,
          fetchImpl: async () =>
            readerResponse(stalledReader({ onCancel: () => (totalCancelled += 1) })),
        }),
      );
      await totalClock.flush();
      await totalClock.advance(75);
      const totalEvents = await totaling;
      assert.equal(totalEvents.length, 1);
      assert.match(totalEvents[0].error, /Total request deadline exceeded after 75 ms/);
      assert.equal(totalCancelled, 1);
      assert.equal(totalClock.pending(), 0);
    },
  );
});

test("safe HTTP failures retry with exponential backoff and Retry-After", async () => {
  const clock = createFakeClock();
  let attempts = 0;
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      const pending = collect(
        streamOpenRouter({
          messages: [],
          clock,
          maxRetries: 2,
          retryBaseDelayMs: 100,
          retryMaxDelayMs: 5000,
          totalTimeoutMs: 10_000,
          fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1)
              return byteResponse(["try again"], { status: 408, contentType: "text/plain" });
            if (attempts === 2) {
              return byteResponse(["slow down"], {
                status: 429,
                contentType: "text/plain",
                headers: { "retry-after": "2" },
              });
            }
            return sseResponse(contentChunks("recovered"));
          },
        }),
      );
      await clock.flush();
      assert.equal(attempts, 1);
      await clock.advance(99);
      assert.equal(attempts, 1);
      await clock.advance(1);
      assert.equal(attempts, 2);
      await clock.advance(1999);
      assert.equal(attempts, 2);
      await clock.advance(1);
      const events = await pending;
      assert.equal(attempts, 3);
      assert.equal(events.find((event) => event.type === "content")?.text, "recovered");
      assert.equal(events.at(-1).type, "done");
      assert.equal(clock.pending(), 0);
    },
  );
});

test("retry count is bounded and permanent HTTP statuses never retry", async () => {
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      const clock = createFakeClock();
      let attempts = 0;
      const pending = collect(
        streamOpenRouter({
          messages: [],
          clock,
          maxRetries: 2,
          retryBaseDelayMs: 0,
          fetchImpl: async () => {
            attempts += 1;
            return byteResponse(["still unavailable"], { status: 500, contentType: "text/plain" });
          },
        }),
      );
      await clock.flush();
      await clock.advance(0);
      const capped = await pending;
      assert.equal(attempts, 3);
      assert.equal(capped.length, 1);
      assert.match(capped[0].error, /HTTP 500/);
      assert.equal(clock.pending(), 0);

      for (const status of [400, 401, 402, 403]) {
        let permanentAttempts = 0;
        const events = await collect(
          streamOpenRouter({
            messages: [],
            maxRetries: 5,
            retryBaseDelayMs: 0,
            fetchImpl: async () => {
              permanentAttempts += 1;
              return byteResponse(["denied"], { status, contentType: "text/plain" });
            },
          }),
        );
        assert.equal(permanentAttempts, 1);
        assert.equal(events.length, 1);
        assert.match(events[0].error, new RegExp(`HTTP ${status}`));
      }
    },
  );
});

test("provider failures after consumed stream bytes are never retried", async () => {
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      let attempts = 0;
      const events = await collect(
        streamOpenRouter({
          messages: [],
          maxRetries: 5,
          retryBaseDelayMs: 0,
          fetchImpl: async () => {
            attempts += 1;
            return byteResponse([
              `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
              'data: {"error":{"code":500,"message":"provider reset"}}\n\n',
            ]);
          },
        }),
      );
      assert.equal(attempts, 1);
      assert.equal(events[0].type, "content");
      assert.equal(events.at(-1).type, "error");
      assert.match(events.at(-1).error, /Provider error 500: provider reset/);
      assert.equal(
        events.some((event) => event.type === "done"),
        false,
      );
    },
  );
});

test("caller abort interrupts Retry-After backoff and clears every timer", async () => {
  const clock = createFakeClock();
  const controller = new AbortController();
  let attempts = 0;
  await withEnv(
    { OPENROUTER_API_KEY: "k", MATRIX_API_BASE: undefined, OPENAI_BASE_URL: undefined },
    async () => {
      const pending = collect(
        streamOpenRouter({
          messages: [],
          signal: controller.signal,
          clock,
          maxRetries: 3,
          totalTimeoutMs: 100_000,
          fetchImpl: async () => {
            attempts += 1;
            return byteResponse(["busy"], {
              status: 429,
              contentType: "text/plain",
              headers: { "retry-after": "60" },
            });
          },
        }),
      );
      await clock.flush();
      assert.equal(attempts, 1);
      controller.abort();
      const events = await pending;
      assert.deepEqual(events, [{ type: "error", error: "Request aborted by user" }]);
      assert.equal(attempts, 1);
      assert.equal(clock.pending(), 0);
    },
  );
});
