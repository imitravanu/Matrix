// Shared test fixtures. Every filesystem test runs on a copy of demo-project;
// the checked-in demo stays pristine even when a test fails mid-write.
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripAnsi } from "../lib/text.mjs";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEMO_ROOT = join(PACKAGE_ROOT, "demo-project");

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
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = predicate();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
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
              { index: 0, id, type: "function", function: { name, arguments: json.slice(0, split) } },
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
