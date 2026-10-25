import test from "node:test";
import assert from "node:assert/strict";

import { accumulateTokenStats } from "../src/matrix.mjs";

const providerRound = {
  prompt_tokens: 100,
  completion_tokens: 40,
  total_tokens: 140,
  cached_tokens: 10,
  cost: 1,
  provenance: "provider",
  costProvenance: "provider",
  costComplete: true,
  provider: {
    prompt_tokens: 100,
    completion_tokens: 40,
    total_tokens: 140,
    cached_tokens: 10,
    cost: 1,
  },
  estimated: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, cost: 0 },
  rounds: { total: 1, provider: 1, estimated: 0, unavailable: 0 },
  costRounds: { provider: 1, estimated: 0, unavailable: 0 },
};

const estimatedRound = {
  prompt_tokens: 20,
  completion_tokens: 5,
  total_tokens: 25,
  cached_tokens: 0,
  cost: 0.5,
  provenance: "estimated",
  costProvenance: "estimated",
  costComplete: true,
  provider: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0, cost: 0 },
  estimated: {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    cached_tokens: 0,
    cost: 0.5,
  },
  rounds: { total: 1, provider: 0, estimated: 1, unavailable: 0 },
  costRounds: { provider: 0, estimated: 1, unavailable: 0 },
};

test("provider and estimated usage retain independent subtotals and sources", () => {
  const first = accumulateTokenStats({}, providerRound);
  assert.equal(first.provenance, "provider");
  assert.equal(first.costProvenance, "provider");
  assert.equal(first.cost, 1);
  assert.equal(first.costComplete, true);

  const mixed = accumulateTokenStats(first, estimatedRound);
  assert.equal(mixed.provenance, "mixed");
  assert.equal(mixed.costProvenance, "mixed");
  assert.equal(mixed.cost, 1.5);
  assert.equal(mixed.provider.cost, 1);
  assert.equal(mixed.estimated.cost, 0.5);
  assert.equal(mixed.rounds.total, 2);
  assert.equal(mixed.rounds.provider, 1);
  assert.equal(mixed.rounds.estimated, 1);
  assert.equal(mixed.costComplete, true);
});

test("unavailable rounds make numeric cost explicitly partial without erasing it", () => {
  const mixed = accumulateTokenStats(accumulateTokenStats({}, providerRound), estimatedRound);
  const partial = accumulateTokenStats(mixed, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
    cost: null,
    provenance: "unavailable",
    costProvenance: "unavailable",
    costComplete: false,
    rounds: { total: 1, provider: 0, estimated: 0, unavailable: 1 },
    costRounds: { provider: 0, estimated: 0, unavailable: 1 },
  });
  assert.equal(partial.cost, 1.5);
  assert.equal(partial.costComplete, false);
  assert.equal(partial.costProvenance, "mixed");
  assert.equal(partial.rounds.unavailable, 1);
});

test("unknown cost stays null while legacy activity is marked, not reinterpreted as provider", () => {
  const unknown = accumulateTokenStats(
    {},
    {
      prompt_tokens: 5,
      completion_tokens: 0,
      total_tokens: 5,
      cached_tokens: 0,
      cost: null,
      provenance: "estimated",
      costProvenance: "unavailable",
      costComplete: false,
      rounds: { total: 1, provider: 0, estimated: 1, unavailable: 0 },
      costRounds: { provider: 0, estimated: 0, unavailable: 1 },
    },
  );
  assert.equal(unknown.cost, null);
  assert.equal(unknown.costComplete, false);

  const legacy = accumulateTokenStats(
    { inputTokens: 50, outputTokens: 5, cachedTokens: 0, cost: 2 },
    providerRound,
  );
  assert.equal(legacy.costProvenance, "mixed");
  assert.equal(legacy.cost, 3);
  assert.equal(legacy.costComplete, false);
});
