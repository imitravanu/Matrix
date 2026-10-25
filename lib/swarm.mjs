// ============================================================================
// Real swarm state.
//
// Planner, Forge and Radar are three views of one actual run, fed by the event
// stream from the local or model agent. There are no decorative ticks: a lane
// only lights up when a real phase starts, and its logs are real tool lines.
// ============================================================================

import { OUTCOME, classifyOutcome } from "./outcome.mjs";

const MAX_LOGS = 80;
const MAX_DIFF = 80;

export function createSwarmState({ task = "", project = null } = {}) {
  return {
    task: String(task ?? ""),
    mode: "idle", // idle | running | waiting | done | error | aborted
    outcome: null,
    phase: "idle",
    tick: 0,
    focusedLane: 0,
    startedAt: null,
    elapsedMs: 0,
    metrics: {},
    project: project
      ? {
          name: project?.name ?? "no workspace",
          root: project?.root ?? null,
          branch: project?.branch ?? null,
          files: project?.fileCount ?? 0,
          test: project.test?.display ?? null,
        }
      : null,
    lanes: {
      planner: {
        id: "planner",
        index: 0,
        title: "PLANNER",
        subtitle: "workspace · scopes",
        status: "idle",
        agent: "matrix/local",
        steps: [],
        logs: [],
        metrics: {},
      },
      forge: {
        id: "forge",
        index: 1,
        title: "FORGE",
        subtitle: "patch · approval",
        status: "idle",
        agent: "matrix/local",
        file: null,
        scope: null,
        diffLines: [],
        stats: null,
        statusText: "no proposal",
        logs: [],
        metrics: {},
      },
      radar: {
        id: "radar",
        index: 2,
        title: "RADAR",
        subtitle: "tests · telemetry",
        status: "idle",
        agent: "matrix/local",
        command: null,
        passed: null,
        failed: null,
        duration: null,
        summary: null,
        logs: [],
        metrics: {},
      },
    },
  };
}

function editableLane(state, previous, id) {
  if (state.lanes === previous.lanes) state.lanes = { ...previous.lanes };
  if (state.lanes[id] === previous.lanes[id]) state.lanes[id] = { ...previous.lanes[id] };
  return state.lanes[id];
}

function cleanLogText(text) {
  return String(text ?? "").replace(/\s+$/, "");
}

function pushLog(lane, text, kind = "info") {
  const clean = cleanLogText(text);
  if (!clean) return;
  const entry = { text: clean, kind, at: Date.now() };
  lane.logs =
    lane.logs.length >= MAX_LOGS
      ? [...lane.logs.slice(lane.logs.length - MAX_LOGS + 1), entry]
      : [...lane.logs, entry];
}

function setLaneStatus(lane, status) {
  lane.status = status;
}

function updatePlan(planner, plan, emitIndex = null) {
  planner.steps = plan.map((step) => ({ ...step }));
  if (emitIndex !== null && planner.steps[emitIndex]?.status === "active") {
    planner.status = "active";
  }
  if (
    planner.steps.length > 0 &&
    planner.steps.every((s) => s.status === "done" || s.status === "skipped")
  ) {
    planner.status = "done";
  }
}

const SWARM_EVENTS = new Set([
  "run:start",
  "phase",
  "plan",
  "plan:step",
  "thought",
  "tool:start",
  "tool:end",
  "proposal",
  "approval:request",
  "approval:result",
  "applied",
  "verify:start",
  "verify:line",
  "verify:skipped",
  "verify:end",
  "usage",
  "metrics",
  "result",
  "error",
]);

function thoughtLogText(text) {
  const first = String(text ?? "")
    .split("\n")
    .find((line) => line.trim());
  return first ? cleanLogText(first.replace(/^#+\s*/, "")) : "";
}

/**
 * Apply one agent/run event. Returns a new state for relevant events; never
 * mutates the input and shares every lane/array that the event does not change.
 */
function reduceSwarmEvent(previous, event, batch = null) {
  if (!event || !event.type || !SWARM_EVENTS.has(event.type)) return batch?.state ?? previous;
  const thought = event.type === "thought" ? thoughtLogText(event.text) : null;
  if (event.type === "thought" && !thought) return batch?.state ?? previous;
  if (event.type === "verify:line" && (!event.line || !cleanLogText(event.line)))
    return batch?.state ?? previous;

  const state = batch?.state ?? { ...previous, lanes: previous.lanes };
  const lane = batch?.lane ?? ((id) => editableLane(state, previous, id));

  switch (event.type) {
    case "run:start": {
      const planner = lane("planner");
      const forge = lane("forge");
      const radar = lane("radar");
      state.mode = "running";
      state.outcome = null;
      state.task = event.task ?? state.task;
      state.phase = "planning";
      state.startedAt = Date.now();
      state.tick += 1;
      setLaneStatus(planner, "active");
      setLaneStatus(forge, "idle");
      setLaneStatus(radar, "idle");
      planner.logs = [];
      forge.logs = [];
      radar.logs = [];
      planner.agent = event.mode === "remote" ? (event.modelName ?? "remote") : "matrix/local";
      forge.agent = planner.agent;
      radar.agent = planner.agent;
      pushLog(planner, `run · ${event.task}`, "accent");
      if (event.plan) updatePlan(planner, event.plan, 0);
      break;
    }

    case "phase": {
      state.phase = event.phase;
      if (
        event.phase === "planning" ||
        event.phase === "indexing" ||
        event.phase === "searching" ||
        event.phase === "reading"
      ) {
        setLaneStatus(lane("planner"), "active");
      } else if (
        event.phase === "thinking" ||
        event.phase === "continuing" ||
        event.phase === "tool"
      ) {
        setLaneStatus(lane("planner"), "active");
      } else if (event.phase === "editing" || event.phase === "applying") {
        setLaneStatus(lane("planner"), "done");
        setLaneStatus(lane("forge"), "active");
      } else if (event.phase === "verifying") {
        const forge = lane("forge");
        setLaneStatus(forge, forge.status === "applied" ? "done" : forge.status);
        setLaneStatus(lane("radar"), "active");
      } else if (event.phase === "complete") {
        state.mode = state.mode === "error" ? "error" : "done";
        const { planner, forge, radar } = state.lanes;
        if (planner.status !== "idle") {
          setLaneStatus(lane("planner"), planner.status === "active" ? "done" : planner.status);
        }
        if (forge.status === "active") setLaneStatus(lane("forge"), "done");
        if (radar.status === "active") setLaneStatus(lane("radar"), "done");
      } else if (event.phase === "failed") {
        state.mode = "error";
      } else if (event.phase === "aborted") {
        state.mode = "aborted";
      }
      break;
    }

    case "plan": {
      updatePlan(lane("planner"), event.plan ?? [], event.activeIndex ?? null);
      break;
    }

    case "plan:step": {
      const planner = lane("planner");
      updatePlan(planner, event.plan ?? planner.steps, event.index);
      const step = planner.steps[event.index];
      if (step)
        pushLog(
          planner,
          `${step.status === "done" ? "✓" : step.status === "error" ? "!" : "·"} ${step.title}`,
          step.status,
        );
      break;
    }

    case "thought": {
      pushLog(lane("planner"), thought, "thought");
      break;
    }

    case "tool:start": {
      const targetId =
        event.name === "propose_edit" ? "forge" : event.name === "run_tests" ? "radar" : "planner";
      const target = lane(targetId);
      if (event.name === "propose_edit") setLaneStatus(target, "active");
      if (event.name === "run_tests") setLaneStatus(target, "active");
      pushLog(target, `▸ ${event.label ?? event.name}`, "tool");
      state.currentTool = { id: event.id, name: event.name, label: event.label, args: event.args };
      break;
    }

    case "tool:end": {
      const toolName = event.name ?? state.currentTool?.name;
      const targetId =
        toolName === "propose_edit" ? "forge" : toolName === "run_tests" ? "radar" : "planner";
      const target = lane(targetId);
      pushLog(
        target,
        `${event.ok === false ? "✗" : "✓"} ${event.summary ?? toolName ?? "tool"}`,
        event.ok === false ? "error" : "ok",
      );
      if (toolName === "search" || toolName === "search_repo") {
        target.metrics = {
          ...target.metrics,
          matches: event.data?.matches?.length ?? target.metrics.matches,
        };
      }
      if (toolName === "propose_edit") {
        if (event.data?.stats) target.stats = event.data.stats;
        if (event.data?.file) target.file = event.data.file;
      }
      if (toolName === "run_tests") {
        if (event.data) {
          target.passed = event.data.passed;
          target.failed = event.data.failed;
          target.summary = event.data.summary;
          target.duration = event.data.duration;
        }
      }
      state.currentTool = null;
      break;
    }

    case "proposal": {
      const proposal = event.proposal;
      const forge = lane("forge");
      state.mode = "waiting";
      setLaneStatus(forge, "waiting");
      forge.file = proposal.file;
      forge.scope = proposal.scope;
      forge.stats = proposal.stats;
      forge.diffLines = String(proposal.patch ?? "")
        .split("\n")
        .filter(Boolean)
        .slice(0, MAX_DIFF);
      forge.statusText = `awaiting approval · +${proposal.stats?.adds ?? 0} −${proposal.stats?.dels ?? 0}`;
      pushLog(
        forge,
        `proposal · ${proposal.file} +${proposal.stats?.adds ?? 0} −${proposal.stats?.dels ?? 0}`,
        "accent",
      );
      break;
    }

    case "approval:request": {
      const forge = lane("forge");
      state.mode = "waiting";
      setLaneStatus(forge, "waiting");
      pushLog(forge, "approval requested · user input required", "waiting");
      break;
    }

    case "approval:result": {
      const forge = lane("forge");
      pushLog(
        forge,
        `decision · ${event.decision === "y" || event.decision === "a" ? "approved" : "denied"}`,
        event.decision === "n" ? "error" : "ok",
      );
      if (event.decision === "y" || event.decision === "a") {
        setLaneStatus(forge, "active");
      } else {
        setLaneStatus(forge, "denied");
        state.mode = "done";
      }
      break;
    }

    case "applied": {
      const forge = lane("forge");
      setLaneStatus(forge, "applied");
      forge.statusText = `applied · +${event.stats?.adds ?? 0} −${event.stats?.dels ?? 0}`;
      forge.backupPath = event.backupPath ?? null;
      pushLog(forge, `write · ${event.file} (backup ${event.backupPath ? "saved" : "n/a"})`, "ok");
      break;
    }

    case "verify:start": {
      const radar = lane("radar");
      setLaneStatus(radar, "active");
      radar.command = event.command;
      radar.logs = [];
      pushLog(radar, `$ ${event.command}`, "accent");
      break;
    }

    case "verify:line": {
      pushLog(lane("radar"), event.line, "test");
      break;
    }

    case "verify:skipped": {
      const radar = lane("radar");
      setLaneStatus(radar, "skipped");
      radar.summary = event.reason ?? "no test runner";
      pushLog(radar, `skipped · ${radar.summary}`, "waiting");
      break;
    }

    case "verify:end": {
      const radar = lane("radar");
      const result = event.result ?? {};
      radar.passed = result.passed ?? null;
      radar.failed = result.failed ?? null;
      radar.summary = result.summary ?? null;
      radar.duration =
        result.durationMs != null ? `${Math.round(result.durationMs)}ms` : radar.duration;
      radar.command = result.command ?? radar.command;
      const outcome = classifyOutcome({ verification: result });
      setLaneStatus(radar, outcome.status === OUTCOME.SUCCESS ? "done" : "error");
      pushLog(
        radar,
        outcome.ok
          ? `✓ ${radar.summary ?? `${radar.passed ?? 0} passed`}`
          : `✗ ${radar.summary ?? `${radar.failed ?? 0} failed`}`,
        outcome.ok ? "ok" : "error",
      );
      break;
    }

    case "usage": {
      state.metrics = { ...state.metrics, usage: event.usage };
      break;
    }

    case "metrics": {
      state.metrics = { ...state.metrics, ...event.metrics };
      state.elapsedMs = event.metrics?.elapsedMs ?? state.elapsedMs;
      break;
    }

    case "result": {
      const result = event.result;
      const outcome = classifyOutcome(result);
      state.mode = outcome.mode;
      state.outcome = outcome.status;
      if (result?.metrics) state.metrics = { ...state.metrics, ...result.metrics };
      state.elapsedMs = result?.elapsedMs ?? result?.metrics?.elapsedMs ?? state.elapsedMs;
      if (result?.plan) updatePlan(lane("planner"), result.plan);
      if (result?.editFile) {
        const forge = lane("forge");
        forge.file = result.editFile.path;
        forge.scope = result.editFile.scope;
        forge.stats = result.editFile.stats;
        forge.diffLines = result.editFile.diff?.slice(0, MAX_DIFF) ?? forge.diffLines;
        forge.statusText =
          result.editFile.status === "approved" || result.editFile.status === "applied"
            ? "applied"
            : result.editFile.status;
      }
      if (result?.verifyTests) {
        const radar = lane("radar");
        radar.passed = result.verifyTests.passed;
        radar.failed = result.verifyTests.failed;
        radar.summary = result.verifyTests.summary;
        radar.duration = result.verifyTests.duration;
        radar.command = result.verifyTests.cmd;
        const verification = classifyOutcome({ verification: result.verifyTests });
        setLaneStatus(
          radar,
          result.verifyTests.skipped
            ? "skipped"
            : verification.status === OUTCOME.SUCCESS
              ? "done"
              : "error",
        );
      }
      const planner = lane("planner");
      if (planner.status === "active") setLaneStatus(planner, outcome.ok ? "done" : "error");
      if (state.lanes.forge.status === "active")
        setLaneStatus(lane("forge"), outcome.ok ? "done" : "error");
      pushLog(
        planner,
        result?.summary ?? outcome.failure ?? "run complete",
        outcome.ok ? "ok" : "error",
      );
      break;
    }

    case "error": {
      state.mode = event.aborted ? "aborted" : "error";
      pushLog(lane("planner"), event.error ?? "run failed", "error");
      break;
    }

    default:
      break;
  }

  return state;
}

export function applySwarmEvent(previous, event) {
  return reduceSwarmEvent(previous, event);
}

/**
 * Reduce an event batch into one published state. Streaming reasoning retains
 * exactly the same log entries and bounds as sequential event application,
 * without allocating intermediate swarm/lane state objects.
 */
export function applySwarmEvents(previous, events = []) {
  let batch = null;
  for (const event of events) {
    if (batch) {
      reduceSwarmEvent(previous, event, batch);
      continue;
    }
    const state = reduceSwarmEvent(previous, event);
    if (state === previous) continue;
    batch = {
      state,
      lane: (id) => editableLane(state, previous, id),
    };
  }
  return batch?.state ?? previous;
}

export function focusLane(state, delta) {
  return {
    ...state,
    focusedLane: (state.focusedLane + delta + 3) % 3,
  };
}

export function laneList(state) {
  return [state.lanes.planner, state.lanes.forge, state.lanes.radar];
}

export function laneById(state, id) {
  return state.lanes[id] ?? null;
}

/**
 * Responsive lane geometry. Widths always sum to the available width exactly.
 */
export function getSwarmLayout(columns, focusedLane = 0) {
  const cols = Math.max(8, Math.floor(columns));
  let mode;
  if (cols >= 96) mode = "triple";
  else if (cols >= 64) mode = "dual";
  else mode = "tabbed";

  if (mode === "triple") {
    const gap = 1;
    const width = Math.floor((cols - gap * 2) / 3);
    const widths = [width, width, cols - gap * 2 - width * 2];
    return {
      mode,
      gap,
      lanes: [0, 1, 2],
      widths,
      laneWidth: width,
      focusedLane: focusedLane % 3,
    };
  }
  if (mode === "dual") {
    const gap = 1;
    const first = focusedLane % 3;
    const second = (first + 1) % 3;
    const width = Math.floor((cols - gap) / 2);
    return {
      mode,
      gap,
      lanes: [first, second],
      widths: [width, cols - gap - width],
      laneWidth: width,
      focusedLane: first,
    };
  }
  return {
    mode,
    gap: 0,
    lanes: [focusedLane % 3],
    widths: [cols],
    laneWidth: cols,
    focusedLane: focusedLane % 3,
  };
}
