// Deterministic fixed-batch scheduling. Agent execution is independent; this
// module owns concurrency and lifecycle only, never workspace writes.

export const MAX_PARALLEL_AGENTS = 8;
export const DEFAULT_MAX_ACTIVE = 2;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function integerInRange(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function agentId(index) {
  return `agent-${String(index + 1).padStart(2, "0")}`;
}

function abortedResult(message = "Batch aborted before agent start") {
  return {
    ok: false,
    status: "aborted",
    outcome: "aborted",
    aborted: true,
    error: message,
  };
}

function publicAgent(record) {
  return {
    batchId: record.batchId,
    agentId: record.agentId,
    index: record.index,
    status: record.status,
    agentRunId: record.agentRunId,
    workspaceKind: record.workspaceKind,
    result: record.result,
    error: record.error,
  };
}

/**
 * Create a one-shot scheduler. `start()` validates the entire fixed job list
 * before invoking an executor. Agent IDs are input-order stable and never
 * reused. `abort()` prevents every queued start and waits for running executors.
 */
export function createFixedBatchScheduler({
  batchId,
  maxActive = DEFAULT_MAX_ACTIVE,
  onEvent = null,
} = {}) {
  if (!ID.test(String(batchId ?? ""))) throw new Error("batchId is missing or invalid");
  const activeLimit = integerInRange(
    maxActive,
    DEFAULT_MAX_ACTIVE,
    1,
    MAX_PARALLEL_AGENTS,
    "maxActive",
  );
  const abortController = new AbortController();
  let records = [];
  let started = false;
  let finished = false;
  let aborted = false;
  let running = 0;
  let settled = 0;
  let next = 0;
  let donePromise = null;
  let finishDone = null;

  const publish = (type, record = null, fields = {}) => {
    if (typeof onEvent !== "function") return;
    const event = {
      type,
      at: Date.now(),
      batchId,
      agentId: record?.agentId ?? null,
      agentRunId: record?.agentRunId ?? null,
      approvalId: null,
      workspaceKind: record?.workspaceKind ?? null,
      ...fields,
    };
    try {
      onEvent(event);
    } catch {
      // Observers cannot change scheduling or cancellation semantics.
    }
  };

  const publicState = () => ({
    batchId,
    maxActive: activeLimit,
    status: !started ? "idle" : finished ? "settled" : aborted ? "aborted" : "running",
    aborted,
    agents: records.map(publicAgent),
  });

  const finishIfReady = () => {
    if (!started || finished || settled !== records.length || running !== 0) return;
    finished = true;
    const agents = records.map(publicAgent);
    const result = {
      batchId,
      aborted,
      status: aborted ? "aborted" : "settled",
      ok: !aborted && agents.every((agent) => agent.result?.ok === true),
      agents,
    };
    publish("batch:settled", null, { aborted, agents });
    finishDone(result);
  };

  const settleQueued = (record, result) => {
    record.status = "settled";
    record.result = result;
    record.error = result.error ?? null;
    settled += 1;
    publish("agent:settled", record, { result });
  };

  const pump = () => {
    if (finished) return;
    if (aborted) {
      while (next < records.length) {
        const record = records[next++];
        if (record.status === "queued") settleQueued(record, abortedResult());
      }
      finishIfReady();
      return;
    }

    while (running < activeLimit && next < records.length) {
      const record = records[next++];
      record.status = "running";
      running += 1;
      publish("agent:started", record, { agentIndex: record.index });
      void executeRecord(record);
    }
    finishIfReady();
  };

  async function executeRecord(record) {
    try {
      const result = await record.executor(record.job, {
        batchId,
        agentId: record.agentId,
        signal: abortController.signal,
        setAgentRunId(value) {
          if (typeof value === "string" && value) record.agentRunId = value;
        },
        setWorkspaceKind(value) {
          if (value === "copy" || value === "worktree") record.workspaceKind = value;
        },
      });
      record.agentRunId = result?.runId ?? record.agentRunId;
      record.result = result ?? {
        ok: false,
        status: "failed",
        outcome: "failed",
        error: "Agent executor returned no result",
      };
    } catch (error) {
      record.error = error?.message ?? String(error);
      record.result = {
        ok: false,
        status: abortController.signal.aborted ? "aborted" : "failed",
        outcome: abortController.signal.aborted ? "aborted" : "failed",
        aborted: abortController.signal.aborted,
        error: record.error,
      };
    } finally {
      record.status = "settled";
      settled += 1;
      running -= 1;
      publish("agent:settled", record, { result: record.result, error: record.error });
      pump();
    }
  }

  function start(jobs, executor) {
    if (started) throw new Error("A fixed batch can only be started once");
    if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > MAX_PARALLEL_AGENTS) {
      throw new Error(`jobs must contain from 1 through ${MAX_PARALLEL_AGENTS} entries`);
    }
    if (typeof executor !== "function") throw new Error("Agent executor is required");
    for (const job of jobs) {
      if (!job || typeof job !== "object" || Array.isArray(job)) {
        throw new Error("Every batch job must be an object");
      }
    }

    records = jobs.map((job, index) => ({
      batchId,
      agentId: agentId(index),
      index,
      job,
      executor,
      status: "queued",
      agentRunId: null,
      workspaceKind: null,
      result: null,
      error: null,
    }));
    started = true;
    donePromise = new Promise((resolve) => {
      finishDone = resolve;
    });
    publish("batch:started", null, { maxActive: activeLimit, agentCount: records.length });
    pump();
    return donePromise;
  }

  function abort() {
    if (!started || finished || aborted) return false;
    aborted = true;
    publish("batch:abort", null, { reason: "Batch abort requested" });
    abortController.abort();
    pump();
    return true;
  }

  return {
    start,
    abort,
    getState: publicState,
    get signal() {
      return abortController.signal;
    },
  };
}
