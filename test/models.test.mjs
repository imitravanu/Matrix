import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_MODEL,
  MODELS,
  estimateCost,
  filterModels,
  formatCost,
  isFreeModel,
  modelById,
  modelIndex,
  modelLabel,
  resolveModel,
} from "../lib/models.mjs";

test("the registry keeps static model metadata honest and Local Forge first", () => {
  assert.equal(MODELS[0], LOCAL_MODEL);
  assert.equal(LOCAL_MODEL.remote, false);
  const remote = MODELS.filter((model) => model.remote);
  assert.ok(remote.length >= 5);
  for (const model of remote) {
    assert.match(model.id, /^[a-z0-9-]+\/[a-z0-9.:-]+$/i);
    assert.ok(["openrouter", "ollama"].includes(model.provider));
    assert.ok(model.pricing.input >= 0);
    assert.ok(model.pricing.output >= 0);
    assert.match(model.description, /unverified|estimate|unknown|depends/i);
    assert.doesNotMatch(
      model.description,
      /highest quality|best active|ultra-low latency|100% private/i,
    );
  }
  assert.ok(remote.some((model) => model.id === "anthropic/claude-sonnet-4.6"));
  assert.ok(remote.some((model) => model.id === "qwen/qwen3-coder-next"));
  assert.ok(remote.some((model) => model.id === "openrouter/free"));
  assert.ok(remote.some((model) => model.id === "nvidia/nemotron-3.5-lightning:free"));
  assert.ok(remote.some((model) => model.id === "ollama/qwen2.5-coder"));
  assert.ok(remote.every((model) => !/space bunny|stealth/i.test(`${model.id} ${model.name}`)));
});

test("resolveModel accepts ids, shorts, names, aliases and falls back local", () => {
  assert.equal(resolveModel("local"), LOCAL_MODEL);
  assert.equal(resolveModel("forge"), LOCAL_MODEL);
  assert.equal(resolveModel("free").id, "openrouter/free");
  assert.equal(resolveModel("ollama").id, "ollama/qwen2.5-coder");
  const dynamicOllama = resolveModel("ollama/llama3.2");
  assert.equal(dynamicOllama.id, "ollama/llama3.2");
  assert.equal(dynamicOllama.free, true);
  assert.equal(dynamicOllama.context, null);
  assert.equal(dynamicOllama.tools, null);
  assert.doesNotMatch(dynamicOllama.description, /100% private/);
  assert.equal(resolveModel("nemotron").id, "nvidia/nemotron-3.5-lightning:free");
  assert.equal(resolveModel("sonnet").id, "anthropic/claude-sonnet-4.6");
  assert.equal(resolveModel("Claude Sonnet 4.6").id, "anthropic/claude-sonnet-4.6");
  assert.equal(resolveModel("google/gemini-2.5-flash").short, "gemini");
  assert.equal(resolveModel("deepseek").provider, "openrouter");
  assert.equal(resolveModel("not-a-model"), LOCAL_MODEL);
  assert.equal(resolveModel("not-a-model", { fallback: false }), null);
  assert.equal(resolveModel("ollama/", { fallback: false }), null);
  assert.equal(resolveModel(null), LOCAL_MODEL);
});

test("isFreeModel and filterModels categorize zero-cost models", () => {
  assert.equal(isFreeModel(LOCAL_MODEL), true);
  assert.equal(isFreeModel(resolveModel("free")), true);
  assert.equal(isFreeModel(resolveModel("sonnet")), false);
  const freeList = filterModels(MODELS, "free");
  assert.ok(freeList.length >= 7);
  assert.ok(freeList.every(isFreeModel));
  const nemotron = filterModels(MODELS, "nemotron");
  assert.equal(nemotron.length, 1);
  assert.equal(nemotron[0].short, "nemotron");
});

test("modelById and modelIndex are safe for unknown ids", () => {
  assert.equal(modelById("local").id, "local");
  assert.equal(modelById("missing"), LOCAL_MODEL);
  assert.equal(modelIndex("local"), 0);
  assert.equal(modelIndex("missing"), 0);
  assert.equal(modelIndex("anthropic/claude-sonnet-4.6"), 1);
});

test("estimateCost prices uncached input, cached input and output", () => {
  const model = {
    pricing: { input: 3, output: 15, cacheRead: 0.3 },
  };
  const usage = {
    prompt_tokens: 1_000_000,
    completion_tokens: 1_000_000,
    prompt_tokens_details: { cached_tokens: 200_000 },
  };
  const expected = (800_000 * 3 + 200_000 * 0.3 + 1_000_000 * 15) / 1_000_000;
  assert.equal(estimateCost(model, usage), expected);
  assert.equal(
    estimateCost(model, { ...usage, prompt_tokens_details: undefined, cached_tokens: 200_000 }),
    expected,
  );
  assert.equal(estimateCost(LOCAL_MODEL, usage), 0);
  assert.equal(estimateCost(model, {}), 0);
  assert.equal(estimateCost({ pricing: {} }, usage), null);
  assert.equal(estimateCost(null, usage), null);
});

test("formatCost and modelLabel stay compact", () => {
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(null), "unknown");
  assert.equal(formatCost(undefined), "unknown");
  assert.equal(formatCost(Number.NaN), "unknown");
  assert.equal(formatCost(0.0004), "$0.0004");
  assert.equal(formatCost(0.000001), "<$0.0001");
  assert.equal(formatCost(1.234), "$1.23");
  assert.equal(modelLabel(LOCAL_MODEL), "Local Forge · offline");
  assert.equal(modelLabel(MODELS[1]), `${MODELS[1].name} · remote`);
  assert.equal(modelLabel(null), "no model");
});
