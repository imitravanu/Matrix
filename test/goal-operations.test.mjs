import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  GOAL_DEFAULT_BUDGET,
  newGoalId,
  validateOperationIntent,
  validateOperationReceipt,
} from "../lib/goal-contracts.mjs";
import { createGoalStore } from "../lib/goal-store.mjs";
import { withGoalLock } from "../lib/goal-lock.mjs";
import {
  applyEditOperation,
  buildOperationReceipt,
  computePlanHash,
  createOperationAuthority,
  prepareEditOperation,
  prepareOperationIntent,
  readWorkspaceFileBounded,
} from "../lib/goal-operations.mjs";

const hash = "a".repeat(64);

for (const boundary of ["blob", "sync"]) {
  for (const change of ["expiry", "drift", "cancel"]) {
    test(`commit boundary refuses ${change} during ${boundary}`, (t) => {
      const { workspace, store, goal } = fixture(t);
      const target = join(workspace, "commit-target");
      const original = Buffer.from("original\r\nwithout newline");
      writeFileSync(target, original, { mode: 0o640 });
      const fence = (g) => ({ goalId: g.id, sequence: g.sequence, generation: g.generation });
      withGoalLock(workspace, (lock) => {
        const running = store.beginAttempt(goal.id, {
          lock,
          fence: fence(goal),
          ttlMs: change === "expiry" ? 1000 : undefined,
        });
        const prep = prepareEditOperation({
          goal: running.goal,
          attemptId: running.lease.attemptId,
          generation: running.goal.generation,
          path: "commit-target",
          content: "new content",
        });
        const auth = (s) => ({ lock, fence: fence(s.goal), leaseId: running.lease.leaseId });
        const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
          blobs: prep.blobs,
        });
        const dispatched = store.append(goal.id, auth(prepared), "dispatch", {
          ...prep.intent,
          state: "dispatched",
        });
        const method = boundary === "blob" ? "readSync" : "fsyncSync";
        const originalMethod = fs[method];
        let injected = false;
        const replacement = (fd, ...args) => {
          const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
          const matches =
            boundary === "blob"
              ? path.endsWith(`/blob_${prep.intent.edit.after.blob}`)
              : path.startsWith(`${workspace}/`) && path.endsWith(".tmp");
          if (!injected && matches) {
            injected = true;
            if (change === "expiry") {
              while (Date.now() <= running.lease.expiresAt)
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            } else if (change === "drift") {
              writeFileSync(target, "external change", { mode: 0o640 });
            } else {
              store.transition(goal.id, auth(dispatched), "cancelled");
            }
          }
          return originalMethod(fd, ...args);
        };
        fs[method] = replacement;
        syncBuiltinESMExports();
        try {
          assert.throws(
            () => applyEditOperation(workspace, prep.intent, null, { lock, store }),
            /expired|precondition|stale fence/,
          );
        } finally {
          fs[method] = originalMethod;
          syncBuiltinESMExports();
        }
        assert.equal(injected, true);
        assert.deepEqual(
          readFileSync(target),
          change === "drift" ? Buffer.from("external change") : original,
        );
        assert.equal(statSync(target).mode & 0o777, 0o640);
        assert.equal(
          fs.readdirSync(workspace).some((name) => name.endsWith(".tmp")),
          false,
        );
        assert.deepEqual(store.readBlob(goal.id, prep.intent.edit.before.blob), original);
      });
    });
  }
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "matrix-goal-ops-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "matrix-goal-ops-ws-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const identity = statSync(workspace, { bigint: true });
  const goal = {
    schemaVersion: 1,
    id: newGoalId(),
    createdAt: 1000,
    objective: "Operation preparation testing",
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
    budget: { ...GOAL_DEFAULT_BUDGET },
    operations: [],
    criteria: [{ id: newGoalId("criterion"), revision: 1, kind: "test", planHash: hash }],
  };

  const store = createGoalStore(home);
  const created = store.create(goal);
  const attemptId = newGoalId("attempt");
  return { home, workspace, store, goal: created, attemptId };
}

test("prepareEditOperation creates valid intent and exact recovery blob for new file", (t) => {
  const { goal, attemptId } = fixture(t);
  const relPath = "src/new-file.txt";
  const content = "created content\r\n";

  const prep = prepareEditOperation({
    goal,
    attemptId,
    generation: 1,
    path: relPath,
    content,
    mode: 0o755,
    toolCallId: "call_abc123",
  });

  assert.equal(prep.intent.kind, "edit");
  assert.equal(prep.intent.edit.path, relPath);
  assert.equal(prep.intent.edit.before.exists, false);
  assert.equal(prep.intent.edit.before.sha256, null);
  assert.equal(prep.intent.edit.before.mode, null);
  assert.equal(prep.intent.edit.before.blob, null);

  assert.equal(prep.intent.edit.after.exists, true);
  assert.equal(prep.intent.edit.after.mode, 0o755);
  assert.equal(prep.intent.preconditions.files.length, 1);
  assert.equal(prep.intent.preconditions.files[0].exists, false);
  assert.equal(prep.intent.preconditions.files[0].sha256, null);

  // Exactly one blob (after image)
  assert.equal(prep.blobs.length, 1);
  assert.equal(prep.blobs[0].toString("utf8"), content);

  // Tool-call ID is stored as metadata but does not alter planHash
  assert.equal(prep.toolCallId, "call_abc123");
  const planHashWithoutToolId = computePlanHash({
    kind: "edit",
    workspace: goal.workspace,
    path: relPath,
    before: { exists: false, sha256: null, mode: null },
    after: prep.intent.edit.after,
    argsSha256: prep.intent.arguments.sha256,
  });
  assert.equal(prep.planHash, planHashWithoutToolId);

  assert.doesNotThrow(() => validateOperationIntent(prep.intent));
});

test("prepareEditOperation captures exact before image, CRLF, modes and blobs for existing file", (t) => {
  const { workspace, goal, attemptId } = fixture(t);
  const relPath = "scripts/tool.sh";
  mkdirSync(join(workspace, "scripts"));
  const original = "#!/bin/sh\r\necho hello\r\n";
  writeFileSync(join(workspace, relPath), original, { mode: 0o751 });

  const updated = "#!/bin/sh\r\necho updated\r\n";
  const prep = prepareEditOperation({
    goal,
    attemptId,
    generation: 1,
    path: relPath,
    content: updated,
  });

  assert.equal(prep.intent.edit.before.exists, true);
  assert.equal(prep.intent.edit.before.mode, 0o751);
  // Preserves existing mode when not explicitly overridden
  assert.equal(prep.intent.edit.after.mode, 0o751);

  assert.equal(prep.blobs.length, 2);
  assert.equal(prep.blobs[0].toString("utf8"), original);
  assert.equal(prep.blobs[1].toString("utf8"), updated);

  assert.equal(prep.intent.preconditions.files[0].exists, true);
  assert.equal(prep.intent.preconditions.files[0].sha256, prep.intent.edit.before.sha256);

  assert.doesNotThrow(() => validateOperationIntent(prep.intent));
});

test("prepareEditOperation handles 0-byte empty original without treating it as creation", (t) => {
  const { workspace, goal, attemptId } = fixture(t);
  const relPath = "empty.txt";
  writeFileSync(join(workspace, relPath), Buffer.alloc(0), { mode: 0o644 });

  const prep = prepareEditOperation({
    goal,
    attemptId,
    generation: 1,
    path: relPath,
    content: "now has content",
  });

  assert.equal(prep.intent.edit.before.exists, true);
  assert.equal(
    prep.intent.edit.before.sha256,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(prep.intent.edit.after.exists, true);
  assert.equal(prep.blobs.length, 2);
  assert.equal(prep.blobs[0].length, 0);
  assert.equal(prep.blobs[1].toString("utf8"), "now has content");
});

test("prepareEditOperation prepares valid deletion edit when content is null", (t) => {
  const { workspace, goal, attemptId } = fixture(t);
  const relPath = "deprecated.txt";
  writeFileSync(join(workspace, relPath), "delete me");

  const prep = prepareEditOperation({
    goal,
    attemptId,
    generation: 1,
    path: relPath,
    content: null,
  });

  assert.equal(prep.intent.edit.before.exists, true);
  assert.equal(prep.intent.edit.after.exists, false);
  assert.equal(prep.intent.edit.after.sha256, null);
  assert.equal(prep.intent.edit.after.mode, null);
  assert.equal(prep.intent.edit.after.blob, null);
  assert.equal(prep.blobs.length, 1);
  assert.equal(prep.blobs[0].toString("utf8"), "delete me");

  assert.doesNotThrow(() => validateOperationIntent(prep.intent));
});

test("prepareEditOperation rejects no-op edits and dangerous targets", (t) => {
  const { workspace, goal, attemptId } = fixture(t);
  writeFileSync(join(workspace, "same.txt"), "unchanged", { mode: 0o644 });

  // No-op edit
  assert.throws(
    () =>
      prepareEditOperation({
        goal,
        attemptId,
        generation: 1,
        path: "same.txt",
        content: "unchanged",
        mode: 0o644,
      }),
    /edit is a no-op/,
  );

  // Path traversal
  assert.throws(
    () =>
      prepareEditOperation({
        goal,
        attemptId,
        generation: 1,
        path: "../outside.txt",
        content: "fail",
      }),
    /unsafe path|invalid goal path|traversal/,
  );

  // Directory target
  mkdirSync(join(workspace, "sub-dir"));
  assert.throws(
    () =>
      prepareEditOperation({
        goal,
        attemptId,
        generation: 1,
        path: "sub-dir",
        content: "fail",
      }),
    /not a regular file/,
  );

  // Symlink target
  const outside = join(tmpdir(), "outside-" + Date.now() + ".txt");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(workspace, "sym-target"));
  t.after(() => rmSync(outside, { force: true }));

  assert.throws(
    () =>
      prepareEditOperation({
        goal,
        attemptId,
        generation: 1,
        path: "sym-target",
        content: "fail",
      }),
    /symbolic link/,
  );

  // Replaced workspace root
  assert.throws(
    () =>
      prepareEditOperation({
        goal: {
          ...goal,
          workspace: { ...goal.workspace, inode: "99999999" },
        },
        attemptId,
        generation: 1,
        path: "any.txt",
        content: "test",
      }),
    /workspace identity changed/,
  );
});

test("readWorkspaceFileBounded handles FIFOs nonblockingly without hanging", (t) => {
  if (process.platform !== "linux") return;
  const { workspace } = fixture(t);
  const fifoPath = join(workspace, "pipe.fifo");
  const res = spawnSync("mkfifo", ["-m", "600", fifoPath], { timeout: 2000 });
  if (res.status !== 0) return;

  assert.throws(() => readWorkspaceFileBounded(workspace, "pipe.fifo"), /not a regular file/);
});

test("authority creation and plan-hash validation bind operations strictly", (t) => {
  const { workspace, goal, attemptId } = fixture(t);
  writeFileSync(join(workspace, "auth-test.txt"), "initial");

  const auth = createOperationAuthority({
    kind: "edit",
    planHash: hash,
  });
  assert.equal(auth.kind, "edit");
  assert.equal(auth.planHash, hash);
  assert.match(auth.decisionId, /^decision_[a-f0-9]{32}$/);

  // Mismatched authority planHash throws
  assert.throws(
    () =>
      prepareEditOperation({
        goal,
        attemptId,
        generation: 1,
        path: "auth-test.txt",
        content: "updated",
        authority: { kind: "edit", planHash: "b".repeat(64), decisionId: auth.decisionId },
      }),
    /authority plan mismatch/,
  );

  // Non-edit operations authority binding
  const testOp = prepareOperationIntent({
    goal,
    attemptId,
    generation: 1,
    kind: "test",
    args: { command: "npm test" },
  });
  assert.equal(testOp.intent.kind, "test");
  assert.equal(testOp.intent.authority.kind, "test");
  assert.equal(testOp.intent.authority.planHash, testOp.planHash);

  const readOp = prepareOperationIntent({
    goal,
    attemptId,
    generation: 1,
    kind: "read",
    args: { path: "auth-test.txt" },
  });
  assert.equal(readOp.intent.kind, "read");
  assert.equal(readOp.intent.authority.kind, "none");
});

test("applyEditOperation and buildOperationReceipt execute effects and bind after images", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "apply-test.txt";

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "written atomically\n",
      mode: 0o640,
    });

    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    const applied = applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
    assert.equal(applied.ok, true);
    assert.equal(readFileSync(join(workspace, relPath), "utf8"), "written atomically\n");
    assert.equal(statSync(join(workspace, relPath)).mode & 0o777, 0o640);

    const receipt = buildOperationReceipt(prep.intent, { sequence: 2 });
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.files[0].path, relPath);
    assert.equal(receipt.files[0].state, "matches-after");
    assert.equal(receipt.files[0].sha256, prep.intent.edit.after.sha256);
    assert.doesNotThrow(() => validateOperationReceipt(receipt));
  });
});

test("applyEditOperation refuses execution without held workspace lock", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "no-lock.txt";

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "should not be written\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    assert.throws(
      () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { store }),
      /applyEditOperation requires a held workspace lock/,
    );
    assert.equal(statSync(join(workspace, relPath), { throwIfNoEntry: false }), undefined);
  });
});

test("applyEditOperation refuses execution without store to verify dispatch and authority", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "no-store.txt";

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "should not be written\n",
    });

    assert.throws(
      () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock }),
      /applyEditOperation requires goalStore/,
    );
    assert.equal(statSync(join(workspace, relPath), { throwIfNoEntry: false }), undefined);
  });
});

test("applyEditOperation refuses execution if intent has not been committed to dispatch", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "undispatched.txt";

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "undispatched write\n",
    });
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );

    assert.throws(
      () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
      /has not been committed to dispatch/,
    );
    assert.equal(statSync(join(workspace, relPath), { throwIfNoEntry: false }), undefined);
  });
});

test("applyEditOperation refuses execution after goal is cancelled", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "cancelled.txt";
  writeFileSync(join(workspace, relPath), "initial content\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "should not overwrite cancelled\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    const sd = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    store.transition(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: sd.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "cancelled",
    );

    assert.throws(
      () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
      /cannot apply edit: goal is cancelled/,
    );
    assert.equal(readFileSync(join(workspace, relPath), "utf8"), "initial content\n");
    assert.equal(statSync(join(workspace, relPath)).mode & 0o777, 0o644);
  });
});

test("applyEditOperation refuses execution when target content changed after approval (precondition check)", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "precondition-content.txt";
  writeFileSync(join(workspace, relPath), "approved content\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "updated content\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    writeFileSync(join(workspace, relPath), "external modification\n");

    assert.throws(
      () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
      /precondition failed: target file .* content changed after approval/,
    );
    assert.equal(readFileSync(join(workspace, relPath), "utf8"), "external modification\n");
    assert.equal(statSync(join(workspace, relPath)).mode & 0o777, 0o644);
  });
});

test("applyEditOperation refuses execution when target mode changed after approval (mode check)", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "precondition-mode.txt";
  writeFileSync(join(workspace, relPath), "content\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "new content\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    chmodSync(join(workspace, relPath), 0o777);

    assert.throws(
      () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
      /precondition failed: target file .* mode changed after approval/,
    );
    assert.equal(readFileSync(join(workspace, relPath), "utf8"), "content\n");
    assert.equal(statSync(join(workspace, relPath)).mode & 0o777, 0o777);
  });
});

test("applyEditOperation refuses execution on creation when target file already exists externally", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "creation-target.txt";

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "creation content\n",
    });
    assert.equal(prep.intent.edit.before.exists, false);

    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    writeFileSync(join(workspace, relPath), "external conflicting file\n", { mode: 0o600 });

    assert.throws(
      () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
      /precondition failed: target file .* already exists/,
    );
    assert.equal(readFileSync(join(workspace, relPath), "utf8"), "external conflicting file\n");
    assert.equal(statSync(join(workspace, relPath)).mode & 0o777, 0o600);
  });
});

test("applyEditOperation refuses execution of stale deletion when target content changed", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "to-delete.txt";
  writeFileSync(join(workspace, relPath), "original to delete\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: null,
    });
    assert.equal(prep.intent.edit.after.exists, false);

    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    writeFileSync(join(workspace, relPath), "modified before deletion\n");

    assert.throws(
      () => applyEditOperation(workspace, prep.intent, { lock, store }),
      /precondition failed: target file .* content changed after approval/,
    );
    assert.equal(readFileSync(join(workspace, relPath), "utf8"), "modified before deletion\n");
  });
});

test("applyEditOperation refuses execution when workspace root or identity is replaced", (t) => {
  const { workspace, store, goal } = fixture(t);
  const relPath = "ws-replace.txt";
  const fakeWorkspace = mkdtempSync(join(tmpdir(), "matrix-fake-ws-"));
  t.after(() => rmSync(fakeWorkspace, { recursive: true, force: true }));

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: relPath,
      content: "content\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    assert.throws(
      () => applyEditOperation(fakeWorkspace, prep.intent, prep.afterBytes, { lock, store }),
      /workspace identity changed|workspace root path mismatch/,
    );
    assert.equal(statSync(join(fakeWorkspace, relPath), { throwIfNoEntry: false }), undefined);
  });
});

test("applyEditOperation refuses execution when caller intent target path is changed vs committed dispatch", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "target.txt";
  const otherRel = "other.txt";
  writeFileSync(join(workspace, targetRel), "ORIGINAL TARGET\n", { mode: 0o644 });
  writeFileSync(join(workspace, otherRel), "ORIGINAL OTHER\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "PLANNED TARGET\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    // Caller modifies target path while keeping operationId
    const changed = structuredClone(prep.intent);
    changed.edit.path = otherRel;
    changed.preconditions.files[0].path = otherRel;

    assert.throws(
      () => applyEditOperation(workspace, changed, prep.afterBytes, { lock, store }),
      /executed intent does not match committed dispatch payload/,
    );
    assert.equal(readFileSync(join(workspace, otherRel), "utf8"), "ORIGINAL OTHER\n");
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "ORIGINAL TARGET\n");
    assert.equal(statSync(join(workspace, otherRel)).mode & 0o777, 0o644);
    assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o644);
  });
});

test("applyEditOperation refuses execution when caller intent after-image or afterBytes is altered", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "target-after.txt";
  writeFileSync(join(workspace, targetRel), "ORIGINAL CONTENT\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "PLANNED AFTER\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    // Case A: altered after image sha256 in caller intent
    const alteredIntent = structuredClone(prep.intent);
    alteredIntent.edit.after.sha256 = "f".repeat(64);

    assert.throws(
      () => applyEditOperation(workspace, alteredIntent, prep.afterBytes, { lock, store }),
      /executed intent does not match committed dispatch payload/,
    );
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "ORIGINAL CONTENT\n");

    // Case B: caller intent matches committed dispatch, but afterBytes buffer content was tampered
    assert.throws(
      () =>
        applyEditOperation(workspace, prep.intent, Buffer.from("TAMPERED BYTES\n"), {
          lock,
          store,
        }),
      /afterBytes does not match committed dispatch after image sha256/,
    );
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "ORIGINAL CONTENT\n");
    assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o644);
  });
});

test("applyEditOperation refuses execution when deletion or authority fields are altered", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "target-del-auth.txt";
  writeFileSync(join(workspace, targetRel), "ORIGINAL CONTENT\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "UPDATED CONTENT\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    // Case A: altered deletion field (after.exists set to false)
    const alteredDel = structuredClone(prep.intent);
    alteredDel.edit.after = { exists: false, sha256: null, mode: null, blob: null };

    assert.throws(
      () => applyEditOperation(workspace, alteredDel, null, { lock, store }),
      /executed intent does not match committed dispatch payload/,
    );
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "ORIGINAL CONTENT\n");

    // Case B: altered authority field
    const alteredAuth = structuredClone(prep.intent);
    alteredAuth.authority.planHash = "b".repeat(64);
    alteredAuth.planHash = "b".repeat(64);

    assert.throws(
      () => applyEditOperation(workspace, alteredAuth, prep.afterBytes, { lock, store }),
      /executed intent does not match committed dispatch payload/,
    );
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "ORIGINAL CONTENT\n");
    assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o644);
  });
});

test("applyEditOperation refuses execution when attempt lease has expired", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "target-expired.txt";
  writeFileSync(join(workspace, targetRel), "ORIGINAL BEFORE EXPIRE\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    // Keep the setup comfortably inside the lease even under coverage
    // instrumentation; the test then waits deterministically for expiry.
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
      ttlMs: 1000,
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "SHOULD NOT BE WRITTEN\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    const dispatched = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    // Wait until lease is expired
    while (Date.now() <= running.lease.expiresAt) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }

    // Verify store renewal is refused
    assert.throws(
      () =>
        store.renew(goal.id, {
          lock,
          fence: {
            goalId: goal.id,
            sequence: dispatched.goal.sequence,
            generation: running.goal.generation,
          },
          leaseId: running.lease.leaseId,
        }),
      /lease expired/,
    );

    // Effect execution without override is refused
    assert.throws(
      () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
      /lease expired/,
    );
    // Caller-supplied time override attempting to bypass expiry is also refused
    assert.throws(
      () =>
        applyEditOperation(workspace, prep.intent, prep.afterBytes, {
          lock,
          store,
          now: running.lease.acquiredAt + 1,
        }),
      /lease expired/,
    );
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "ORIGINAL BEFORE EXPIRE\n");
    assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o644);
  });
});

test("applyEditOperation refuses execution when a different process acquires workspace lock while previous owner's lease remains", (t) => {
  const { home, workspace, store, goal } = fixture(t);
  const targetRel = "target-owner-mismatch.txt";
  writeFileSync(join(workspace, targetRel), "ORIGINAL BEFORE OWNER MISMATCH\n", { mode: 0o644 });

  let prep;
  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "UNAUTHORIZED BY OTHER OWNER\n",
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );
  });

  // Real OS subprocess acquires workspace lock and tries to execute parent's lease
  const childScript = `
    import assert from "node:assert/strict";
    import { createGoalStore } from "${new URL("../lib/goal-store.mjs", import.meta.url).href}";
    import { withGoalLock } from "${new URL("../lib/goal-lock.mjs", import.meta.url).href}";
    import { applyEditOperation } from "${new URL("../lib/goal-operations.mjs", import.meta.url).href}";

    const [home, workspace, rawIntent, afterContent] = process.argv.slice(1);
    const store = createGoalStore(home);
    const intent = JSON.parse(rawIntent);
    const snapshot = store.inspect(intent.goalId);

    assert.notEqual(process.pid, snapshot.lease.owner.pid);

    withGoalLock(workspace, (lock) => {
      // 1. Without override: refuses
      assert.throws(
        () => applyEditOperation(workspace, intent, Buffer.from(afterContent), { lock, store }),
        /lease owner mismatch/,
      );
      // 2. Caller-supplied owner override attempting to substitute persisted lease owner still refuses
      assert.throws(
        () =>
          applyEditOperation(workspace, intent, Buffer.from(afterContent), {
            lock,
            store,
            owner: snapshot.lease.owner,
          }),
        /lease owner mismatch/,
      );
    });
    process.exit(0);
  `;

  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      childScript,
      home,
      workspace,
      JSON.stringify(prep.intent),
      "UNAUTHORIZED BY OTHER OWNER\n",
    ],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    readFileSync(join(workspace, targetRel), "utf8"),
    "ORIGINAL BEFORE OWNER MISMATCH\n",
  );
  assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o644);
});

test("applyEditOperation succeeds with exact dispatch and valid current authority (positive control)", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "target-positive.txt";
  writeFileSync(join(workspace, targetRel), "ORIGINAL POSITIVE\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: { goalId: goal.id, sequence: goal.sequence, generation: goal.generation },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "EXACT DISPATCHED CONTENT\n",
      mode: 0o755,
    });
    const s1 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: running.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    const sd = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s1.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );

    // Call applyEditOperation with exact dispatch and valid current authority
    const result = applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "EXACT DISPATCHED CONTENT\n");
    assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o755);

    // Also test positive control when afterBytes is omitted (loads from store blob)
    const target2Rel = "target-from-blob.txt";
    const prep2 = prepareEditOperation({
      goal: sd.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: target2Rel,
      content: "CONTENT RESTORED FROM STORE BLOB\n",
      mode: 0o600,
    });
    const s2 = store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: sd.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep2.intent,
      { blobs: prep2.blobs },
    );
    store.append(
      goal.id,
      {
        lock,
        fence: {
          goalId: goal.id,
          sequence: s2.goal.sequence,
          generation: running.goal.generation,
        },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep2.intent, state: "dispatched" },
    );

    // Omit afterBytes: loads from store blob
    const result2 = applyEditOperation(workspace, prep2.intent, { lock, store });
    assert.equal(result2.ok, true);
    assert.equal(
      readFileSync(join(workspace, target2Rel), "utf8"),
      "CONTENT RESTORED FROM STORE BLOB\n",
    );
    assert.equal(statSync(join(workspace, target2Rel)).mode & 0o777, 0o600);
  });
});

function matrixArtifacts(workspace) {
  return readdirSync(workspace).filter(
    (name) => name.startsWith(".matrix-integration-") || name.startsWith(".matrix-commit-"),
  );
}

for (const deletion of [false, true]) {
  test(`commit boundary rechecks cancellation during the final ${deletion ? "deletion" : "write"} read`, (t) => {
    const { workspace, store, goal } = fixture(t);
    const targetRel = deletion ? "cancel-final-delete.txt" : "cancel-final-write.txt";
    const target = join(workspace, targetRel);
    const original = "ORIGINAL BEFORE CANCELLATION\n";
    writeFileSync(target, original, { mode: 0o640 });

    withGoalLock(workspace, (lock) => {
      const snapshot = store.inspect(goal.id);
      const running = store.beginAttempt(goal.id, {
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshot.goal.sequence,
          generation: snapshot.goal.generation,
        },
      });
      const prep = prepareEditOperation({
        goal: running.goal,
        attemptId: running.lease.attemptId,
        generation: running.goal.generation,
        path: targetRel,
        content: deletion ? null : "AFTER CANCELLATION\n",
      });
      const auth = (snapshotValue) => ({
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshotValue.goal.sequence,
          generation: snapshotValue.goal.generation,
        },
        leaseId: running.lease.leaseId,
      });
      const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
        blobs: prep.blobs,
      });
      const dispatched = store.append(goal.id, auth(prepared), "dispatch", {
        ...prep.intent,
        state: "dispatched",
      });

      const originalRead = fs.readSync;
      let targetReads = 0;
      let cancelled = false;
      fs.readSync = (fd, buffer, offset, length, position) => {
        let path = "";
        try {
          path = fs.readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          /* Not a file descriptor with a path. */
        }
        if (path === target) {
          targetReads++;
          if (targetReads === 3 && length > 1 && !cancelled) {
            cancelled = true;
            store.transition(goal.id, auth(dispatched), "cancelled");
          }
        }
        return originalRead(fd, buffer, offset, length, position);
      };
      syncBuiltinESMExports();
      try {
        assert.throws(
          () =>
            applyEditOperation(workspace, prep.intent, deletion ? null : prep.afterBytes, {
              lock,
              store,
            }),
          /stale fence|cancelled|no active attempt/,
        );
      } finally {
        fs.readSync = originalRead;
        syncBuiltinESMExports();
      }

      assert.equal(cancelled, true);
      assert.equal(store.inspect(goal.id).goal.state, "cancelled");
      assert.equal(readFileSync(target, "utf8"), original);
      assert.equal(statSync(target).mode & 0o777, 0o640);
      assert.deepEqual(matrixArtifacts(workspace), []);
    });
  });
}

test("commit boundary rechecks an intervening lease renewal before publication", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "renew-final.txt";
  const target = join(workspace, targetRel);
  const original = "ORIGINAL BEFORE RENEWAL\n";
  writeFileSync(target, original, { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const snapshot = store.inspect(goal.id);
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: {
        goalId: goal.id,
        sequence: snapshot.goal.sequence,
        generation: snapshot.goal.generation,
      },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "AFTER RENEWAL\n",
    });
    const auth = (snapshotValue) => ({
      lock,
      fence: {
        goalId: goal.id,
        sequence: snapshotValue.goal.sequence,
        generation: snapshotValue.goal.generation,
      },
      leaseId: running.lease.leaseId,
    });
    const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
      blobs: prep.blobs,
    });
    const dispatched = store.append(goal.id, auth(prepared), "dispatch", {
      ...prep.intent,
      state: "dispatched",
    });

    const originalRead = fs.readSync;
    let targetReads = 0;
    let renewed = false;
    fs.readSync = (fd, buffer, offset, length, position) => {
      let path = "";
      try {
        path = fs.readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        /* Not a file descriptor with a path. */
      }
      if (path === target) {
        targetReads++;
        if (targetReads === 3 && length > 1 && !renewed) {
          renewed = true;
          store.renew(goal.id, auth(dispatched));
        }
      }
      return originalRead(fd, buffer, offset, length, position);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
        /stale fence/,
      );
    } finally {
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }

    assert.equal(renewed, true);
    assert.equal(readFileSync(target, "utf8"), original);
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.deepEqual(matrixArtifacts(workspace), []);
  });
});

test("commit boundary rechecks cancellation during displaced-target verification", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "cancel-quarantine.txt";
  const target = join(workspace, targetRel);
  const original = "ORIGINAL BEFORE QUARANTINE CANCELLATION\n";
  writeFileSync(target, original, { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const snapshot = store.inspect(goal.id);
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: {
        goalId: goal.id,
        sequence: snapshot.goal.sequence,
        generation: snapshot.goal.generation,
      },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "AFTER QUARANTINE CANCELLATION\n",
    });
    const auth = (snapshotValue) => ({
      lock,
      fence: {
        goalId: goal.id,
        sequence: snapshotValue.goal.sequence,
        generation: snapshotValue.goal.generation,
      },
      leaseId: running.lease.leaseId,
    });
    const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
      blobs: prep.blobs,
    });
    const dispatched = store.append(goal.id, auth(prepared), "dispatch", {
      ...prep.intent,
      state: "dispatched",
    });

    const originalRead = fs.readSync;
    let cancelled = false;
    fs.readSync = (fd, buffer, offset, length, position) => {
      let path = "";
      try {
        path = fs.readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        /* Not a file descriptor with a path. */
      }
      if (path.includes(".matrix-commit-") && length > 1 && !cancelled) {
        cancelled = true;
        store.transition(goal.id, auth(dispatched), "cancelled");
      }
      return originalRead(fd, buffer, offset, length, position);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
        /stale fence|cancelled|no active attempt/,
      );
    } finally {
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }

    assert.equal(cancelled, true);
    assert.equal(readFileSync(target, "utf8"), original);
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.deepEqual(matrixArtifacts(workspace), []);
  });
});

for (const deletion of [false, true]) {
  test(`commit boundary restores external drift after the final ${deletion ? "deletion" : "write"} read`, (t) => {
    const { workspace, store, goal } = fixture(t);
    const targetRel = deletion ? "drift-final-delete.txt" : "drift-final-write.txt";
    const target = join(workspace, targetRel);
    const original = "ORIGINAL BEFORE DRIFT\n";
    const external = deletion ? "EXTERNAL DELETE TARGET\n" : "EXTERNAL WRITE TARGET\n";
    writeFileSync(target, original, { mode: 0o640 });

    withGoalLock(workspace, (lock) => {
      const snapshot = store.inspect(goal.id);
      const running = store.beginAttempt(goal.id, {
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshot.goal.sequence,
          generation: snapshot.goal.generation,
        },
      });
      const prep = prepareEditOperation({
        goal: running.goal,
        attemptId: running.lease.attemptId,
        generation: running.goal.generation,
        path: targetRel,
        content: deletion ? null : "PLANNED WRITE\n",
      });
      const auth = (snapshotValue) => ({
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshotValue.goal.sequence,
          generation: snapshotValue.goal.generation,
        },
        leaseId: running.lease.leaseId,
      });
      const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
        blobs: prep.blobs,
      });
      store.append(goal.id, auth(prepared), "dispatch", {
        ...prep.intent,
        state: "dispatched",
      });

      const originalRead = fs.readSync;
      let targetReads = 0;
      let injected = false;
      fs.readSync = (fd, buffer, offset, length, position) => {
        let path = "";
        try {
          path = fs.readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          /* Not a file descriptor with a path. */
        }
        const result = originalRead(fd, buffer, offset, length, position);
        if (path === target) {
          targetReads++;
          if (targetReads === 3 && length > 1 && !injected) {
            injected = true;
            if (deletion) {
              const replacement = join(workspace, ".external-delete-replacement");
              writeFileSync(replacement, external, { mode: 0o600 });
              renameSync(replacement, target);
            } else {
              writeFileSync(target, external);
              chmodSync(target, 0o600);
            }
          }
        }
        return result;
      };
      syncBuiltinESMExports();
      try {
        assert.throws(
          () =>
            applyEditOperation(workspace, prep.intent, deletion ? null : prep.afterBytes, {
              lock,
              store,
            }),
          /changed during commit/,
        );
      } finally {
        fs.readSync = originalRead;
        syncBuiltinESMExports();
      }

      assert.equal(injected, true);
      assert.equal(readFileSync(target, "utf8"), external);
      assert.equal(statSync(target).mode & 0o777, 0o600);
      assert.deepEqual(matrixArtifacts(workspace), []);
    });
  });
}

for (const deletion of [false, true]) {
  test(`commit boundary rechecks a generation advance during the final ${deletion ? "deletion" : "write"} read`, (t) => {
    const { workspace, store, goal } = fixture(t);
    const targetRel = deletion ? "generation-final-delete.txt" : "generation-final-write.txt";
    const target = join(workspace, targetRel);
    const original = "ORIGINAL BEFORE GENERATION ADVANCE\n";
    writeFileSync(target, original, { mode: 0o640 });

    withGoalLock(workspace, (lock) => {
      const snapshot = store.inspect(goal.id);
      const running = store.beginAttempt(goal.id, {
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshot.goal.sequence,
          generation: snapshot.goal.generation,
        },
      });
      const prep = prepareEditOperation({
        goal: running.goal,
        attemptId: running.lease.attemptId,
        generation: running.goal.generation,
        path: targetRel,
        content: deletion ? null : "PLANNED AFTER GENERATION ADVANCE\n",
      });
      const auth = (snapshotValue) => ({
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshotValue.goal.sequence,
          generation: snapshotValue.goal.generation,
        },
        leaseId: running.lease.leaseId,
      });
      const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
        blobs: prep.blobs,
      });
      const dispatched = store.append(goal.id, auth(prepared), "dispatch", {
        ...prep.intent,
        state: "dispatched",
      });

      const originalRead = fs.readSync;
      let targetReads = 0;
      let advanced = false;
      fs.readSync = (fd, buffer, offset, length, position) => {
        let path = "";
        try {
          path = fs.readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          /* Not a file descriptor with a path. */
        }
        if (path === target) {
          targetReads++;
          if (targetReads === 3 && length > 1 && !advanced) {
            advanced = true;
            const stopped = store.transition(goal.id, auth(dispatched), "interrupted");
            store.beginAttempt(goal.id, {
              lock,
              fence: {
                goalId: goal.id,
                sequence: stopped.goal.sequence,
                generation: stopped.goal.generation,
              },
            });
          }
        }
        return originalRead(fd, buffer, offset, length, position);
      };
      syncBuiltinESMExports();
      try {
        assert.throws(
          () =>
            applyEditOperation(workspace, prep.intent, deletion ? null : prep.afterBytes, {
              lock,
              store,
            }),
          /stale fence/,
        );
      } finally {
        fs.readSync = originalRead;
        syncBuiltinESMExports();
      }

      assert.equal(advanced, true);
      assert.equal(store.inspect(goal.id).goal.generation, running.goal.generation + 1);
      assert.equal(readFileSync(target, "utf8"), original);
      assert.equal(statSync(target).mode & 0o777, 0o640);
      assert.deepEqual(matrixArtifacts(workspace), []);
    });
  });
}

for (const deletion of [false, true]) {
  test(`commit boundary restores mode-only drift after the final ${deletion ? "deletion" : "write"} read`, (t) => {
    const { workspace, store, goal } = fixture(t);
    const targetRel = deletion ? "mode-final-delete.txt" : "mode-final-write.txt";
    const target = join(workspace, targetRel);
    const original = "ORIGINAL BEFORE MODE DRIFT\n";
    writeFileSync(target, original, { mode: 0o640 });

    withGoalLock(workspace, (lock) => {
      const snapshot = store.inspect(goal.id);
      const running = store.beginAttempt(goal.id, {
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshot.goal.sequence,
          generation: snapshot.goal.generation,
        },
      });
      const prep = prepareEditOperation({
        goal: running.goal,
        attemptId: running.lease.attemptId,
        generation: running.goal.generation,
        path: targetRel,
        content: deletion ? null : "PLANNED MODE WRITE\n",
      });
      const auth = (snapshotValue) => ({
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshotValue.goal.sequence,
          generation: snapshotValue.goal.generation,
        },
        leaseId: running.lease.leaseId,
      });
      const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
        blobs: prep.blobs,
      });
      store.append(goal.id, auth(prepared), "dispatch", {
        ...prep.intent,
        state: "dispatched",
      });

      const originalRead = fs.readSync;
      let targetReads = 0;
      let injected = false;
      fs.readSync = (fd, buffer, offset, length, position) => {
        let path = "";
        try {
          path = fs.readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          /* Not a file descriptor with a path. */
        }
        const result = originalRead(fd, buffer, offset, length, position);
        if (path === target) {
          targetReads++;
          if (targetReads === 3 && length > 1 && !injected) {
            injected = true;
            chmodSync(target, 0o600);
          }
        }
        return result;
      };
      syncBuiltinESMExports();
      try {
        assert.throws(
          () =>
            applyEditOperation(workspace, prep.intent, deletion ? null : prep.afterBytes, {
              lock,
              store,
            }),
          /mode changed during commit/,
        );
      } finally {
        fs.readSync = originalRead;
        syncBuiltinESMExports();
      }

      assert.equal(injected, true);
      assert.equal(readFileSync(target, "utf8"), original);
      assert.equal(statSync(target).mode & 0o777, 0o600);
      assert.deepEqual(matrixArtifacts(workspace), []);
    });
  });
}

test("commit boundary refuses creation when a target appears between the final read and publication", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "creation-publication-race.txt";
  const target = join(workspace, targetRel);
  const external = "EXTERNAL CREATION TARGET\n";
  assert.throws(() => statSync(target), { code: "ENOENT" });

  withGoalLock(workspace, (lock) => {
    const snapshot = store.inspect(goal.id);
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: {
        goalId: goal.id,
        sequence: snapshot.goal.sequence,
        generation: snapshot.goal.generation,
      },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "PLANNED CREATION\n",
      mode: 0o751,
    });
    const auth = (snapshotValue) => ({
      lock,
      fence: {
        goalId: goal.id,
        sequence: snapshotValue.goal.sequence,
        generation: snapshotValue.goal.generation,
      },
      leaseId: running.lease.leaseId,
    });
    const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
      blobs: prep.blobs,
    });
    store.append(goal.id, auth(prepared), "dispatch", {
      ...prep.intent,
      state: "dispatched",
    });

    const originalLink = fs.linkSync;
    let injected = false;
    fs.linkSync = (source, destination) => {
      if (
        !injected &&
        String(destination).endsWith(targetRel) &&
        String(source).includes(".matrix-integration-")
      ) {
        injected = true;
        writeFileSync(target, external, { mode: 0o600 });
      }
      return originalLink(source, destination);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
        /already exists/,
      );
    } finally {
      fs.linkSync = originalLink;
      syncBuiltinESMExports();
    }

    assert.equal(injected, true);
    assert.equal(readFileSync(target, "utf8"), external);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(matrixArtifacts(workspace), []);
  });
});

for (const deletion of [false, true]) {
  test(`commit boundary verifies the displaced target's mode after the final ${deletion ? "deletion" : "write"} read`, (t) => {
    const { workspace, store, goal } = fixture(t);
    const targetRel = deletion ? "mode-final-delete.txt" : "mode-final-write.txt";
    const target = join(workspace, targetRel);
    const original = "ORIGINAL MODE BYTES\n";
    writeFileSync(target, original, { mode: 0o640 });

    withGoalLock(workspace, (lock) => {
      const snapshot = store.inspect(goal.id);
      const running = store.beginAttempt(goal.id, {
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshot.goal.sequence,
          generation: snapshot.goal.generation,
        },
      });
      const prep = prepareEditOperation({
        goal: running.goal,
        attemptId: running.lease.attemptId,
        generation: running.goal.generation,
        path: targetRel,
        content: deletion ? null : "PLANNED MODE WRITE\n",
      });
      const auth = (snapshotValue) => ({
        lock,
        fence: {
          goalId: goal.id,
          sequence: snapshotValue.goal.sequence,
          generation: snapshotValue.goal.generation,
        },
        leaseId: running.lease.leaseId,
      });
      const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
        blobs: prep.blobs,
      });
      store.append(goal.id, auth(prepared), "dispatch", {
        ...prep.intent,
        state: "dispatched",
      });

      const originalRead = fs.readSync;
      let targetReads = 0;
      let injected = false;
      fs.readSync = (fd, buffer, offset, length, position) => {
        let path = "";
        try {
          path = fs.readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          /* Not a file descriptor with a path. */
        }
        const result = originalRead(fd, buffer, offset, length, position);
        if (path === target) {
          targetReads++;
          if (targetReads === 3 && length > 1 && !injected) {
            injected = true;
            chmodSync(target, 0o600);
          }
        }
        return result;
      };
      syncBuiltinESMExports();
      try {
        assert.throws(
          () =>
            applyEditOperation(workspace, prep.intent, deletion ? null : prep.afterBytes, {
              lock,
              store,
            }),
          /mode changed during commit/,
        );
      } finally {
        fs.readSync = originalRead;
        syncBuiltinESMExports();
      }

      assert.equal(injected, true);
      assert.equal(readFileSync(target, "utf8"), original);
      assert.equal(statSync(target).mode & 0o777, 0o600);
      assert.deepEqual(matrixArtifacts(workspace), []);
    });
  });
}

test("commit boundary refuses a creation target that appears before no-replace publication", (t) => {
  const { workspace, store, goal } = fixture(t);
  const targetRel = "creation-race.txt";
  const target = join(workspace, targetRel);
  const external = "EXTERNAL CREATION WINNER\n";

  withGoalLock(workspace, (lock) => {
    const snapshot = store.inspect(goal.id);
    const running = store.beginAttempt(goal.id, {
      lock,
      fence: {
        goalId: goal.id,
        sequence: snapshot.goal.sequence,
        generation: snapshot.goal.generation,
      },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "PLANNED CREATION\n",
      mode: 0o751,
    });
    assert.equal(prep.intent.edit.before.exists, false);
    const auth = (snapshotValue) => ({
      lock,
      fence: {
        goalId: goal.id,
        sequence: snapshotValue.goal.sequence,
        generation: snapshotValue.goal.generation,
      },
      leaseId: running.lease.leaseId,
    });
    const prepared = store.append(goal.id, auth(running), "intent", prep.intent, {
      blobs: prep.blobs,
    });
    store.append(goal.id, auth(prepared), "dispatch", {
      ...prep.intent,
      state: "dispatched",
    });

    // The target is absent during final validation; an external creator wins
    // the race immediately before the no-replace link(2).
    const originalLink = fs.linkSync;
    let injected = false;
    fs.linkSync = (source, destination) => {
      // The commit uses a pinned /proc/self/fd parent path, not the lexical
      // target path, so match on the leaf name.
      if (!injected && destination.endsWith(targetRel)) {
        injected = true;
        writeFileSync(target, external, { mode: 0o600 });
      }
      return originalLink(source, destination);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
        /already exists/,
      );
    } finally {
      fs.linkSync = originalLink;
      syncBuiltinESMExports();
    }

    assert.equal(injected, true);
    assert.equal(readFileSync(target, "utf8"), external);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(matrixArtifacts(workspace), []);
  });
});
