// Bounded projection of real isolated agents, separate from the three-lane
// projection of a single run. No status is inferred from another agent.
export function createParallelSwarmState(jobs = []) {
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 8) {
    throw new Error("Parallel swarm requires one through eight agents");
  }
  return {
    kind: "parallel",
    status: "starting",
    agents: jobs.map((job, index) => ({
      id: `agent-${String(index + 1).padStart(2, "0")}`,
      task: String(job.task ?? ""),
      status: "queued",
      workspaceKind: null,
      detail: "queued",
    })),
  };
}

export function applyParallelSwarmEvent(previous, event) {
  if (!previous || previous.kind !== "parallel" || !event) return previous;
  if (event.type === "batch:settled")
    return { ...previous, status: event.aborted ? "aborted" : "settled" };
  if (event.type === "batch:abort") return { ...previous, status: "aborting" };
  const index = previous.agents.findIndex((agent) => agent.id === event.agentId);
  if (index < 0) return previous;
  const agent = previous.agents[index];
  let update;
  switch (event.type) {
    case "agent:started":
      update = { status: "running", detail: "starting" };
      break;
    case "workspace:ready":
      update = { workspaceKind: event.workspaceKind, detail: "workspace ready" };
      break;
    case "phase":
      update = { detail: String(event.phase ?? "running") };
      break;
    case "approval:request":
      update = { status: "waiting", detail: `approval: ${event.kind ?? "edit"}` };
      break;
    case "approval:result":
      update = { status: "running", detail: "decision received" };
      break;
    case "agent:settled":
      update = { status: "settled", detail: String(event.result?.status ?? "settled") };
      break;
    default:
      return previous;
  }
  const agents = previous.agents.slice();
  agents[index] = { ...agent, ...update };
  return {
    ...previous,
    status: previous.status === "starting" ? "running" : previous.status,
    agents,
  };
}
