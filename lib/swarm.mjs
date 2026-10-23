// ============================================================================
// Real swarm state.
//
// Planner, Forge and Radar are three views of one actual run, fed by the event
// stream from the local or model agent. There are no decorative ticks: a lane
// only lights up when a real phase starts, and its logs are real tool lines.
// ============================================================================

const MAX_LOGS = 80;
const MAX_DIFF = 80;

export function createSwarmState({ task = "", project = null } = {}) {
  return {
    task: String(task ?? ""),
    mode: "idle", // idle | running | waiting | done | error
    phase: "idle",
    tick: 0,
    focusedLane: 0,
    startedAt: null,
    elapsedMs: 0,
    metrics: {},
    project: project
      ? {
          name: project.name,
          root: project.root,
          branch: project.branch,
          files: project.fileCount,
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

function clone(state) {
  return {
    ...state,
    lanes: {
      planner: { ...state.lanes.planner, steps: [...state.lanes.planner.steps], logs: [...state.lanes.planner.logs] },
      forge: { ...state.lanes.forge, diffLines: [...state.lanes.forge.diffLines], logs: [...state.lanes.forge.logs] },
      radar: { ...state.lanes.radar, logs: [...state.lanes.radar.logs] },
    },
  };
}

function pushLog(lane, text, kind = "info") {
  const clean = String(text ?? "").replace(/\s+$/, "");
  if (!clean) return;
  lane.logs.push({ text: clean, kind, at: Date.now() });
  if (lane.logs.length > MAX_LOGS) lane.logs.splice(0, lane.logs.length - MAX_LOGS);
}

function setLaneStatus(lane, status) {
  lane.status = status;
}

function allStepsDone(steps) {
  return steps.length > 0 && steps.every((step) => step.status === "done" || step.status === "skipped");
}

function updatePlan(state, plan, emitIndex = null) {
  const planner = state.lanes.planner;
  planner.steps = plan.map((step) => ({ ...step }));
  if (emitIndex !== null && planner.steps[emitIndex]?.status === "active") {
    planner.status = "active";
  }
  if (planner.steps.length > 0 && planner.steps.every((s) => s.status === "done" || s.status === "skipped")) {
    planner.status = "done";
  }
}

/**
 * Apply one agent/run event. Returns a new state; never mutates the input.
 */
export function applySwarmEvent(previous, event) {
  if (!event || !event.type) return previous;
  const state = clone(previous);
  const { planner, forge, radar } = state.lanes;

  switch (event.type) {
    case "run:start": {
      state.mode = "running";
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
      planner.agent = event.mode === "remote" ? event.modelName ?? "remote" : "matrix/local";
      forge.agent = planner.agent;
      radar.agent = planner.agent;
      pushLog(planner, `run · ${event.task}`, "accent");
      if (event.plan) updatePlan(state, event.plan, 0);
      break;
    }

    case "phase": {
      state.phase = event.phase;
      if (event.phase === "planning" || event.phase === "indexing" || event.phase === "searching" || event.phase === "reading") {
        setLaneStatus(planner, "active");
      } else if (event.phase === "thinking" || event.phase === "continuing" || event.phase === "tool") {
        setLaneStatus(planner, "active");
      } else if (event.phase === "editing" || event.phase === "applying") {
        setLaneStatus(planner, "done");
        setLaneStatus(forge, "active");
      } else if (event.phase === "verifying") {
        setLaneStatus(forge, forge.status === "applied" ? "done" : forge.status);
        setLaneStatus(radar, "active");
      } else if (event.phase === "complete") {
        state.mode = state.mode === "error" ? "error" : "done";
        if (planner.status !== "idle") setLaneStatus(planner, planner.status === "active" ? "done" : planner.status);
        if (forge.status === "active") setLaneStatus(forge, "done");
        if (radar.status === "active") setLaneStatus(radar, "done");
      } else if (event.phase === "failed" || event.phase === "aborted") {
        state.mode = "error";
      }
      break;
    }

    case "plan": {
      updatePlan(state, event.plan ?? [], event.activeIndex ?? null);
      break;
    }

    case "plan:step": {
      updatePlan(state, event.plan ?? planner.steps, event.index);
      const step = planner.steps[event.index];
      if (step) pushLog(planner, `${step.status === "done" ? "✓" : step.status === "error" ? "!" : "·"} ${step.title}`, step.status);
      break;
    }

    case "thought": {
      const first = String(event.text ?? "").split("\n").find((line) => line.trim());
      if (first) pushLog(planner, first.replace(/^#+\s*/, ""), "thought");
      break;
    }

    case "tool:start": {
      const target = event.name === "propose_edit" ? forge : event.name === "run_tests" ? radar : planner;
      if (event.name === "propose_edit") setLaneStatus(forge, "active");
      if (event.name === "run_tests") setLaneStatus(radar, "active");
      pushLog(target, `▸ ${event.label ?? event.name}`, "tool");
      state.currentTool = { id: event.id, name: event.name, label: event.label, args: event.args };
      break;
    }

    case "tool:end": {
      const toolName = event.name ?? state.currentTool?.name;
      const target = toolName === "propose_edit" ? forge : toolName === "run_tests" ? radar : planner;
      pushLog(target, `${event.ok === false ? "✗" : "✓"} ${event.summary ?? toolName ?? "tool"}`, event.ok === false ? "error" : "ok");
      if (toolName === "search" || toolName === "search_repo") {
        planner.metrics.matches = event.data?.matches?.length ?? planner.metrics.matches;
      }
      if (toolName === "propose_edit") {
        if (event.data?.stats) forge.stats = event.data.stats;
        if (event.data?.file) forge.file = event.data.file;
      }
      if (toolName === "run_tests") {
        if (event.data) {
          radar.passed = event.data.passed;
          radar.failed = event.data.failed;
          radar.summary = event.data.summary;
          radar.duration = event.data.duration;
        }
      }
      state.currentTool = null;
      break;
    }

    case "proposal": {
      const proposal = event.proposal;
      state.mode = "waiting";
      setLaneStatus(forge, "waiting");
      forge.file = proposal.file;
      forge.scope = proposal.scope;
      forge.stats = proposal.stats;
      forge.diffLines = String(proposal.patch ?? "").split("\n").filter(Boolean).slice(0, MAX_DIFF);
      forge.statusText = `awaiting approval · +${proposal.stats?.adds ?? 0} −${proposal.stats?.dels ?? 0}`;
      pushLog(forge, `proposal · ${proposal.file} +${proposal.stats?.adds ?? 0} −${proposal.stats?.dels ?? 0}`, "accent");
      break;
    }

    case "approval:request": {
      state.mode = "waiting";
      setLaneStatus(forge, "waiting");
      pushLog(forge, "approval requested · user input required", "waiting");
      break;
    }

    case "approval:result": {
      pushLog(forge, `decision · ${event.decision === "y" || event.decision === "a" ? "approved" : "denied"}`, event.decision === "n" ? "error" : "ok");
      if (event.decision === "y" || event.decision === "a") {
        setLaneStatus(forge, "active");
      } else {
        setLaneStatus(forge, "denied");
        state.mode = "done";
      }
      break;
    }

    case "applied": {
      setLaneStatus(forge, "applied");
      forge.statusText = `applied · +${event.stats?.adds ?? 0} −${event.stats?.dels ?? 0}`;
      forge.backupPath = event.backupPath ?? null;
      pushLog(forge, `write · ${event.file} (backup ${event.backupPath ? "saved" : "n/a"})`, "ok");
      break;
    }

    case "verify:start": {
      setLaneStatus(radar, "active");
      radar.command = event.command;
      radar.logs = [];
      pushLog(radar, `$ ${event.command}`, "accent");
      break;
    }

    case "verify:line": {
      if (event.line) pushLog(radar, event.line, "test");
      break;
    }

    case "verify:skipped": {
      setLaneStatus(radar, "skipped");
      radar.summary = event.reason ?? "no test runner";
      pushLog(radar, `skipped · ${radar.summary}`, "waiting");
      break;
    }

    case "verify:end": {
      const result = event.result ?? {};
      radar.passed = result.passed ?? null;
      radar.failed = result.failed ?? null;
      radar.summary = result.summary ?? null;
      radar.duration = result.durationMs != null ? `${Math.round(result.durationMs)}ms` : radar.duration;
      radar.command = result.command ?? radar.command;
      setLaneStatus(radar, result.ok ? "done" : "error");
      pushLog(
        radar,
        result.ok
          ? `✓ ${radar.summary ?? `${radar.passed ?? 0} passed`}`
          : `✗ ${radar.summary ?? `${radar.failed ?? 0} failed`}`,
        result.ok ? "ok" : "error"
      );
      break;
    }

    case "usage": {
      state.metrics.usage = event.usage;
      break;
    }

    case "metrics": {
      state.metrics = { ...state.metrics, ...event.metrics };
      state.elapsedMs = event.metrics?.elapsedMs ?? state.elapsedMs;
      break;
    }

    case "result": {
      const result = event.result;
      state.mode = result?.error || result?.failure ? "error" : "done";
      if (result?.plan) updatePlan(state, result.plan);
      if (result?.editFile) {
        forge.file = result.editFile.path;
        forge.scope = result.editFile.scope;
        forge.stats = result.editFile.stats;
        forge.diffLines = result.editFile.diff?.slice(0, MAX_DIFF) ?? forge.diffLines;
        forge.statusText = result.editFile.status === "approved" || result.editFile.status === "applied" ? "applied" : result.editFile.status;
      }
      if (result?.verifyTests) {
        radar.passed = result.verifyTests.passed;
        radar.failed = result.verifyTests.failed;
        radar.summary = result.verifyTests.summary;
        radar.duration = result.verifyTests.duration;
        radar.command = result.verifyTests.cmd;
        setLaneStatus(radar, result.verifyTests.skipped ? "skipped" : result.verifyTests.ok ? "done" : "error");
      }
      if (planner.status === "active") setLaneStatus(planner, "done");
      if (forge.status === "active") setLaneStatus(forge, "done");
      pushLog(planner, result?.summary ?? "run complete", state.mode === "error" ? "error" : "ok");
      break;
    }

    case "error": {
      state.mode = "error";
      pushLog(planner, event.error ?? "run failed", "error");
      break;
    }

    default:
      break;
  }

  return state;
}

export function focusLane(state, delta) {
  const next = clone(state);
  next.focusedLane = (state.focusedLane + delta + 3) % 3;
  return next;
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
