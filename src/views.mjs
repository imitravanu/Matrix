// Shared navigation and structural-source definitions. Keep these lists free of
// UI/runtime imports so render-only and CLI consumers use the same contracts.

export const SCREENS = ["empty", "chat", "permission", "swarm", "scope", "vision"];
export const PRIMARY_VIEWS = SCREENS;
export const ALL_VIEWS = [...SCREENS, "model", "help"];

export const DEFAULT_SCOPE_EXTENSIONS = new Set([
  ".py",
  ".pyi",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".rs",
  ".go",
  ".rb",
]);

export const SCOPE_LANGUAGES = new Set(["python", "javascript", "rust", "go", "ruby"]);

export function normalizeViewModel(screen) {
  if (screen === "ast") return "scope";
  if (screen === "perm") return "permission";
  return screen;
}

export function scopeFilesFor(project) {
  if (!project) return [];
  return project.files
    .filter((file) => file.size < 220_000)
    .filter((file) => DEFAULT_SCOPE_EXTENSIONS.has(file.ext) || SCOPE_LANGUAGES.has(file.language))
    .map((file) => file.rel)
    .slice(0, 400);
}
