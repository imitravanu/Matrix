import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listSessions, sessionsDir } from "../lib/session.mjs";
import { makeTempDir } from "./helpers.mjs";

test("session metadata recovery remains covered across malformed records and sidecars", (t) => {
  const home = makeTempDir("matrix-session-coverage-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = sessionsDir(home);
  mkdirSync(directory, { recursive: true });

  const writeMain = (id, overrides = {}) => {
    writeFileSync(
      join(directory, `${id}.json`),
      JSON.stringify({ version: 1, id, savedAt: 1, cwd: null, history: [], ...overrides }),
    );
  };

  writeFileSync(join(directory, "array.json"), "[]");
  writeMain("wrong-id", { id: "different" });
  writeMain("bad-time", { savedAt: "now" });
  writeMain("bad-cwd", { cwd: 42 });

  writeMain("legacy");
  writeFileSync(join(directory, "legacy.meta.json"), "{ not JSON");
  writeMain("bad-version");
  writeFileSync(join(directory, "bad-version.meta.json"), "{}");
  writeMain("bad-dropped");
  writeFileSync(
    join(directory, "bad-dropped.meta.json"),
    JSON.stringify({
      version: 1,
      id: "bad-dropped",
      savedAt: 1,
      cwd: null,
      messages: 0,
      historyBytes: 2,
      droppedMessages: -1,
    }),
  );
  writeFileSync(join(directory, "orphan.meta.json"), "{}");

  const warnings = [];
  const listed = listSessions({ home, onWarning: (warning) => warnings.push(warning) });
  assert.deepEqual(listed.map((session) => session.id).sort(), [
    "bad-dropped",
    "bad-version",
    "legacy",
  ]);
  for (const code of [
    "session-malformed",
    "session-metadata-corrupt",
    "session-metadata-malformed",
    "session-metadata-orphaned",
  ]) {
    assert.ok(
      warnings.some((warning) => warning.code === code),
      code,
    );
  }
  assert.ok(warnings.every((warning) => warning.nonfatal));

  const recovered = listSessions({
    home,
    onWarning: () => {
      throw new Error("diagnostic callbacks are isolated");
    },
  });
  assert.deepEqual(recovered, listed);
});
