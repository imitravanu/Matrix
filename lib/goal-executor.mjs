// ============================================================================
// Resumable durable-goal executor.
//
// The executor owns one attempt lifetime and the durable boundaries around
// provider turns and tool dispatches. It never replaces the existing agent
// engines: an engine is a narrow `turn(context, control)` adapter returning a
// bounded proposal. Code that wires a real engine belongs to DUR-005.
//
// Every provider request and tool dispatch follows the accepted store protocol:
// reserve persistently (intent), record dispatch, perform the effect, record a
// receipt, then expose completion. Context is rebuilt from receipt-backed
// summaries, never from a persisted transcript. Cancellation, pause and
// generation changes fence late callbacks before they can mutate state.
// ============================================================================

import { canonicalJson, validateGoalId, validateGoalUsage } from "./goal-contracts.mjs";
import { withGoalLock } from "./goal-lock.mjs";
import {
  applyEditOperation,
  buildOperationReceipt,
  prepareEditOperation,
  prepareOperationIntent,
} from "./goal-operations.mjs";
import { reconcileGoalOperations } from "./goal-recovery.mjs";
import { classifyOutcome, OUTCOME } from "./outcome.mjs";
import {
  PROVIDER_MAX_MS,
  PROVIDER_RESERVATION,
  TOOL_MAX_MS,
  TOOL_RESERVATION,
  budgetSnapshot,
  budgetStopReason,
  canReserve,
  elapsedUsage,
  reservationFor,
} from "./goal-budget.mjs";
import {
  DEFAULT_CONTEXT_BYTES,
  buildGoalContext,
  collectOperationHistory,
  createOperationSummary,
  failureFingerprint,
  hashWorkspacePaths,
  receiptSummary,
} from "./goal-context.mjs";

const ACTIVE_STATES = new Set(["running", "awaiting-approval", "reconciling"]);
const MAX_TOOL_CALLS = 8;
const MAX_TOOL_ARGS_BYTES = 32 * 1024;
const MAX_CONTENT_CHARS = 16_384;
const DEFAULT_NO_PROGRESS = 3;
const NO_PROGRESS_MESSAGE = "no tool calls and the acceptance criteria remain unmet";
/** Control requests are observed during effects even when an adapter ignores abort. */
const CONTROL_POLL_MS = 50;
/**
 * Operations whose adapter can own a local process. A provider request is a
 * remote effect (uncertain usage only) and an edit is an in-process write, so
 * neither can leave a surviving child. Reads/searches are in-process by
 * contract; DUR-005 must not give them process-ownership behavior without
 * extending this boundary.
 */
const EXECUTION_KINDS = new Set(["test", "command"]);
/** Hint shown whenever a durable teardown block refuses a resume. */
const TEARDOWN_HANDOFF =
  "Do not resume, delete state or start another goal in this workspace while " +
  "execution may survive. DUR-005 must verify the owned process tree through the " +
  "trusted process-ownership boundary (boot id, process start identity and a " +
  "reviewed OS ownership mechanism) and return an attestation bound to the " +
  "listed operation, attempt and generation; only that boundary may release " +
  "this goal.";

/** A durable attempt refused an operation because it is no longer current. */
export class StaleGoalAttemptError extends Error {
  constructor(message = "stale goal attempt") {
    super(message);
    this.name = "StaleGoalAttemptError";
    this.code = "stale-attempt";
  }
}

/** A bounded executor refusal that must stop before another effect. */
export class GoalExecutorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GoalExecutorError";
    this.code = code;
    this.details = details;
  }
}

function boundedText(value, maximum = 1_000) {
  if (typeof value !== "string") return "";
  const text = Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function fenceOf(goal) {
  return { goalId: goal.id, generation: goal.generation, sequence: goal.sequence };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * One live attempt. Every mutation re-opens the workspace lock, re-reads the
 * goal and compares the persisted lease/generation with this attempt. A closed
 * or superseded session refuses before the store is called and before any
 * caller-supplied effect can run.
 */
export class GoalAttemptSession {
  /**
   * @param {{ store: *, goalId: string, workspace: string, attempt: {generation: number, attemptId: string, leaseId: string}, verifiedOperations?: Set<string> }} input
   */
  constructor({ store, goalId, workspace, attempt, verifiedOperations = new Set() }) {
    this.store = store;
    this.goalId = goalId;
    this.workspace = workspace;
    this.generation = attempt.generation;
    this.attemptId = attempt.attemptId;
    this.leaseId = attempt.leaseId;
    this.closed = false;
    this.verifiedOperations = verifiedOperations;
  }

  /** @param {*} status */
  _assert(status) {
    if (this.closed) throw new StaleGoalAttemptError("goal attempt is closed");
    const goal = status.goal;
    if (goal.state !== "running" || !status.lease) {
      throw new StaleGoalAttemptError("goal attempt is not running");
    }
    if (goal.generation !== this.generation) {
      throw new StaleGoalAttemptError("goal generation changed");
    }
    if (status.lease.leaseId !== this.leaseId || status.lease.attemptId !== this.attemptId) {
      throw new StaleGoalAttemptError("goal lease changed");
    }
    return status;
  }

  /** Re-read persisted state under the workspace lock. */
  current() {
    return withGoalLock(this.workspace, () => this._assert(this.store.inspect(this.goalId)), {
      home: this.store.home,
      verifiedOperations: this.verifiedOperations,
    });
  }

  /**
   * Run a synchronous durable mutation. The callback receives the current
   * status, a fresh authority object and the held lock.
   * @template T
   * @param {(status: *, authority: {lock: object, fence: object, leaseId: string}) => T} use
   * @returns {T}
   */
  commit(use) {
    return withGoalLock(
      this.workspace,
      (lock) => {
        const status = this._assert(this.store.inspect(this.goalId));
        return use(status, {
          lock,
          fence: fenceOf(status.goal),
          leaseId: this.leaseId,
        });
      },
      { home: this.store.home, verifiedOperations: this.verifiedOperations },
    );
  }

  /**
   * @param {"intent" | "dispatch" | "receipt"} kind
   * @param {*} payload
   * @param {{ blobs?: Buffer[] }} [options]
   */
  append(kind, payload, options = {}) {
    return this.commit((_status, authority) =>
      this.store.append(this.goalId, authority, kind, payload, options),
    );
  }

  /**
   * @param {*} state
   * @param {{ evidence?: * }} [options]
   */
  transition(state, options = {}) {
    const status = this.commit((_current, authority) =>
      this.store.transition(this.goalId, authority, state, options),
    );
    if (!ACTIVE_STATES.has(state)) this.closed = true;
    return status;
  }

  /** Renew the bounded lease before a long dispatch when it is near expiry. */
  maybeRenew(now, thresholdMs = 60_000) {
    return this.commit((status, authority) => {
      if (status.lease.expiresAt - now > thresholdMs) return status;
      return this.store.renew(this.goalId, authority);
    });
  }
}

/**
 * A narrow adapter around a turn-based engine. Existing Local Forge and remote
 * engines are adapted by trusted integration code (DUR-005); this executor
 * only accepts a bounded proposal so it can place durable boundaries before
 * any effect.
 * @param {{ turn?: Function } | Function} engine
 */
export function engineTurn(engine) {
  if (typeof engine === "function") return engine;
  if (engine && typeof engine.turn === "function") return engine.turn.bind(engine);
  throw new Error("goal executor: engine must be a function or expose turn()");
}

function normalizeTurn(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new GoalExecutorError("engine-protocol", "engine turn returned no result object");
  }
  const content = boundedText(
    typeof result.content === "string" ? result.content : "",
    MAX_CONTENT_CHARS,
  );
  const toolCalls = result.toolCalls ?? [];
  if (!Array.isArray(toolCalls) || toolCalls.length > MAX_TOOL_CALLS) {
    throw new GoalExecutorError("engine-protocol", "engine turn returned invalid tool calls");
  }
  const calls = toolCalls.map((call) => {
    if (!call || typeof call !== "object") {
      throw new GoalExecutorError("engine-protocol", "invalid tool call");
    }
    const name = call.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 64) {
      throw new GoalExecutorError("engine-protocol", "invalid tool name");
    }
    const args = call.arguments ?? call.args ?? {};
    if (!isPlainObject(args)) {
      throw new GoalExecutorError("engine-protocol", "tool arguments must be an object");
    }
    const bytes = Buffer.byteLength(JSON.stringify(args));
    if (bytes > MAX_TOOL_ARGS_BYTES) {
      throw new GoalExecutorError("engine-protocol", "tool arguments exceed the bound");
    }
    return { name, arguments: structuredClone(args) };
  });
  return {
    content,
    toolCalls: calls,
    status: result.status ?? result.outcome ?? null,
    aborted: result.aborted === true,
    timedOut: result.timedOut === true,
    budgetExhausted: result.budgetExhausted === true,
  };
}

function stopReason(code, message, nextAction, extra = {}) {
  return { code, message, nextAction, ...extra };
}

/**
 * @param {*} store
 * @param {string} goalId
 */
function statusResult(store, goalId, status, reason, extra = {}) {
  const current = store.inspect(goalId);
  return {
    status,
    goal: current.goal,
    budget: budgetSnapshot(current.goal.budget, current.counters),
    reason,
    ...extra,
  };
}

/**
 * @param {*} options
 */
export function createGoalExecutor(options) {
  if (!options || typeof options !== "object") throw new Error("goal executor: options required");
  const { store, goalId } = options;
  if (!store || typeof store.inspect !== "function") {
    throw new Error("goal executor: goal store required");
  }
  validateGoalId(goalId);
  const initial = store.inspect(goalId);
  const workspace = options.workspaceRoot ?? initial.goal.workspace.path;
  const turn = engineTurn(options.engine);
  const tools = options.tools ?? {};
  if (!isPlainObject(tools)) throw new Error("goal executor: tools must be an object");
  const control = options.control ?? {};
  const providerTimeoutMs = options.providerTimeoutMs ?? PROVIDER_MAX_MS;
  const toolTimeoutMs = options.toolTimeoutMs ?? TOOL_MAX_MS;
  if (
    !Number.isSafeInteger(providerTimeoutMs) ||
    providerTimeoutMs < 10 ||
    providerTimeoutMs > PROVIDER_MAX_MS
  ) {
    throw new Error("goal executor: invalid provider timeout");
  }
  if (!Number.isSafeInteger(toolTimeoutMs) || toolTimeoutMs < 10 || toolTimeoutMs > TOOL_MAX_MS) {
    throw new Error("goal executor: invalid tool timeout");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_CONTEXT_BYTES;
  const noProgressLimit = options.noProgressLimit ?? DEFAULT_NO_PROGRESS;
  if (!Number.isSafeInteger(noProgressLimit) || noProgressLimit < 1 || noProgressLimit > 10) {
    throw new Error("goal executor: invalid no-progress limit");
  }
  const humanDecisions = new Map(options.humanDecisions ?? []);
  const authorizeEdit = options.authorizeEdit ?? null;
  const authorizeTest =
    options.authorizeTest ??
    (options.authorizeEdit ? ({ planHash }) => authorizeEdit({ planHash, kind: "test" }) : null);
  const runTest = options.runTest ?? null;
  const executionOwnership = options.executionOwnership ?? null;
  if (executionOwnership !== null && typeof executionOwnership?.verifyTeardown !== "function") {
    throw new Error("goal executor: invalid execution-ownership boundary");
  }

  /** @type {GoalAttemptSession | null} */
  let session = null;
  let lastContext = null;
  let completedStatus = null;

  function requested() {
    if (typeof control.requested === "function") return control.requested();
    return null;
  }

  function requestedStop() {
    const request = requested();
    if (request === "cancel") {
      return stopReason(
        "cancelled",
        "Cancellation requested; no new operation may start.",
        "Inspect the retained journal and undo evidence. Start a new goal for further work.",
      );
    }
    if (request === "pause") {
      return stopReason(
        "paused",
        "Pause requested at a safe boundary.",
        "Resume the goal with a fresh invocation; the persisted budget and journal are retained.",
      );
    }
    return null;
  }

  /**
   * Race one adapter promise against a hard wall-clock deadline and control
   * polling. The abort signal is advisory: an adapter that ignores it still
   * cannot keep the executor waiting, and its later result is never consumed.
   * @param {(signal: AbortSignal) => Promise<*>} start
   * @param {{ signal?: AbortSignal | null, timeoutMs: number, label: string }} input
   */
  async function runBounded(start, { signal = null, timeoutMs, label }) {
    const controller = new AbortController();
    let deadlineExpired = false;
    let controlRequest = null;
    const interrupt = {};
    const interrupted = new Promise((_, reject) => {
      interrupt.reject = reject;
    });
    // A late abort after the race settled must not surface as an unhandled
    // rejection; the settled result is already fenced.
    interrupted.catch(() => {});
    /**
     * A parent abort ends the wait even when the adapter ignores its signal.
     * Otherwise an adapter that never settles would hold the executor open
     * past the caller's cancellation.
     */
    const abortFromParent = () => {
      const error = /** @type {Error & {code?: string}} */ (new Error("goal dispatch aborted"));
      error.name = "AbortError";
      error.code = "ABORT_ERR";
      controller.abort(error);
      interrupt.reject(error);
      return error;
    };
    if (signal?.aborted) {
      // Do not start an effect whose dispatch was already aborted.
      return {
        value: undefined,
        error: abortFromParent(),
        deadlineExpired,
        controlRequest,
      };
    }
    signal?.addEventListener?.("abort", abortFromParent, { once: true });
    const deadline = setTimeout(() => {
      deadlineExpired = true;
      const error = /** @type {Error & {code?: string}} */ (
        new Error(`${label} deadline exceeded`)
      );
      error.code = "DEADLINE_EXCEEDED";
      controller.abort(error);
      interrupt.reject(error);
    }, timeoutMs);
    const watcher = setInterval(() => {
      if (controlRequest) return;
      const request = requested();
      if (request !== "cancel" && request !== "pause") return;
      controlRequest = request;
      const error = /** @type {Error & {code?: string}} */ (new Error(`goal ${request} requested`));
      error.code = "GOAL_CONTROL";
      controller.abort(error);
      interrupt.reject(error);
    }, CONTROL_POLL_MS);
    try {
      const pending = Promise.resolve().then(() => start(controller.signal));
      const value = await Promise.race([pending, interrupted]);
      return { value, error: null, deadlineExpired, controlRequest };
    } catch (error) {
      return { value: undefined, error, deadlineExpired, controlRequest };
    } finally {
      clearTimeout(deadline);
      clearInterval(watcher);
      signal?.removeEventListener?.("abort", abortFromParent);
    }
  }

  /** Classify a bounded adapter result without trusting a late resolution. */
  function boundedKind(bounded) {
    if (bounded.deadlineExpired) return "deadline";
    if (bounded.controlRequest) return "control";
    if (bounded.error) {
      return bounded.error.name === "AbortError" || bounded.error.code === "ABORT_ERR"
        ? "aborted"
        : "error";
    }
    return "value";
  }

  function progressPaths(goal) {
    const paths = new Set();
    for (const criterion of goal.criteria) {
      if (criterion.kind === "artifact") paths.add(criterion.path);
    }
    for (const record of store.readJournal(goalId)) {
      if (record.kind === "intent" && record.payload?.kind === "edit") {
        paths.add(record.payload.edit.path);
      }
    }
    return [...paths];
  }

  /**
   * Blocked durable operations of one goal: dispatched execution-bearing
   * operations that never reached a verified process teardown, either through a
   * conservative `unverified` receipt marker or through an unreceipted dispatch
   * (the process died between dispatch and observation).
   * @param {string} blockedGoalId
   * @returns {Array<*>}
   */
  function blockedOperationsFor(blockedGoalId) {
    const history = collectOperationHistory(store, blockedGoalId);
    const operations = [];
    for (const entry of history.operations) {
      const intent = entry.intent;
      if (!intent || !EXECUTION_KINDS.has(intent.kind) || !entry.dispatch) continue;
      if (!entry.receipt) {
        operations.push({
          operationId: entry.operationId,
          kind: intent.kind,
          attemptId: intent.attemptId,
          generation: intent.generation,
          reservation: intent.reservation,
          state: "dispatched-without-receipt",
        });
        continue;
      }
      // Recovery receipts carry no success evidence and are written only after
      // the process boundary was verified during admission.
      if (entry.recovered) continue;
      let summary = null;
      try {
        summary = receiptSummary(store, blockedGoalId, entry.receipt);
      } catch {
        // A receipt whose evidence summary cannot be read cannot prove a
        // process boundary; it stays blocked rather than being assumed safe.
      }
      if (summary && summary.execution?.teardown !== "unverified") continue;
      operations.push({
        operationId: entry.operationId,
        kind: intent.kind,
        attemptId: entry.receipt.attemptId,
        generation: entry.receipt.generation,
        reservation: intent.reservation,
        state: "interrupted-without-verified-teardown",
      });
    }
    return operations;
  }

  /**
   * Durable surviving-execution block for the canonical workspace. Unresolved
   * execution of the resumed goal or of any sibling goal bound to the same
   * workspace identity is collected, so a new goal, retry, restart, cancellation
   * or elapsed time cannot bypass a block held by original execution records.
   * The block is bound to the canonical workspace identity and carries the
   * owning goal of every blocked operation.
   * @param {{ path: string, device: string, inode: string }} workspaceIdentity
   */
  function durableExecutionBlock(workspaceIdentity) {
    const operations = [];
    const seen = new Set();
    const goals = store.listWorkspaceGoals(workspaceIdentity);
    for (const goal of goals) {
      for (const operation of blockedOperationsFor(goal.id)) {
        if (seen.has(operation.operationId)) continue;
        seen.add(operation.operationId);
        operations.push({ ...operation, goalId: goal.id, workspace: goal.workspace });
      }
    }
    return {
      goalId,
      workspace: {
        path: workspaceIdentity.path,
        device: workspaceIdentity.device,
        inode: workspaceIdentity.inode,
      },
      operations,
    };
  }

  /**
   * The only release channel DUR-004 exposes. The callback is trusted
   * integration code wired by DUR-005; it is never reachable from model
   * output, goal text or the test adapter. An attestation is accepted only
   * when it binds every blocked operation, its attempt, its generation and an
   * independent ownership identity. A bare `verified: true`, elapsed time, a
   * PID lookup or a settled adapter promise is not sufficient.
   */
  function acceptedTeardownAttestation(block) {
    if (!executionOwnership) return null;
    let value;
    try {
      value = executionOwnership.verifyTeardown(structuredClone(block));
    } catch {
      return null;
    }
    if (!isPlainObject(value) || value.verified !== true || value.goalId !== goalId) return null;
    if (!Array.isArray(value.operations) || value.operations.length !== block.operations.length) {
      return null;
    }
    const expected = new Map(
      block.operations.map((operation) => [operation.operationId, operation]),
    );
    const seen = new Set();
    const accepted = [];
    for (const entry of value.operations) {
      if (!isPlainObject(entry)) return null;
      const operation = expected.get(entry.operationId);
      if (!operation || seen.has(entry.operationId)) return null;
      if (entry.attemptId !== operation.attemptId || entry.generation !== operation.generation) {
        return null;
      }
      if (typeof entry.mechanism !== "string" || !/^[\x20-\x7e]{1,120}$/.test(entry.mechanism)) {
        return null;
      }
      if (!isPlainObject(entry.ownership)) return null;
      const { pid, startTime, bootId } = entry.ownership;
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      if (typeof startTime !== "string" || !/^[0-9]{1,32}$/.test(startTime)) return null;
      if (typeof bootId !== "string" || bootId.length === 0 || bootId.length > 128) return null;
      seen.add(entry.operationId);
      accepted.push({
        operationId: entry.operationId,
        attemptId: entry.attemptId,
        generation: entry.generation,
        mechanism: entry.mechanism,
        ownership: { pid, startTime, bootId },
      });
    }
    return seen.size === block.operations.length ? accepted : null;
  }

  function teardownBlockReason(block) {
    const kinds = [...new Set(block.operations.map((operation) => operation.kind))].join("/");
    return stopReason(
      "teardown-unverified",
      `${block.operations.length} dispatched ${kinds} operation(s) ended without a verified ` +
        "process teardown; the goal may still own running execution.",
      TEARDOWN_HANDOFF,
      {
        operations: block.operations,
        handoff: {
          owner: "DUR-005",
          boundary: "executionOwnership.verifyTeardown",
          requirement:
            "Return { verified: true, goalId, operations: [{ operationId, attemptId, " +
            "generation, mechanism, ownership: { pid, startTime, bootId } }] } for every " +
            "listed operation after independently verifying its owned process tree is gone.",
        },
      },
    );
  }

  function fingerprintFor(goal, code, message) {
    return failureFingerprint({
      workspaceRoot: workspace,
      paths: progressPaths(goal),
      code,
      message,
    });
  }

  function noProgressCount(summaries, fingerprint) {
    let count = 0;
    for (let index = summaries.length - 1; index >= 0; index--) {
      const entry = summaries[index];
      if (!entry.progress) continue;
      if (entry.progress !== fingerprint) break;
      count++;
    }
    return count;
  }

  /** Evaluate every criterion from trusted runtime state, never model text. */
  function evaluateCriteria(goal) {
    const paths = progressPaths(goal);
    const workspaceState = hashWorkspacePaths(workspace, paths);
    const history = collectOperationHistory(store, goalId);
    const tests = history.summaries.filter(
      (entry) => entry.operationKind === "test" && entry.status === "succeeded" && entry.test,
    );
    const entries = [];
    const unmet = [];
    for (const criterion of goal.criteria) {
      let accepted = false;
      if (criterion.kind === "artifact") {
        try {
          const file = hashWorkspacePaths(workspace, [criterion.path]).files[0];
          accepted = file?.exists === true && file.sha256 === criterion.sha256;
        } catch {
          accepted = false;
        }
      } else if (criterion.kind === "test") {
        accepted = tests.some(
          (entry) =>
            entry.test.planHash === criterion.planHash &&
            entry.test.sourceFingerprint === workspaceState.sha256,
        );
      } else if (criterion.kind === "human") {
        const decision = humanDecisions.get(criterion.id);
        accepted = Boolean(
          decision &&
          decision.accepted === true &&
          decision.revision === criterion.revision &&
          /^decision_[a-f0-9]{32}$/.test(decision.decisionId ?? ""),
        );
      }
      if (accepted) {
        entries.push({
          criterionId: criterion.id,
          revision: criterion.revision,
          generation: goal.generation,
          manifest: goal.workspace.manifest,
          binding:
            criterion.kind === "test"
              ? criterion.planHash
              : criterion.kind === "artifact"
                ? criterion.sha256
                : null,
          accepted: true,
        });
      } else {
        unmet.push(criterion);
      }
    }
    return { complete: unmet.length === 0, entries, unmet, workspaceState };
  }

  function buildContext(goal, counters) {
    const history = collectOperationHistory(store, goalId);
    const evaluation = evaluateCriteria(goal);
    const statuses = /** @type {Record<string, string>} */ ({});
    for (const criterion of goal.criteria) {
      statuses[criterion.id] = evaluation.entries.some(
        (entry) => entry.criterionId === criterion.id,
      )
        ? "accepted"
        : "unmet";
    }
    const factCandidates = [];
    const seen = new Set();
    for (const entry of history.summaries) {
      const source = entry.source;
      if (!source?.path || !source.sha256 || seen.has(source.path)) continue;
      // Facts are re-read before they are sent back. A stale source fingerprint
      // is dropped rather than shown as if it were still current.
      let current;
      try {
        current = hashWorkspacePaths(workspace, [source.path]).files[0];
      } catch {
        continue;
      }
      if (current?.exists !== source.exists || current?.sha256 !== source.sha256) continue;
      seen.add(source.path);
      factCandidates.push({
        path: source.path,
        sha256: source.sha256,
        statement: entry.summary,
      });
    }
    return buildGoalContext({
      goal,
      counters,
      summaries: history.summaries,
      unresolved: history.unresolved,
      factCandidates,
      evidenceStatus: statuses,
      humanReview: goal.criteria
        .filter((criterion) => criterion.kind === "human")
        .map((criterion) => ({
          criterionId: criterion.id,
          revision: criterion.revision,
          description: criterion.description,
        })),
      maxBytes,
    });
  }

  function trustedDecision(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && typeof value.decisionId === "string") {
      return value.decisionId;
    }
    return null;
  }

  function toolSchema() {
    return Object.entries(tools).map(([name, descriptor]) => ({
      name,
      description:
        typeof descriptor?.description === "string"
          ? boundedText(descriptor.description, 300)
          : `Run the ${name} tool`,
      parameters: { type: "object", additionalProperties: true },
    }));
  }

  /** Build and persist a provider request, then dispatch it. */
  function dispatchProvider(goal, counters, context) {
    const request = {
      schemaVersion: 1,
      goalId: goal.id,
      generation: goal.generation,
      messages: context.messages,
      tools: toolSchema(),
      budget: budgetSnapshot(goal.budget, counters).remaining,
    };
    const args = Buffer.from(canonicalJson(request), "utf8");
    const result = session.commit((status, authority) => {
      const prepared = prepareOperationIntent({
        goal: status.goal,
        attemptId: session.attemptId,
        generation: status.goal.generation,
        kind: "provider",
        args: request,
        reservation: PROVIDER_RESERVATION,
      });
      prepared.intent.arguments = {
        sha256: prepared.intent.arguments.sha256,
        blob: prepared.intent.arguments.sha256,
      };
      const pending = store.append(goalId, authority, "intent", prepared.intent, {
        blobs: [args],
      });
      const dispatched = store.append(
        goalId,
        { ...authority, fence: fenceOf(pending.goal) },
        "dispatch",
        { ...prepared.intent, state: "dispatched" },
      );
      return { intent: prepared.intent, status: dispatched };
    });
    return { ...result, request };
  }

  function providerReceipt(intent, status, usage, uncertainty, summaryInput) {
    const summary = createOperationSummary(summaryInput);
    return session.commit((current, authority) => {
      const receipt = buildOperationReceipt(intent, {
        sequence: current.goal.sequence + 1,
        status,
        usage,
        uncertainty,
        evidence: [summary.sha256],
      });
      return {
        status: store.append(goalId, authority, "receipt", receipt, {
          blobs: [summary.bytes],
        }),
        summary: summary.summary,
      };
    });
  }

  function handleProviderOutcome(goal, intent, result, elapsed, timing) {
    const classification = classifyOutcome({
      status: result.status ?? undefined,
      aborted: result.aborted || timing.abortedByControl === "pause" || timing.cancelled,
      timedOut: result.timedOut || timing.timedOut,
      budgetExhausted: result.budgetExhausted,
      error: timing.error === true,
      failure: timing.errorMessage ?? undefined,
    });
    const reservation = validateGoalUsage(intent.reservation);
    const successUsage = {
      rounds: 1,
      tools: 0,
      requests: 1,
      activeMs: elapsed,
    };
    if (classification.status === OUTCOME.SUCCESS) {
      const summary = providerReceipt(
        intent,
        "succeeded",
        successUsage,
        { kind: "none", detail: null },
        {
          operationId: intent.operationId,
          operationKind: "provider",
          status: "succeeded",
          summary: result.content || "provider response accepted",
          noTools: result.toolCalls.length === 0,
          progress:
            result.toolCalls.length === 0
              ? fingerprintFor(goal, "no-tool-calls", NO_PROGRESS_MESSAGE)
              : null,
        },
      );
      return { kind: "continue", summary: summary.summary, status: summary.status };
    }
    const status =
      classification.status === OUTCOME.ABORTED
        ? timing.cancelled
          ? "cancelled"
          : timing.abortedByControl === "pause"
            ? "interrupted"
            : "interrupted"
        : classification.status === OUTCOME.DENIED
          ? "denied"
          : classification.status === OUTCOME.TIMED_OUT
            ? "uncertain"
            : "failed";
    const uncertainty = {
      kind: "unknown-usage",
      detail: "the provider turn ended before trustworthy usage was observed",
    };
    const code =
      classification.status === OUTCOME.TIMED_OUT
        ? "provider-timeout"
        : classification.status === OUTCOME.ABORTED
          ? "provider-interrupted"
          : `provider-${classification.status}`;
    const message = classification.failure ?? code;
    const summary = providerReceipt(intent, status, reservation, uncertainty, {
      operationId: intent.operationId,
      operationKind: "provider",
      status,
      summary: message,
      progress: fingerprintFor(goal, code, message),
    });
    return {
      kind: "stop",
      summary: summary.summary,
      status: summary.status,
      reason: stopReason(
        code,
        `Provider turn stopped: ${boundedText(message, 500)}`,
        classification.status === OUTCOME.ABORTED
          ? "Resume with a fresh request after inspecting the retained reservation."
          : "Inspect the provider failure, then resume with a fresh invocation and the remaining budget.",
      ),
    };
  }

  function deniedToolResult(goal, message) {
    const fingerprint = fingerprintFor(goal, "tool-denied", message);
    return {
      stop: true,
      fingerprint,
      reason: stopReason("tool-denied", message, "Request fresh authority and resume."),
    };
  }

  function unknownToolResult(goal, name) {
    const message = `The tool "${boundedText(name, 80)}" is not available. Criteria, budgets and authority cannot be changed by a tool proposal.`;
    return {
      stop: true,
      fingerprint: fingerprintFor(goal, "unknown-tool", message),
      reason: stopReason(
        "unsupported-tool",
        message,
        "Propose only the listed tools; policy is unchanged.",
      ),
    };
  }

  /**
   * Dispatch one validated tool proposal with its own durable operation.
   * @returns {Promise<{stop?: boolean, control?: string | null, state?: string | null, fingerprint?: string, reason?: *, summary?: string}>}
   */
  async function dispatchTool(goal, call, signal) {
    if (call.name === "edit") return dispatchEdit(goal, call);
    if (call.name === "test") return dispatchTest(goal, call, signal);
    const descriptor = tools[call.name];
    if (!descriptor) return unknownToolResult(goal, call.name);
    const run = typeof descriptor === "function" ? descriptor : descriptor.run;
    if (typeof run !== "function") return unknownToolResult(goal, call.name);
    const kind = descriptor.kind === "search" ? "search" : "read";
    const args = call.arguments;
    const prepared = session.commit((status, authority) => {
      const prep = prepareOperationIntent({
        goal: status.goal,
        attemptId: session.attemptId,
        generation: status.goal.generation,
        kind,
        args,
        reservation: reservationFor(kind),
      });
      const intent = prep.intent;
      const argsBytes = Buffer.from(canonicalJson(args), "utf8");
      intent.arguments = { sha256: intent.arguments.sha256, blob: intent.arguments.sha256 };
      const pending = store.append(goalId, authority, "intent", intent, { blobs: [argsBytes] });
      const dispatched = store.append(
        goalId,
        { ...authority, fence: fenceOf(pending.goal) },
        "dispatch",
        { ...intent, state: "dispatched" },
      );
      return { intent, status: dispatched };
    });
    const bounded = await runBounded(
      (toolSignal) =>
        run({
          args,
          goal,
          signal: toolSignal,
          operationId: prepared.intent.operationId,
        }),
      { signal, timeoutMs: toolTimeoutMs, label: kind },
    );
    const boundedResult = boundedKind(bounded);
    if (boundedResult !== "value") {
      const controlRequest = boundedResult === "control" ? bounded.controlRequest : null;
      const status =
        boundedResult === "control"
          ? controlRequest === "cancel"
            ? "cancelled"
            : "interrupted"
          : boundedResult === "deadline"
            ? "uncertain"
            : boundedResult === "aborted"
              ? "interrupted"
              : "failed";
      const code =
        boundedResult === "control"
          ? `${kind}-${controlRequest}`
          : boundedResult === "deadline"
            ? "tool-deadline"
            : boundedResult === "aborted"
              ? `${kind}-interrupted`
              : `${kind}-error`;
      const message =
        boundedResult === "control"
          ? `The goal ${controlRequest} request interrupted the ${kind} tool before a trusted observation.`
          : boundedResult === "deadline"
            ? `The ${kind} tool exceeded its hard execution deadline.`
            : boundedResult === "aborted"
              ? `The ${kind} tool aborted before a trusted observation.`
              : boundedText(bounded.error?.message ?? String(bounded.error), 800);
      const nextAction =
        boundedResult === "deadline"
          ? "Do not use this result. Verify or stop the owned process through the process-ownership boundary, then resume only after reconciliation."
          : boundedResult === "control"
            ? controlRequest === "cancel"
              ? "Inspect retained evidence. Start a new goal for further work."
              : "Resume with a fresh invocation after verifying the interrupted process is no longer running."
            : "Inspect the failure and resume; reservations from interrupted work are retained.";
      const uncertainty =
        boundedResult === "error"
          ? { kind: "none", detail: null }
          : {
              kind: "unknown-effect",
              detail:
                boundedResult === "deadline"
                  ? `${kind} deadline expired; execution may still be running and its result is unknown`
                  : `${kind} execution ended without a verified process boundary`,
            };
      const fingerprint = fingerprintFor(goal, code, message);
      const summary = createOperationSummary({
        operationId: prepared.intent.operationId,
        operationKind: kind,
        status,
        summary: message,
        progress: fingerprint,
        denial: status === "failed" ? { code, message } : null,
      });
      session.commit((current, authority) => {
        const receipt = buildOperationReceipt(prepared.intent, {
          sequence: current.goal.sequence + 1,
          status,
          usage: prepared.intent.reservation,
          uncertainty,
          evidence: [summary.sha256],
        });
        return store.append(goalId, authority, "receipt", receipt, { blobs: [summary.bytes] });
      });
      return {
        stop: true,
        control: controlRequest,
        state: boundedResult === "aborted" ? "interrupted" : null,
        fingerprint,
        summary: message,
        reason: stopReason(code, message, nextAction),
      };
    }
    let observation = bounded.value;
    if (!observation || typeof observation !== "object") {
      observation = { summary: "", status: "succeeded" };
    }
    const summaryText = boundedText(observation.summary ?? "", 1_200);
    const source =
      typeof observation.path === "string" && observation.path
        ? {
            path: observation.path,
            exists: observation.exists !== false,
            sha256:
              typeof observation.sha256 === "string" && /^[a-f0-9]{64}$/.test(observation.sha256)
                ? observation.sha256
                : null,
          }
        : null;
    const observedStatus = ["succeeded", "failed", "denied"].includes(observation.status)
      ? observation.status
      : "failed";
    const failed = observedStatus !== "succeeded";
    const fingerprint = failed ? fingerprintFor(goal, `${kind}-failed`, summaryText) : null;
    const summary = createOperationSummary({
      operationId: prepared.intent.operationId,
      operationKind: kind,
      status: observedStatus,
      summary: summaryText,
      source,
      progress: fingerprint,
      denial: failed ? { code: `${kind}-failed`, message: summaryText } : null,
    });
    session.commit((current, authority) => {
      const receipt = buildOperationReceipt(prepared.intent, {
        sequence: current.goal.sequence + 1,
        status: observedStatus,
        usage: prepared.intent.reservation,
        uncertainty: { kind: "none", detail: null },
        evidence: [summary.sha256],
      });
      return store.append(goalId, authority, "receipt", receipt, { blobs: [summary.bytes] });
    });
    return { summary: summaryText, fingerprint };
  }

  function dispatchEdit(goal, call) {
    const args = call.arguments;
    if (
      typeof args.path !== "string" ||
      !(args.content === null || typeof args.content === "string")
    ) {
      return unknownToolResult(goal, "edit");
    }
    const prepared = session.commit((status, authority) => {
      const prep = prepareEditOperation({
        goal: status.goal,
        attemptId: session.attemptId,
        generation: status.goal.generation,
        path: args.path,
        content: args.content,
        mode: args.mode ?? null,
        reservation: reservationFor("edit"),
        workspaceRoot: workspace,
      });
      const authorized = authorizeEdit
        ? trustedDecision(
            authorizeEdit({
              kind: "edit",
              path: args.path,
              content: args.content,
              mode: args.mode ?? null,
              planHash: prep.planHash,
              intent: prep.intent,
              goal: status.goal,
            }),
          )
        : null;
      if (!authorized) return { denied: true, prep };
      prep.intent.authority = { ...prep.intent.authority, decisionId: authorized };
      const pending = store.append(goalId, authority, "intent", prep.intent, {
        blobs: prep.blobs,
      });
      store.append(goalId, { ...authority, fence: fenceOf(pending.goal) }, "dispatch", {
        ...prep.intent,
        state: "dispatched",
      });
      let effect;
      let failure = null;
      try {
        // The effect runs while the workspace lock token is still held. The
        // accepted operation layer revalidates dispatch, lease and generation.
        effect = applyEditOperation(workspace, prep.intent, prep.afterBytes, {
          lock: authority.lock,
          store,
        });
      } catch (error) {
        failure = error;
      }
      return { prep, effect, failure };
    });
    if (prepared.denied) {
      return deniedToolResult(goal, "Edit authority was denied; no durable intent was created.");
    }
    const effect = prepared.effect;
    const failure = prepared.failure;
    const summary = createOperationSummary({
      operationId: prepared.prep.intent.operationId,
      operationKind: "edit",
      status: failure ? "uncertain" : "succeeded",
      summary: failure
        ? boundedText(failure.message, 1_000)
        : `edited ${prepared.prep.intent.edit.path}`,
      source: {
        path: prepared.prep.intent.edit.path,
        exists: prepared.prep.intent.edit.after.exists,
        sha256: prepared.prep.intent.edit.after.sha256,
      },
      progress: failure
        ? fingerprintFor(goal, "edit-uncertain", boundedText(failure.message, 800))
        : null,
      denial: failure
        ? { code: "edit-uncertain", message: boundedText(failure.message, 600) }
        : null,
    });
    session.commit((current, authority) => {
      const receipt = buildOperationReceipt(prepared.prep.intent, {
        sequence: current.goal.sequence + 1,
        status: failure ? "uncertain" : "succeeded",
        usage: prepared.prep.intent.reservation,
        uncertainty: failure
          ? {
              kind: "unknown-effect",
              detail: "edit failed or cleanup is uncertain; reconcile before further effects",
            }
          : effect?.cleanupPending
            ? {
                kind: "unknown-effect",
                detail: "effect committed; cleanup is pending and must be reconciled",
              }
            : { kind: "none", detail: null },
        evidence: [summary.sha256],
        effect: effect ?? null,
      });
      return store.append(goalId, authority, "receipt", receipt, { blobs: [summary.bytes] });
    });
    if (failure) {
      return {
        stop: true,
        fingerprint: summary.summary.progress,
        reason: stopReason(
          "edit-uncertain",
          `Edit did not reach a verified boundary: ${boundedText(failure.message, 500)}`,
          "Reconcile the retained transaction evidence before any further effect. Do not retry blindly.",
        ),
      };
    }
    if (effect?.cleanupPending) {
      return {
        stop: true,
        reason: stopReason(
          "unresolved-transactions",
          `Edit committed but ${effect.retained.length} transaction artifact(s) still require reconciliation.`,
          "Inspect the retained commit manifests and quarantine objects, restore or record the target evidence, then rerun recovery. Do not dispatch further effects.",
          { retained: effect.retained },
        ),
      };
    }
    return { summary: summary.summary.summary };
  }

  function normalizeProcessResult(observedProcess) {
    if (!observedProcess || typeof observedProcess !== "object") return null;
    const exitCode =
      Number.isSafeInteger(observedProcess.exitCode) &&
      observedProcess.exitCode >= 0 &&
      observedProcess.exitCode <= 255
        ? observedProcess.exitCode
        : null;
    const signal =
      typeof observedProcess.signal === "string" && /^SIG[A-Z0-9]+$/.test(observedProcess.signal)
        ? observedProcess.signal
        : null;
    return exitCode === null && signal === null ? null : { exitCode, signal };
  }

  async function dispatchTest(goal, call, signal) {
    const planHash = call.arguments.planHash;
    if (typeof planHash !== "string" || !/^[a-f0-9]{64}$/.test(planHash)) {
      return unknownToolResult(goal, "test");
    }
    if (typeof runTest !== "function") {
      return deniedToolResult(goal, "No trusted test evaluator is configured.");
    }
    const prepared = session.commit((status, authority) => {
      const prep = prepareOperationIntent({
        goal: status.goal,
        attemptId: session.attemptId,
        generation: status.goal.generation,
        kind: "test",
        planHash,
        args: { planHash },
        reservation: reservationFor("test"),
      });
      const intent = prep.intent;
      const authorized = authorizeTest
        ? trustedDecision(
            authorizeTest({
              kind: "test",
              planHash,
              intent,
              goal: status.goal,
            }),
          )
        : null;
      if (!authorized) return { denied: true };
      intent.authority = { ...intent.authority, decisionId: authorized };
      const argsBytes = Buffer.from(canonicalJson({ planHash }), "utf8");
      intent.arguments = { sha256: intent.arguments.sha256, blob: intent.arguments.sha256 };
      // Capture the exact input identity at the dispatch boundary. The
      // workspace lock is held here, so a cooperating writer cannot change it
      // between this read and the committed dispatch.
      const inputState = hashWorkspacePaths(workspace, progressPaths(status.goal));
      const inputUnreadable = inputState.files
        .filter((file) => file.type === "unreadable")
        .map((file) => file.path);
      const pending = store.append(goalId, authority, "intent", intent, { blobs: [argsBytes] });
      options.stageTestDispatch?.(intent);
      const dispatched = store.append(
        goalId,
        { ...authority, fence: fenceOf(pending.goal) },
        "dispatch",
        { ...intent, state: "dispatched" },
      );
      return { intent, status: dispatched, inputState, inputUnreadable };
    });
    if (prepared.denied) {
      return deniedToolResult(goal, "Test authority was denied; no durable intent was created.");
    }

    const bounded = await runBounded(
      (toolSignal) =>
        runTest({
          planHash,
          goal,
          signal: toolSignal,
          operationId: prepared.intent.operationId,
        }),
      { signal, timeoutMs: toolTimeoutMs, label: "test" },
    );
    const kind = boundedKind(bounded);
    const control = bounded.controlRequest ?? requested();
    const inputFingerprint = prepared.inputState.sha256;

    /** @type {*} */
    let forced = null;
    let observation = bounded.value;
    let processResult = null;
    if (kind === "deadline") {
      forced = {
        status: "uncertain",
        code: "tool-deadline",
        message: "The test exceeded its hard execution deadline.",
        nextAction:
          "Do not treat the test as passed. Verify or stop the owned process through the process-ownership boundary, then rerun against current inputs.",
        uncertainty: {
          kind: "unknown-effect",
          detail: "test deadline expired; execution may still be running and its result is unknown",
        },
        progress: "test-deadline",
        teardownUnverified: true,
      };
    } else if (kind === "control") {
      forced = {
        status: control === "cancel" ? "cancelled" : "interrupted",
        control,
        code: control === "cancel" ? "test-cancelled" : "test-paused",
        message: `The goal ${control} request interrupted the test before a trusted observation.`,
        nextAction:
          control === "cancel"
            ? "Inspect retained evidence. Start a new goal for further work."
            : "Resume with a fresh invocation after verifying the interrupted process is no longer running.",
        uncertainty: {
          kind: "unknown-effect",
          detail: "test execution was interrupted; process teardown is unverified",
        },
        progress: `test-${control}`,
        teardownUnverified: true,
      };
    } else if (kind === "aborted") {
      forced = {
        status: "interrupted",
        state: "interrupted",
        code: "test-interrupted",
        message: "The test adapter aborted before producing a trusted observation.",
        nextAction:
          "Verify the test process is no longer running, then resume against current inputs.",
        uncertainty: {
          kind: "unknown-effect",
          detail: "test execution aborted; process teardown is unverified",
        },
        progress: "test-interrupted",
        teardownUnverified: true,
      };
    } else if (kind === "error") {
      forced = {
        status: "failed",
        code: "test-error",
        message: boundedText(bounded.error?.message ?? String(bounded.error), 1_000),
        nextAction:
          "Do not assume the evaluator owned no process. Verify or stop any owned process through the process-ownership boundary, then resume against current inputs.",
        uncertainty: { kind: "none", detail: null },
        progress: "test-error",
        // A thrown adapter error may happen after it spawned a child. Without
        // an observation the executor cannot distinguish that from a failure
        // before the effect, so it stays a surviving-execution block.
        teardownUnverified: true,
      };
    } else if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      forced = {
        status: "failed",
        code: "test-protocol",
        message: "The test evaluator returned no usable observation object.",
        nextAction: "Fix the trusted test adapter; no result was accepted as evidence.",
        uncertainty: { kind: "none", detail: null },
        progress: "test-protocol",
        teardownUnverified: true,
      };
    } else {
      processResult = normalizeProcessResult(observation.process);
      if (observation.status === "succeeded") {
        if (prepared.inputUnreadable.length > 0) {
          forced = {
            status: "uncertain",
            code: "test-inputs-unknown",
            message: `Test input identity is uncertain: ${boundedText(
              prepared.inputUnreadable.join(", "),
              500,
            )} could not be read at dispatch.`,
            nextAction: "Do not accept the result. Restore readable inputs and rerun verification.",
            uncertainty: {
              kind: "unknown-effect",
              detail: "a covered test input was unreadable at dispatch",
            },
            progress: "test-inputs-unknown",
          };
        }
        let postState = null;
        try {
          postState = hashWorkspacePaths(workspace, progressPaths(goal));
        } catch (error) {
          forced = {
            status: "uncertain",
            code: "test-inputs-unknown",
            message: `Test input identity could not be re-read: ${boundedText(error?.message ?? String(error), 500)}`,
            nextAction:
              "Do not accept the result. Inspect the workspace inputs and rerun verification.",
            uncertainty: {
              kind: "unknown-effect",
              detail: "post-execution input identity is uncertain",
            },
            progress: "test-inputs-unknown",
          };
        }
        if (!forced && postState.sha256 !== inputFingerprint) {
          forced = {
            status: "uncertain",
            code: "test-inputs-changed",
            message:
              "Source inputs changed between test dispatch and observation; the result does not certify the current bytes.",
            nextAction:
              "Do not accept the stale result. Inspect the change, then rerun verification against the current source.",
            uncertainty: {
              kind: "unknown-effect",
              detail: "tested input fingerprint no longer matches the workspace",
            },
            progress: "test-inputs-changed",
          };
        }
        const claimed = observation.sourceFingerprint;
        if (!forced && claimed !== undefined) {
          const validClaim =
            typeof claimed === "string" &&
            /^[a-f0-9]{64}$/.test(claimed) &&
            claimed === inputFingerprint;
          if (!validClaim) {
            forced = {
              status: "uncertain",
              code: "test-evidence-mismatch",
              message:
                "The evaluator snapshot does not bind to the exact inputs captured at dispatch.",
              nextAction:
                "Reject the snapshot evidence. Fix the trusted evaluator binding and rerun against current inputs.",
              uncertainty: {
                kind: "unknown-effect",
                detail: "evaluator snapshot fingerprint does not match dispatched inputs",
              },
              progress: "test-evidence-mismatch",
            };
          }
        }
        const claimedPlan = observation.planHash;
        if (!forced && claimedPlan !== undefined && claimedPlan !== planHash) {
          forced = {
            status: "uncertain",
            code: "test-plan-mismatch",
            message: "The evaluator snapshot does not bind to the test plan that was dispatched.",
            nextAction:
              "Reject the snapshot evidence. Fix the trusted evaluator plan binding and rerun.",
            uncertainty: {
              kind: "unknown-effect",
              detail: "evaluator snapshot plan does not match the dispatched plan",
            },
            progress: "test-plan-mismatch",
          };
        }
      }
    }

    const success = !forced && observation.status === "succeeded";
    const denied = !forced && observation.status === "denied";
    const finalStatus = forced
      ? forced.status
      : success
        ? "succeeded"
        : denied
          ? "denied"
          : "failed";
    const summaryText = forced
      ? forced.message
      : boundedText(observation.summary ?? "", 1_200) ||
        (success ? "verification passed" : "verification failed");
    const uncertainty = forced ? forced.uncertainty : { kind: "none", detail: null };
    const progressCode = forced ? forced.progress : success ? null : "test-failed";
    const fingerprint = progressCode ? fingerprintFor(goal, progressCode, summaryText) : null;
    const summary = createOperationSummary({
      operationId: prepared.intent.operationId,
      operationKind: "test",
      status: finalStatus,
      summary: summaryText,
      test: { planHash, sourceFingerprint: inputFingerprint },
      progress: fingerprint,
      denial:
        finalStatus === "failed" || finalStatus === "denied"
          ? { code: forced?.code ?? "test-failed", message: summaryText }
          : null,
      // Persist the unresolved execution state in the same durable receipt that
      // charges the reservation, before the stop transition releases the lease.
      execution: forced?.teardownUnverified
        ? {
            teardown: "unverified",
            attemptId: prepared.intent.attemptId,
            generation: prepared.intent.generation,
          }
        : undefined,
    });
    session.commit((current, authority) => {
      const receipt = buildOperationReceipt(prepared.intent, {
        sequence: current.goal.sequence + 1,
        status: finalStatus,
        usage: prepared.intent.reservation,
        process: processResult,
        uncertainty,
        evidence: [summary.sha256],
      });
      return store.append(goalId, authority, "receipt", receipt, { blobs: [summary.bytes] });
    });
    if (forced) {
      return {
        stop: true,
        control: forced.control ?? null,
        state: forced.state ?? null,
        fingerprint,
        summary: summaryText,
        reason: stopReason(forced.code, forced.message, forced.nextAction),
      };
    }
    return {
      summary: summary.summary.summary,
      fingerprint,
      reason: success
        ? undefined
        : stopReason(
            "test-failed",
            `Verification failed: ${summaryText || "no trusted pass"}`,
            "Inspect the failure; change code or diagnostics before retrying. Repeated identical failures stop the goal.",
          ),
    };
  }

  function finishStop(status, reason, extra = {}) {
    const current = store.inspect(goalId);
    return {
      status,
      goal: current.goal,
      budget: budgetSnapshot(current.goal.budget, current.counters),
      reason,
      context: lastContext,
      ...extra,
    };
  }

  function transitionStop(state, status, reason) {
    session.transition(state);
    return finishStop(status, reason);
  }

  async function loop() {
    for (;;) {
      const stop = requestedStop();
      if (stop) {
        const state = stop.code === "cancelled" ? "cancelled" : "paused";
        return transitionStop(state, stop.code, stop);
      }
      const current = session.current();
      const evaluation = evaluateCriteria(current.goal);
      if (evaluation.complete) {
        session.transition("completed", { evidence: evaluation.entries });
        completedStatus = finishStop(
          "completed",
          {
            code: "completed",
            message: "Every acceptance criterion has current trusted evidence.",
            nextAction: "Inspect the completed goal read-only. Further work is a new goal.",
          },
          { evidence: evaluation.entries },
        );
        return completedStatus;
      }
      if (!canReserve(current.goal.budget, current.counters, PROVIDER_RESERVATION)) {
        const reason = budgetStopReason(current.goal.budget, current.counters);
        return transitionStop("budget-exhausted", "budget-exhausted", reason);
      }
      session.maybeRenew(Date.now());
      const context = buildContext(current.goal, current.counters);
      lastContext = {
        messages: context.messages,
        bytes: context.bytes,
        omitted: context.data.omitted,
      };
      const provider = dispatchProvider(current.goal, current.counters, context);
      const startedAt = Date.now();
      const bounded = await runBounded(
        (providerSignal) =>
          turn({
            messages: context.messages,
            context: context.data,
            goal: current.goal,
            generation: current.goal.generation,
            budget: budgetSnapshot(current.goal.budget, current.counters),
            tools: toolSchema(),
            signal: providerSignal,
          }),
        { signal: control.signal ?? null, timeoutMs: providerTimeoutMs, label: "provider" },
      );
      const elapsed = elapsedUsage(startedAt, Date.now(), provider.intent.reservation);
      const request = bounded.controlRequest ?? requested();
      const abortedByControl = request === "cancel" || request === "pause" ? request : null;
      const error = bounded.error;
      const timedOut = bounded.deadlineExpired;
      if (error || timedOut || abortedByControl) {
        const engineAborted = Boolean(
          error &&
          !timedOut &&
          !abortedByControl &&
          (error.name === "AbortError" || error.code === "ABORT_ERR"),
        );
        const outcome = handleProviderOutcome(
          current.goal,
          provider.intent,
          {
            content: "",
            toolCalls: [],
            status: request === "cancel" || abortedByControl || engineAborted ? "aborted" : null,
            aborted: Boolean(abortedByControl) || engineAborted,
            timedOut,
          },
          elapsed,
          {
            error: Boolean(error) && !abortedByControl && !timedOut && !engineAborted,
            errorMessage: error ? boundedText(error.message ?? String(error), 800) : null,
            timedOut,
            cancelled: request === "cancel",
            abortedByControl,
          },
        );
        if (request === "cancel") return transitionStop("cancelled", "cancelled", outcome.reason);
        if (request === "pause") return transitionStop("paused", "paused", outcome.reason);
        if (outcome.reason.code === "provider-interrupted") {
          return transitionStop("interrupted", "interrupted", outcome.reason);
        }
        return transitionStop("needs-attention", "needs-attention", outcome.reason);
      }
      const raw = bounded.value;
      let normalized;
      try {
        normalized = normalizeTurn(raw);
      } catch (caught) {
        const reason = stopReason(
          "engine-protocol",
          caught.message,
          "Fix the engine adapter; no tool was dispatched and no authority was granted.",
        );
        const summary = createOperationSummary({
          operationId: provider.intent.operationId,
          operationKind: "provider",
          status: "failed",
          summary: reason.message,
          progress: fingerprintFor(current.goal, "engine-protocol", reason.message),
        });
        session.commit((stateNow, authority) => {
          const receipt = buildOperationReceipt(provider.intent, {
            sequence: stateNow.goal.sequence + 1,
            status: "failed",
            usage: provider.intent.reservation,
            uncertainty: { kind: "unknown-usage", detail: "invalid engine response" },
            evidence: [summary.sha256],
          });
          return store.append(goalId, authority, "receipt", receipt, { blobs: [summary.bytes] });
        });
        return transitionStop("needs-attention", "needs-attention", reason);
      }
      const outcome = handleProviderOutcome(current.goal, provider.intent, normalized, elapsed, {
        timedOut: false,
        cancelled: false,
        abortedByControl: null,
      });
      if (outcome.kind === "stop") {
        return transitionStop("needs-attention", "needs-attention", outcome.reason);
      }
      if (normalized.toolCalls.length === 0) {
        if (requestedStop()) continue;
        const after = session.current();
        const afterEvaluation = evaluateCriteria(after.goal);
        if (afterEvaluation.complete) continue;
        const remainingTest = afterEvaluation.unmet.some((criterion) => criterion.kind === "test");
        const remainingHuman = afterEvaluation.unmet.every(
          (criterion) => criterion.kind === "human",
        );
        if (remainingHuman && afterEvaluation.unmet.length > 0) {
          session.transition("needs-attention");
          return finishStop("needs-attention", {
            code: "human-review-required",
            message: "The remaining acceptance criteria require trusted human review.",
            nextAction:
              "Record an explicit human decision for each remaining criterion, then resume. Model text cannot satisfy them.",
          });
        }
        if (remainingTest && typeof runTest !== "function") {
          session.transition("needs-attention");
          return finishStop("needs-attention", {
            code: "no-trusted-evaluator",
            message: "A test criterion has no trusted evaluator configured.",
            nextAction:
              "Configure a trusted test evaluator and resume; model claims are not evidence.",
          });
        }
        const history = collectOperationHistory(store, goalId);
        const fingerprint = fingerprintFor(current.goal, "no-tool-calls", NO_PROGRESS_MESSAGE);
        const count = noProgressCount(history.summaries, fingerprint);
        if (count >= noProgressLimit) {
          session.transition("needs-attention");
          return finishStop("needs-attention", {
            code: "no-progress",
            message: `${count} equivalent turns produced no changed evidence and no tool action.`,
            nextAction:
              "Inspect the criteria and last failure. Change the code or diagnostics, or revise the objective; retrying prose alone is not progress.",
          });
        }
        continue;
      }
      for (const call of normalized.toolCalls) {
        if (requestedStop()) break;
        const currentTool = session.current();
        if (!canReserve(currentTool.goal.budget, currentTool.counters, TOOL_RESERVATION)) {
          const reason = budgetStopReason(currentTool.goal.budget, currentTool.counters);
          return transitionStop("budget-exhausted", "budget-exhausted", reason);
        }
        let result;
        try {
          result = await dispatchTool(currentTool.goal, call, control.signal ?? null);
        } catch (caught) {
          if (caught instanceof StaleGoalAttemptError) {
            return finishStop("interrupted", {
              code: "stale-attempt",
              message: "A late callback or generation change fenced this dispatch.",
              nextAction: "Inspect the current generation and resume from persisted state.",
            });
          }
          const reason = stopReason(
            caught.code ?? "tool-protocol",
            boundedText(caught.message ?? String(caught), 800),
            "Inspect the operation journal; do not retry an uncertain effect automatically.",
          );
          return finishStop("needs-attention", reason);
        }
        if (result.stop) {
          if (result.control === "cancel") {
            return transitionStop("cancelled", "cancelled", result.reason);
          }
          if (result.control === "pause") {
            return transitionStop("paused", "paused", result.reason);
          }
          if (result.state === "interrupted") {
            return transitionStop("interrupted", "interrupted", result.reason);
          }
          return transitionStop("needs-attention", "needs-attention", result.reason);
        }
        if (result.fingerprint) {
          const history = collectOperationHistory(store, goalId);
          if (noProgressCount(history.summaries, result.fingerprint) >= noProgressLimit) {
            session.transition("needs-attention");
            return finishStop("needs-attention", {
              code: "no-progress",
              message: `${noProgressLimit} equivalent failures produced no changed evidence.`,
              nextAction:
                "Inspect the failure and current source. Change the code, diagnostics or objective before resuming; repeating the same attempt is not progress.",
            });
          }
        }
      }
      if (requestedStop()) continue;
      const afterTools = session.current();
      const toolEvaluation = evaluateCriteria(afterTools.goal);
      if (toolEvaluation.complete) continue;
    }
  }

  /**
   * Begin an attempt if the prior state is safely resumable. The accepted
   * store has no abandoned-lease reclamation API; a live lease is therefore a
   * safe stop, not permission to steal the attempt. DUR-005 owns that
   * cross-process recovery channel.
   */
  function begin() {
    try {
      // Read-only phase (no workspace lock): inspect and verify any surviving
      // execution through the trusted ownership boundary. The attestation
      // writes only under MATRIX_HOME and never the workspace, so it cannot
      // deadlock against the probe that gates workspace writes. DUR-005 owns
      // this integration; the accepted executor previously ran this check
      // inside the workspace lock, which made verification impossible.
      const preStatus = store.inspect(goalId);
      if (preStatus.uncommittedBytes > 0) {
        return {
          stop: statusResult(store, goalId, "safe-stop", {
            code: "uncommitted-journal-tail",
            message: "The committed checkpoint does not cover the journal tail.",
            nextAction: "Run the accepted recovery procedure before any new operation.",
          }),
        };
      }
      if (ACTIVE_STATES.has(preStatus.goal.state) || preStatus.lease) {
        return {
          stop: statusResult(store, goalId, "safe-stop", {
            code: "active-attempt",
            message:
              "Another attempt still owns the goal lease. It cannot be reclaimed by a fresh process yet.",
            nextAction:
              "Wait for the owner to stop, or use the reviewed DUR-005 recovery channel. Do not delete state or steal the lease.",
          }),
        };
      }
      const preBlock = durableExecutionBlock(preStatus.goal.workspace);
      const verified = preBlock.operations.length ? acceptedTeardownAttestation(preBlock) : [];
      if (!verified) {
        return { stop: statusResult(store, goalId, "safe-stop", teardownBlockReason(preBlock)) };
      }
      const verifiedOperations = new Set(verified.map((entry) => entry.operationId));
      return withGoalLock(
        workspace,
        (lock) => {
          const status = store.inspect(goalId);
          if (status.uncommittedBytes > 0) {
            return {
              stop: statusResult(store, goalId, "safe-stop", {
                code: "uncommitted-journal-tail",
                message: "The committed checkpoint does not cover the journal tail.",
                nextAction: "Run the accepted recovery procedure before any new operation.",
              }),
            };
          }
          if (ACTIVE_STATES.has(status.goal.state) || status.lease) {
            return {
              stop: statusResult(store, goalId, "safe-stop", {
                code: "active-attempt",
                message:
                  "Another attempt still owns the goal lease. It cannot be reclaimed by a fresh process yet.",
                nextAction:
                  "Wait for the owner to stop, or use the reviewed DUR-005 recovery channel. Do not delete state or steal the lease.",
              }),
            };
          }
          // Re-check the teardown block under the lock (TOCTOU guard); the
          // attestation is idempotent through the reconciled records.
          const block = durableExecutionBlock(status.goal.workspace);
          if (block.operations.length > 0 && !acceptedTeardownAttestation(block)) {
            return { stop: statusResult(store, goalId, "safe-stop", teardownBlockReason(block)) };
          }
          if (status.goal.state === "completed" || status.goal.state === "cancelled") {
            return {
              stop: statusResult(store, goalId, status.goal.state, {
                code: status.goal.state,
                message: `Goal is ${status.goal.state}; it cannot be resumed.`,
                nextAction:
                  status.goal.state === "completed"
                    ? "Inspect read-only. Start a new goal for further work."
                    : "Inspect retained recovery; start a new goal for further work.",
              }),
            };
          }
          if (status.goal.state === "budget-exhausted") {
            return {
              stop: statusResult(
                store,
                goalId,
                "budget-exhausted",
                budgetStopReason(status.goal.budget, status.counters),
              ),
            };
          }
          const reconciliation = reconcileGoalOperations(store, goalId, {
            workspaceRoot: workspace,
          });
          if (!reconciliation.canResume || reconciliation.unresolvedCommits.length > 0) {
            return {
              stop: statusResult(store, goalId, "needs-attention", {
                code: "unresolved-transactions",
                message:
                  "DUR-003 recovery retains unresolved transaction artifacts. Effects and resume are blocked.",
                nextAction:
                  "Inspect the retained commit manifests and quarantine objects, restore or record the target evidence, then rerun recovery. Nothing is pruned automatically.",
                retained: reconciliation.unresolvedCommits.map((artifact) => ({
                  path: artifact.path,
                  manifest: artifact.manifest,
                  retained: artifact.retained,
                })),
                files: reconciliation.fileReconciliations,
              }),
            };
          }
          if (reconciliation.needsAttention) {
            return {
              stop: statusResult(store, goalId, "needs-attention", {
                code: "workspace-drift",
                message: "Reconciliation found divergent or ambiguous workspace state.",
                nextAction:
                  "Inspect the reported files and retained evidence; resolve the divergence before resuming.",
                files: reconciliation.fileReconciliations,
              }),
            };
          }
          let settled = status;
          for (const entry of status.journal.operations) {
            if (entry.dispatchSequence !== null && entry.receiptSequence === null) {
              settled = store.recordRecoveredDispatch(
                goalId,
                {
                  lock,
                  fence: fenceOf(settled.goal),
                },
                entry.operationId,
              );
            }
          }
          let begun = store.beginAttempt(goalId, {
            lock,
            fence: fenceOf(settled.goal),
          });
          if (begun.goal.state === "reconciling") {
            begun = store.transition(
              goalId,
              {
                lock,
                fence: fenceOf(begun.goal),
                leaseId: begun.lease.leaseId,
              },
              "running",
            );
          }
          return {
            session: new GoalAttemptSession({
              store,
              goalId,
              workspace,
              verifiedOperations,
              attempt: {
                generation: begun.goal.generation,
                attemptId: begun.lease.attemptId,
                leaseId: begun.lease.leaseId,
              },
            }),
          };
        },
        { home: store.home, recoveryGoalId: goalId, verifiedOperations },
      );
    } catch (error) {
      return {
        stop: statusResult(store, goalId, "safe-stop", {
          code: "store-refused",
          message: boundedText(error?.message ?? String(error), 800),
          nextAction: "Inspect the store and recovery evidence. Do not retry blindly.",
        }),
      };
    }
  }

  return {
    goalId,
    workspace,
    get session() {
      return session;
    },
    get context() {
      return lastContext;
    },
    /** Trusted code records a human decision; the model has no access to this. */
    recordHumanDecision(criterionId, decision) {
      const current = store.inspect(goalId);
      const criterion = current.goal.criteria.find((item) => item.id === criterionId);
      if (!criterion || criterion.kind !== "human") {
        throw new Error("goal executor: unknown human criterion");
      }
      validateGoalId(criterionId, "criterion");
      if (!decision || decision.accepted !== true) {
        throw new Error("goal executor: human decision must be accepted");
      }
      validateGoalId(decision.decisionId, "decision");
      const value = {
        criterionId,
        revision: criterion.revision,
        decisionId: decision.decisionId,
        accepted: true,
      };
      humanDecisions.set(criterionId, value);
      return { ...value };
    },
    async resume() {
      if (session) throw new Error("goal executor: an attempt is already active");
      if (completedStatus) return completedStatus;
      const begun = begin();
      if (begun.stop) return begun.stop;
      session = begun.session;
      try {
        return await loop();
      } catch (error) {
        if (error instanceof StaleGoalAttemptError) {
          return finishStop("interrupted", {
            code: "stale-attempt",
            message: error.message,
            nextAction: "Inspect the current generation and resume from persisted state.",
          });
        }
        return finishStop("needs-attention", {
          code: "executor-error",
          message: boundedText(error?.message ?? String(error), 800),
          nextAction: "Inspect the journal and retained evidence before retrying.",
        });
      } finally {
        if (session) session.closed = true;
        session = null;
      }
    },
  };
}
