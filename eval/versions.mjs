import { createHash } from "node:crypto";

export const EVAL_SCHEMA_VERSION = 1;
export const EVAL_FIXTURE_VERSION = 1;
export const EVAL_BASELINE_VERSION = 1;
export const EVAL_NAME = "matrix-agent-evaluation";

export const EVIDENCE_CLASS = Object.freeze({
  LOCAL: "local-forge",
  MOCKED_REMOTE: "mocked-remote-policy",
});

/** Stable JSON used for fixture identity and baseline provenance, not report timing. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function fixtureDigest(definitions) {
  const identity = definitions.map((definition) => ({
    id: definition.id,
    profiles: definition.profiles,
    evidenceClass: definition.evidenceClass,
    task: definition.task,
    model: definition.model,
    fixture: definition.fixture,
    scenario: definition.scenario,
    approval: definition.approval,
    recovery: definition.recovery,
    expect: definition.expect,
  }));
  return sha256(canonicalJson(identity));
}
