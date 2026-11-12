import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { renderGoalApp } from "../src/goal-app.mjs";
import {
  GOAL_DEFAULT_BUDGET,
  GOAL_SCHEMA_VERSION,
  newGoalId,
  validateGoalRecord,
} from "./goal-contracts.mjs";
import { collectOperationHistory, hashWorkspacePaths, receiptSummary } from "./goal-context.mjs";
import { budgetSnapshot } from "./goal-budget.mjs";
import {
  createGoalRuntime,
  createGoalSourceManifestProvider,
  reclaimStaleGoalAttempt,
  workspaceIdentityOf,
} from "./goal-policy.mjs";
import { readGoalReview, saveGoalReview } from "./goal-human-review.mjs";
import { createGoalStore } from "./goal-store.mjs";
import { prepareEditOperation } from "./goal-operations.mjs";
import { assertGoalLock, withGoalLock } from "./goal-lock.mjs";
import { bindGoalProvider, createGoalEngine, goalReadTool } from "./goal-engine.mjs";
import { startGoalControl, requestGoalControl, goalOwnerIsLive } from "./goal-control.mjs";
import { createRedactor, redactedDetail } from "./redaction.mjs";
import { isExplicitBuiltinProvider } from "./provider-contracts.mjs";
import { getExplicitBuiltinKey } from "./credentials.mjs";
import { loadProviderConfig } from "./provider-config.mjs";
import { detectProject } from "./project.mjs";
import { inspectTestPlan } from "./test-policy.mjs";
import { matrixHome } from "./session.mjs";

const CRITERIA_BYTES = 64 * 1024;
const LIST_LIMIT = 64;
const TERMINAL = new Set(["completed", "cancelled"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function invalid(message) {
  return Object.assign(new Error(message), { exitCode: 2 });
}

function plainText(value, redactor, limit = 512, trusted = false) {
  const text = trusted
    ? redactor.text(value ?? "").slice(0, limit)
    : redactedDetail(value ?? "", { secrets: redactor.values, maxChars: limit });
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

function readCriteria(path, planHash) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > CRITERIA_BYTES)
      throw invalid("criteria must be a regular JSON file of at most 64 KiB");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw invalid("criteria file changed while reading");
    const document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    );
    if (
      !document ||
      document.schemaVersion !== 1 ||
      !Array.isArray(document.criteria) ||
      Object.keys(document).some((key) => !["schemaVersion", "criteria"].includes(key))
    ) {
      throw invalid("criteria file must have schemaVersion 1 and a criteria array");
    }
    return document.criteria.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        throw invalid("invalid criterion");
      const criterion = { id: newGoalId("criterion"), revision: 1, ...entry };
      if (criterion.kind === "test") {
        if (!planHash) throw invalid("no valid test plan is available for this workspace");
        criterion.planHash ??= planHash;
        if (criterion.planHash !== planHash)
          throw invalid("test criterion does not match the current workspace test plan");
      }
      return criterion;
    });
  } finally {
    closeSync(fd);
  }
}

function sameWorkspace(goal, workspace) {
  return goal.workspace.device === workspace.device && goal.workspace.inode === workspace.inode;
}

/** Whether the goal's recorded path still resolves to the recorded workspace identity. */
function recordedWorkspace(goal) {
  try {
    const identity = workspaceIdentityOf(goal.workspace.path);
    return {
      path: goal.workspace.path,
      matches: identity.device === goal.workspace.device && identity.inode === goal.workspace.inode,
    };
  } catch {
    return { path: goal.workspace.path, matches: false };
  }
}

function resolveGoalSecretValues(home, provider) {
  const providerId = provider?.id ?? provider;
  if (!providerId || typeof providerId !== "string") return [];
  const secrets = [];
  try {
    if (isExplicitBuiltinProvider(providerId)) {
      const key = getExplicitBuiltinKey(providerId);
      if (typeof key === "string" && key.length > 0) secrets.push(key);
    } else {
      const { config } = loadProviderConfig({ home });
      const profile = config?.providers?.find((entry) => entry.id === providerId);
      if (profile?.auth?.type === "bearer" && profile.auth.env) {
        const value = process.env[profile.auth.env];
        if (typeof value === "string" && value.length > 0) {
          secrets.push(value);
          if (value.trim() !== value && value.trim().length > 0) {
            secrets.push(value.trim());
          }
        }
      }
    }
  } catch {
    // Keep inspect and refusal paths read-only and offline.
  }
  return secrets;
}

function isSensitivePath(path, redactor) {
  if (!path || typeof path !== "string") return false;
  if (redactor.text(path) !== path) return true;
  for (const secret of redactor.values ?? []) {
    if (typeof secret === "string" && secret.length > 0 && path.includes(secret)) {
      return true;
    }
  }
  return false;
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

/** Append a copyable --cwd only when the path can be shown without redaction. */
function withWorkspace(command, path, redactor) {
  if (!path || path === process.cwd() || isSensitivePath(path, redactor)) return command;
  return `${command} --cwd ${shellQuote(path)}`;
}

/**
 * Locally constructed mismatch guidance. It is redacted by the caller as trusted
 * text: the recorded path is part of the answer, and withholding the whole
 * message would hide the only copyable continuation.
 */
function workspaceMismatchReason(recorded, redactor) {
  const sensitive = isSensitivePath(recorded.path, redactor);
  if (recorded.matches) {
    if (sensitive) {
      return "This goal belongs to the recorded workspace [redacted]. Run the printed command from the original workspace.";
    }
    return `This goal belongs to the recorded workspace ${shellQuote(recorded.path)}. Run the printed command from that directory.`;
  }
  const path = sensitive ? "[redacted]" : shellQuote(recorded.path);
  return `This goal belongs to the recorded workspace ${path}, which is missing or has been replaced. Restore that directory. If it moved, confirm the new location with matrix goal list --cwd <new directory>, then resume from the directory that lists this goal. Resuming in a replacement directory is refused.`;
}

function nextCommand(goal, ownerAlive) {
  if (TERMINAL.has(goal.state) || goal.state === "budget-exhausted")
    return `matrix goal inspect ${goal.id}`;
  if (["running", "awaiting-approval", "reconciling"].includes(goal.state))
    return `matrix goal ${ownerAlive ? "pause" : "resume"} ${goal.id}`;
  return `matrix goal resume ${goal.id}`;
}

/**
 * The source identity of one goal, computed with the same rules the executor
 * uses. The projection must agree with the accepted evidence, so the identity
 * is the goal's complete source manifest and not only its artifact paths.
 */
function goalSources(goal, workspace, history, provider = null) {
  if (!sameWorkspace(goal, workspace)) return null;
  const paths = goal.criteria
    .filter((criterion) => criterion.kind === "artifact")
    .map((criterion) => criterion.path);
  for (const entry of history.operations)
    if (entry.intent?.edit) paths.push(entry.intent.edit.path);
  if (provider) {
    try {
      return provider({ paths, root: workspace.path });
    } catch {
      // An unreadable input set cannot certify a criterion; the projection
      // falls back to the accepted path set rather than claiming a match.
      return hashWorkspacePaths(workspace.path, paths);
    }
  }
  return hashWorkspacePaths(workspace.path, paths);
}

function projectGoal(
  store,
  status,
  workspace,
  home,
  redactor,
  result = null,
  providerFactory = null,
) {
  const { goal, counters } = status;
  const ownerAlive = status.lease ? goalOwnerIsLive(status.lease) : false;
  const history = collectOperationHistory(store, goal.id);
  // The workspace plan is only needed when a test criterion has to be
  // projected; a goal without one keeps the accepted path-set identity.
  const needsSourceIdentity = goal.criteria.some((criterion) => criterion.kind === "test");
  const provider = needsSourceIdentity && providerFactory ? providerFactory().provider : null;
  const sources = goalSources(goal, workspace, history, provider);
  const recent = history.operations.findLast((entry) => entry.dispatch || entry.receipt);
  const summary = recent?.receipt ? receiptSummary(store, goal.id, recent.receipt) : null;
  const evidence = new Set(result?.evidence?.map((entry) => entry.criterionId) ?? []);
  const defaultReason =
    {
      ready: "This goal has a saved definition and has not started.",
      paused: "The attempt paused at a safe boundary.",
      interrupted: "The last attempt was interrupted. Resume to verify recovery.",
      "needs-attention":
        "The attempt stopped before satisfying every criterion. Inspect the last operation before resuming.",
      "budget-exhausted": "The saved budget cannot reserve another operation.",
      completed: "The recorded attempt satisfied every criterion.",
      cancelled: "The goal was cancelled.",
    }[goal.state] ??
    (ownerAlive
      ? "The recorded owner is running."
      : "The recorded owner stopped. Resume to verify recovery.");
  if (goal.state === "completed") {
    const final = store.readJournal(goal.id).findLast((entry) => entry.kind === "terminal");
    for (const entry of final?.payload.evidence ?? [])
      if (entry.accepted) evidence.add(entry.criterionId);
  }
  const recorded = sameWorkspace(goal, workspace) ? null : recordedWorkspace(goal);
  return {
    schemaVersion: 1,
    goalId: goal.id,
    state: goal.state,
    generation: goal.generation,
    criteria: goal.criteria.map((criterion) => ({
      id: criterion.id,
      kind: criterion.kind,
      label: plainText(
        criterion.path ?? criterion.planHash ?? criterion.description,
        redactor,
        160,
      ),
      accepted:
        criterion.kind === "artifact"
          ? sources?.files.some(
              (file) => file.path === criterion.path && file.sha256 === criterion.sha256,
            ) === true
          : criterion.kind === "test"
            ? history.summaries.some(
                (item) =>
                  item.status === "succeeded" &&
                  item.test?.planHash === criterion.planHash &&
                  item.test.sourceFingerprint === sources?.sha256,
              )
            : evidence.has(criterion.id) ||
              (sources !== null && readGoalReview(home, goal, criterion, sources.sha256) !== null),
    })),
    remaining: budgetSnapshot(goal.budget, counters).remaining,
    lastOperation: recent
      ? {
          id: recent.operationId,
          kind: recent.intent.kind,
          status: recent.receipt?.status ?? "unobserved",
        }
      : null,
    reason:
      (result?.reason?.message !== undefined
        ? plainText(result.reason.message, redactor)
        : recorded
          ? plainText(workspaceMismatchReason(recorded, redactor), redactor, 512, true)
          : summary?.denial?.message !== undefined
            ? plainText(summary.denial.message, redactor)
            : plainText(defaultReason, redactor, 512, true)) || null,
    reasonCode:
      plainText(result?.reason?.code ?? summary?.denial?.code, redactor, 80, true) || null,
    ownerAlive,
    nextCommand: recorded
      ? recorded.matches
        ? withWorkspace(nextCommand(goal, ownerAlive), recorded.path, redactor)
        : `matrix goal inspect ${goal.id}`
      : withWorkspace(nextCommand(goal, ownerAlive), workspace.path, redactor),
  };
}

function output(view, options, stdout) {
  const text = options.json ? JSON.stringify(view) : renderGoalApp(view, stdout);
  stdout.write(text + "\n");
}

function goalBudget(options) {
  return {
    rounds: options.goalRounds ?? GOAL_DEFAULT_BUDGET.rounds,
    tools: options.goalTools ?? GOAL_DEFAULT_BUDGET.tools,
    requests: options.goalRequests ?? GOAL_DEFAULT_BUDGET.requests,
    activeMs: options.goalActiveMs ?? GOAL_DEFAULT_BUDGET.activeMs,
  };
}

export async function commandGoal(
  options,
  cwd,
  { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {},
) {
  const home = resolve(matrixHome());
  const action = options.goalAction;
  let redactor = createRedactor();
  if (options.providerId) {
    const startSecrets = resolveGoalSecretValues(home, { id: options.providerId });
    if (startSecrets.length > 0) {
      redactor = createRedactor({ secretValues: [...redactor.values, ...startSecrets] });
    }
  }
  let store;
  let goalId = options.goalId;
  try {
    const workspace = workspaceIdentityOf(cwd);
    store = createGoalStore(home);
    if (action === "list") {
      const path = join(home, "goals");
      const goals = lstatSync(path, { throwIfNoEntry: false })
        ? store
            .listWorkspaceGoals(workspace)
            .filter((goal) => sameWorkspace(goal, workspace))
            .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
        : [];
      output(
        {
          schemaVersion: 1,
          goals: goals.slice(0, LIST_LIMIT).map((goal) => ({
            id: goal.id,
            state: goal.state,
            generation: goal.generation,
            objective: plainText(goal.objective, redactor, 160),
          })),
          omitted: Math.max(0, goals.length - LIST_LIMIT),
        },
        options,
        stdout,
      );
      return 0;
    }

    let detected = null;
    /**
     * The workspace's test plan and the source-manifest provider built from
     * it. The projection and the executor must agree on the identity of the
     * goal's inputs, so both use the same provider.
     */
    const detectSources = (required = false) => {
      if (detected) return detected;
      try {
        const project = detectProject(workspace.path);
        detected = {
          project,
          inspected: project.test ? inspectTestPlan(project.test, { cwd: workspace.path }) : null,
          provider: project.test
            ? createGoalSourceManifestProvider({ root: workspace.path, plan: project.test, home })
            : null,
        };
      } catch (error) {
        // A read-only projection must not fail because the workspace cannot be
        // scanned; it simply cannot show a test criterion as accepted. An
        // attempt that needs the plan still reports the failure.
        if (required) throw error;
        detected = { project: null, inspected: null, provider: null };
      }
      return detected;
    };

    let status;
    if (action !== "start") {
      try {
        status = store.inspect(goalId);
      } catch (error) {
        throw invalid(error.code === "ENOENT" ? `unknown goal ${goalId}` : error.message);
      }
      const goalSecrets = resolveGoalSecretValues(home, status.goal?.provider);
      if (goalSecrets.length > 0) {
        redactor = createRedactor({ secretValues: [...redactor.values, ...goalSecrets] });
      }
      if (action === "inspect") {
        output(
          projectGoal(store, status, workspace, home, redactor, null, detectSources),
          options,
          stdout,
        );
        return 0;
      }
      if (!sameWorkspace(status.goal, workspace)) {
        const recorded = recordedWorkspace(status.goal);
        const sensitive = isSensitivePath(recorded.path, redactor);
        const displayPath = sensitive ? "[redacted]" : shellQuote(recorded.path);
        throw invalid(
          recorded.matches
            ? sensitive
              ? `current workspace does not match the recorded goal; run from the original recorded workspace: matrix goal resume ${goalId}`
              : `current workspace does not match the recorded goal; run from the recorded workspace: ${withWorkspace(`matrix goal resume ${goalId}`, recorded.path, redactor)}`
            : `current workspace does not match the recorded goal, and its recorded workspace ${displayPath} is missing or has been replaced; restore that directory, then resume from it. If it moved, confirm the new location with matrix goal list --cwd <new directory>, then resume from the directory that lists this goal. Resuming in a replacement directory is refused.`,
        );
      }
      if (action === "pause" || action === "cancel") {
        if (status.lease) {
          try {
            await requestGoalControl({ home, goalId, lease: status.lease, action });
          } catch (error) {
            const live = goalOwnerIsLive(status.lease);
            const detail = plainText(error.message, redactor, 160, true);
            throw invalid(
              live
                ? `the goal owner did not accept this ${action} request (${detail}); use matrix goal inspect ${goalId} to see the current attempt, then retry`
                : `the goal has no verified live owner; use matrix goal resume ${goalId} to verify recovery, or matrix goal inspect ${goalId}`,
            );
          }
        } else if (action === "cancel" && !TERMINAL.has(status.goal.state)) {
          withGoalLock(
            workspace.path,
            (lock) => {
              const { goal } = status;
              store.transition(
                goalId,
                { lock, fence: { goalId, generation: goal.generation, sequence: goal.sequence } },
                "cancelled",
              );
            },
            { home },
          );
        } else {
          throw invalid("the goal has no active attempt that accepts this control request");
        }
        const view = projectGoal(
          store,
          store.inspect(goalId),
          workspace,
          home,
          redactor,
          null,
          detectSources,
        );
        output(
          { ...view, event: status.lease ? `${action} requested` : "Goal cancelled" },
          options,
          stdout,
        );
        return 0;
      }
      if (TERMINAL.has(status.goal.state)) {
        throw invalid(
          `goal is already ${status.goal.state}; inspect it or start a new goal (refused)`,
        );
      }
    }

    const { project, inspected } = detectSources(true);
    const availablePlanHash = inspected?.ok ? inspected.plan.planHash : null;
    const criteria =
      status?.goal.criteria ??
      readCriteria(resolve(cwd, options.goalCriteriaFile), availablePlanHash);
    const testPlanHash = criteria.some(
      (entry) => entry.kind === "test" && entry.planHash === availablePlanHash,
    )
      ? availablePlanHash
      : null;
    let provider;
    try {
      provider = bindGoalProvider({ home, options, saved: status?.goal.provider });
    } catch (error) {
      throw invalid(error.message);
    }
    redactor = createRedactor({
      secretValues: [...redactor.values, provider.binding?.credential],
    });
    if (action === "start") {
      goalId = newGoalId();
      if (redactor.text(options.goalObjective) !== options.goalObjective)
        throw invalid("goal objective contains protected text");
      const goal = validateGoalRecord({
        schemaVersion: GOAL_SCHEMA_VERSION,
        id: goalId,
        createdAt: Date.now(),
        objective: options.goalObjective,
        provider: provider.identity,
        workspace: { ...workspace, revision: null, manifest: hash(JSON.stringify(workspace)) },
        state: "ready",
        generation: 0,
        sequence: 0,
        operations: [],
        criteria,
        budget: goalBudget(options),
      });
      mkdirSync(home, { recursive: true, mode: 0o700 });
      store.create(goal);
      status = store.inspect(goalId);
    }

    let reclaimed = false;
    if (status.lease) {
      const recovery = reclaimStaleGoalAttempt({ home, goalId, workspace: workspace.path });
      if (!recovery.reclaimed)
        throw invalid(
          `resume refused (${recovery.reason}); use matrix goal inspect ${goalId} or matrix goal pause ${goalId}`,
        );
      reclaimed = true;
    }

    const interactive = !options.json && stdin.isTTY && stdout.isTTY;
    const reader = interactive ? createInterface({ input: stdin, output: stderr }) : null;
    const inputAbort = new AbortController();
    let runtime;
    const ask = async (prompt, signal) => {
      if (!reader || signal?.aborted) return false;
      try {
        return (await reader.question(prompt, { signal })).trim() === "y";
      } catch (error) {
        if (signal?.aborted) return false;
        throw error;
      }
    };
    const approve = async (call, input) => {
      if (input.signal.aborted) return;
      if (call.name === "edit" && !options.autoApprove && reader) {
        const { path, content, mode = null } = call.arguments;
        const active = store.inspect(goalId);
        const prepare = () =>
          prepareEditOperation({
            goal: input.goal,
            attemptId: active.lease.attemptId,
            generation: active.goal.generation,
            path,
            content,
            mode,
            workspaceRoot: workspace.path,
          });
        const before = prepare();
        const edit = before.intent.edit;
        const preview = JSON.stringify({
          path,
          before: before.beforeBytes?.toString("utf8") ?? null,
          after: content,
          previousMode: edit.before.mode,
          mode: edit.after.mode,
        });
        if (redactor.text(preview) !== preview || Buffer.byteLength(preview) > 32 * 1024) return;
        if (
          before.beforeBytes &&
          !Buffer.from(before.beforeBytes.toString("utf8"), "utf8").equals(before.beforeBytes)
        )
          return;
        const escaped = preview.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
          character
            .split("")
            .map((unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"))
            .join(""),
        );
        stderr.write(`Proposed edit (JSON-escaped text)\n${escaped}\n`);
        const approved = await ask("Apply this exact edit? [y/N] ", input.signal);
        if (!input.signal.aborted && before.planHash === prepare().planHash) {
          runtime.authority.registerEditGrant({ path, content, mode, approved, goalId });
        }
      }
      if (
        call.name === "test" &&
        !options.allowTests &&
        reader &&
        call.arguments.planHash === testPlanHash
      ) {
        const plan = JSON.stringify({
          cwd: inspected.plan.cwd,
          executable: inspected.plan.executable,
          args: inspected.plan.args,
          planHash: testPlanHash,
        });
        if (redactor.text(plan) !== plan || Buffer.byteLength(plan) > 16 * 1024) return;
        stderr.write(`Exact test plan\n${plan}\n`);
        const approved = await ask("Run this exact test plan? [y/N] ", input.signal);
        if (!input.signal.aborted)
          runtime.authority.registerTestGrant({ planHash: testPlanHash, approved, goalId });
      }
    };
    const engine = createGoalEngine({ provider, project, home, testPlanHash, redactor, approve });
    runtime = createGoalRuntime({
      home,
      goalId,
      workspace: workspace.path,
      store,
      engine,
      tools: { read: goalReadTool(workspace.path, home, redactor) },
      testPlan: testPlanHash ? project.test : null,
      headless: !interactive,
      allowEdits: options.autoApprove,
      allowTests: options.allowTests,
    });
    let interrupted = false;
    const stop = () => {
      interrupted = true;
      runtime.pause();
      inputAbort.abort();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    reader?.on("SIGINT", stop);
    let closeControl;
    try {
      closeControl = await startGoalControl({ home, goalId, store, runtime });
      if (interactive) {
        const current = projectGoal(
          store,
          store.inspect(goalId),
          workspace,
          home,
          redactor,
          null,
          detectSources,
        );
        output(
          {
            ...current,
            event: reclaimed
              ? "Previous owner verified stopped. Checking recovery."
              : action === "start"
                ? "Goal created. Starting an attempt."
                : "Starting a fresh goal attempt.",
          },
          options,
          stdout,
        );
      }
      const humans = criteria.filter((criterion) => criterion.kind === "human");
      if (humans.length && !interrupted) {
        const current = store.inspect(goalId);
        const view = projectGoal(store, current, workspace, home, redactor, null, detectSources);
        if (
          !current.lease &&
          view.criteria.every((criterion) => criterion.kind === "human" || criterion.accepted)
        ) {
          const sources = goalSources(
            current.goal,
            workspace,
            collectOperationHistory(store, goalId),
            detectSources().provider,
          );
          const decisions = new Map();
          for (const criterion of humans) {
            if (interrupted) break;
            let decision = readGoalReview(home, current.goal, criterion, sources.sha256);
            if (
              !decision &&
              reader &&
              (await ask(
                `Accept human criterion "${plainText(criterion.description, redactor)}" for the current workspace? [y/N] `,
                inputAbort.signal,
              ))
            ) {
              decision = withGoalLock(
                workspace.path,
                (lock) => {
                  assertGoalLock(lock, workspace);
                  const fresh = store.inspect(goalId);
                  if (
                    fresh.lease ||
                    fresh.goal.sequence !== current.goal.sequence ||
                    goalSources(
                      fresh.goal,
                      workspace,
                      collectOperationHistory(store, goalId),
                      detectSources().provider,
                    ).sha256 !== sources.sha256
                  ) {
                    throw invalid(
                      `goal changed during human review; use matrix goal resume ${goalId}`,
                    );
                  }
                  return saveGoalReview(home, fresh.goal, criterion, sources.sha256);
                },
                { home },
              );
            }
            if (decision) decisions.set(criterion.id, decision);
          }
          if (!interrupted && decisions.size === humans.length) {
            const fresh = store.inspect(goalId);
            if (
              !fresh.lease &&
              fresh.goal.sequence === current.goal.sequence &&
              goalSources(
                fresh.goal,
                workspace,
                collectOperationHistory(store, goalId),
                detectSources().provider,
              ).sha256 === sources.sha256
            ) {
              for (const [criterionId, decision] of decisions)
                runtime.recordHumanDecision(criterionId, decision);
            }
          }
        }
      }
      const result = await runtime.resume();
      const view = projectGoal(
        store,
        store.inspect(goalId),
        workspace,
        home,
        redactor,
        result,
        detectSources,
      );
      const admitted = view.generation > status.goal.generation;
      output(
        {
          ...view,
          event:
            result.status === "completed"
              ? action === "resume" && admitted
                ? "Goal completed after resume"
                : "Goal completed"
              : admitted
                ? action === "resume"
                  ? "Goal resumed and stopped"
                  : "Goal started and stopped"
                : "Goal attempt refused",
          reconciled: reclaimed && admitted,
          resumed: action === "resume" && admitted,
          result: result.status,
        },
        options,
        stdout,
      );
      return interrupted || result.status === "interrupted"
        ? 130
        : result.status === "completed"
          ? 0
          : 1;
    } finally {
      reader?.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await closeControl?.();
    }
  } catch (error) {
    const message =
      error.exitCode === 2
        ? plainText(error.message, redactor, 512, true)
        : redactedDetail(error.message, { secrets: redactor.values, maxChars: 512 });
    const exitCode = error.exitCode ?? (action === "start" ? 2 : 1);
    if (options.json)
      output({ schemaVersion: 1, goalId, result: "refused", reason: message }, options, stdout);
    else stderr.write(`matrix goal: ${message}\n`);
    return exitCode;
  }
}
