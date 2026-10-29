// Independent, one-shot approval authorities for fixed-batch agents and final
// integration. A decision is valid only for its exact agent/kind/approval tuple.

export const APPROVAL_KINDS = Object.freeze(["edit", "test", "command", "integration"]);

const KINDS = new Set(APPROVAL_KINDS);
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const APPROVED = new Set(["y", "yes", "a", "always", "approve", "approved", "once"]);
const ONCE = new Set(["y", "yes", "approve", "approved", "once"]);

function normalizedDecision(decision) {
  if (decision === true) return "y";
  if (decision === false) return "n";
  return String(decision ?? "n").toLowerCase();
}

function publicRecord(record) {
  return {
    batchId: record.batchId,
    agentId: record.agentId,
    agentRunId: record.agentRunId,
    workspaceKind: record.workspaceKind,
    approvalId: record.approvalId,
    kind: record.kind,
    request: structuredClone(record.request),
    status: record.status,
    decision: record.decision,
    consumed: record.consumed,
  };
}

/** Create a bounded broker. Resolved decisions can never be replayed or retargeted. */
export function createApprovalBroker({ batchId, onEvent = null, maxRecords = 256 } = {}) {
  if (!ID.test(String(batchId ?? ""))) throw new Error("approval broker batchId is invalid");
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 4096) {
    throw new Error("approval broker maxRecords must be an integer from 1 through 4096");
  }
  const records = new Map();
  let sequence = 0;
  let closed = false;

  const publish = (record, type, fields = {}) => {
    if (!record.emit || typeof onEvent !== "function") return;
    try {
      onEvent({
        type,
        at: Date.now(),
        batchId,
        agentId: record.agentId,
        agentRunId: record.agentRunId,
        approvalId: record.approvalId,
        workspaceKind: record.workspaceKind,
        kind: record.kind,
        approvalKind: record.kind,
        request: structuredClone(record.request),
        decision: record.decision,
        status: record.status,
        ...fields,
      });
    } catch {
      // Approval state transitions do not depend on an observer.
    }
  };

  function issue({
    agentId,
    kind,
    request = null,
    approvalId = null,
    agentRunId = null,
    workspaceKind = null,
    emit = true,
  } = {}) {
    if (closed) throw new Error("Approval broker is closed");
    if (!ID.test(String(agentId ?? ""))) throw new Error("approval agentId is invalid");
    if (!KINDS.has(kind)) throw new Error("approval kind is invalid");
    if (records.size >= maxRecords) throw new Error("approval record budget exhausted");
    const id = approvalId ?? `approval-${String(++sequence).padStart(4, "0")}`;
    if (!ID.test(String(id)) || records.has(id)) throw new Error("approvalId is invalid or reused");

    let resolvePromise;
    const record = {
      batchId,
      agentId,
      kind,
      approvalId: id,
      agentRunId,
      workspaceKind,
      request: structuredClone(request),
      status: "pending",
      decision: null,
      consumed: false,
      emit: Boolean(emit),
      promise: null,
      resolve: null,
    };
    record.promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    record.resolve = resolvePromise;
    records.set(id, record);
    publish(record, "approval:request");
    return publicRecord(record);
  }

  function exact(id, { agentId, approvalId, kind } = {}) {
    const record = records.get(approvalId ?? id);
    if (
      !record ||
      record.agentId !== agentId ||
      record.kind !== kind ||
      record.approvalId !== (approvalId ?? id)
    ) {
      return null;
    }
    return record;
  }

  function wait(identity) {
    const record = exact(null, identity);
    if (!record) return Promise.resolve("n");
    return record.promise;
  }

  function decide({ agentId, approvalId, kind, decision } = {}) {
    const record = exact(null, { agentId, approvalId, kind });
    if (!record || record.status !== "pending" || record.consumed) {
      return { ok: false, error: "Approval is stale, resolved, or belongs to another authority" };
    }
    const normalized = normalizedDecision(decision);
    record.decision = normalized;
    record.status = APPROVED.has(normalized) ? "resolved" : "denied";
    record.resolve(normalized);
    publish(record, "approval:result");
    return { ok: true, ...publicRecord(record) };
  }

  function inspect({ agentId, approvalId, kind } = {}) {
    const record = exact(null, { agentId, approvalId, kind });
    return record ? publicRecord(record) : null;
  }

  /** Consume one approved integration/execution grant. Persistent grants are not one-shot. */
  function consume(identity) {
    const record = exact(null, identity);
    if (!record || record.status !== "resolved" || record.consumed || !ONCE.has(record.decision)) {
      return false;
    }
    record.consumed = true;
    return true;
  }

  function pending() {
    return [...records.values()].filter((record) => record.status === "pending").map(publicRecord);
  }

  function abort(reason = "Batch aborted") {
    if (closed) return 0;
    closed = true;
    let denied = 0;
    for (const record of records.values()) {
      if (record.status !== "pending") continue;
      record.status = "aborted";
      record.decision = "n";
      record.resolve("n");
      denied += 1;
      publish(record, "approval:result", { error: reason, aborted: true });
    }
    return denied;
  }

  return {
    issue,
    wait,
    decide,
    inspect,
    consume,
    pending,
    abort,
    get closed() {
      return closed;
    },
  };
}
