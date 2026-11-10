import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  GOAL_DEFAULT_BUDGET,
  GOAL_LIMITS,
  canonicalJson,
  encodeJournalRecord,
  newGoalId,
  sealJournalRecord,
} from "../lib/goal-contracts.mjs";
import { createGoalStore } from "../lib/goal-store.mjs";
import { withGoalLock } from "../lib/goal-lock.mjs";

const linux = { skip: process.platform !== "linux" };
const hash = "a".repeat(64);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fence = ({ id, sequence, generation }) => ({ goalId: id, sequence, generation });
const zeros = { rounds: 0, tools: 0, requests: 0, activeMs: 0 };
const charge = { ...zeros, tools: 1 };

function authority(lock, snapshot) {
  return { lock, fence: fence(snapshot.goal), leaseId: snapshot.lease.leaseId };
}

function editIntent(snapshot, before, after) {
  const image = (bytes) => ({ exists: true, sha256: sha(bytes), mode: 0o644, blob: sha(bytes) });
  const { goal, lease } = snapshot;
  return {
    schemaVersion: 1,
    goalId: goal.id,
    attemptId: lease.attemptId,
    generation: goal.generation,
    operationId: newGoalId("operation"),
    kind: "edit",
    arguments: { sha256: hash, blob: null },
    planHash: hash,
    authority: {
      kind: "edit",
      planHash: hash,
      decisionId: newGoalId("decision"),
      scope: "operation",
    },
    workspace: goal.workspace,
    preconditions: { files: [{ path: "target", exists: true, sha256: sha(before) }] },
    edit: { path: "target", before: image(before), after: image(after) },
    reservation: charge,
    state: "prepared",
  };
}

function editReceipt(intent, snapshot, after) {
  return {
    schemaVersion: 1,
    goalId: intent.goalId,
    attemptId: intent.attemptId,
    generation: intent.generation,
    operationId: intent.operationId,
    sequence: snapshot.goal.sequence + 1,
    status: "succeeded",
    evidence: [],
    files: [{ path: "target", state: "matches-after", sha256: sha(after) }],
    process: null,
    usage: charge,
    uncertainty: { kind: "none", detail: null },
  };
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "matrix-goal-store-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const identity = statSync(workspace, { bigint: true });
  const record = {
    schemaVersion: 1,
    id: newGoalId(),
    createdAt: 1,
    objective: "Verify the goal store",
    workspace: {
      path: workspace,
      device: String(identity.dev),
      inode: String(identity.ino),
      revision: null,
      manifest: hash,
    },
    provider: { id: "local", modelId: "local", digest: hash },
    state: "ready",
    generation: 0,
    sequence: 0,
    criteria: [{ id: newGoalId("criterion"), revision: 1, kind: "test", planHash: hash }],
    budget: { ...GOAL_DEFAULT_BUDGET },
    operations: [],
  };
  const root = join(home, "goals");
  const directory = join(root, record.id);
  return {
    home,
    workspace,
    root,
    directory,
    record,
    store: createGoalStore(home),
    journal: join(directory, "journal.jsonl"),
    checkpoint: join(directory, "checkpoint.json"),
  };
}

test("fresh goals publish private synced metadata and one committed journal frame", linux, (t) => {
  const { store, record, root, directory, journal, checkpoint, home } = fixture(t);
  assert.throws(() => store.inspect(record.id), { code: "ENOENT" });
  assert.equal(existsSync(root), false, "inspection does not create state");
  assert.throws(() => store.create({ ...record, generation: 1 }), /fresh ready goal/);
  assert.equal(existsSync(root), false, "invalid creation does not create state");
  const created = store.create(record);
  assert.equal(record.sequence, 0);
  const reopened = createGoalStore(home).inspect(record.id);
  assert.deepEqual(reopened.goal, { ...record, sequence: 1 });
  assert.deepEqual(reopened.goal, created);
  assert.equal(reopened.journal.count, 1);
  assert.equal(reopened.uncommittedBytes, 0);
  assert.deepEqual(readdirSync(root).sort(), [".store.lock", record.id]);
  for (const path of [root, directory]) assert.equal(statSync(path).mode & 0o777, 0o700);
  for (const path of [journal, checkpoint]) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(
    () => store.create({ ...record, objective: "must never replace" }),
    /already exists/,
  );
  assert.deepEqual(store.inspect(record.id), reopened);
});

test(
  "inspection preserves an uncommitted tail and refuses corrupt or missing committed bytes",
  linux,
  (t) => {
    const { store, record, journal, checkpoint } = fixture(t);
    store.create(record);
    const originalJournal = readFileSync(journal);
    const baseline = store.inspect(record.id);
    const tail = Buffer.from('{"partial":');
    appendFileSync(journal, tail);
    assert.deepEqual(store.inspect(record.id), { ...baseline, uncommittedBytes: tail.length });
    assert.deepEqual(readFileSync(journal), Buffer.concat([originalJournal, tail]));

    const corrupt = Buffer.from(originalJournal.toString().replace('"ready"', '"stale"'));
    writeFileSync(journal, corrupt);
    assert.throws(() => store.inspect(record.id), /journal checksum mismatch/);
    assert.deepEqual(readFileSync(journal), corrupt);
    writeFileSync(journal, originalJournal.subarray(0, -1));
    assert.throws(() => store.inspect(record.id), /committed journal bytes are missing/);

    writeFileSync(journal, originalJournal);
    const originalCheckpoint = readFileSync(checkpoint, "utf8");
    writeFileSync(
      checkpoint,
      originalCheckpoint.replace("Verify the goal store", "Tampered objective"),
    );
    assert.throws(() => store.inspect(record.id), /checkpoint bytes or checksum mismatch/);
  },
);

test("inspection refuses unsafe state paths, file types, modes and sizes", linux, (t) => {
  const { store, record, journal, directory, root, home } = fixture(t);
  store.create(record);
  const baseline = readFileSync(journal);
  const outside = join(home, "outside");
  writeFileSync(outside, "preserve", { mode: 0o600 });
  rmSync(journal);
  symlinkSync(outside, journal);
  assert.throws(() => store.inspect(record.id), { code: "ELOOP" });
  assert.equal(readFileSync(outside, "utf8"), "preserve");
  rmSync(journal);

  const fifo = spawnSync("mkfifo", ["-m", "600", journal], { timeout: 2000 });
  assert.equal(fifo.status, 0, String(fifo.error ?? fifo.stderr));
  assert.throws(() => store.inspect(record.id), /state must be a regular file/);
  rmSync(journal);
  writeFileSync(journal, baseline, { mode: 0o644 });
  assert.throws(() => store.inspect(record.id), /state must be private/);
  chmodSync(journal, 0o600);
  truncateSync(journal, GOAL_LIMITS.journalBytes + 1);
  assert.throws(() => store.inspect(record.id), /state exceeds its byte limit/);

  const alias = newGoalId();
  symlinkSync(directory, join(root, alias));
  assert.throws(() => store.inspect(alias), { code: "ENOTDIR" });
  assert.throws(() => store.inspect("../outside"), /invalid ID/);
  const homeAlias = join(home, "alias");
  symlinkSync(home, homeAlias);
  assert.throws(() => createGoalStore(homeAlias).inspect(record.id), { code: "ENOTDIR" });
});

test("a journal sync failure is propagated without publishing a checkpoint", linux, (t) => {
  const { store, record, root, directory } = fixture(t);
  const sync = fs.fsyncSync;
  const failure = Object.assign(new Error("synthetic journal sync failure"), { code: "EIO" });
  const override = t.mock.method(fs, "fsyncSync", (fd) => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`).includes("/.matrix-integration-")) throw failure;
    return sync(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => store.create(record),
      (error) => error === failure,
    );
  } finally {
    override.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(directory), false);
  const stage = readdirSync(root).find((name) => name.startsWith(".new-goal-"));
  assert.match(stage, /^\.new-goal-/);
  assert.deepEqual(readdirSync(join(root, stage)), []);
  assert.equal(store.create(record).sequence, 1);
});

test(
  "SIGKILL before goal publication leaves no visible goal and a retry publishes cleanly",
  { ...linux, timeout: 10_000 },
  async (t) => {
    const { home, root, store, record, directory } = fixture(t);
    const worker = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const [url, home, record] = process.argv.slice(1);
    const goal = JSON.parse(record);
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to.endsWith("/" + goal.id)) {
        fs.writeSync(1, "before publication\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
      }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const { createGoalStore } = await import(url);
    createGoalStore(home).create(goal);
    `,
        new URL("../lib/goal-store.mjs", import.meta.url).href,
        home,
        JSON.stringify(record),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const closed = once(worker, "exit");
    t.after(async () => {
      worker.kill("SIGKILL");
      await closed;
    });
    const [marker] = await Promise.race([
      once(worker.stdout, "data"),
      closed.then(([code, signal]) => {
        throw new Error(`worker exited before barrier: ${code}/${signal}`);
      }),
    ]);
    assert.equal(marker.toString(), "before publication\n");
    worker.kill("SIGKILL");
    assert.deepEqual(await closed, [null, "SIGKILL"]);
    assert.equal(existsSync(directory), false);
    assert.throws(() => store.inspect(record.id), { code: "ENOENT" });
    const staged = readdirSync(root).find((name) => name.startsWith(".new-goal-"));
    assert.match(staged, /^\.new-goal-/);
    assert.deepEqual(readdirSync(join(root, staged)).sort(), ["checkpoint.json", "journal.jsonl"]);
    store.create(record);
    assert.equal(store.inspect(record.id).goal.sequence, 1);
    assert.ok(existsSync(join(root, staged)), "inspection and retry preserve interrupted staging");
    assert.equal(store.cleanupStaging(), 1);
    assert.equal(store.inspect(record.id).goal.sequence, 1);
  },
);

test("intent, dispatch and receipt retain exact images and a durable budget ledger", linux, (t) => {
  const { store, workspace, record, directory } = fixture(t);
  const id = record.id;
  const created = store.create(record);
  const before = Buffer.from("before\r\nwithout newline");
  const after = Buffer.from("after\r\n");
  withGoalLock(workspace, (lock) => {
    const started = store.beginAttempt(id, { lock, fence: fence(created) });
    assert.equal(started.goal.generation, 1);
    const intent = editIntent(started, before, after);
    const opened = createGoalStore(join(workspace, "..", "."));
    assert.throws(
      () => opened.append(id, authority(lock, started), "intent", intent, { blobs: [before] }),
      /required recovery blob is missing/,
    );
    const prepared = opened.append(id, authority(lock, started), "intent", intent, {
      blobs: [before, after],
    });
    assert.equal(prepared.counters.reserved.tools, 1);
    assert.equal(store.inspectPrevious(id).goal.sequence, started.goal.sequence);
    assert.deepEqual(store.readBlob(id, sha(before)), before);
    assert.deepEqual(store.readBlob(id, sha(after)), after);
    assert.throws(
      () => store.append(id, authority(lock, started), "intent", intent),
      /stale fence/,
    );
    const dispatched = store.append(id, authority(lock, prepared), "dispatch", {
      ...intent,
      state: "dispatched",
    });
    const receipt = editReceipt(intent, dispatched, after);
    const settled = opened.append(id, authority(lock, dispatched), "receipt", receipt);
    assert.deepEqual(settled.counters, { used: charge, reserved: zeros });
    assert.deepEqual(
      store.readJournal(id).map((entry) => entry.kind),
      ["state", "attempt", "intent", "dispatch", "receipt"],
    );
    const paused = store.transition(id, authority(lock, settled), "paused");
    assert.equal(paused.lease, null);
    const resumed = opened.beginAttempt(id, { lock, fence: fence(paused.goal) });
    assert.equal(resumed.goal.generation, 2);
    assert.equal(resumed.goal.state, "reconciling");
    assert.deepEqual(resumed.counters, settled.counters);
    assert.throws(
      () => store.renew(id, { ...authority(lock, resumed), leaseId: started.lease.leaseId }),
      /stale or missing writer lease/,
    );
    const running = opened.transition(id, authority(lock, resumed), "running");
    assert.throws(
      () => store.append(id, authority(lock, running), "intent", intent),
      /stale intent generation/,
    );
  });
  const blob = join(directory, `blob_${sha(before)}`);
  writeFileSync(blob, "tampered");
  assert.throws(() => store.readBlob(id, sha(before)), /blob checksum mismatch/);
});

test("store mutations require the live workspace lock and refuse a replaced root", linux, (t) => {
  const { store, workspace, record } = fixture(t);
  const created = store.create(record);
  let expired;
  withGoalLock(workspace, (lock) => {
    expired = lock;
    assert.equal(
      spawnSync("flock", ["-n", `${workspace}.lock`, "true"], { timeout: 2000 }).status,
      1,
    );
    const old = `${workspace}.old`;
    renameSync(workspace, old);
    mkdirSync(workspace);
    assert.throws(
      () => store.beginAttempt(record.id, { lock, fence: fence(created) }),
      /workspace identity changed/,
    );
  });
  assert.throws(
    () => store.beginAttempt(record.id, { lock: expired, fence: fence(created) }),
    /held workspace lock is required/,
  );
  assert.equal(store.inspect(record.id).goal.sequence, created.sequence);
});

test("workspace goal listing finds path or directory-identity overlaps", linux, (t) => {
  const { store, home, record } = fixture(t);
  store.create(record);
  assert.deepEqual(
    store.listWorkspaceGoals(record.workspace).map((goal) => goal.id),
    [record.id],
  );
  const otherWorkspace = join(home, "workspace-other");
  mkdirSync(otherWorkspace);
  const otherIdentity = statSync(otherWorkspace, { bigint: true });
  const other = store.create({
    ...record,
    id: newGoalId(),
    workspace: {
      path: otherWorkspace,
      device: String(otherIdentity.dev),
      inode: String(otherIdentity.ino),
      revision: null,
      manifest: record.workspace.manifest,
    },
  });
  assert.deepEqual(
    store.listWorkspaceGoals(record.workspace).map((goal) => goal.id),
    [record.id],
  );
  assert.deepEqual(
    store.listWorkspaceGoals(other.workspace).map((goal) => goal.id),
    [other.id],
  );
  assert.deepEqual(
    store
      .listWorkspaceGoals({ ...record.workspace, path: join(home, "renamed") })
      .map((goal) => goal.id),
    [record.id],
    "the same directory remains associated after a rename",
  );
  assert.deepEqual(
    store.listWorkspaceGoals({ ...record.workspace, inode: "999999999999" }).map((goal) => goal.id),
    [record.id],
    "the same path remains protected after directory replacement",
  );
});

test(
  "partial journal write plus ENOSPC leaves the prior checkpoint and blocks further appends",
  linux,
  (t) => {
    const { store, workspace, record, journal } = fixture(t);
    const created = store.create(record);
    withGoalLock(workspace, (lock) => {
      const running = store.beginAttempt(record.id, { lock, fence: fence(created) });
      const original = readFileSync(journal);
      const write = fs.writeSync;
      let partial = false;
      const failure = Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
      const override = t.mock.method(fs, "writeSync", (fd, buffer, offset, length, position) => {
        if (fs.readlinkSync(`/proc/self/fd/${fd}`) === journal) {
          if (partial) throw failure;
          partial = true;
          return write(fd, buffer, offset, 9, position);
        }
        return write(fd, buffer, offset, length, position);
      });
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => store.renew(record.id, authority(lock, running)),
          (error) => error === failure,
        );
      } finally {
        override.mock.restore();
        syncBuiltinESMExports();
      }
      assert.deepEqual(readFileSync(journal).subarray(0, original.length), original);
      assert.deepEqual(store.inspect(record.id), { ...running, uncommittedBytes: 9 });
      assert.deepEqual(store.inspectPrevious(record.id), { ...running, uncommittedBytes: 9 });
      assert.throws(
        () => store.renew(record.id, authority(lock, running)),
        /uncommitted journal tail/,
      );
    });
  },
);

test(
  "quota blocks new work while preserving space for terminal metadata and exact blobs",
  linux,
  (t) => {
    const { store, workspace, record, root } = fixture(t);
    const created = store.create(record);
    const before = Buffer.from("recover me");
    const after = Buffer.from("preserved change");
    withGoalLock(workspace, (lock) => {
      const running = store.beginAttempt(record.id, { lock, fence: fence(created) });
      const prepared = store.append(
        record.id,
        authority(lock, running),
        "intent",
        editIntent(running, before, after),
        { blobs: [before, after] },
      );
      const pressure = join(root, "quota-pressure");
      writeFileSync(pressure, "", { mode: 0o600 });
      truncateSync(pressure, GOAL_LIMITS.storeBytes - 1024 * 1024);
      assert.throws(
        () => store.renew(record.id, authority(lock, prepared)),
        /store capacity exceeded/,
      );
      assert.throws(() => store.create({ ...record, id: newGoalId() }), /store capacity exceeded/);
      assert.equal(
        store.transition(record.id, authority(lock, prepared), "cancelled").goal.state,
        "cancelled",
      );
      assert.deepEqual(store.readBlob(record.id, sha(before)), before);
      assert.deepEqual(store.readBlob(record.id, sha(after)), after);
    });
  },
);

test("store quota protects pending receipts from another goal's writes", linux, (t) => {
  const { store, home, workspace, record, root } = fixture(t);
  const otherWorkspace = join(home, "other-workspace");
  mkdirSync(otherWorkspace);
  const { dev, ino } = statSync(otherWorkspace, { bigint: true });
  const other = store.create({
    ...record,
    id: newGoalId(),
    workspace: {
      ...record.workspace,
      path: otherWorkspace,
      device: String(dev),
      inode: String(ino),
    },
  });
  const created = store.create(record);
  const before = Buffer.from("preserve the original");
  const after = Buffer.from("preserve the edit");
  const metadata = 2 * GOAL_LIMITS.checkpointBytes + GOAL_LIMITS.journalRecordBytes + 1;
  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(record.id, { lock, fence: fence(created) });
    const intent = editIntent(running, before, after);
    const prepared = store.append(record.id, authority(lock, running), "intent", intent, {
      blobs: [before, after],
    });
    const dispatch = () =>
      store.append(record.id, authority(lock, prepared), "dispatch", {
        ...intent,
        state: "dispatched",
      });
    const pressure = join(root, "quota-pressure");
    writeFileSync(pressure, "", { mode: 0o600 });
    truncateSync(pressure, GOAL_LIMITS.storeBytes - 3 * metadata - 64 * 1024);
    assert.throws(dispatch, /store capacity exceeded/);
    assert.deepEqual(store.inspect(record.id), prepared);
    truncateSync(pressure, GOAL_LIMITS.storeBytes - 4 * metadata - 64 * 1024);
    const dispatched = dispatch();
    const startOther = () =>
      withGoalLock(otherWorkspace, (lock) =>
        store.beginAttempt(other.id, { lock, fence: fence(other) }),
      );
    assert.throws(startOther, /store capacity exceeded/);
    const observed = store.append(
      record.id,
      authority(lock, dispatched),
      "receipt",
      editReceipt(intent, dispatched, after),
    );
    assert.equal(observed.counters.used.tools, 1);
    assert.equal(startOther().goal.state, "running");
    assert.deepEqual(store.readBlob(record.id, sha(before)), before);
    assert.deepEqual(store.readBlob(record.id, sha(after)), after);
  });
});

test(
  "checkpoint rename failure retains a verified prefix and cleans only unpublished files",
  linux,
  (t) => {
    const { store, workspace, record, directory } = fixture(t);
    const created = store.create(record);
    withGoalLock(workspace, (lock) => {
      const running = store.beginAttempt(record.id, { lock, fence: fence(created) });
      const rename = fs.renameSync;
      const failure = Object.assign(new Error("synthetic permission denial"), { code: "EACCES" });
      const override = t.mock.method(fs, "renameSync", (from, to) => {
        if (to.endsWith("/checkpoint.json")) throw failure;
        return rename(from, to);
      });
      syncBuiltinESMExports();
      try {
        assert.throws(
          () => store.renew(record.id, authority(lock, running)),
          (error) => error === failure,
        );
      } finally {
        override.mock.restore();
        syncBuiltinESMExports();
      }
      const actual = store.inspect(record.id);
      assert.ok(actual.uncommittedBytes > 0);
      assert.deepEqual(actual, { ...running, uncommittedBytes: actual.uncommittedBytes });
      const temp = join(directory, ".matrix-integration-" + "f".repeat(32) + ".tmp");
      writeFileSync(temp, "unpublished bytes", { mode: 0o600 });
      assert.equal(store.cleanupStaging(), 1);
      assert.equal(existsSync(temp), false);
      assert.deepEqual(store.inspect(record.id), actual);
    });
  },
);

for (const boundary of [
  "before-journal-sync",
  "before-checkpoint-rename",
  "after-checkpoint-rename",
]) {
  test(
    "SIGKILL during an update at " + boundary + " preserves a verified checkpoint",
    { ...linux, timeout: 10_000 },
    async (t) => {
      const { home, store, record, workspace } = fixture(t);
      const created = store.create(record);
      const worker = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const [storeUrl, lockUrl, home, workspace, id, boundary] = process.argv.slice(1);
      const { createGoalStore } = await import(storeUrl);
      const { withGoalLock } = await import(lockUrl);
      const store = createGoalStore(home);
      const fence = (goal) => ({ goalId: id, sequence: goal.sequence, generation: goal.generation });
      const barrier = () => {
        fs.writeSync(1, boundary + "\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
      };
      withGoalLock(workspace, (lock) => {
        const running = store.beginAttempt(id, { lock, fence: fence(store.inspect(id).goal) });
        const sync = fs.fsyncSync;
        fs.fsyncSync = (fd) => {
          if (boundary === "before-journal-sync" && fs.readlinkSync("/proc/self/fd/" + fd).endsWith("/journal.jsonl")) barrier();
          return sync(fd);
        };
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (!to.endsWith("/checkpoint.json")) return rename(from, to);
          if (boundary === "before-checkpoint-rename") barrier();
          rename(from, to);
          if (boundary === "after-checkpoint-rename") barrier();
        };
        syncBuiltinESMExports();
        store.renew(id, { lock, fence: fence(running.goal), leaseId: running.lease.leaseId });
      });
    `,
          new URL("../lib/goal-store.mjs", import.meta.url).href,
          new URL("../lib/goal-lock.mjs", import.meta.url).href,
          home,
          workspace,
          record.id,
          boundary,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const closed = once(worker, "exit");
      t.after(async () => {
        worker.kill("SIGKILL");
        await closed;
      });
      const [marker] = await Promise.race([
        once(worker.stdout, "data"),
        closed.then(([code, signal]) => {
          throw new Error("worker exited before barrier: " + code + "/" + signal);
        }),
      ]);
      assert.equal(marker.toString(), boundary + "\n");
      assert.throws(
        () => withGoalLock(workspace, () => assert.fail("second writer entered")),
        /workspace is locked/,
      );
      const second = { ...record, id: newGoalId() };
      assert.throws(() => store.create(second), /writer busy/);
      assert.throws(() => store.inspect(second.id), { code: "ENOENT" });
      worker.kill("SIGKILL");
      assert.deepEqual(await closed, [null, "SIGKILL"]);
      const reopened = createGoalStore(home);
      const actual = reopened.inspect(record.id);
      assert.equal(
        actual.goal.sequence,
        created.sequence + (boundary === "after-checkpoint-rename" ? 2 : 1),
      );
      assert.equal(actual.uncommittedBytes > 0, boundary !== "after-checkpoint-rename");
      assert.equal(reopened.inspectPrevious(record.id).goal.sequence, created.sequence + 1);
      withGoalLock(workspace, (lock) => {
        assert.throws(
          () => reopened.renew(record.id, authority(lock, actual)),
          /uncommitted journal tail|lease owner mismatch/,
        );
      });
    },
  );
}

test("an active checkpoint reserves its workspace across lock scopes", linux, (t) => {
  const { store, workspace, record } = fixture(t);
  const first = store.create(record);
  const second = store.create({ ...record, id: newGoalId() });
  const running = withGoalLock(workspace, (lock) =>
    store.beginAttempt(first.id, { lock, fence: fence(first) }),
  );
  withGoalLock(workspace, (lock) => {
    assert.throws(
      () => store.beginAttempt(second.id, { lock, fence: fence(second) }),
      /another goal owns the workspace/,
    );
    store.transition(first.id, authority(lock, running), "cancelled");
    assert.equal(
      store.beginAttempt(second.id, { lock, fence: fence(second) }).goal.state,
      "running",
    );
  });
});

test("stopped goals can be cancelled with a current fence and workspace lock", linux, (t) => {
  const { store, workspace, record, home } = fixture(t);
  for (const state of ["ready", "paused", "budget-exhausted"]) {
    const created = store.create({ ...record, id: newGoalId() });
    withGoalLock(workspace, (lock) => {
      let current = store.inspect(created.id);
      if (state !== "ready") {
        current = store.beginAttempt(created.id, { lock, fence: fence(current.goal) });
        assert.throws(
          () => store.transition(created.id, { lock, fence: fence(current.goal) }, "cancelled"),
          /active attempt requires a writer lease/,
        );
        current = store.transition(created.id, authority(lock, current), state);
      }
      assert.throws(
        () =>
          store.transition(
            created.id,
            { lock, fence: { ...fence(current.goal), sequence: current.goal.sequence - 1 } },
            "cancelled",
          ),
        /stale fence/,
      );
      const cancelled = store.transition(
        created.id,
        { lock, fence: fence(current.goal) },
        "cancelled",
      );
      assert.equal(cancelled.goal.state, "cancelled");
      assert.equal(createGoalStore(home).inspect(created.id).goal.state, "cancelled");
    });
  }
});

test("journal admission reserves room for receipts, stopping, and cancellation", linux, (t) => {
  for (const fits of [false, true]) {
    const { store, workspace, record, checkpoint, journal } = fixture(t);
    const created = store.create(record);
    const before = Buffer.from("original\r\nbytes");
    const after = Buffer.alloc(0);
    withGoalLock(workspace, (lock) => {
      const started = store.beginAttempt(record.id, { lock, fence: fence(created) });
      // Fill with canonical renewal frames without syncing hundreds of individual updates.
      const sequence = GOAL_LIMITS.journalRecords - (fits ? 5 : 4);
      let prevChecksum = started.journal.checksum;
      const frames = [];
      for (let n = started.goal.sequence + 1; n <= sequence; n++) {
        const frame = sealJournalRecord({
          schemaVersion: 1,
          goalId: record.id,
          attemptId: started.lease.attemptId,
          generation: started.goal.generation,
          sequence: n,
          kind: "state",
          operationId: null,
          prevChecksum,
          payload: { schemaVersion: 1, state: "running" },
        });
        frames.push(`${encodeJournalRecord(frame)}\n`);
        prevChecksum = frame.checksum;
      }
      appendFileSync(journal, frames.join(""));
      const { checksum: _checksum, ...body } = JSON.parse(readFileSync(checkpoint, "utf8"));
      body.goal.sequence = sequence;
      body.journalBytes = statSync(journal).size;
      body.journalChecksum = prevChecksum;
      writeFileSync(checkpoint, canonicalJson({ ...body, checksum: sha(canonicalJson(body)) }));
      const running = store.inspect(record.id);
      const intent = editIntent(running, before, after);
      let current = store.append(record.id, authority(lock, running), "intent", intent, {
        blobs: [before, after],
      });
      const dispatch = () =>
        store.append(record.id, authority(lock, current), "dispatch", {
          ...intent,
          state: "dispatched",
        });
      if (fits) {
        current = dispatch();
        current = store.append(
          record.id,
          authority(lock, current),
          "receipt",
          editReceipt(intent, current, after),
        );
        assert.equal(current.counters.used.tools, 1);
      } else {
        assert.throws(dispatch, /journal capacity exceeded/);
        assert.deepEqual(store.inspect(record.id), current);
      }
      const stopped = store.transition(record.id, authority(lock, current), "paused");
      const cancelled = store.transition(
        record.id,
        { lock, fence: fence(stopped.goal) },
        "cancelled",
      );
      assert.equal(cancelled.goal.sequence, GOAL_LIMITS.journalRecords - Number(!fits));
      assert.equal(store.inspect(record.id).goal.state, "cancelled");
      assert.deepEqual(store.readBlob(record.id, sha(before)), before);
      assert.deepEqual(store.readBlob(record.id, sha(after)), after);
    });
  }
});
