// Static goal snapshots stay in terminal scrollback while readline owns input.
import React from "react";
import { renderToString } from "ink";
import { screenReaderMode, terminalSize } from "../lib/term.mjs";
import { GoalScreen } from "./screens/goal.mjs";
import { renderGoalStatus } from "./goal-screen.mjs";

export function renderGoalApp(view, stdout = process.stdout) {
  const { cols, rows } = terminalSize();
  if (!stdout.isTTY || screenReaderMode() || view.goals || !view.criteria) {
    return renderGoalStatus(view, cols);
  }
  const columns = Math.max(20, Math.min(160, cols));
  const frame = renderToString(React.createElement(GoalScreen, { view, columns, rows }), {
    columns,
  });
  // The continuation is printed as a complete copyable command, even when
  // the terminal itself needs to wrap the line.
  return [
    frame,
    view.reason ? `Reason: ${view.reason}` : null,
    view.nextCommand ? `Next command: ${view.nextCommand}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}
