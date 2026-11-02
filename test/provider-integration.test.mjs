import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { parseArgv } from "../lib/cli.mjs";
import { runModelAgent } from "../lib/model-agent.mjs";
import { addProviderProfile } from "../lib/provider-config.mjs";
import { resolveProviderSelection } from "../lib/provider-contracts.mjs";
import { detectProject } from "../lib/project.mjs";
import { copyDemo, makeTempDir } from "./helpers.mjs";

const MODEL = "Vendor/Model-X:Free";
const KEY = "sk-integration-canary-key";

async function startServer() {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "provider run complete" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("--provider parses with an exact model and rejects invalid combinations", () => {
  const parsed = parseArgv(["--provider", "lab", "--model", MODEL, "inspect the repo"]);
  assert.equal(parsed.command, "interactive");
  assert.equal(parsed.providerId, "lab");
  assert.equal(parsed.modelQuery, MODEL);
  assert.equal(parsed.task, "inspect the repo");

  assert.throws(() => parseArgv(["--provider", "Lab", "x"]), /lowercase provider id/);
  assert.throws(() => parseArgv(["--provider", "lab", "--offline", "x"]), /mutually exclusive/);
  assert.throws(
    () => parseArgv(["--provider", "lab", "doctor"]),
    /only valid with matrix interactive/,
  );
});

test("explicit built-in routing resolves exact targets without a named profile", () => {
  const openrouter = resolveProviderSelection({
    providerId: "openrouter",
    modelQuery: "sonnet",
  }).target;
  assert.equal(openrouter.kind, "builtin");
  assert.equal(openrouter.providerId, "openrouter");
  assert.match(openrouter.modelId, /^anthropic\/claude-sonnet-4\.6$/);
  assert.equal(openrouter.baseUrl, null);
  assert.equal(openrouter.configDigest, null);

  const exact = resolveProviderSelection({
    providerId: "openrouter",
    modelQuery: "Vendor/Arbitrary:tag",
  }).target;
  assert.equal(exact.kind, "builtin");
  assert.equal(exact.providerId, "openrouter");
  assert.equal(exact.modelId, "Vendor/Arbitrary:tag");
  assert.equal(exact.capabilities.tools, "unknown");

  const ollama = resolveProviderSelection({
    providerId: "ollama",
    modelQuery: "llama3.2:8b",
  }).target;
  assert.equal(ollama.kind, "builtin");
  assert.equal(ollama.providerId, "ollama");
  assert.equal(ollama.modelId, "llama3.2:8b");

  const local = resolveProviderSelection({ providerId: "local" }).target;
  assert.equal(local.kind, "local");
  assert.equal(local.providerId, "matrix");
  assert.equal(
    resolveProviderSelection({ providerId: "matrix", modelQuery: "forge" }).target.modelId,
    local.modelId,
  );

  assert.throws(
    () => resolveProviderSelection({ providerId: "openrouter" }),
    /requires an exact --model/,
  );
  assert.throws(
    () => resolveProviderSelection({ providerId: "ollama", modelQuery: "sonnet" }),
    /belongs to provider "openrouter"/,
  );
  assert.throws(
    () => resolveProviderSelection({ providerId: "matrix", modelQuery: "sonnet" }),
    /only serves Local Forge/,
  );
});

test("a named provider completes a real headless agent run over loopback", async (t) => {
  const server = await startServer();
  const demo = copyDemo("matrix-provider-run-");
  const home = join(makeTempDir("matrix-provider-home-"), "home");
  t.after(async () => {
    await server.close();
    demo.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  await addProviderProfile(
    {
      id: "lab",
      name: "Lab inference",
      baseUrl: `${server.baseUrl}/team/v1`,
      auth: { type: "bearer", env: "LAB_API_KEY" },
      defaultModel: MODEL,
      models: [{ id: MODEL, capabilities: { tools: "unknown" } }],
    },
    { home },
  );
  const loaded = (await import("../lib/provider-config.mjs")).loadProviderConfig({ home });
  const target = resolveProviderSelection({
    providerId: "lab",
    modelQuery: MODEL,
    config: loaded.config,
  }).target;

  const project = detectProject(demo.workspace);
  const model = {
    id: target.modelId,
    name: `${target.providerName} · ${target.modelName}`,
    provider: target.providerId,
    short: target.modelName,
    context: 128_000,
    pricing: null,
    remote: true,
    tools: null,
  };

  const result = await runModelAgent({
    task: "Say that the provider run completed.",
    project,
    model,
    providerTarget: target,
    env: { LAB_API_KEY: KEY },
    autoApprove: false,
    autoVerify: false,
    recoveryMode: "headless",
  });

  assert.match(result.content, /provider run complete/);
  assert.notEqual(result.status, "failed");
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].url, "/team/v1/chat/completions");
  assert.equal(server.requests[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(server.requests[0].body.model, MODEL);
  assert.ok(Array.isArray(server.requests[0].body.tools));
  assert.equal(server.requests[0].body.stream, true);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("one run keeps a single credential binding across tool rounds", async (t) => {
  const requests = [];
  const original = "sk-binding-original-canary";
  const replacement = "sk-binding-replacement-canary";
  const env = { LAB_API_KEY: original };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (requests.length === 1) {
        // The environment changes after the first request was already served.
        env.LAB_API_KEY = replacement;
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: "list_files", arguments: "{}" },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "tool_calls" }] })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "binding complete" } }] })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const demo = copyDemo("matrix-binding-run-");
  const home = join(makeTempDir("matrix-binding-home-"), "home");
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    demo.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  await addProviderProfile(
    {
      id: "lab",
      name: "Lab inference",
      baseUrl: `http://127.0.0.1:${server.address().port}/team/v1`,
      auth: { type: "bearer", env: "LAB_API_KEY" },
      defaultModel: MODEL,
      models: [{ id: MODEL, capabilities: { tools: "unknown" } }],
    },
    { home },
  );
  const loaded = (await import("../lib/provider-config.mjs")).loadProviderConfig({ home });
  const target = resolveProviderSelection({
    providerId: "lab",
    modelQuery: MODEL,
    config: loaded.config,
  }).target;

  const result = await runModelAgent({
    task: "List the workspace and confirm the binding.",
    project: detectProject(demo.workspace),
    model: {
      id: target.modelId,
      name: target.modelName,
      provider: target.providerId,
      short: target.modelName,
      context: 128_000,
      pricing: null,
      remote: true,
      tools: null,
    },
    providerTarget: target,
    env,
    autoApprove: false,
    autoVerify: false,
    recoveryMode: "headless",
  });

  assert.equal(requests.length, 2, "the tool round must issue a second request");
  for (const request of requests) {
    assert.equal(request.headers.authorization, `Bearer ${original}`);
  }
  assert.equal(env.LAB_API_KEY, replacement);
  assert.equal(JSON.stringify(result).includes(original), false);
  assert.equal(JSON.stringify(result).includes(replacement), false);

  // A fresh run resolves the deliberately changed credential.
  const freshEnv = { LAB_API_KEY: replacement };
  const second = await runModelAgent({
    task: "Confirm the new binding.",
    project: detectProject(demo.workspace),
    model: {
      id: target.modelId,
      name: target.modelName,
      provider: target.providerId,
      short: target.modelName,
      context: 128_000,
      pricing: null,
      remote: true,
      tools: null,
    },
    providerTarget: target,
    env: freshEnv,
    autoApprove: false,
    autoVerify: false,
    recoveryMode: "headless",
  });
  assert.notEqual(second.status, "failed");
  assert.equal(requests[2].headers.authorization, `Bearer ${replacement}`);
});
