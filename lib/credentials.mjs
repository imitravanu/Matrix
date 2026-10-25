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
  for (const dir of [".matrix"]) {
    try {
      const credPath = `${homedir()}/${dir}/credentials.json`;
      const creds = JSON.parse(readFileSync(credPath, "utf8"));
      const key = creds.openrouterApiKey ?? creds.apiKey ?? creds.matrixApiKey;
      if (typeof key === "string" && key.trim()) {
        return key.trim();
      }
    } catch {
      // Continue to next path
    }
  }
  return null;
}

export function isOpenRouterAvailable(model = "") {
  return Boolean(getOpenRouterKey(model));
}
