// Transport-free provider credential lookup shared by execution and the UI.
// Availability checks return only booleans to callers; keys are never logged.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export function modelId(model) {
  return typeof model === "string" ? model : String(model?.id ?? "");
}

export function isOllamaModel(model) {
  return model?.provider === "ollama" || /^(?:ollama|local)\//i.test(modelId(model));
}

function storedOpenRouterKey() {
  for (const dir of [".matrix"]) {
    try {
      const credPath = `${homedir()}/${dir}/credentials.json`;
      const creds = JSON.parse(readFileSync(credPath, "utf8"));
      const key = creds.openrouterApiKey ?? creds.apiKey ?? creds.matrixApiKey;
      if (typeof key === "string" && key.trim()) return key.trim();
    } catch {
      // Continue to next path
    }
  }
  return null;
}

export function getOpenRouterKey(model = "") {
  if (isOllamaModel(model)) return process.env.OLLAMA_API_KEY || "ollama";

  const matrixBase = process.env.MATRIX_API_BASE?.trim();
  const openAIBase = process.env.OPENAI_BASE_URL?.trim();
  if (matrixBase && !/^https:\/\/openrouter\.ai\//i.test(matrixBase)) {
    return process.env.MATRIX_API_KEY?.trim() || null;
  }
  if (!matrixBase && openAIBase) return process.env.OPENAI_API_KEY?.trim() || null;

  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) {
    return process.env.OPENROUTER_API_KEY.trim();
  }
  if (process.env.MATRIX_API_KEY && process.env.MATRIX_API_KEY.trim()) {
    return process.env.MATRIX_API_KEY.trim();
  }
  return storedOpenRouterKey();
}

/**
 * Explicit built-in selection binds the provider's own endpoint and credential
 * policy. Global MATRIX_API_BASE / OPENAI_BASE_URL / MATRIX_API_KEY redirection
 * belongs only to the legacy no-provider path.
 */
export function getExplicitBuiltinEndpoint(providerId, env = process.env) {
  if (providerId === "openrouter") return "https://openrouter.ai/api/v1/chat/completions";
  if (providerId === "ollama") {
    const host = String(env.OLLAMA_HOST || "http://127.0.0.1:11434")
      .trim()
      .replace(/\/+$/, "");
    return `${host}/v1/chat/completions`;
  }
  throw new Error(`provider "${providerId}" has no explicit built-in endpoint`);
}

export function getExplicitBuiltinKey(providerId, env = process.env) {
  if (providerId === "openrouter") {
    const key = env.OPENROUTER_API_KEY;
    return typeof key === "string" && key.trim() ? key.trim() : storedOpenRouterKey();
  }
  if (providerId === "ollama") {
    const key = env.OLLAMA_API_KEY;
    return typeof key === "string" && key.trim() ? key.trim() : "ollama";
  }
  return null;
}

export function isOpenRouterAvailable(model = "") {
  return Boolean(getOpenRouterKey(model));
}
