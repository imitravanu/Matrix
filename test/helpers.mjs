// Shared test fixtures. Every filesystem test runs on a copy of demo-project;
// the checked-in demo stays pristine even when a test fails mid-write.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripAnsi } from "../lib/text.mjs";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEMO_ROOT = join(PACKAGE_ROOT, "demo-project");

/** Six main screens in navigation order, followed by the model/help overlays. */
export const ALL_VIEW_NAMES = Object.freeze([
  "empty",
  "chat",
  "permission",
  "swarm",
  "scope",
  "vision",
  "model",
  "help",
]);

export const PROVIDER_ENVIRONMENT_KEYS = Object.freeze([
  "OPENROUTER_API_KEY",
  "MATRIX_API_KEY",
  "MATRIX_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OLLAMA_API_KEY",
  "OLLAMA_HOST",
]);

export function makeTempDir(prefix = "matrix-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function copyDemo(prefix = "matrix-test-demo-") {
  const root = makeTempDir(prefix);
  const workspace = join(root, "demo-project");
  cpSync(DEMO_ROOT, workspace, {
    recursive: true,
    force: true,
    filter: (source) => !source.includes("__pycache__") && !source.includes(".pytest_cache"),
  });
  return {
    root,
    workspace,
    read(rel) {
      return readFileSync(join(workspace, rel), "utf8");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function frameText(app) {
  return stripAnsi(app.lastFrame() ?? "");
}

export async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 30 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/** Temporarily replace environment values and return an idempotent restore function. */
export function patchEnv(values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Intercept global fetch for a network-free test. Without an implementation,
 * every request fails; an optional mock can supply a deterministic Response.
 */
export function installFetchTrap(implementation = null) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  const trappedFetch = async (...args) => {
    calls.push(args);
    if (typeof implementation === "function") return implementation(...args);
    throw new Error("Unexpected fetch in a network-free test");
  };
  globalThis.fetch = trappedFetch;
  let restored = false;
  return {
    calls,
    restore() {
      if (restored) return;
      restored = true;
      globalThis.fetch = previousFetch;
    },
  };
}

/** Build a streaming HTTP response from an array of OpenRouter SSE chunks. */
export function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

export function textResponse(text, status = 500) {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

/** A tool-call delta pair split across two chunks, like real providers send. */
export function toolCallChunks(id, name, args) {
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

export function contentChunks(text) {
  return [
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    { usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 } },
  ];
}
