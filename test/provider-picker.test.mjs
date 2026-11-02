import test from "node:test";
import assert from "node:assert/strict";

import { MODELS } from "../lib/models.mjs";
import {
  PROVIDER_SCHEMA_VERSION,
  resolveProviderSelection,
  validateProviderConfig,
} from "../lib/provider-contracts.mjs";
import {
  buildPickerModels,
  findPickerModel,
  pickerIndexFor,
  pickerKeyFor,
  pickerModelFromTarget,
} from "../src/provider-picker.mjs";

const config = validateProviderConfig({
  schemaVersion: PROVIDER_SCHEMA_VERSION,
  providers: [
    {
      id: "lab",
      name: "Lab",
      baseUrl: "https://lab.example/v1",
      auth: { type: "bearer", env: "LAB_KEY" },
      models: [{ id: "shared/model", capabilities: { tools: "supported" } }],
    },
    {
      id: "other",
      name: "Other",
      baseUrl: "https://other.example/v1",
      auth: { type: "none" },
      models: [{ id: "shared/model", capabilities: { tools: "unsupported" } }],
    },
  ],
});

function entry(overrides) {
  return {
    providerId: "lab",
    providerName: "Lab",
    source: "custom",
    modelId: "shared/model",
    name: "Shared Model",
    contextWindow: null,
    pricing: null,
    capabilities: { tools: "unknown" },
    available: true,
    legacy: false,
    ...overrides,
  };
}

const catalog = {
  status: "valid",
  entries: [
    entry({ capabilities: { tools: "supported" } }),
    entry({
      providerId: "other",
      providerName: "Other",
      available: false,
      capabilities: { tools: "unsupported" },
    }),
    entry({
      source: "discovered",
      modelId: "vendor/extra",
      name: "vendor/extra",
      capabilities: { tools: "unknown" },
      stale: true,
      discoveryError: "HTTP 503",
      contextWindow: 128_000,
    }),
    { ...MODELS[1], source: "builtin", modelId: MODELS[1].id },
    { ...MODELS[0], source: "local", modelId: MODELS[0].id },
  ],
};

test("built-ins stay first and provider entries append with stable keys", () => {
  const models = buildPickerModels({ catalog, config });
  assert.equal(models.length, MODELS.length + 3);
  assert.deepEqual(
    models.slice(0, MODELS.length).map((model) => model.id),
    MODELS.map((model) => model.id),
  );
  const keys = new Set(models.map(pickerKeyFor));
  assert.equal(keys.size, models.length, "every entry needs a unique key");
  assert.match(pickerKeyFor(models[0]), /^builtin:matrix:local$/);
  assert.notEqual(
    pickerKeyFor(models.find((model) => model.pickerKey === "provider:lab:shared/model")),
    pickerKeyFor(models.find((model) => model.pickerKey === "provider:other:shared/model")),
  );
});

test("provider entries carry resolved targets, availability and capabilities", () => {
  const models = buildPickerModels({ catalog, config });
  const lab = models.find((model) => model.pickerKey === "provider:lab:shared/model");
  assert.equal(lab.custom, true);
  assert.equal(lab.providerName, "Lab");
  assert.equal(lab.available, true);
  assert.equal(lab.tools, true);
  assert.equal(lab.providerTarget.providerId, "lab");
  assert.equal(lab.providerTarget.modelId, "shared/model");
  assert.equal(lab.providerTarget.baseUrl, "https://lab.example/v1");
  assert.match(lab.providerTarget.configDigest, /^[a-f0-9]{64}$/);

  const other = models.find((model) => model.pickerKey === "provider:other:shared/model");
  assert.equal(other.available, false);
  assert.equal(other.tools, false);
  assert.equal(other.providerTarget.baseUrl, "https://other.example/v1");

  const discovered = models.find((model) => model.pickerKey === "provider:lab:vendor/extra");
  assert.equal(discovered.source, "discovered");
  assert.equal(discovered.stale, true);
  assert.equal(discovered.context, 128_000);
  assert.match(discovered.description, /Discovered model from Lab · discovery stale/);
});

test("a missing or invalid configuration leaves built-ins usable", () => {
  const models = buildPickerModels({ catalog, config: null });
  assert.deepEqual(
    models.slice(0, MODELS.length).map((model) => model.id),
    MODELS.map((model) => model.id),
  );
  const lab = models.find((model) => model.providerId === "lab" && model.id === "shared/model");
  assert.equal(lab.providerTarget, null);
  assert.match(lab.targetError, /not loaded/);

  const invalid = buildPickerModels({ catalog: { status: "invalid" }, config });
  assert.equal(invalid.length, MODELS.length);
});

test("explicit presets and manual exact IDs project into real picker rows", () => {
  const manualTarget = resolveProviderSelection({
    providerId: "lab",
    modelQuery: "Vendor/Unlisted:Free",
    config,
  }).target;
  const manual = pickerModelFromTarget(manualTarget, { source: "manual", available: true });
  assert.equal(manual.pickerKey, "provider:lab:Vendor/Unlisted:Free");
  assert.equal(manual.providerName, "Lab");
  assert.equal(manual.name, "Vendor/Unlisted:Free");
  assert.equal(manual.tier, "custom");
  assert.equal(manual.custom, true);
  assert.equal(manual.remote, true);
  assert.equal(manual.available, true);
  assert.equal(manual.providerTarget.baseUrl, "https://lab.example/v1");
  assert.match(manual.description, /Exact manual model on Lab/);

  const preset = pickerModelFromTarget(
    resolveProviderSelection({ providerId: "openrouter", modelQuery: "sonnet" }).target,
    { source: "preset", available: null },
  );
  assert.match(preset.pickerKey, /^builtin:openrouter:/);
  assert.equal(preset.providerName, "OpenRouter");
  assert.equal(preset.tier, "builtin");
  assert.equal(preset.available, null, "built-ins keep the legacy credential policy");
  assert.equal(preset.custom, false);
  assert.equal(preset.providerTarget.kind, "builtin");

  const local = pickerModelFromTarget(resolveProviderSelection({ providerId: "matrix" }).target, {
    source: "preset",
    available: true,
  });
  assert.equal(local.pickerKey, "builtin:matrix:local");
  assert.equal(local.tier, "offline");
  assert.equal(local.free, true);
});

test("lookup prefers exact keys and IDs, then names and short aliases", () => {
  const models = buildPickerModels({ catalog, config });
  assert.equal(findPickerModel(models, "provider:other:shared/model").providerName, "Other");
  assert.equal(findPickerModel(models, "shared/model").providerName, "Lab");
  assert.equal(findPickerModel(models, "shared model").providerTarget.providerId, "lab");
  assert.equal(findPickerModel(models, "LOCAL").id, "local");
  assert.equal(findPickerModel(models, "nope"), null);

  const lab = models.find((model) => model.pickerKey === "provider:lab:shared/model");
  assert.equal(models[pickerIndexFor(models, lab)].pickerKey, "provider:lab:shared/model");
  assert.equal(pickerIndexFor(models, models[0]), 0);
  assert.equal(pickerIndexFor(models, { id: "absent", provider: "matrix" }), 0);
});
