import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GOAL_DEFAULT_BUDGET, newGoalId } from "../lib/goal-contracts.mjs";
import { withGoalLock } from "../lib/goal-lock.mjs";
import {
  applyEditOperation,
  buildOperationReceipt,
  prepareEditOperation,
  prepareOperationIntent,
} from "../lib/goal-operations.mjs";
import {
  applyExactUndo,
  captureWorkspaceFingerprints,
  checkOperationAuthorityFreshness,
  detectWorkspaceDrift,
  reconcileFile,
  reconcileGoalOperations,
  reconstructExactUndo,
} from "../lib/goal-recovery.mjs";
import { createGoalStore } from "../lib/goal-store.mjs";

const linux = process.platform === "linux" ? {} : { skip: "Linux required" };
const hash = "a".repeat(64);

for (const scenario of [
  "delete-capture",
  "write-capture",
  "delete-verified",
  "write-published",
  "create-pending",
  "undo-capture",
  "undo-published",
]) {
  test(`interrupted commit is inspectable and blocks undo: ${scenario}`, linux, (t) => {
    const { home, workspace, store, goalId } = makeFixture(t);
    const target = join(workspace, "transaction-target");
    if (!scenario.startsWith("create")) writeFileSync(target, "ORIGINAL", { mode: 0o640 });
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const [storeUrl, lockUrl, opsUrl, recoveryUrl, home, workspace, id, scenario] = process.argv.slice(1);
      const {createGoalStore}=await import(storeUrl),{withGoalLock}=await import(lockUrl);
      const {prepareEditOperation,applyEditOperation}=await import(opsUrl);
      const {reconstructExactUndo,applyExactUndo}=await import(recoveryUrl);
      const store=createGoalStore(home),f=g=>({goalId:id,generation:g.generation,sequence:g.sequence});
      withGoalLock(workspace,lock=>{
        const initial=store.inspect(id),r=store.beginAttempt(id,{lock,fence:f(initial.goal)});
        const prep=prepareEditOperation({goal:r.goal,attemptId:r.lease.attemptId,generation:r.goal.generation,path:'transaction-target',content:scenario.startsWith('delete')?null:'PLANNED'});
        const auth=s=>({lock,fence:f(s.goal),leaseId:r.lease.leaseId});
        const p=store.append(id,auth(r),'intent',prep.intent,{blobs:prep.blobs});
        store.append(id,auth(p),'dispatch',{...prep.intent,state:'dispatched'});
        let undo;
        if(scenario.startsWith('undo')){applyEditOperation(workspace,prep.intent,prep.afterBytes,{lock,store});undo=reconstructExactUndo(store,id);}
        const rename=fs.renameSync,link=fs.linkSync;
        fs.renameSync=(from,to)=>{
          if(String(to).endsWith('.displaced')&&scenario.endsWith('capture')){
            fs.writeFileSync(workspace+'/transaction-target','EXTERNAL CAPTURED');
            rename(from,to);process.kill(process.pid,'SIGKILL');
          }
          const result=rename(from,to);
          if(String(to).includes('.matrix-transaction-')&&String(to).endsWith('.json')){
            const phase=JSON.parse(fs.readFileSync(to,'utf8')).phase;
            if((scenario.endsWith('verified')&&phase==='verified')||(scenario.endsWith('published')&&phase==='published'))process.kill(process.pid,'SIGKILL');
          }
          return result;
        };
        fs.linkSync=(from,to)=>{if(scenario==='create-pending'&&String(to).endsWith('/transaction-target'))process.kill(process.pid,'SIGKILL');return link(from,to);};
        syncBuiltinESMExports();
        if(undo)applyExactUndo(store,id,undo.undoEntries,{lock});else applyEditOperation(workspace,prep.intent,prep.afterBytes,{lock,store});
      });
    `,
        new URL("../lib/goal-store.mjs", import.meta.url).href,
        new URL("../lib/goal-lock.mjs", import.meta.url).href,
        new URL("../lib/goal-operations.mjs", import.meta.url).href,
        new URL("../lib/goal-recovery.mjs", import.meta.url).href,
        home,
        workspace,
        goalId,
        scenario,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const inventory = fs.readdirSync(workspace).sort();
    const state = reconcileGoalOperations(store, goalId);
    assert.equal(state.canResume, false);
    assert.equal(state.needsAttention, true);
    assert.equal(state.appliedOperations.length, 0);
    assert.equal(state.unresolvedCommits.length, 1);
    const transaction = state.unresolvedCommits[0];
    assert.equal(transaction.path, "transaction-target");
    assert.equal(transaction.action, scenario.startsWith("undo") ? "undo" : "edit");
    assert.equal(
      transaction.retained.every((path) => fs.existsSync(path)),
      true,
    );
    if (scenario.endsWith("capture"))
      assert.equal(
        readFileSync(join(workspace, transaction.displaced), "utf8"),
        "EXTERNAL CAPTURED",
      );
    assert.throws(() => reconstructExactUndo(store, goalId), /unresolved commit/);
    assert.throws(() => applyExactUndo(store, goalId, [], {}), /unresolved commit/);
    assert.deepEqual(fs.readdirSync(workspace).sort(), inventory, "inspection preserves artifacts");
    const reopened = createGoalStore(home);
    assert.deepEqual(
      reconcileGoalOperations(reopened, goalId).unresolvedCommits,
      state.unresolvedCommits,
    );
  });
}

for (const action of ["write", "delete", "create", "undo"]) {
  test(`public ${action} reports stable retention paths and blocks continuation`, linux, (t) => {
    const { workspace, store, goalId } = makeFixture(t);
    const target = join(workspace, "retention-target");
    if (action !== "create") writeFileSync(target, "ORIGINAL", { mode: 0o640 });
    withGoalLock(workspace, (lock) => {
      const r = store.beginAttempt(goalId, { lock, fence: { goalId, generation: 0, sequence: 1 } });
      const prep = prepareEditOperation({
        goal: r.goal,
        attemptId: r.lease.attemptId,
        generation: r.goal.generation,
        path: "retention-target",
        content: action === "delete" ? null : "PLANNED",
      });
      const auth = (s) => ({
        lock,
        fence: { goalId, generation: s.goal.generation, sequence: s.goal.sequence },
        leaseId: r.lease.leaseId,
      });
      const p = store.append(goalId, auth(r), "intent", prep.intent, { blobs: prep.blobs });
      store.append(goalId, auth(p), "dispatch", { ...prep.intent, state: "dispatched" });
      let undo;
      if (action === "undo") {
        applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
        undo = reconstructExactUndo(store, goalId);
      }
      const unlink = fs.unlinkSync;
      fs.unlinkSync = (path) => {
        if (String(path).endsWith(action === "create" ? ".tmp" : ".displaced"))
          throw Object.assign(new Error("cleanup refused"), { code: "EACCES" });
        return unlink(path);
      };
      syncBuiltinESMExports();
      let result;
      try {
        result = undo
          ? applyExactUndo(store, goalId, undo.undoEntries, { lock })
          : applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
      } finally {
        fs.unlinkSync = unlink;
        syncBuiltinESMExports();
      }
      assert.equal(result.ok, true);
      assert.equal(result.cleanupPending, true);
      assert.ok(result.retained.length >= 2);
      assert.equal(
        result.retained.every((path) => fs.existsSync(path) && !path.startsWith("/proc/")),
        true,
      );
      assert.equal(reconcileGoalOperations(store, goalId).needsAttention, true);
      assert.throws(
        () => applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store }),
        /unresolved commit/,
      );
      if (!undo)
        assert.match(
          buildOperationReceipt(prep.intent, { sequence: p.goal.sequence + 2, effect: result })
            .uncertainty.detail,
          /cleanup pending/,
        );
    });
  });
}

test("undo refuses drift during temporary-file sync and retains external bytes", (t) => {
  const { workspace, store, goalId } = makeFixture(t);
  const target = join(workspace, "undo-target");
  writeFileSync(target, "original", { mode: 0o640 });
  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: "undo-target",
      content: "applied",
    });
    const authority = (s) => ({
      lock,
      fence: { goalId, sequence: s.goal.sequence, generation: s.goal.generation },
      leaseId: running.lease.leaseId,
    });
    const prepared = store.append(goalId, authority(running), "intent", prep.intent, {
      blobs: prep.blobs,
    });
    store.append(goalId, authority(prepared), "dispatch", { ...prep.intent, state: "dispatched" });
    applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
    const undo = reconstructExactUndo(store, goalId);
    const originalSync = fs.fsyncSync;
    let injected = false;
    fs.fsyncSync = (fd) => {
      if (!injected && fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith(".tmp")) {
        injected = true;
        writeFileSync(target, "external change");
      }
      return originalSync(fd);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => applyExactUndo(store, goalId, undo.undoEntries, { lock }),
        /diverged before commit/,
      );
    } finally {
      fs.fsyncSync = originalSync;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal(readFileSync(target, "utf8"), "external change");
    assert.equal(statSync(target).mode & 0o777, 0o640);
    assert.equal(
      fs.readdirSync(workspace).some((name) => name.endsWith(".tmp")),
      false,
    );
  });
});

function makeFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "matrix-dur003-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "matrix-dur003-ws-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  const identity = statSync(workspace, { bigint: true });
  const record = {
    schemaVersion: 1,
    id: newGoalId(),
    createdAt: Date.now(),
    objective: "DUR-003 Effect reconciliation and exact undo",
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
  const created = store.create(record);
  return { home, workspace, record: created, store, goalId: created.id };
}

test(
  "CR-04: real subprocess SIGKILL after file write but before receipt sync preserves after image and recovers exact undo",
  { ...linux, timeout: 15_000 },
  async (t) => {
    const { home, workspace, goalId } = makeFixture(t);
    const targetRel = "src/important.txt";
    mkdirSync(join(workspace, "src"));
    const originalContent = "original pre-crash bytes\r\n";
    writeFileSync(join(workspace, targetRel), originalContent, { mode: 0o751 });

    const worker = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import fs from "node:fs";
        const [storeUrl, lockUrl, opsUrl, home, workspace, goalId, targetRel] = process.argv.slice(1);
        const { createGoalStore } = await import(storeUrl);
        const { withGoalLock } = await import(lockUrl);
        const { prepareEditOperation, applyEditOperation } = await import(opsUrl);

        const store = createGoalStore(home);
        const fence = (goal) => ({ goalId, sequence: goal.sequence, generation: goal.generation });

        withGoalLock(workspace, (lock) => {
          const snapshot = store.inspect(goalId);
          const running = store.beginAttempt(goalId, { lock, fence: fence(snapshot.goal) });
          const auth = {
            lock,
            fence: fence(running.goal),
            leaseId: running.lease.leaseId,
          };

          // 1. Prepare validated edit intent & recovery blobs
          const prep = prepareEditOperation({
            goal: running.goal,
            attemptId: running.lease.attemptId,
            generation: running.goal.generation,
            path: targetRel,
            content: "after crash content\\r\\n",
            mode: 0o755,
          });

          // 2. Append intent and dispatch to store
          const afterIntent = store.append(goalId, auth, "intent", prep.intent, { blobs: prep.blobs });
          const authDispatch = { lock, fence: fence(afterIntent.goal), leaseId: running.lease.leaseId };
          store.append(goalId, authDispatch, "dispatch", { ...prep.intent, state: "dispatched" });

          // 3. Perform file write effect in workspace
          applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });

          // 4. Barrier: inform parent that file write has succeeded, then wait to be killed
          fs.writeSync(1, "FILE_WRITTEN\\n");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
        });
      `,
        new URL("../lib/goal-store.mjs", import.meta.url).href,
        new URL("../lib/goal-lock.mjs", import.meta.url).href,
        new URL("../lib/goal-operations.mjs", import.meta.url).href,
        home,
        workspace,
        goalId,
        targetRel,
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
      closed.then(() => [Buffer.from("worker died early")]),
    ]);
    assert.match(marker.toString("utf8"), /FILE_WRITTEN/);

    // Kill the worker with SIGKILL before receipt can be saved!
    worker.kill("SIGKILL");
    await closed;

    // Fresh process / reopening inspects state
    const reopenStore = createGoalStore(home);
    const journal = reopenStore.readJournal(goalId);

    // Verify journal has intent and dispatch, but NO receipt
    const hasIntent = journal.some((r) => r.kind === "intent");
    const hasDispatch = journal.some((r) => r.kind === "dispatch");
    const hasReceipt = journal.some((r) => r.kind === "receipt");
    assert.equal(hasIntent, true);
    assert.equal(hasDispatch, true);
    assert.equal(hasReceipt, false);

    // Workspace file on disk has the new content
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "after crash content\r\n");

    // Reconcile operations: recognizes applied edit without rewriting
    const reconciliation = reconcileGoalOperations(reopenStore, goalId);
    assert.equal(reconciliation.needsAttention, false);
    assert.equal(reconciliation.appliedOperations.length, 1);
    const op = reconciliation.appliedOperations[0];
    assert.equal(op.observedApplied, true);
    assert.equal(op.unacknowledgedReceipt, true);
    assert.equal(op.fileState, "applied");

    // Reconstruct exact undo from durable store recovery blobs
    const undoData = reconstructExactUndo(reopenStore, goalId);
    assert.equal(undoData.count, 1);
    assert.equal(undoData.undoEntries.length, 1);
    const undoEntry = undoData.undoEntries[0];
    assert.equal(undoEntry.path, targetRel);
    assert.equal(undoEntry.originalBytes.toString("utf8"), originalContent);
    assert.equal(undoEntry.originalMode, 0o751);

    // Execute exact undo and verify file is restored to exact pre-crash bytes and mode
    withGoalLock(workspace, (lock) => {
      const undoResult = applyExactUndo(reopenStore, goalId, undoData.undoEntries, {
        workspaceRoot: workspace,
        lock,
      });
      assert.equal(undoResult.ok, true);
      assert.deepEqual(undoResult.restored, [targetRel]);
      assert.equal(readFileSync(join(workspace, targetRel), "utf8"), originalContent);
      assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o751);
    });
  },
);

test("CR-03: crash after edit intent before write keeps before image; pending effect requires fresh authority", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "pending-edit.txt";
  const beforeContent = "unmodified bytes\n";
  writeFileSync(join(workspace, targetRel), beforeContent, { mode: 0o644 });

  let intent;
  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "never written\n",
    });
    intent = prep.intent;

    store.append(
      goalId,
      {
        lock,
        fence: { goalId, sequence: running.goal.sequence, generation: running.goal.generation },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    // Process "crashes" here before dispatch or file write
  });

  // Reopen and reconcile
  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);

  // File on disk is untouched
  assert.equal(readFileSync(join(workspace, targetRel), "utf8"), beforeContent);

  // Reconciled as pending, not applied
  assert.equal(reconciliation.appliedOperations.length, 0);
  assert.equal(reconciliation.pendingOperations.length, 1);
  const pendingOp = reconciliation.pendingOperations[0];
  assert.equal(pendingOp.observedApplied, false);
  assert.equal(pendingOp.status, "pending");
  assert.equal(pendingOp.requiresFreshAuthority, true);

  // CR-07: Resumed attempt in Generation 2 requires fresh authority; old intent authority is stale
  const freshness = checkOperationAuthorityFreshness(intent, "new_attempt_id", 2);
  assert.equal(freshness.valid, false);
  assert.match(freshness.reason, /fresh authority is required/);
});

test("CR-05: partial multi-file edits report exact partial state and undo only applied files", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const file1 = "first.txt";
  const file2 = "second.txt";
  writeFileSync(join(workspace, file1), "first original\n", { mode: 0o644 });
  writeFileSync(join(workspace, file2), "second original\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    let curSeq = running.goal.sequence;

    // Operation 1 on file1: applied and dispatched
    const prep1 = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: file1,
      content: "first applied\n",
    });
    const auth1 = {
      lock,
      fence: { goalId, sequence: curSeq, generation: 1 },
      leaseId: running.lease.leaseId,
    };
    const s1 = store.append(goalId, auth1, "intent", prep1.intent, { blobs: prep1.blobs });
    curSeq = s1.goal.sequence;
    const auth1d = {
      lock,
      fence: { goalId, sequence: curSeq, generation: 1 },
      leaseId: running.lease.leaseId,
    };
    const s1d = store.append(goalId, auth1d, "dispatch", { ...prep1.intent, state: "dispatched" });
    curSeq = s1d.goal.sequence;
    applyEditOperation(workspace, prep1.intent, prep1.afterBytes, { lock, store });

    // Operation 2 on file2: intent appended, but crashed before write or dispatch
    const prep2 = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: file2,
      content: "second pending\n",
    });
    const auth2 = {
      lock,
      fence: { goalId, sequence: curSeq, generation: 1 },
      leaseId: running.lease.leaseId,
    };
    store.append(goalId, auth2, "intent", prep2.intent, { blobs: prep2.blobs });
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);

  assert.equal(reconciliation.appliedOperations.length, 1);
  assert.equal(reconciliation.appliedOperations[0].path, file1);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.equal(reconciliation.pendingOperations[0].path, file2);

  // Exact undo reconstructs undo ONLY for file1
  const undoData = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undoData.undoEntries.length, 1);
  assert.equal(undoData.undoEntries[0].path, file1);

  // Apply undo restores file1, keeps file2 untouched
  withGoalLock(workspace, (lock) => {
    applyExactUndo(reopenStore, goalId, undoData.undoEntries, { workspaceRoot: workspace, lock });
  });
  assert.equal(readFileSync(join(workspace, file1), "utf8"), "first original\n");
  assert.equal(readFileSync(join(workspace, file2), "utf8"), "second original\n");
});

test("CR-06: repeated edits to same file preserve original pre-goal bytes and order", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "counter.txt";
  const v0 = "count: 0\r\n";
  writeFileSync(join(workspace, targetRel), v0, { mode: 0o755 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    let curSeq = running.goal.sequence;

    // Edit 1: v0 -> v1
    const prep1 = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: 1,
      path: targetRel,
      content: "count: 1\r\n",
    });
    const s1 = store.append(
      goalId,
      { lock, fence: { goalId, sequence: curSeq, generation: 1 }, leaseId: running.lease.leaseId },
      "intent",
      prep1.intent,
      { blobs: prep1.blobs },
    );
    curSeq = s1.goal.sequence;
    const s1d = store.append(
      goalId,
      { lock, fence: { goalId, sequence: curSeq, generation: 1 }, leaseId: running.lease.leaseId },
      "dispatch",
      { ...prep1.intent, state: "dispatched" },
    );
    curSeq = s1d.goal.sequence;
    applyEditOperation(workspace, prep1.intent, prep1.afterBytes, { lock, store });
    const receipt1 = buildOperationReceipt(prep1.intent, { sequence: curSeq + 1 });
    const s1r = store.append(
      goalId,
      { lock, fence: { goalId, sequence: curSeq, generation: 1 }, leaseId: running.lease.leaseId },
      "receipt",
      receipt1,
    );
    curSeq = s1r.goal.sequence;

    // Edit 2: v1 -> v2
    const prep2 = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: 1,
      path: targetRel,
      content: "count: 2\r\n",
    });
    const s2 = store.append(
      goalId,
      { lock, fence: { goalId, sequence: curSeq, generation: 1 }, leaseId: running.lease.leaseId },
      "intent",
      prep2.intent,
      { blobs: prep2.blobs },
    );
    store.append(
      goalId,
      {
        lock,
        fence: { goalId, sequence: s2.goal.sequence, generation: 1 },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep2.intent, state: "dispatched" },
    );
    applyEditOperation(workspace, prep2.intent, prep2.afterBytes, { lock, store });
    // Crash before receipt of Edit 2
  });

  const reopenStore = createGoalStore(home);
  const undoData = reconstructExactUndo(reopenStore, goalId);

  // Both edits applied: undo stack has 2 entries (v2 -> v1, then v1 -> v0)
  assert.equal(undoData.undoEntries.length, 2);
  assert.equal(undoData.undoEntries[0].originalBytes.toString("utf8"), "count: 1\r\n");
  assert.equal(undoData.undoEntries[1].originalBytes.toString("utf8"), "count: 0\r\n");

  // Pre-goal original state is preserved as v0
  assert.equal(undoData.prestate[targetRel].originalBytes.toString("utf8"), v0);
  assert.equal(undoData.prestate[targetRel].originalMode, 0o755);

  withGoalLock(workspace, (lock) => {
    // Execute undo step 1: reverts from v2 back to v1
    applyExactUndo(reopenStore, goalId, [undoData.undoEntries[0]], {
      workspaceRoot: workspace,
      lock,
    });
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "count: 1\r\n");

    // Execute undo step 2: reverts from v1 back to initial pre-goal v0
    applyExactUndo(reopenStore, goalId, [undoData.undoEntries[1]], {
      workspaceRoot: workspace,
      lock,
    });
    assert.equal(readFileSync(join(workspace, targetRel), "utf8"), v0);
    assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o755);
  });
});

test("CR-08 & CR-09: interrupted tests are uncertain and workspace drift invalidates verification", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const sourceRel = "src/code.js";
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, sourceRel), "function add(a,b){return a+b;}\n");

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const curSeq = running.goal.sequence;

    // Test operation started but crashed without receipt
    const testOp = prepareOperationIntent({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: 1,
      kind: "test",
      args: { command: "npm test" },
    });

    store.append(
      goalId,
      { lock, fence: { goalId, sequence: curSeq, generation: 1 }, leaseId: running.lease.leaseId },
      "intent",
      testOp.intent,
    );
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);

  // CR-08: Interrupted test is uncertain; no false test success is inferred
  const testRecord = reconciliation.operations.find((op) => op.kind === "test");
  assert.equal(testRecord.status, "uncertain");
  assert.equal(testRecord.observedApplied, false);

  // CR-09: Drift detection: capture baseline, then modify source file
  const baseline = captureWorkspaceFingerprints(workspace, [sourceRel]);
  assert.equal(detectWorkspaceDrift(workspace, baseline).drifted, false);
  // Modify source file
  writeFileSync(join(workspace, sourceRel), "function add(a,b){return a*b;}\n");
  const driftAfter = detectWorkspaceDrift(workspace, baseline);
  assert.equal(driftAfter.drifted, true);
  assert.equal(driftAfter.changed[0].path, sourceRel);
  assert.equal(driftAfter.changed[0].reason, "content-changed");
});

test("CR-14: file reconciliation detects symlinks, FIFOs, and directory type changes", (t) => {
  const { workspace } = makeFixture(t);

  // 1. Target is a symlink
  const target = join(workspace, "real.txt");
  writeFileSync(target, "real");
  const symlink = join(workspace, "sym.txt");
  symlinkSync(target, symlink);

  const symRec = reconcileFile(workspace, "sym.txt", {
    before: { exists: true, sha256: hash, mode: 0o644 },
    after: { exists: true, sha256: "b".repeat(64), mode: 0o644 },
  });
  assert.equal(symRec.state, "type-changed");
  assert.equal(symRec.substate, "symlink");

  // 2. Target is a directory
  mkdirSync(join(workspace, "dir.txt"));
  const dirRec = reconcileFile(workspace, "dir.txt", {
    before: { exists: false, sha256: null, mode: null },
    after: { exists: true, sha256: hash, mode: 0o644 },
  });
  assert.equal(dirRec.state, "type-changed");
  assert.equal(dirRec.substate, "directory");

  // 3. Target is a FIFO (nonblocking)
  if (process.platform === "linux") {
    const fifo = join(workspace, "fifo.txt");
    const res = spawnSync("mkfifo", ["-m", "600", fifo], { timeout: 2000 });
    if (res.status === 0) {
      const fifoRec = reconcileFile(workspace, "fifo.txt", {
        before: { exists: false, sha256: null, mode: null },
        after: { exists: true, sha256: hash, mode: 0o600 },
      });
      assert.equal(fifoRec.state, "type-changed");
    }
  }

  // 4. Missing file
  const missingRec = reconcileFile(workspace, "nonexistent.txt", {
    before: { exists: true, sha256: hash, mode: 0o644 },
    after: { exists: true, sha256: "b".repeat(64), mode: 0o644 },
  });
  assert.equal(missingRec.state, "missing");
});

test("CR-19: exact undo preserves CRLF, no-final-newline, empty originals, and refuses corrupted blobs", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);

  // File A: CRLF line endings
  const crlfRel = "crlf.txt";
  const crlfContent = "line 1\r\nline 2\r\n";
  writeFileSync(join(workspace, crlfRel), crlfContent, { mode: 0o644 });

  // File B: Missing trailing newline
  const noNlRel = "no-nl.txt";
  const noNlContent = "no trailing newline";
  writeFileSync(join(workspace, noNlRel), noNlContent, { mode: 0o644 });

  // File C: Empty original (0 bytes)
  const emptyRel = "empty.txt";
  writeFileSync(join(workspace, emptyRel), Buffer.alloc(0), { mode: 0o640 });

  // File D: Creation
  const newRel = "created.txt";

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    let curSeq = running.goal.sequence;

    for (const [path, content, mode] of [
      [crlfRel, "crlf updated\r\n", 0o644],
      [noNlRel, "no nl updated", 0o644],
      [emptyRel, "now full", 0o640],
      [newRel, "newly created\n", 0o755],
    ]) {
      const prep = prepareEditOperation({
        goal: running.goal,
        attemptId: running.lease.attemptId,
        generation: 1,
        path,
        content,
        mode,
      });
      const s = store.append(
        goalId,
        {
          lock,
          fence: { goalId, sequence: curSeq, generation: 1 },
          leaseId: running.lease.leaseId,
        },
        "intent",
        prep.intent,
        { blobs: prep.blobs },
      );
      curSeq = s.goal.sequence;
      const sd = store.append(
        goalId,
        {
          lock,
          fence: { goalId, sequence: curSeq, generation: 1 },
          leaseId: running.lease.leaseId,
        },
        "dispatch",
        { ...prep.intent, state: "dispatched" },
      );
      curSeq = sd.goal.sequence;
      applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
      const receipt = buildOperationReceipt(prep.intent, { sequence: curSeq + 1 });
      const sr = store.append(
        goalId,
        {
          lock,
          fence: { goalId, sequence: curSeq, generation: 1 },
          leaseId: running.lease.leaseId,
        },
        "receipt",
        receipt,
      );
      curSeq = sr.goal.sequence;
    }
  });

  const reopenStore = createGoalStore(home);
  const undoData = reconstructExactUndo(reopenStore, goalId);

  // 1. Verify exact undo restores CRLF byte-for-byte
  const crlfEntry = undoData.undoEntries.find((e) => e.path === crlfRel);
  assert.equal(crlfEntry.originalBytes.toString("utf8"), crlfContent);

  // 2. Verify exact undo restores missing final newline byte-for-byte
  const noNlEntry = undoData.undoEntries.find((e) => e.path === noNlRel);
  assert.equal(noNlEntry.originalBytes.toString("utf8"), noNlContent);

  // 3. Verify empty original restores 0-byte file without unlinking
  const emptyEntry = undoData.undoEntries.find((e) => e.path === emptyRel);
  assert.equal(emptyEntry.isCreation, false);
  assert.equal(emptyEntry.originalBytes.length, 0);

  // 4. Verify creation unlinks the created file
  const createdEntry = undoData.undoEntries.find((e) => e.path === newRel);
  assert.equal(createdEntry.isCreation, true);

  withGoalLock(workspace, (lock) => {
    // Apply all undos
    applyExactUndo(reopenStore, goalId, undoData.undoEntries, { workspaceRoot: workspace, lock });

    assert.equal(readFileSync(join(workspace, crlfRel), "utf8"), crlfContent);
    assert.equal(readFileSync(join(workspace, noNlRel), "utf8"), noNlContent);
    assert.equal(readFileSync(join(workspace, emptyRel)).length, 0);
    assert.equal(statSync(join(workspace, emptyRel)).mode & 0o777, 0o640);

    // Created file should now be deleted
    assert.throws(() => statSync(join(workspace, newRel)), { code: "ENOENT" });

    // 5. Corrupted recovery blob refusal: if blob bytes do not match expected hash, refuse
    writeFileSync(join(workspace, crlfRel), "crlf updated\r\n");
    const corruptEntry = {
      ...crlfEntry,
      originalBytes: Buffer.from("tampered bytes"),
    };
    assert.throws(
      () =>
        applyExactUndo(reopenStore, goalId, [corruptEntry], {
          workspaceRoot: workspace,
          lock,
        }),
      /backup integrity check failed/,
    );

    // 6. Diverged target refusal: if file changed externally after edit, refuse
    writeFileSync(join(workspace, crlfRel), "external change");
    assert.throws(
      () =>
        applyExactUndo(reopenStore, goalId, [crlfEntry], {
          workspaceRoot: workspace,
          lock,
        }),
      /target file diverged/,
    );
  });
});

test("CR-16: cancellation stops new actions, reconciles prior effects, and late callbacks fail fence", (t) => {
  const { workspace, store, goalId } = makeFixture(t);
  const targetRel = "cancel-test.txt";
  writeFileSync(join(workspace, targetRel), "initial\n", { mode: 0o644 });

  let staleAuthority;
  let prep;
  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    staleAuthority = {
      lock,
      fence: { goalId, sequence: running.goal.sequence, generation: 1 },
      leaseId: running.lease.leaseId,
    };

    prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: 1,
      path: targetRel,
      content: "applied before cancel\n",
    });

    const s = store.append(goalId, staleAuthority, "intent", prep.intent, { blobs: prep.blobs });
    const authDispatch = {
      lock,
      fence: { goalId, sequence: s.goal.sequence, generation: 1 },
      leaseId: running.lease.leaseId,
    };
    store.append(goalId, authDispatch, "dispatch", { ...prep.intent, state: "dispatched" });
    applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });

    // Cancel the goal
    const authCancel = {
      lock,
      fence: { goalId, sequence: s.goal.sequence + 1, generation: 1 },
      leaseId: running.lease.leaseId,
    };
    store.transition(goalId, authCancel, "cancelled");
  });

  // Goal is cancelled
  const current = store.inspect(goalId);
  assert.equal(current.goal.state, "cancelled");

  // Reconcile: dispatched effects before cancellation are recognized and reconciled
  const reconciliation = reconcileGoalOperations(store, goalId);
  assert.equal(reconciliation.appliedOperations.length, 1);
  assert.equal(reconciliation.appliedOperations[0].path, targetRel);
  assert.equal(reconciliation.appliedOperations[0].observedApplied, true);

  // Exact undo remains reconstructable and can undo the change even for cancelled goals
  const undoData = reconstructExactUndo(store, goalId);
  assert.equal(undoData.undoEntries.length, 1);
  withGoalLock(workspace, (lock) => {
    applyExactUndo(store, goalId, undoData.undoEntries, { workspaceRoot: workspace, lock });
  });
  assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "initial\n");

  // Late callback from cancelled attempt trying to append a receipt or new intent fails
  withGoalLock(workspace, (_lock) => {
    assert.throws(
      () =>
        store.append(
          goalId,
          staleAuthority,
          "receipt",
          buildOperationReceipt(prep.intent, { sequence: 99 }),
        ),
      /stale or missing writer lease|operation requires a running attempt|invalid goal contract/,
    );
  });
});

test("provenance: reconciliation requires committed dispatch before matching bytes are classified applied", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "target.txt";
  writeFileSync(join(workspace, targetRel), "ORIGINAL CONTENT\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "PLANNED AFTER BYTES\n",
    });
    // Append intent ONLY — do NOT dispatch
    store.append(
      goalId,
      {
        lock,
        fence: { goalId, sequence: running.goal.sequence, generation: running.goal.generation },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
  });

  // External actor writes the matching after-image bytes
  writeFileSync(join(workspace, targetRel), "PLANNED AFTER BYTES\n");

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);

  // Provenance boundary: matching bytes without dispatch MUST NOT be classified applied
  assert.equal(reconciliation.appliedOperations.length, 0);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "divergent");
  assert.equal(
    reconciliation.fileReconciliations[targetRel].substate,
    "matches-undispatched-after",
  );

  // Reconstruct exact undo: must NOT contain undo entries for undispatched intent
  const undoData = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undoData.count, 0);
  assert.equal(undoData.undoEntries.length, 0);

  // Apply undo: leaves external matching bytes untouched
  withGoalLock(workspace, (lock) => {
    const undoRes = applyExactUndo(reopenStore, goalId, undoData.undoEntries, {
      workspaceRoot: workspace,
      lock,
    });
    assert.deepEqual(undoRes.restored, []);
  });
  assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "PLANNED AFTER BYTES\n");
});

test("provenance: undispatched creation whose target appears externally is classified divergent and not deleted", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "external-create.txt";

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "external create content\n",
      mode: 0o640,
    });
    assert.equal(prep.intent.edit.before.exists, false);

    // Append intent ONLY — do NOT dispatch
    store.append(
      goalId,
      {
        lock,
        fence: { goalId, sequence: running.goal.sequence, generation: running.goal.generation },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
  });

  // Target file appears externally
  writeFileSync(join(workspace, targetRel), "external create content\n", { mode: 0o640 });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);

  assert.equal(reconciliation.appliedOperations.length, 0);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "divergent");
  assert.equal(
    reconciliation.fileReconciliations[targetRel].substate,
    "matches-undispatched-after",
  );

  const undoData = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undoData.count, 0);
  assert.equal(undoData.undoEntries.length, 0);

  // Undo must not delete the external file
  withGoalLock(workspace, (lock) => {
    applyExactUndo(reopenStore, goalId, undoData.undoEntries, { workspaceRoot: workspace, lock });
  });
  assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "external create content\n");
  assert.equal(statSync(join(workspace, targetRel)).mode & 0o777, 0o640);
});

test("applyExactUndo requires held workspace lock and refuses execution without lock", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "undo-lock.txt";
  writeFileSync(join(workspace, targetRel), "original\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: 1,
      path: targetRel,
      content: "modified\n",
    });
    const s = store.append(
      goalId,
      {
        lock,
        fence: { goalId, sequence: running.goal.sequence, generation: 1 },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goalId,
      {
        lock,
        fence: { goalId, sequence: s.goal.sequence, generation: 1 },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );
    applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
  });

  const reopenStore = createGoalStore(home);
  const undoData = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undoData.count, 1);

  // Calling applyExactUndo without lock must throw and leave file unchanged
  assert.throws(
    () => applyExactUndo(reopenStore, goalId, undoData.undoEntries, { workspaceRoot: workspace }),
    /applyExactUndo requires a held workspace lock/,
  );
  assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "modified\n");
});

test("applyExactUndo refuses execution on workspace identity replacement", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "ws-replace.txt";
  writeFileSync(join(workspace, targetRel), "original\n", { mode: 0o644 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: 1,
      path: targetRel,
      content: "modified\n",
    });
    const s = store.append(
      goalId,
      {
        lock,
        fence: { goalId, sequence: running.goal.sequence, generation: 1 },
        leaseId: running.lease.leaseId,
      },
      "intent",
      prep.intent,
      { blobs: prep.blobs },
    );
    store.append(
      goalId,
      {
        lock,
        fence: { goalId, sequence: s.goal.sequence, generation: 1 },
        leaseId: running.lease.leaseId,
      },
      "dispatch",
      { ...prep.intent, state: "dispatched" },
    );
    applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
  });

  const reopenStore = createGoalStore(home);
  const undoData = reconstructExactUndo(reopenStore, goalId);

  const fakeWs = mkdtempSync(join(tmpdir(), "matrix-fake-undo-ws-"));
  t.after(() => rmSync(fakeWs, { recursive: true, force: true }));

  withGoalLock(workspace, (lock) => {
    assert.throws(
      () =>
        applyExactUndo(reopenStore, goalId, undoData.undoEntries, {
          workspaceRoot: fakeWs,
          lock,
        }),
      /workspace identity changed|workspace root path mismatch/,
    );
  });
  assert.equal(readFileSync(join(workspace, targetRel), "utf8"), "modified\n");
});

function authorityFor(goalId, lock, attempt, snapshot) {
  return {
    lock,
    fence: { goalId, sequence: snapshot.goal.sequence, generation: snapshot.goal.generation },
    leaseId: attempt.lease.leaseId,
  };
}

function beginRunningAttempt(store, goalId, lock) {
  const current = store.inspect(goalId);
  const begun = store.beginAttempt(goalId, {
    lock,
    fence: { goalId, sequence: current.goal.sequence, generation: current.goal.generation },
  });
  if (begun.goal.state === "running") return begun;
  return store.transition(goalId, authorityFor(goalId, lock, begun, begun), "running");
}

function appendIntent(store, goalId, lock, attempt, prep, snapshot) {
  return store.append(
    goalId,
    authorityFor(goalId, lock, attempt, snapshot),
    "intent",
    prep.intent,
    {
      blobs: prep.blobs,
    },
  );
}

function appendDispatch(store, goalId, lock, attempt, prep, snapshot) {
  return store.append(goalId, authorityFor(goalId, lock, attempt, snapshot), "dispatch", {
    ...prep.intent,
    state: "dispatched",
  });
}

function appendReceipt(store, goalId, lock, attempt, prep, snapshot) {
  return store.append(
    goalId,
    authorityFor(goalId, lock, attempt, snapshot),
    "receipt",
    buildOperationReceipt(prep.intent, { sequence: snapshot.goal.sequence + 1 }),
  );
}

function matrixArtifacts(workspace) {
  return fs.readdirSync(workspace).filter((name) => name.startsWith(".matrix-"));
}

test("B1: reconciliation continues past an abandoned undispatched intent to a later dispatched edit", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "cross-attempt.txt";
  const target = join(workspace, targetRel);
  const original = "V0 original\r\n";
  writeFileSync(target, original, { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const first = beginRunningAttempt(store, goalId, lock);
    const abandoned = prepareEditOperation({
      goal: first.goal,
      attemptId: first.lease.attemptId,
      generation: first.goal.generation,
      path: targetRel,
      content: "V1 abandoned\n",
    });
    const firstIntent = appendIntent(store, goalId, lock, first, abandoned, first);
    store.transition(goalId, authorityFor(goalId, lock, first, firstIntent), "interrupted");

    const second = beginRunningAttempt(store, goalId, lock);
    const fresh = prepareEditOperation({
      goal: second.goal,
      attemptId: second.lease.attemptId,
      generation: second.goal.generation,
      path: targetRel,
      content: "V2 committed\n",
    });
    const secondIntent = appendIntent(store, goalId, lock, second, fresh, second);
    const secondDispatch = appendDispatch(store, goalId, lock, second, fresh, secondIntent);
    applyEditOperation(workspace, fresh.intent, fresh.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, second, fresh, secondDispatch);
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "applied");
  assert.equal(reconciliation.fileReconciliations[targetRel].substate, "matches-after");
  assert.equal(reconciliation.appliedOperations.length, 1);
  assert.equal(reconciliation.pendingOperations.length, 1);
  const applied = reconciliation.appliedOperations[0];
  assert.equal(applied.status, "succeeded");
  assert.equal(applied.observedApplied, true);
  assert.equal(applied.receipt.status, "succeeded");

  const undo = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undo.count, 1);
  assert.equal(undo.undoEntries[0].originalBytes.toString("utf8"), original);
  assert.equal(undo.undoEntries[0].originalMode, 0o640);

  withGoalLock(workspace, (lock) => {
    applyExactUndo(reopenStore, goalId, undo.undoEntries, { workspaceRoot: workspace, lock });
  });
  assert.equal(readFileSync(target, "utf8"), original);
  assert.equal(statSync(target).mode & 0o777, 0o640);
  assert.deepEqual(matrixArtifacts(workspace), []);
});

test("B1: creation dispatched by a later attempt remains undoable after an abandoned creation", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "cross-attempt-create.txt";
  const target = join(workspace, targetRel);

  withGoalLock(workspace, (lock) => {
    const first = beginRunningAttempt(store, goalId, lock);
    const abandoned = prepareEditOperation({
      goal: first.goal,
      attemptId: first.lease.attemptId,
      generation: first.goal.generation,
      path: targetRel,
      content: "abandoned creation\n",
      mode: 0o640,
    });
    const firstIntent = appendIntent(store, goalId, lock, first, abandoned, first);
    store.transition(goalId, authorityFor(goalId, lock, first, firstIntent), "interrupted");

    const second = beginRunningAttempt(store, goalId, lock);
    const fresh = prepareEditOperation({
      goal: second.goal,
      attemptId: second.lease.attemptId,
      generation: second.goal.generation,
      path: targetRel,
      content: "committed creation\n",
      mode: 0o751,
    });
    assert.equal(fresh.intent.edit.before.exists, false);
    const secondIntent = appendIntent(store, goalId, lock, second, fresh, second);
    const secondDispatch = appendDispatch(store, goalId, lock, second, fresh, secondIntent);
    applyEditOperation(workspace, fresh.intent, fresh.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, second, fresh, secondDispatch);
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);
  assert.equal(reconciliation.appliedOperations.length, 1);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "applied");

  const undo = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undo.count, 1);
  assert.equal(undo.undoEntries[0].isCreation, true);

  withGoalLock(workspace, (lock) => {
    applyExactUndo(reopenStore, goalId, undo.undoEntries, { workspaceRoot: workspace, lock });
  });
  assert.throws(() => statSync(target), { code: "ENOENT" });
  assert.deepEqual(matrixArtifacts(workspace), []);
});

test("B1: deletion dispatched by a later attempt restores exact bytes and mode", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "cross-attempt-delete.txt";
  const target = join(workspace, targetRel);
  const original = "delete me\r\nwithout final newline";
  writeFileSync(target, original, { mode: 0o751 });

  withGoalLock(workspace, (lock) => {
    const first = beginRunningAttempt(store, goalId, lock);
    const abandoned = prepareEditOperation({
      goal: first.goal,
      attemptId: first.lease.attemptId,
      generation: first.goal.generation,
      path: targetRel,
      content: null,
    });
    const firstIntent = appendIntent(store, goalId, lock, first, abandoned, first);
    store.transition(goalId, authorityFor(goalId, lock, first, firstIntent), "interrupted");

    const second = beginRunningAttempt(store, goalId, lock);
    const fresh = prepareEditOperation({
      goal: second.goal,
      attemptId: second.lease.attemptId,
      generation: second.goal.generation,
      path: targetRel,
      content: null,
    });
    const secondIntent = appendIntent(store, goalId, lock, second, fresh, second);
    const secondDispatch = appendDispatch(store, goalId, lock, second, fresh, secondIntent);
    applyEditOperation(workspace, fresh.intent, null, { lock, store });
    appendReceipt(store, goalId, lock, second, fresh, secondDispatch);
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);
  assert.equal(reconciliation.appliedOperations.length, 1);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "applied");
  assert.equal(reconciliation.fileReconciliations[targetRel].substate, "matches-after");

  const undo = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undo.count, 1);
  assert.equal(undo.undoEntries[0].isDeletion, true);
  assert.equal(undo.undoEntries[0].originalBytes.toString("utf8"), original);
  assert.equal(undo.undoEntries[0].originalMode, 0o751);

  withGoalLock(workspace, (lock) => {
    applyExactUndo(reopenStore, goalId, undo.undoEntries, { workspaceRoot: workspace, lock });
  });
  assert.equal(readFileSync(target, "utf8"), original);
  assert.equal(statSync(target).mode & 0o777, 0o751);
  assert.deepEqual(matrixArtifacts(workspace), []);
});

test("B1: a dispatched-but-unapplied branch does not hide a later branch resumed from an earlier image", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "cross-attempt-branch.txt";
  const original = "branch original\n";
  writeFileSync(join(workspace, targetRel), original, { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const first = beginRunningAttempt(store, goalId, lock);
    const branch = prepareEditOperation({
      goal: first.goal,
      attemptId: first.lease.attemptId,
      generation: first.goal.generation,
      path: targetRel,
      content: "V1 dispatched but unapplied\n",
    });
    const branchIntent = appendIntent(store, goalId, lock, first, branch, first);
    const branchDispatch = appendDispatch(store, goalId, lock, first, branch, branchIntent);
    store.transition(goalId, authorityFor(goalId, lock, first, branchDispatch), "interrupted");

    const second = beginRunningAttempt(store, goalId, lock);
    const fresh = prepareEditOperation({
      goal: second.goal,
      attemptId: second.lease.attemptId,
      generation: second.goal.generation,
      path: targetRel,
      content: "V2 resumed from V0\n",
    });
    assert.equal(fresh.intent.edit.before.sha256, branch.intent.edit.before.sha256);
    const secondIntent = appendIntent(store, goalId, lock, second, fresh, second);
    const secondDispatch = appendDispatch(store, goalId, lock, second, fresh, secondIntent);
    applyEditOperation(workspace, fresh.intent, fresh.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, second, fresh, secondDispatch);
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);
  assert.equal(reconciliation.appliedOperations.length, 1);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "applied");
  assert.equal(reconciliation.fileReconciliations[targetRel].substate, "matches-after");

  const undo = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undo.count, 1);
  assert.equal(undo.undoEntries[0].originalBytes.toString("utf8"), original);
});

test("B1: discontinuous dispatched history stops attribution instead of claiming external bytes", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "cross-attempt-discontinuous.txt";
  const target = join(workspace, targetRel);
  writeFileSync(target, "V0\n", { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const first = beginRunningAttempt(store, goalId, lock);
    const applied = prepareEditOperation({
      goal: first.goal,
      attemptId: first.lease.attemptId,
      generation: first.goal.generation,
      path: targetRel,
      content: "V1 applied without receipt\n",
    });
    const intent = appendIntent(store, goalId, lock, first, applied, first);
    const dispatch = appendDispatch(store, goalId, lock, first, applied, intent);
    applyEditOperation(workspace, applied.intent, applied.afterBytes, { lock, store });
    store.transition(goalId, authorityFor(goalId, lock, first, dispatch), "interrupted");
  });

  // External bytes land between attempts, so the later intent's before image is
  // not connected to any reachable checkpoint.
  writeFileSync(target, "EXTERNAL BETWEEN ATTEMPTS\n", { mode: 0o600 });

  withGoalLock(workspace, (lock) => {
    const second = beginRunningAttempt(store, goalId, lock);
    const fresh = prepareEditOperation({
      goal: second.goal,
      attemptId: second.lease.attemptId,
      generation: second.goal.generation,
      path: targetRel,
      content: "V2 from external bytes\n",
    });
    const secondIntent = appendIntent(store, goalId, lock, second, fresh, second);
    appendDispatch(store, goalId, lock, second, fresh, secondIntent);
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);
  assert.equal(reconciliation.appliedOperations.length, 0);
  assert.equal(reconciliation.pendingOperations.length, 2);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "divergent");
  assert.equal(reconciliation.fileReconciliations[targetRel].substate, "matches-neither");
  assert.equal(reconstructExactUndo(reopenStore, goalId).count, 0);
});

test("B1: an undispatched after-image cannot displace a genuinely dispatched chain with identical bytes", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "cross-attempt-same-bytes.txt";
  const target = join(workspace, targetRel);
  const original = "V0 same bytes\n";
  writeFileSync(target, original, { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const first = beginRunningAttempt(store, goalId, lock);
    const abandoned = prepareEditOperation({
      goal: first.goal,
      attemptId: first.lease.attemptId,
      generation: first.goal.generation,
      path: targetRel,
      content: "V1 same bytes\n",
    });
    const firstIntent = appendIntent(store, goalId, lock, first, abandoned, first);
    store.transition(goalId, authorityFor(goalId, lock, first, firstIntent), "interrupted");

    const second = beginRunningAttempt(store, goalId, lock);
    const fresh = prepareEditOperation({
      goal: second.goal,
      attemptId: second.lease.attemptId,
      generation: second.goal.generation,
      path: targetRel,
      content: "V1 same bytes\n",
    });
    const secondIntent = appendIntent(store, goalId, lock, second, fresh, second);
    const secondDispatch = appendDispatch(store, goalId, lock, second, fresh, secondIntent);
    applyEditOperation(workspace, fresh.intent, fresh.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, second, fresh, secondDispatch);
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);
  assert.equal(reconciliation.appliedOperations.length, 1);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "applied");

  const undo = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undo.count, 1);
  assert.equal(undo.undoEntries[0].originalBytes.toString("utf8"), original);
});

test("B3: undo refuses external replacement after the final target read and preserves external bytes", (t) => {
  const { workspace, store, goalId } = makeFixture(t);
  const targetRel = "undo-final-drift.txt";
  const target = join(workspace, targetRel);
  writeFileSync(target, "ORIGINAL UNDO BYTES\r\n", { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "APPLIED\n",
      mode: 0o600,
    });
    let snapshot = appendIntent(store, goalId, lock, running, prep, running);
    snapshot = appendDispatch(store, goalId, lock, running, prep, snapshot);
    applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, running, prep, snapshot);

    const undo = reconstructExactUndo(store, goalId);
    const external = "EXTERNAL DURING UNDO\n";
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
        if (targetReads === 2 && length > 1 && !injected) {
          injected = true;
          const replacement = join(workspace, ".external-undo-replacement");
          writeFileSync(replacement, external, { mode: 0o600 });
          fs.renameSync(replacement, target);
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => applyExactUndo(store, goalId, undo.undoEntries, { workspaceRoot: workspace, lock }),
        /diverged before commit/,
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

test("B3: undo verifies the displaced target's mode at publication, not only its bytes", (t) => {
  const { workspace, store, goalId } = makeFixture(t);
  const targetRel = "undo-mode-drift.txt";
  const target = join(workspace, targetRel);
  writeFileSync(target, "ORIGINAL MODE DRIFT\n", { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const running = store.beginAttempt(goalId, {
      lock,
      fence: { goalId, sequence: 1, generation: 0 },
    });
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "APPLIED MODE DRIFT\n",
      mode: 0o640,
    });
    let snapshot = appendIntent(store, goalId, lock, running, prep, running);
    snapshot = appendDispatch(store, goalId, lock, running, prep, snapshot);
    applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, running, prep, snapshot);

    const undo = reconstructExactUndo(store, goalId);
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
        // Same bytes as the applied target, but a different mode appears after
        // the final read. Quarantine verification must observe the real object.
        if (targetReads === 2 && length > 1 && !injected) {
          injected = true;
          fs.chmodSync(target, 0o600);
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => applyExactUndo(store, goalId, undo.undoEntries, { workspaceRoot: workspace, lock }),
        /diverged before commit/,
      );
    } finally {
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }

    assert.equal(injected, true);
    assert.equal(readFileSync(target, "utf8"), "APPLIED MODE DRIFT\n");
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(matrixArtifacts(workspace), []);
  });
});

test("B1: reconciliation continues past an undispatched gap in the same attempt", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "same-attempt-gap.txt";
  const target = join(workspace, targetRel);
  const original = "same attempt V0\n";
  writeFileSync(target, original, { mode: 0o640 });

  let abandoned;
  let fresh;
  withGoalLock(workspace, (lock) => {
    const running = beginRunningAttempt(store, goalId, lock);
    abandoned = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "same attempt V1 abandoned\n",
    });
    const firstIntent = appendIntent(store, goalId, lock, running, abandoned, running);

    fresh = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "same attempt V2 applied\n",
    });
    const secondIntent = appendIntent(store, goalId, lock, running, fresh, firstIntent);
    const secondDispatch = appendDispatch(store, goalId, lock, running, fresh, secondIntent);
    applyEditOperation(workspace, fresh.intent, fresh.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, running, fresh, secondDispatch);
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "applied");
  assert.equal(reconciliation.fileReconciliations[targetRel].substate, "matches-after");
  assert.equal(reconciliation.appliedOperations.length, 1);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.equal(reconciliation.appliedOperations[0].operationId, fresh.intent.operationId);
  assert.equal(reconciliation.pendingOperations[0].operationId, abandoned.intent.operationId);

  const undo = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undo.count, 1);
  assert.equal(undo.undoEntries[0].originalBytes.toString("utf8"), original);
  assert.equal(undo.undoEntries[0].originalMode, 0o640);

  withGoalLock(workspace, (lock) => {
    applyExactUndo(reopenStore, goalId, undo.undoEntries, { workspaceRoot: workspace, lock });
  });
  assert.equal(readFileSync(target, "utf8"), original);
  assert.equal(statSync(target).mode & 0o777, 0o640);
  assert.deepEqual(matrixArtifacts(workspace), []);
});

test("B1: repeated edits across attempts undo in reverse order to the pre-goal image", (t) => {
  const { home, workspace, store, goalId } = makeFixture(t);
  const targetRel = "cross-attempt-repeated.txt";
  const target = join(workspace, targetRel);
  const v0 = "counter V0\r\n";
  writeFileSync(target, v0, { mode: 0o751 });

  let secondPrep;
  let thirdPrep;
  withGoalLock(workspace, (lock) => {
    const first = beginRunningAttempt(store, goalId, lock);
    const abandoned = prepareEditOperation({
      goal: first.goal,
      attemptId: first.lease.attemptId,
      generation: first.goal.generation,
      path: targetRel,
      content: "counter abandoned V1\r\n",
    });
    const firstIntent = appendIntent(store, goalId, lock, first, abandoned, first);
    store.transition(goalId, authorityFor(goalId, lock, first, firstIntent), "interrupted");

    const second = beginRunningAttempt(store, goalId, lock);
    secondPrep = prepareEditOperation({
      goal: second.goal,
      attemptId: second.lease.attemptId,
      generation: second.goal.generation,
      path: targetRel,
      content: "counter V2\r\n",
    });
    let snapshot = appendIntent(store, goalId, lock, second, secondPrep, second);
    snapshot = appendDispatch(store, goalId, lock, second, secondPrep, snapshot);
    applyEditOperation(workspace, secondPrep.intent, secondPrep.afterBytes, { lock, store });
    snapshot = appendReceipt(store, goalId, lock, second, secondPrep, snapshot);
    store.transition(goalId, authorityFor(goalId, lock, second, snapshot), "interrupted");

    const third = beginRunningAttempt(store, goalId, lock);
    thirdPrep = prepareEditOperation({
      goal: third.goal,
      attemptId: third.lease.attemptId,
      generation: third.goal.generation,
      path: targetRel,
      content: "counter V3\r\n",
    });
    const thirdIntent = appendIntent(store, goalId, lock, third, thirdPrep, third);
    appendDispatch(store, goalId, lock, third, thirdPrep, thirdIntent);
    applyEditOperation(workspace, thirdPrep.intent, thirdPrep.afterBytes, { lock, store });
    // Crash before the third receipt so reconciliation must infer it.
  });

  const reopenStore = createGoalStore(home);
  const reconciliation = reconcileGoalOperations(reopenStore, goalId);
  assert.equal(reconciliation.fileReconciliations[targetRel].state, "applied");
  assert.equal(reconciliation.fileReconciliations[targetRel].substate, "matches-after");
  assert.equal(reconciliation.appliedOperations.length, 2);
  assert.equal(reconciliation.pendingOperations.length, 1);
  assert.deepEqual(
    reconciliation.appliedOperations.map((op) => op.operationId),
    [secondPrep.intent.operationId, thirdPrep.intent.operationId],
  );

  const undo = reconstructExactUndo(reopenStore, goalId);
  assert.equal(undo.count, 2);
  assert.equal(undo.undoEntries[0].originalBytes.toString("utf8"), "counter V2\r\n");
  assert.equal(undo.undoEntries[1].originalBytes.toString("utf8"), v0);
  assert.equal(undo.prestate[targetRel].originalBytes.toString("utf8"), v0);

  withGoalLock(workspace, (lock) => {
    applyExactUndo(reopenStore, goalId, [undo.undoEntries[0]], {
      workspaceRoot: workspace,
      lock,
    });
    assert.equal(readFileSync(target, "utf8"), "counter V2\r\n");
    assert.equal(statSync(target).mode & 0o777, 0o751);

    applyExactUndo(reopenStore, goalId, [undo.undoEntries[1]], {
      workspaceRoot: workspace,
      lock,
    });
    assert.equal(readFileSync(target, "utf8"), v0);
    assert.equal(statSync(target).mode & 0o777, 0o751);
  });
  assert.deepEqual(matrixArtifacts(workspace), []);
});

test("B3: undo of a creation refuses an external replacement after the final read", (t) => {
  const { workspace, store, goalId } = makeFixture(t);
  const targetRel = "undo-created-drift.txt";
  const target = join(workspace, targetRel);
  const external = "EXTERNAL CREATION REPLACEMENT\n";

  withGoalLock(workspace, (lock) => {
    const running = beginRunningAttempt(store, goalId, lock);
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: "CREATED BY GOAL\n",
      mode: 0o640,
    });
    assert.equal(prep.intent.edit.before.exists, false);
    let snapshot = appendIntent(store, goalId, lock, running, prep, running);
    snapshot = appendDispatch(store, goalId, lock, running, prep, snapshot);
    applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, running, prep, snapshot);

    const undo = reconstructExactUndo(store, goalId);
    assert.equal(undo.undoEntries[0].isCreation, true);
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
        if (targetReads === 2 && length > 1 && !injected) {
          injected = true;
          const replacement = join(workspace, ".external-created-replacement");
          writeFileSync(replacement, external, { mode: 0o600 });
          fs.renameSync(replacement, target);
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => applyExactUndo(store, goalId, undo.undoEntries, { workspaceRoot: workspace, lock }),
        /diverged before commit/,
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

test("B3: undo restoring a deletion refuses to clobber a target that appears at publication", (t) => {
  const { workspace, store, goalId } = makeFixture(t);
  const targetRel = "undo-deleted-no-clobber.txt";
  const target = join(workspace, targetRel);
  const original = "DELETED ORIGINAL\n";
  const external = "EXTERNAL RESTORED TARGET\n";
  writeFileSync(target, original, { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const running = beginRunningAttempt(store, goalId, lock);
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: null,
    });
    let snapshot = appendIntent(store, goalId, lock, running, prep, running);
    snapshot = appendDispatch(store, goalId, lock, running, prep, snapshot);
    applyEditOperation(workspace, prep.intent, null, { lock, store });
    appendReceipt(store, goalId, lock, running, prep, snapshot);

    const undo = reconstructExactUndo(store, goalId);
    assert.equal(undo.undoEntries[0].isDeletion, true);
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
        () => applyExactUndo(store, goalId, undo.undoEntries, { workspaceRoot: workspace, lock }),
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

test("B3: undo retains the displaced target when a newer target reappears during publication", (t) => {
  const { workspace, store, goalId } = makeFixture(t);
  const targetRel = "undo-reappeared.txt";
  const target = join(workspace, targetRel);
  const applied = "APPLIED BEFORE UNDO\n";
  const external = "EXTERNAL DURING UNDO RECOVERY\n";
  writeFileSync(target, "ORIGINAL BEFORE UNDO\n", { mode: 0o640 });

  withGoalLock(workspace, (lock) => {
    const running = beginRunningAttempt(store, goalId, lock);
    const prep = prepareEditOperation({
      goal: running.goal,
      attemptId: running.lease.attemptId,
      generation: running.goal.generation,
      path: targetRel,
      content: applied,
    });
    let snapshot = appendIntent(store, goalId, lock, running, prep, running);
    snapshot = appendDispatch(store, goalId, lock, running, prep, snapshot);
    applyEditOperation(workspace, prep.intent, prep.afterBytes, { lock, store });
    appendReceipt(store, goalId, lock, running, prep, snapshot);

    const undo = reconstructExactUndo(store, goalId);
    const originalRead = fs.readSync;
    let injected = false;
    fs.readSync = (fd, buffer, offset, length, position) => {
      let path = "";
      try {
        path = fs.readlinkSync(`/proc/self/fd/${fd}`);
      } catch {
        /* Not a file descriptor with a path. */
      }
      const result = originalRead(fd, buffer, offset, length, position);
      if (path.includes(".matrix-commit-") && length > 1 && !injected) {
        injected = true;
        writeFileSync(target, external, { mode: 0o600 });
      }
      return result;
    };
    syncBuiltinESMExports();
    let error;
    try {
      applyExactUndo(store, goalId, undo.undoEntries, { workspaceRoot: workspace, lock });
    } catch (caught) {
      error = caught;
    } finally {
      fs.readSync = originalRead;
      syncBuiltinESMExports();
    }

    assert.equal(injected, true);
    assert.match(error.message, /target reappeared during commit/);
    assert.match(error.message, /displaced target retained at /);
    assert.equal(readFileSync(target, "utf8"), external);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    const artifacts = matrixArtifacts(workspace);
    assert.equal(artifacts.length, 2);
    const displaced = artifacts.find((name) => /^\.matrix-commit-.*\.displaced$/.test(name));
    assert.ok(displaced);
    assert.equal(readFileSync(join(workspace, displaced), "utf8"), applied);
    assert.equal(statSync(join(workspace, displaced)).mode & 0o777, 0o640);
    assert.equal(
      error.retained.every((path) => fs.existsSync(path)),
      true,
    );
  });
});
