// ============================================================================
// `matrix providers` projections.
//
// This layer adds no storage format and performs no network call except the
// explicit `--refresh`. It reads the validated configuration, the catalog and
// the persisted discovery snapshot/outcome so a terminal user can manage named
// providers without editing ${MATRIX_HOME}/providers.json by hand.
// ============================================================================

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

import {
  buildProviderCatalog,
  catalogDiagnostic,
  discoverySummary,
  groupCatalog,
} from "./provider-catalog.mjs";
import {
  addProviderProfile,
  loadProviderConfig,
  removeProviderProfile,
  replaceProviderProfile,
} from "./provider-config.mjs";
import {
  readDiscoveryCache,
  readDiscoveryStatus,
  refreshProviderModels,
} from "./provider-discovery.mjs";
import { isProviderCredentialAvailable, PROVIDER_LIMITS } from "./provider-contracts.mjs";
import { probeProvider, readProbeRecords } from "./provider-probe.mjs";
import { oneLine, sanitizeText, stripAnsi } from "./text.mjs";

/**
 * Build the profile the bounded writer will validate. The key value is never
 * accepted here; only the environment-variable name is stored.
 */
export function providerProfileFromOptions({
  providerAddId,
  providerBaseUrl,
  providerName = null,
  providerApiKeyEnv = null,
  providerAuth = "bearer",
  modelQuery = null,
}) {
  const profile = {
    id: providerAddId,
    baseUrl: providerBaseUrl,
    auth: providerAuth === "none" ? { type: "none" } : { type: "bearer", env: providerApiKeyEnv },
    models: modelQuery ? [{ id: modelQuery, capabilities: { tools: "unknown" } }] : [],
  };
  if (providerName) profile.name = providerName;
  if (modelQuery) profile.defaultModel = modelQuery;
  return profile;
}

/** Add one named profile. Duplicate ids are refused by the writer, never replaced. */
export async function addProvider({ home, ...options } = {}) {
  const profile = providerProfileFromOptions(options);
  const result = await addProviderProfile(profile, { home });
  const stored = result.config.providers.find((entry) => entry.id === profile.id);
  return {
    providerId: profile.id,
    name: stored?.name ?? profile.id,
    path: result.path,
    digest: result.digest,
    models: stored?.models.map((model) => model.id) ?? [],
  };
}

/** Replace one complete profile using a caller-observed configuration digest. */
export async function replaceProviderFromFile({
  home,
  providerId,
  profileFile,
  expectedDigest,
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest ?? "")) {
    throw new Error("provider replacement requires the current configuration digest");
  }
  let fd;
  let profile;
  try {
    fd = openSync(
      profileFile,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PROVIDER_LIMITS.configBytes)
      throw new Error("invalid replacement file");
    const buffer = Buffer.alloc(PROVIDER_LIMITS.configBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > PROVIDER_LIMITS.configBytes) throw new Error("replacement file is too large");
    profile = JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } catch {
    throw new Error("cannot read a valid bounded profile JSON file");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const result = await replaceProviderProfile(providerId, profile, { home, expectedDigest });
  return { providerId, path: result.path, digest: result.digest };
}

/**
 * Detail projection for one profile. The auth section carries the env-var name,
 * never the value; `available` is resolved from the current environment.
 */
export function showProvider({ home, providerId, env = process.env } = {}) {
  const loaded = loadProviderConfig({ home });
  if (loaded.status === "invalid") throw loaded.error;
  const profile = loaded.config.providers.find((entry) => entry.id === providerId);
  if (!profile) throw new Error(`unknown provider "${providerId}"`);
  const cached = readDiscoveryCache(home, profile);
  const status = readDiscoveryStatus(home, profile);
  const configured = new Set(profile.models.map((model) => model.id));
  return {
    providerId,
    path: loaded.path,
    configurationDigest: loaded.digest,
    name: profile.name,
    baseUrl: profile.baseUrl,
    transport: profile.transport,
    auth: {
      type: profile.auth.type,
      env: profile.auth.type === "bearer" ? profile.auth.env : null,
    },
    available: isProviderCredentialAvailable({ auth: profile.auth }, env),
    defaultModel: profile.defaultModel,
    models: profile.models.map((model) => ({
      id: model.id,
      name: model.name,
      tools: model.capabilities.tools,
      contextWindow: model.contextWindow,
    })),
    discovered: (cached?.models ?? [])
      .filter((model) => !configured.has(model.id))
      .map((model) => model.id),
    fetchedAt: cached?.fetchedAt ?? null,
    discovery: discoverySummary(status, cached),
    observations: readProbeRecords(home, profile).map((record) => ({
      modelId: record.modelId,
      testedAt: record.testedAt,
      text: record.checks.text.status,
      tools: record.checks.tools.status,
    })),
  };
}

/**
 * Partial update. Only fields named by a flag change; models, request options
 * and unknown future fields are preserved. The write is optimistic: the digest
 * read here must still be current or the store refuses the replacement.
 */
export async function updateProvider({
  home,
  providerId,
  providerName = null,
  providerBaseUrl = null,
  providerApiKeyEnv = null,
  providerAuth = null,
  modelQuery = null,
  providerRemoveModel = null,
  providerDefaultModel = null,
} = {}) {
  const loaded = loadProviderConfig({ home });
  if (loaded.status === "invalid") throw loaded.error;
  const profile = loaded.config.providers.find((entry) => entry.id === providerId);
  if (!profile) throw new Error(`unknown provider "${providerId}"`);

  const changes = [];
  const next = {
    ...profile,
    models: profile.models.map((model) => ({ ...model, capabilities: { ...model.capabilities } })),
  };

  if (providerName !== null) {
    next.name = providerName;
    changes.push("name");
  }
  if (providerBaseUrl !== null) {
    next.baseUrl = providerBaseUrl;
    changes.push("baseUrl");
  }

  const authType = providerAuth === null ? null : String(providerAuth).toLowerCase();
  if (authType !== null && authType !== "bearer" && authType !== "none") {
    throw new Error('--auth expects "bearer" or "none"');
  }
  if (authType === "none" && providerApiKeyEnv !== null) {
    throw new Error("--api-key-env is not valid with --auth none");
  }
  if (authType !== null || providerApiKeyEnv !== null) {
    if (authType === "none") {
      next.auth = { type: "none" };
    } else {
      const env = providerApiKeyEnv ?? (profile.auth.type === "bearer" ? profile.auth.env : null);
      if (!env) throw new Error("--auth bearer requires --api-key-env");
      next.auth = { type: "bearer", env };
    }
    changes.push("auth");
  }

  if (modelQuery !== null && providerRemoveModel === modelQuery) {
    throw new Error("--model and --remove-model cannot name the same model");
  }
  let models = next.models;
  if (modelQuery !== null) {
    if (models.some((model) => model.id === modelQuery)) {
      throw new Error(`provider "${providerId}" already lists model "${modelQuery}"`);
    }
    models = [...models, { id: modelQuery, capabilities: { tools: "unknown" } }];
    changes.push("model");
  }
  if (providerRemoveModel !== null) {
    if (!models.some((model) => model.id === providerRemoveModel)) {
      throw new Error(`provider "${providerId}" does not list model "${providerRemoveModel}"`);
    }
    models = models.filter((model) => model.id !== providerRemoveModel);
    changes.push("model");
  }
  next.models = models;

  let defaultModel = profile.defaultModel ?? null;
  if (providerDefaultModel !== null) {
    // Any syntactically valid exact ID is allowed, listed or not: selection must
    // not depend on a catalog. The store validates the wire ID on replacement.
    defaultModel = providerDefaultModel;
    changes.push("defaultModel");
  } else if (providerRemoveModel !== null && defaultModel === providerRemoveModel) {
    // An unlisted default is valid and must survive unrelated edits. Clear it
    // only when this command actually removed the model it pointed at.
    defaultModel = null;
    changes.push("defaultModel");
  }
  next.defaultModel = defaultModel;

  if (changes.length === 0) throw new Error("providers update requires at least one change");
  const result = await replaceProviderProfile(providerId, next, {
    home,
    expectedDigest: loaded.digest,
  });
  const stored = result.config.providers.find((entry) => entry.id === providerId);
  return {
    providerId,
    path: result.path,
    digest: result.digest,
    name: stored.name,
    baseUrl: stored.baseUrl,
    auth: {
      type: stored.auth.type,
      env: stored.auth.type === "bearer" ? stored.auth.env : null,
    },
    defaultModel: stored.defaultModel,
    models: stored.models.map((model) => model.id),
    changes: [...new Set(changes)],
  };
}

/** Remove one profile by exact id. */
export async function removeProvider({ home, providerId } = {}) {
  const result = await removeProviderProfile(providerId, { home });
  return {
    providerId,
    path: result.path,
    digest: result.digest,
    remaining: result.config.providers.map((entry) => entry.id),
  };
}

/**
 * Catalog projection: configuration validity stays separate from discovery
 * freshness, so a stale table never looks like a broken file.
 */
export function listProviders({ home, env = process.env } = {}) {
  const loaded = loadProviderConfig({ home });
  const catalog = buildProviderCatalog({ home, env, loaded });
  const authById = new Map(
    loaded.status === "valid"
      ? loaded.config.providers.map((profile) => [profile.id, profile.auth.type])
      : [],
  );
  return {
    status: catalog.status,
    path: catalog.path,
    error: catalogDiagnostic(catalog),
    providers: groupCatalog(catalog).map((group) => ({
      id: group.id,
      name: group.name,
      source: group.source,
      available: group.available,
      auth: group.source === "builtin" ? null : (authById.get(group.id) ?? null),
      discovery: group.discovery ?? null,
      models: group.models.map((entry) => ({
        id: entry.modelId,
        source: entry.source,
        stale: entry.stale === true,
      })),
    })),
  };
}

/** Cached models (manual always wins) plus the last refresh outcome. */
export async function modelsReport({ home, providerId, env = process.env, refresh = false } = {}) {
  const loaded = loadProviderConfig({ home });
  if (loaded.status === "invalid") throw loaded.error;
  const profile = loaded.config.providers.find((entry) => entry.id === providerId);
  if (!profile) throw new Error(`unknown provider "${providerId}"`);

  let refreshResult = null;
  if (refresh) refreshResult = await refreshProviderModels({ home, providerId, env });

  const cached = readDiscoveryCache(home, profile);
  const status = readDiscoveryStatus(home, profile);
  const configured = new Set(profile.models.map((model) => model.id));
  return {
    providerId,
    baseUrl: profile.baseUrl,
    path: loaded.path,
    auth: profile.auth.type,
    available: isProviderCredentialAvailable({ auth: profile.auth }, env),
    configured: profile.models.map((model) => model.id),
    discovered: (cached?.models ?? [])
      .filter((model) => !configured.has(model.id))
      .map((model) => model.id),
    fetchedAt: cached?.fetchedAt ?? null,
    // One summary shared with the catalog: a cached read and a rebuilt catalog
    // must never disagree about whether the last refresh failed.
    discovery: discoverySummary(status, cached),
    refresh: refreshResult
      ? {
          ok: refreshResult.ok,
          error: refreshResult.error ?? null,
          stale: refreshResult.stale ?? null,
          count: refreshResult.models?.length ?? 0,
          truncated: refreshResult.truncated === true,
        }
      : null,
  };
}

/**
 * Provider responses and stored status are untrusted. Terminal output keeps one
 * bounded line, so a body cannot paint escape sequences or forge extra rows.
 */
function displayText(value, max = 160) {
  return oneLine(sanitizeText(stripAnsi(value)), max);
}

/** Availability is reported as what it means, not always as a key. */
function credentialLabel({ available, auth }) {
  const type = typeof auth === "string" ? auth : auth?.type;
  if (type === "none") return "no key required";
  return available ? "key present" : "key missing";
}

function clockLabel(value) {
  if (!Number.isFinite(value)) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "never" : date.toISOString().replace(".000Z", "Z");
}

export function formatProviderList(report) {
  const lines = [`PROVIDERS  ${report.path}`];
  if (report.error) lines.push(`  ✗ invalid configuration: ${displayText(report.error)}`);
  if (report.providers.length === 0) lines.push("  no providers configured");
  for (const provider of report.providers) {
    const state = [];
    if (provider.source === "builtin") {
      state.push("built-in");
      state.push(
        provider.available ? "key present" : provider.available === false ? "key missing" : "",
      );
    } else {
      state.push(credentialLabel(provider));
      const discovery = provider.discovery;
      if (discovery?.stale)
        state.push(`stale: ${displayText(discovery.error ?? "last refresh failed")}`);
      else if (discovery?.outcome === "ok")
        state.push(`fresh · ${clockLabel(discovery.fetchedAt)}`);
      else if (!discovery) state.push("no snapshot");
    }
    const icon = provider.source === "builtin" ? "·" : provider.available ? "✓" : "!";
    const models = provider.models.length;
    lines.push(
      `  ${icon} ${provider.id.padEnd(16)} ${displayText(provider.name, 64)} · ${models} model${models === 1 ? "" : "s"} · ${state.filter(Boolean).join(" · ")}`,
    );
  }
  return lines.join("\n");
}

function toolsLabel(tools) {
  return tools === "supported" ? "tools" : tools === "unsupported" ? "no tools" : "tools unknown";
}

function contextLabel(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k ctx`;
  return `${value} ctx`;
}

/** Full profile view: what a user must know before editing or running it. */
export function formatProviderDetail(report) {
  const lines = [`PROVIDER ${report.providerId} · ${displayText(report.name, 64)}`];
  lines.push(`  file ${report.path}`);
  lines.push(`  configuration digest ${report.configurationDigest}`);
  lines.push(`  endpoint ${report.baseUrl} · ${report.transport}`);
  lines.push(
    report.auth.type === "none"
      ? "  auth anonymous (no key)"
      : `  auth bearer · ${displayText(report.auth.env, 64)}`,
  );
  lines.push(`  default ${report.defaultModel ?? "none"}`);
  lines.push(`  ${credentialLabel(report)} · snapshot ${clockLabel(report.fetchedAt)}`);
  lines.push(`  configured (${report.models.length})`);
  for (const model of report.models) {
    const detail = [toolsLabel(model.tools)];
    const context = contextLabel(model.contextWindow);
    if (context) detail.push(context);
    lines.push(`    ${model.id} · ${detail.join(" · ")}`);
  }
  lines.push(`  discovered (${report.discovered.length})`);
  for (const id of report.discovered) lines.push(`    ${id}`);
  lines.push(`  observed probes (${report.observations?.length ?? 0})`);
  for (const observation of report.observations ?? []) {
    lines.push(
      `    ${displayText(observation.modelId)} · text ${observation.text} · tools ${observation.tools} · ${clockLabel(observation.testedAt)}`,
    );
  }
  if (report.discovery?.stale || report.discovery?.outcome === "error")
    lines.push(`  stale: ${displayText(report.discovery.error ?? "last refresh failed")}`);
  else if (report.discovery?.outcome === "ok") lines.push("  last refresh ok");
  else if (!report.fetchedAt)
    lines.push("  no snapshot yet; run matrix providers models with --refresh to ask the provider");
  return lines.join("\n");
}

/** One-line receipt for a successful partial update. */
export function formatProviderUpdate(result) {
  const auth =
    result.auth.type === "none" ? "anonymous" : `bearer · ${displayText(result.auth.env, 64)}`;
  const models = result.models.length;
  return [
    `provider "${result.providerId}" updated · ${result.changes.join(", ")}`,
    `  ${displayText(result.name, 64)} · ${result.baseUrl} · ${auth}`,
    `  default ${result.defaultModel ?? "none"} · ${models} model${models === 1 ? "" : "s"}`,
    `  ${result.path}`,
  ].join("\n");
}

/**
 * Explicit opt-in network probe for one exact provider/model. Synthetic
 * fixtures only; the probe module owns every request and retention limit.
 */
export async function testProvider({
  home,
  providerId,
  modelQuery,
  providerChecks = null,
  env = process.env,
  signal = null,
} = {}) {
  if (!modelQuery) throw new Error("providers test requires --model <exact-id>");
  return probeProvider({
    home,
    providerId,
    modelId: modelQuery,
    checks: providerChecks,
    env,
    signal,
  });
}

/** Five-line probe receipt. A pass is evidence for one stream, never a badge for quality. */
export function formatProviderProbe(report) {
  const lines = [`PROVIDER PROBE ${report.providerId} · ${displayText(report.modelId, 100)}`];
  for (const check of ["text", "tools"]) {
    const result = report.checks[check];
    const detail =
      result.status === "pass"
        ? `pass${check === "text" && Number.isFinite(result.contentChars) ? ` · ${result.contentChars} content char${result.contentChars === 1 ? "" : "s"}` : ""}`
        : result.status === "fail"
          ? `fail · ${displayText(result.error ?? "unknown error")}`
          : "not evaluated";
    const icon = result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "–";
    lines.push(`  ${check.padEnd(5)} ${icon} ${detail}`);
  }
  if (report.usage) {
    const usage = ["prompt_tokens", "completion_tokens", "total_tokens"]
      .filter((key) => Number.isFinite(report.usage[key]))
      .map((key) => `${key.replace("_tokens", "")} ${report.usage[key]}`);
    if (usage.length > 0) {
      lines.push(
        `  usage ${usage.join(" · ")}${report.usageComplete === false ? " · partial" : ""}`,
      );
    }
  }
  lines.push(
    `  ${report.requests} request${report.requests === 1 ? "" : "s"} · ${clockLabel(report.testedAt)} · digest ${report.digest.slice(0, 12)}`,
  );
  if (report.cancelled) lines.push("  cancelled · no record written");
  else if (report.recorded) lines.push(`  record ${report.recordPath}`);
  else lines.push("  record not written (permissions, size or storage failure)");
  lines.push(
    "  Synthetic fixtures only; one stream is not coding-quality, context-length or full protocol evidence.",
  );
  return lines.join("\n");
}

export function formatProviderModels(report) {
  const lines = [
    `PROVIDER ${report.providerId} · ${report.baseUrl}`,
    `  ${credentialLabel(report)} · snapshot ${clockLabel(report.fetchedAt)}`,
  ];
  lines.push(`  configured (${report.configured.length})`);
  for (const id of report.configured) lines.push(`    ${id}`);
  lines.push(`  discovered (${report.discovered.length})`);
  for (const id of report.discovered) lines.push(`    ${id}`);
  if (report.discovery?.stale || report.discovery?.outcome === "error")
    lines.push(`  stale: ${displayText(report.discovery.error ?? "last refresh failed")}`);
  else if (report.discovery?.outcome === "ok") lines.push("  last refresh ok");
  if (report.refresh) {
    lines.push(
      report.refresh.ok
        ? `  refresh ok · ${report.refresh.count} model${report.refresh.count === 1 ? "" : "s"}${report.refresh.truncated ? " (truncated)" : ""}`
        : `  refresh failed · ${displayText(report.refresh.error)} · ${
            report.fetchedAt ? "prior snapshot preserved" : "no snapshot available"
          }`,
    );
  } else if (!report.fetchedAt) {
    lines.push("  no snapshot yet; run with --refresh to ask the provider");
  }
  return lines.join("\n");
}
