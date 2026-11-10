// Goal presentation consumes bounded projections and never opens the store.
function wrap(line, width) {
  const rows = [];
  let rest = line;
  while (rest.length > width) {
    const space = rest.lastIndexOf(" ", width);
    const cut = space > 0 ? space : width;
    rows.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  rows.push(rest);
  return rows;
}

export function renderGoalStatus(view, columns = 80) {
  const width = Math.max(20, Math.min(160, Number.isFinite(columns) ? columns : 80));
  const lines = [];
  if (view.goals) {
    lines.push(view.goals.length ? "Goals in this workspace" : "No goals in this workspace");
    for (const goal of view.goals) lines.push(`${goal.id} · ${goal.state} · ${goal.objective}`);
    if (view.omitted) lines.push(`${view.omitted} more goals omitted`);
  } else {
    if (view.event) lines.push(view.event);
    if (view.goalId) lines.push(`Goal ${view.goalId}`);
    if (view.state) lines.push(`State ${view.state} · generation ${view.generation}`);
    if (view.criteria) {
      const remaining = view.criteria.filter((criterion) => !criterion.accepted);
      lines.push(`Remaining criteria ${remaining.length} of ${view.criteria.length}`);
      for (const criterion of remaining) lines.push(`  ${criterion.kind} · ${criterion.label}`);
    }
    if (view.remaining) {
      lines.push(
        `Remaining budget ${view.remaining.rounds} rounds · ${view.remaining.tools} tools · ${view.remaining.requests} requests · ${view.remaining.activeMs} ms`,
      );
    }
    if (view.lastOperation) {
      lines.push(
        `Last operation ${view.lastOperation.kind} · ${view.lastOperation.status} · ${view.lastOperation.id}`,
      );
    }
    if (view.reason) lines.push(view.reason);
    if (view.nextCommand) lines.push(`Next command: ${view.nextCommand}`);
  }
  return lines.flatMap((line) => wrap(line, width)).join("\n");
}
