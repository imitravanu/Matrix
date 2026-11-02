// ============================================================================
// Shared, best-effort redaction for local logs and retained process output.
//
// Redaction is not a substitute for refusing to collect sensitive data. Audit
// records therefore use allowlisted fields and never include process output.
// Known credential values are also removed from transcript/run-log projections.
//
// Providers echo credentials in encodings they choose, not the one we sent, so
// every secret is expanded to its supported textual forms before matching. When
// an unknown encoding still leaves a recognisable fragment, the surrounding
// untrusted text is withheld rather than displayed.
// ============================================================================

export const REDACTED = "[redacted]";
export const WITHHELD = "[provider detail withheld]";

const SENSITIVE_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PRIVATE)(?:_|$)/i;
const SENSITIVE_KEY_SUFFIX =
  /(?:apikey|token|secret|password|passwd|credentials?|authorization|auth|privatekey)$/i;

/** Values shorter than this are matched as whole tokens, never substrings. */
const LITERAL_SUBSTRING_MIN = 4;
/** A surviving run this long proves the text still carries key material. */
const FRAGMENT_MIN_RUN = 4;
const MAX_SECRET_VALUES = 128;
const MAX_VARIANTS_PER_SECRET = 12;

export function isSensitiveEnvName(key) {
  return SENSITIVE_ENV.test(String(key ?? ""));
}

export function isSensitiveKey(key) {
  const normalized = String(key ?? "").replace(/[-_]/g, "");
  return SENSITIVE_KEY_SUFFIX.test(normalized);
}

/** Gather only credential-like environment values; never retain the environment itself. */
export function secretValuesFromEnv(env = process.env) {
  const values = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (isSensitiveEnvName(key) && typeof value === "string" && value.length > 0)
      values.push(value);
  }
  return values;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addVariant(set, value) {
  if (typeof value === "string" && value.length > 0) set.add(value);
}

/**
 * Textual forms a provider may echo for one credential: the literal value,
 * percent-encoding, JSON escaping and the base64/base64url encodings of both
 * the bare credential and its `Bearer <credential>` header form.
 */
export function secretVariants(secret) {
  if (typeof secret !== "string" || secret.length === 0) return [];
  const variants = new Set();
  addVariant(variants, secret);
  try {
    addVariant(variants, encodeURIComponent(secret));
    addVariant(variants, encodeURI(secret));
  } catch {
    // Lone surrogates cannot be encoded; the literal form still applies.
  }
  try {
    addVariant(variants, JSON.stringify(secret).slice(1, -1));
  } catch {
    // Non-serializable values are not credentials.
  }
  for (const form of [secret, `Bearer ${secret}`]) {
    const base64 = Buffer.from(form, "utf8").toString("base64");
    addVariant(variants, base64);
    addVariant(variants, base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  }
  // Percent-encoding hex digits are case-insensitive; add the lowercase form.
  for (const value of [...variants]) {
    addVariant(
      variants,
      value.replace(/%[0-9a-f]{2}/gi, (match) => match.toLowerCase()),
    );
  }

  const ordered = [...variants].sort((a, b) => b.length - a.length);
  return ordered.slice(0, MAX_VARIANTS_PER_SECRET);
}

function replaceForm(text, value) {
  if (value.length >= LITERAL_SUBSTRING_MIN) return text.split(value).join(REDACTED);
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(value)}(?![A-Za-z0-9])`, "g");
  return text.replace(pattern, REDACTED);
}

/** Apply the transport, CLI, URL and JSON/config credential patterns. */
export function redactPatterns(input) {
  return String(input ?? "")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/(\b[a-z][a-z\d+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${REDACTED}@`)
    .replace(
      /(--?(?:api[-_]?key|token|secret|password|passwd|auth)(?:=|\s+))([^\s]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization)["']?\s*[:=]\s*)(["']))([^"']*)(\2)/gi,
      `$1${REDACTED}$4`,
    )
    .replace(
      /(\b[A-Z\d_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PRIVATE)[A-Z\d_]*=)([^\s]+)/g,
      `$1${REDACTED}`,
    );
}

/** Remove every supported form of `secrets` from `text`. */
export function redactSecrets(text, secrets = []) {
  let output = String(text ?? "");
  const values = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  for (const secret of values) {
    for (const variant of secretVariants(secret)) output = replaceForm(output, variant);
  }
  return redactPatterns(output);
}

/** True when any run of the secret survives, which means the encoding is unknown. */
export function containsSecretFragment(text, secret, { minRun = FRAGMENT_MIN_RUN } = {}) {
  if (typeof secret !== "string" || secret.length < minRun) return false;
  const haystack = String(text ?? "");
  if (haystack.length < minRun) return false;
  for (let index = 0; index + minRun <= secret.length; index++) {
    if (haystack.includes(secret.slice(index, index + minRun))) return true;
  }
  return false;
}

/** Bound display text. Redaction must already have happened. */
export function truncateText(text, maxChars = 160) {
  const value = String(text ?? "");
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 0;
  if (value.length <= limit) return value;
  return limit === 0 ? "" : value.slice(0, limit);
}

/**
 * Redact untrusted provider text with every known credential, then bound it for
 * display. If a recognisable fragment survives, the whole detail is withheld:
 * an unknown encoding must not become a partial credential leak.
 */
export function redactedDetail(text, { secrets = [], maxChars = 160, withheld = WITHHELD } = {}) {
  const values = (Array.isArray(secrets) ? secrets : [secrets]).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  const redacted = redactSecrets(text, values);
  // Ignore the marker itself: its own letters are not key material.
  const residual = redacted.split(REDACTED).join("\u0000");
  if (values.some((secret) => containsSecretFragment(residual, secret))) return withheld;
  return truncateText(redacted, maxChars);
}

/**
 * Build a stateless redactor. Explicit values support isolated tests and
 * callers that received credentials somewhere other than process.env. Explicit
 * values keep short credentials; environment scanning requires four characters
 * so single-letter values cannot erase ordinary words.
 */
export function createRedactor({ env = process.env, secretValues = [] } = {}) {
  const envValues = secretValuesFromEnv(env).filter(
    (value) => value.length >= LITERAL_SUBSTRING_MIN,
  );
  const explicitValues = (Array.isArray(secretValues) ? secretValues : [secretValues]).filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  const values = [...new Set([...envValues, ...explicitValues])]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_SECRET_VALUES);

  return { text: (input) => redactSecrets(input, values), values };
}
