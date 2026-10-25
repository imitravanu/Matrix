import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  appendRunEvent,
  backupFile,
  listSessions,
  loadLatestSession,
  loadSession,
  matrixHome,
  newRunId,
  pruneBackups,
  pruneRunLogs,
  readBackup,
  removeBackup,
  retainTranscript,
  runsDir,
  saveSession,
  sessionsDir,
} from "../lib/session.mjs";
import { relativePath, resolveInside, writeFileAtomic } from "../lib/workspace.mjs";
import { makeTempDir } from "./helpers.mjs";

function tempHome(t) {
  const root = makeTempDir("matrix-home-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("saveSession, loadSession and loadLatestSession round-trip a transcript", (t) => {
  const home = tempHome(t);
  const cwd = "/tmp/example-workspace";
  const saved = saveSession(
    {
      id: "ses-test-1",
      cwd,
      project: { name: "example", fileCount: 2 },
      modelId: "local",
      history: [{ role: "user", content: "hello" }],
      tokenStats: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
      metrics: { elapsedMs: 42 },
      lastPatch: { file: "a.py", patch: "x" },
    },
    { home, now: 1234 },
  );
  assert.equal(saved.id, "ses-test-1");
  assert.ok(saved.path.endsWith("ses-test-1.json"));
  const loaded = loadSession("ses-test-1", { home });
  assert.equal(loaded.cwd, cwd);
  assert.equal(loaded.history[0].content, "hello");
  assert.equal(loaded.savedAt, 1234);
  assert.equal(loadSession("missing", { home }), null);
  assert.equal(loadSession("ses-test-1", { home, cwd })?.id, "ses-test-1");
  assert.equal(loadSession("ses-test-1", { home, cwd: "/tmp/other-workspace" }), null);
  assert.equal(loadSession("../ses-test-1", { home }), null);
  assert.equal(loadSession("..", { home }), null);
  assert.equal(loadLatestSession(cwd, { home })?.id, "ses-test-1");
  assert.equal(loadLatestSession("/tmp/other", { home }), null);
});

test("undoRun recovery entries and exact strings bypass transcript truncation", (t) => {
  const home = tempHome(t);
  const exact = `start-${"λ".repeat(8192)}-end`;
  const entries = Array.from({ length: 501 }, (_, index) => ({
    file: `file-${index}.txt`,
    absPath: `/tmp/workspace/file-${index}.txt`,
    original: index === 500 ? exact : `before-${index}`,
    updatedText: `after-${index}`,
    backupPath: `/tmp/backups/${index}`,
    isCreation: false,
  }));
  saveSession(
    {
      id: "recovery-bounds",
      cwd: "/tmp/workspace",
      history: Array.from({ length: 501 }, (_, index) => ({
        role: "user",
        content: `message-${index}`,
      })),
      lastPatch: { file: "stale.txt", original: "stale" },
      undoRun: { version: 1, runId: "run-complete", entries },
    },
    { home },
  );
  const loaded = loadSession("recovery-bounds", { home });
  assert.equal(loaded.history.length, 500, "transcript retention remains bounded");
  assert.equal(loaded.lastPatch, null, "new undo state does not keep a stale legacy projection");
  assert.equal(loaded.undoRun.entries.length, 501, "recovery entries are not transcript entries");
  assert.equal(loaded.undoRun.entries[500].original, exact);
});

test("listSessions sorts newest first and ignores corrupt records", async (t) => {
  const home = tempHome(t);
  saveSession({ id: "old", cwd: "/tmp/a", history: [] }, { home, now: 1000 });
  saveSession(
    { id: "new", cwd: "/tmp/b", history: [{ role: "user", content: "x" }] },
    { home, now: 2000 },
  );
  writeFileSync(join(sessionsDir(home), "corrupt.json"), "{ nope");
  const list = await awaitList(home);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "new");
  assert.equal(list[1].id, "old");
  assert.equal(list[0].messages, 1);
});

function awaitList(home) {
  // listSessions is synchronous; this wrapper keeps the test readable.
  return import("../lib/session.mjs").then(({ listSessions }) => listSessions({ home }));
}

test("backupFile stores exact bytes, backups are private, and remove is safe", (t) => {
  const root = tempHome(t);
  const file = join(root, "source.py");
  writeFileSync(file, "original\n");
  chmodSync(file, 0o640);
  const backup = backupFile(file, { home: root });
  assert.ok(backup.path);
  assert.equal(backup.size, 9);
  assert.equal((statSync(backup.path).mode & 0o777).toString(8), "600");
  assert.equal(readBackup(backup.path).content.toString(), "original\n");
  removeBackup(backup.path);
  assert.equal(readBackup(backup.path).ok, false);
  assert.equal(backupFile(join(root, "missing"), { home: root }), null);
});

test("appendRunEvent writes one valid JSON object per line and never throws", (t) => {
  const home = tempHome(t);
  const file = appendRunEvent("run-1", { type: "proposal", file: "x.py" }, { home });
  appendRunEvent("run-1", { type: "applied", file: "x.py" }, { home });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, "proposal");
  assert.equal(JSON.parse(lines[1]).type, "applied");
  assert.equal(
    appendRunEvent("run-2", { type: "x", fn: () => {} }, { home }).endsWith(".jsonl"),
    true,
  );
});

test("run logs are private, bounded, valid JSON and redact fake secret values", (t) => {
  const home = tempHome(t);
  const path = join(runsDir(home), "private.jsonl");
  mkdirSync(runsDir(home), { recursive: true });
  writeFileSync(path, "");
  chmodSync(path, 0o644);
  const sentinel = "fake-run-log-secret-SEC001";
  const written = appendRunEvent(
    "private",
    {
      type: "result",
      message: `provider echoed ${sentinel}`,
      nested: { apiKey: "fake-api-key", text: sentinel },
    },
    { home, secretValues: [sentinel] },
  );
  assert.equal(written, path);
  const text = readFileSync(path, "utf8");
  assert.equal(text.includes(sentinel), false);
  assert.equal(text.includes("fake-api-key"), false);
  assert.match(text, /\[redacted\]/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(text.trim()).type, "result");

  appendRunEvent(
    "bounded",
    { type: "result", payload: "x".repeat(10000) },
    {
      home,
      retention: { maxEventBytes: 2048 },
    },
  );
  const boundedText = readFileSync(join(runsDir(home), "bounded.jsonl"), "utf8");
  assert.ok(Buffer.byteLength(boundedText) <= 2048);
  assert.equal(JSON.parse(boundedText.trim()).truncated, true);
  assert.equal(appendRunEvent("../escape", { type: "result" }, { home }), null);
});

test("session transcript redaction and run-log retention never alter exact undo recovery", (t) => {
  const home = tempHome(t);
  const sentinel = "fake-session-secret-SEC001";
  const source = join(home, "source.txt");
  writeFileSync(source, "before\n");
  const backup = backupFile(source, { home });
  const undoRun = {
    version: 1,
    runId: "run-recovery",
    entries: [
      {
        file: "source.txt",
        absPath: source,
        original: sentinel,
        updatedText: "after\n",
        backupPath: backup.path,
        isCreation: false,
      },
    ],
  };
  const saved = saveSession(
    {
      id: "private-recovery",
      cwd: home,
      history: [{ role: "user", content: `do not retain ${sentinel}` }],
      undoRun,
    },
    { home, secretValues: [sentinel] },
  );
  const loaded = loadSession(saved.id, { home });
  assert.equal(loaded.history[0].content.includes(sentinel), false);
  assert.equal(
    loaded.undoRun.entries[0].original,
    sentinel,
    "recovery bytes are not a redacted transcript projection",
  );
  assert.equal(statSync(saved.path).mode & 0o777, 0o600);

  for (let index = 0; index < 5; index++) {
    appendRunEvent(`run-${index}`, { type: "done" }, { home, retention: { maxFiles: 2 } });
  }
  assert.equal(readdirSync(runsDir(home)).filter((name) => name.endsWith(".jsonl")).length, 2);
  pruneRunLogs({ home, maxFiles: 100, maxTotalBytes: 1 });
  assert.equal(existsSync(backup.path), true);
  assert.equal(readBackup(backup.path).ok, true);
  assert.equal(loadSession(saved.id, { home }).undoRun.entries[0].backupPath, backup.path);
});

test("600-message live and persisted retention keeps the newest records within count and byte budgets", (t) => {
  const home = tempHome(t);
  const history = Array.from({ length: 600 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index}-${"x".repeat(512)}`,
  }));

  const countOnly = retainTranscript(history, { maxEntries: 500, maxBytes: 1024 * 1024 });
  assert.equal(countOnly.history.length, 500);
  assert.equal(countOnly.history[0].id, "message-100");
  assert.equal(countOnly.history.at(-1).id, "message-599");

  const options = { maxEntries: 500, maxBytes: 32 * 1024 };
  const live = retainTranscript(history, options);
  assert.ok(live.history.length < 500, "the byte budget is exercised independently");
  assert.ok(live.bytes <= options.maxBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(live.history)), live.bytes);
  assert.equal(live.history.at(-1).id, "message-599");
  assert.equal(live.history[0].id, `message-${600 - live.history.length}`);
  assert.equal(live.dropped, 600 - live.history.length);

  const oversized = retainTranscript([{ id: "huge", role: "user", content: "λ".repeat(20_000) }], {
    maxEntries: 500,
    maxBytes: 256,
  });
  assert.ok(oversized.bytes <= 256);
  assert.equal(oversized.history[0].id, "huge");
  assert.equal(oversized.history[0].truncated, true);
  assert.equal(oversized.truncatedRecords, 1);

  const saved = saveSession(
    { id: "six-hundred", cwd: "/tmp/six-hundred", history },
    { home, retention: { historyEntries: options.maxEntries, historyBytes: options.maxBytes } },
  );
  const loaded = loadSession(saved.id, { home });
  assert.deepEqual(loaded.history, live.history);
  assert.equal(loaded.historyRetention.bytes, live.bytes);
  assert.equal(loaded.historyRetention.dropped, live.dropped);
  assert.equal(loaded.historyRetention.retained, live.history.length);
});

test("1,000 large sessions list from metadata without parsing full transcripts", (t) => {
  const home = tempHome(t);
  for (let index = 0; index < 1000; index++) {
    saveSession(
      {
        id: `bulk-${String(index).padStart(4, "0")}`,
        cwd: `/tmp/bulk-${index % 7}`,
        project: { name: "bulk" },
        modelId: "local",
        history: [{ role: "user", content: "λ".repeat(16 * 1024) }],
      },
      { home, now: index + 1 },
    );
  }
  const names = readdirSync(sessionsDir(home));
  const transcripts = names.filter(
    (name) => name.endsWith(".json") && !name.endsWith(".meta.json"),
  );
  assert.equal(transcripts.length, 1000);
  assert.equal(names.filter((name) => name.endsWith(".meta.json")).length, 1000);
  assert.ok(statSync(join(sessionsDir(home), "bulk-0000.meta.json")).size < 4096);

  // Valid sidecars are authoritative for the picker. Poison every full record
  // so any implementation that parses transcripts cannot produce this list.
  for (const name of transcripts) writeFileSync(join(sessionsDir(home), name), "{ not JSON");
  const warnings = [];
  const list = listSessions({ home, onWarning: (warning) => warnings.push(warning) });
  assert.equal(list.length, 1000);
  assert.equal(list[0].id, "bulk-0999");
  assert.equal(list[0].messages, 1);
  assert.ok(list[0].historyBytes > 16 * 1024);
  assert.equal(list[0].droppedMessages, 0);
  assert.deepEqual(warnings, []);
});

test("event payload arrays retain the newest entries and every serialized event obeys its byte cap", (t) => {
  const home = tempHome(t);
  const path = appendRunEvent(
    "event-bounds",
    {
      type: "delta",
      payload: Array.from({ length: 600 }, (_, index) => ({ index, text: `event-${index}` })),
    },
    { home },
  );
  const record = JSON.parse(readFileSync(path, "utf8").trim());
  assert.equal(record.payload.length, 500);
  assert.equal(record.payload[0].index, 100);
  assert.equal(record.payload.at(-1).index, 599);

  const boundedPath = appendRunEvent(
    "event-bytes",
    {
      type: "result",
      payload: "λ".repeat(20_000),
    },
    { home, retention: { maxEventBytes: 2048 } },
  );
  for (const line of readFileSync(boundedPath, "utf8").trim().split("\n")) {
    assert.ok(Buffer.byteLength(line) + 1 <= 2048);
    assert.equal(JSON.parse(line).truncated, true);
  }
});

test("corrupt, malformed and missing records produce nonfatal structured warnings", (t) => {
  const home = tempHome(t);
  const cwd = "/tmp/session-warnings";
  const valid = saveSession({ id: "valid", cwd, history: [] }, { home, now: 100 });
  writeFileSync(join(sessionsDir(home), "corrupt.json"), "{ nope");
  writeFileSync(
    join(sessionsDir(home), "malformed.json"),
    JSON.stringify({
      version: 1,
      id: "malformed",
      savedAt: 200,
      cwd,
      history: "not-an-array",
    }),
  );
  writeFileSync(
    join(sessionsDir(home), "unsupported.json"),
    JSON.stringify({
      version: 2,
      id: "unsupported",
      savedAt: 300,
      cwd,
      history: [],
    }),
  );

  const listedWarnings = [];
  const list = listSessions({ home, onWarning: (warning) => listedWarnings.push(warning) });
  assert.deepEqual(
    list.map((session) => session.id),
    ["valid"],
  );
  assert.ok(listedWarnings.every((warning) => warning.nonfatal && warning.operation === "list"));
  assert.ok(listedWarnings.some((warning) => warning.code === "session-corrupt"));
  assert.ok(listedWarnings.some((warning) => warning.code === "session-malformed"));
  assert.ok(listedWarnings.some((warning) => warning.code === "session-unsupported-version"));

  for (const [id, code] of [
    ["corrupt", "session-corrupt"],
    ["malformed", "session-malformed"],
    ["missing", "session-not-found"],
  ]) {
    const warnings = [];
    assert.equal(loadSession(id, { home, onWarning: (warning) => warnings.push(warning) }), null);
    assert.equal(warnings[0]?.code, code);
    assert.equal(warnings[0]?.nonfatal, true);
  }

  // A valid metadata index must not hide a full-record resume failure.
  writeFileSync(valid.path, "{ broken after indexing");
  const resumeWarnings = [];
  assert.equal(
    loadLatestSession(cwd, { home, onWarning: (warning) => resumeWarnings.push(warning) }),
    null,
  );
  assert.ok(resumeWarnings.some((warning) => warning.code === "session-corrupt"));
});

test("save and list I/O failures return structured warnings instead of throwing", (t) => {
  const home = tempHome(t);
  writeFileSync(sessionsDir(home), "not a directory");
  const callbackWarnings = [];
  const onWarning = (warning) => callbackWarnings.push(warning);
  const saved = saveSession(
    { id: "cannot-save", cwd: "/tmp/nope", history: [] },
    { home, onWarning },
  );
  assert.equal(saved.ok, false);
  assert.equal(saved.id, "cannot-save");
  assert.equal(saved.warnings[0].code, "session-save-failed");
  assert.equal(saved.warnings[0].nonfatal, true);
  assert.equal(callbackWarnings[0], saved.warnings[0]);

  const listedWarnings = [];
  assert.deepEqual(
    listSessions({ home, onWarning: (warning) => listedWarnings.push(warning) }),
    [],
  );
  assert.equal(listedWarnings[0].code, "session-list-failed");
  assert.equal(listedWarnings[0].nonfatal, true);
});

test("run-log and backup retention preserve every recovery reference", (t) => {
  const home = tempHome(t);
  const makeBackup = (name) => {
    const source = join(home, `${name}.txt`);
    writeFileSync(source, `${name}-exact-bytes\n`);
    return backupFile(source, { home }).path;
  };
  const requiredBackup = makeBackup("required");
  const legacyBackup = makeBackup("legacy");
  const staleBackup = makeBackup("stale");
  const undoRun = {
    version: 1,
    runId: "required-run",
    entries: [
      {
        file: "required.txt",
        absPath: join(home, "required.txt"),
        original: "required-exact-bytes\n",
        updatedText: "after\n",
        backupPath: requiredBackup,
        isCreation: false,
      },
    ],
  };
  saveSession({ id: "required", cwd: home, history: [], undoRun }, { home, now: 100 });
  saveSession(
    {
      id: "legacy",
      cwd: home,
      history: [],
      lastPatch: {
        file: "legacy.txt",
        absPath: join(home, "legacy.txt"),
        backupPath: legacyBackup,
      },
    },
    { home, now: 200 },
  );
  appendRunEvent("required-run", { type: "applied" }, { home });
  appendRunEvent("stale-run", { type: "done" }, { home });

  const prunedBackups = pruneBackups({ home, maxFiles: 1, maxTotalBytes: 1 });
  assert.equal(prunedBackups.removed, 1);
  assert.equal(readBackup(requiredBackup).content.toString(), "required-exact-bytes\n");
  assert.equal(readBackup(legacyBackup).content.toString(), "legacy-exact-bytes\n");
  assert.equal(existsSync(staleBackup), false);
  assert.deepEqual(loadSession("required", { home }).undoRun, undoRun);

  const prunedRuns = pruneRunLogs({ home, maxFiles: 1, maxTotalBytes: 1 });
  assert.equal(prunedRuns.removed, 1);
  assert.equal(existsSync(join(runsDir(home), "required-run.jsonl")), true);
  assert.equal(existsSync(join(runsDir(home), "stale-run.jsonl")), false);

  // An unreadable session may contain another recovery reference. Fail closed
  // rather than reclaiming any currently unreferenced backup.
  const unknownBackup = makeBackup("unknown");
  writeFileSync(join(sessionsDir(home), "unknown.json"), "{ unreadable");
  const warnings = [];
  const skipped = pruneBackups({
    home,
    maxFiles: 1,
    maxTotalBytes: 1,
    onWarning: (warning) => warnings.push(warning),
  });
  assert.equal(skipped.removed, 0);
  assert.equal(existsSync(unknownBackup), true);
  assert.ok(warnings.some((warning) => warning.code === "session-retention-scan-failed"));
});

test("newRunId and matrixHome are stable, safe strings", () => {
  assert.match(newRunId(0), /^19700101000000-[0-9a-f]{6}$/);
  assert.equal(matrixHome("/tmp/example"), "/tmp/example");
  assert.match(matrixHome(), /[\\/]\.matrix$/);
});

test("resolveInside allows descendants and rejects traversal, absolute escapes and symlinks", (t) => {
  const root = tempHome(t);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.py"), "x\n");
  const inside = resolveInside(root, "src/a.py");
  assert.equal(inside.ok, true);
  assert.equal(inside.rel, "src/a.py");
  assert.equal(resolveInside(root, "./src/../src/a.py").ok, true);
  assert.equal(resolveInside(root, "../outside.py").ok, false);
  assert.equal(resolveInside(root, "/etc/passwd").ok, false);
  symlinkSync("/etc/passwd", join(root, "escape"));
  assert.equal(resolveInside(root, "escape").ok, false);
  assert.equal(resolveInside(root, "").ok, false);
});

test("writeFileAtomic preserves an existing mode and leaves no temp files", (t) => {
  const root = tempHome(t);
  const file = join(root, "a.txt");
  writeFileSync(file, "old");
  chmodSync(file, 0o640);
  writeFileAtomic(file, "new");
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.equal((statSync(file).mode & 0o777).toString(8), "640");
  assert.deepEqual(
    readdirSync(root).filter((name) => name.includes(".tmp")),
    [],
  );
  assert.equal(relativePath(root, file), "a.txt");
});
