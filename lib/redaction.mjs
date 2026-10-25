// ============================================================================
// Shared, best-effort redaction for local logs and retained process output.
//
// Redaction is not a substitute for refusing to collect sensitive data. Audit
// records therefore use allowlisted fields and never include process output.
// Known credential values are also removed from transcript/run-log projections.
// ============================================================================

export const REDACTED = "[redacted]";

const SENSITIVE_ENV = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|PRIVATE)(?:_|$)/i;
const SENSITIVE_KEY_SUFFIX =
  /(?:apikey|token|secret|password|passwd|credentials?|authorization|auth|privatekey)$/i;

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

/**
 * Build a stateless redactor. Explicit values support isolated tests and
 * callers that received credentials somewhere other than process.env.
 */
export function createRedactor({ env = process.env, secretValues = [] } = {}) {
  const values = [...new Set([...secretValuesFromEnv(env), ...secretValues])]
    .filter((value) => typeof value === "string" && value.length >= 4)
    .sort((a, b) => b.length - a.length)
    .slice(0, 128);

  const text = (input) => {
    let output = String(input ?? "");
    for (const secret of values) output = output.split(secret).join(REDACTED);

    // Common transport, CLI, URL and JSON/config forms. These patterns are
    // deliberately secondary to known-value replacement and data allowlists.
    output = output
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
    return output;
  };

  return { text, values };
}
