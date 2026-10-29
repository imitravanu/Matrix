import test from "node:test";
import assert from "node:assert/strict";

import { createFixedBatchScheduler, MAX_PARALLEL_AGENTS } from "../lib/parallel-scheduler.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("fixed scheduler runs two independently, defers the third, and preserves stable IDs", async () => {
  const gates = [deferred(), deferred(), deferred()];
  const events = [];
  const active = new Set();
  let maximum = 0;
  const starts = [];
  const scheduler = createFixedBatchScheduler({
    batchId: "batch-concurrency",
    onEvent: (event) => events.push(event),
  });
  const done = scheduler.start(
    [{ task: "a" }, { task: "b" }, { task: "c" }],
    async (job, _context) => {
      starts.push(job.task);
      active.add(job.task);
      maximum = Math.max(maximum, active.size);
      await gates[starts.indexOf(job.task)].promise;
      active.delete(job.task);
      return { ok: true, status: "success", runId: `run-${job.task}`, task: job.task };
    },
  );

  assert.deepEqual(starts, ["a", "b"]);
  assert.deepEqual(
    scheduler.getState().agents.map((agent) => [agent.agentId, agent.status]),
    [
      ["agent-01", "running"],
      ["agent-02", "running"],
      ["agent-03", "queued"],
    ],
  );
  assert.equal(maximum, 2);

  gates[0].resolve();
  await tick();
  assert.deepEqual(starts, ["a", "b", "c"]);
  assert.equal(scheduler.getState().agents[2].status, "running");
  gates[1].resolve();
  gates[2].resolve();
  const result = await done;

  assert.equal(result.ok, true);
  assert.equal(maximum, 2);
  assert.deepEqual(
    result.agents.map((agent) => [agent.agentId, agent.agentRunId, agent.status]),
    [
      ["agent-01", "run-a", "settled"],
      ["agent-02", "run-b", "settled"],
      ["agent-03", "run-c", "settled"],
    ],
  );
  assert.ok(events.every((event) => event.batchId === "batch-concurrency"));
  assert.ok(events.every((event) => "agentRunId" in event && "approvalId" in event));
  assert.throws(() => scheduler.start([{ task: "again" }], async () => ({ ok: true })), /once/);
});

test("abort prevents queued starts and done awaits every running executor", async () => {
  const first = deferred();
  const second = deferred();
  const signals = [];
  const starts = [];
  const scheduler = createFixedBatchScheduler({ batchId: "batch-abort" });
  const done = scheduler.start([{}, {}, {}], async (_job, context) => {
    starts.push(context.agentId);
    signals.push(context.signal);
    await (context.agentId === "agent-01" ? first.promise : second.promise);
    return { ok: !context.signal.aborted, runId: `child-${context.agentId}` };
  });

  assert.equal(scheduler.abort(), true);
  assert.equal(scheduler.abort(), false);
  assert.deepEqual(starts, ["agent-01", "agent-02"]);
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
  );
  assert.equal(scheduler.getState().agents[2].status, "settled");
  assert.equal(scheduler.getState().agents[2].result.status, "aborted");

  let completed = false;
  void done.then(() => {
    completed = true;
  });
  await tick();
  assert.equal(completed, false, "abort does not abandon running children");
  first.resolve();
  await tick();
  assert.equal(completed, false);
  second.resolve();
  const result = await done;
  assert.equal(completed, true);
  assert.equal(result.aborted, true);
  assert.deepEqual(starts, ["agent-01", "agent-02"]);
});

test("all jobs and caps are validated before any executor side effect", () => {
  let calls = 0;
  const scheduler = createFixedBatchScheduler({ batchId: "batch-validation" });
  const jobs = Array.from({ length: MAX_PARALLEL_AGENTS + 1 }, () => ({}));
  assert.throws(
    () =>
      scheduler.start(jobs, async () => {
        calls += 1;
      }),
    /1 through 8/,
  );
  assert.equal(calls, 0);
  assert.equal(scheduler.getState().status, "idle");
  assert.throws(
    () => createFixedBatchScheduler({ batchId: "bad-active", maxActive: 0 }),
    /maxActive/,
  );
});

test("queued jobs retain their submitted authority and task despite caller mutation", async () => {
  const gate = deferred();
  const jobs = [
    { task: "first" },
    { task: "second", autoApprove: false, allowTests: false, model: { id: "local" } },
  ];
  const starts = [];
  const scheduler = createFixedBatchScheduler({ batchId: "batch-immutable-jobs", maxActive: 1 });
  const done = scheduler.start(jobs, async (job) => {
    starts.push(job);
    if (job.task === "first") await gate.promise;
    return { ok: true };
  });
  Object.assign(jobs[1], { task: "replacement", autoApprove: true, allowTests: true });
  jobs[1].model.id = "other";
  gate.resolve();
  await done;
  assert.deepEqual(starts[1], {
    task: "second",
    autoApprove: false,
    allowTests: false,
    model: { id: "local" },
  });
});

test("scheduler outcomes cannot be changed by observers or state consumers", async () => {
  const gate = deferred();
  const scheduler = createFixedBatchScheduler({
    batchId: "batch-immutable-outcomes",
    maxActive: 1,
    onEvent(event) {
      if (event.type === "agent:settled") {
        event.result.ok = true;
        event.result.details.message = "observer replacement";
      }
      if (event.type === "batch:settled") event.agents[0].result.ok = true;
    },
  });
  const done = scheduler.start([{}, {}], async (_job, context) => {
    if (context.agentId === "agent-02") await gate.promise;
    return { ok: false, details: { message: "failed" } };
  });
  await tick();
  const state = scheduler.getState();
  state.agents[0].result.ok = true;
  state.agents[0].result.details.message = "consumer replacement";
  gate.resolve();
  const result = await done;
  assert.equal(result.ok, false);
  assert.deepEqual(result.agents[0].result, { ok: false, details: { message: "failed" } });
  result.agents[0].result.ok = true;
  assert.equal(scheduler.getState().agents[0].result.ok, false);
});
