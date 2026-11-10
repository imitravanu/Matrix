// Presentational DUR-006 screen. Commands own the journal and approvals.
import React from "react";
import { Box, Text } from "ink";
import { forge } from "../../lib/forge.mjs";
import { truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

export function GoalScreen({ view, columns = 80, rows = 30 }) {
  const width = Math.max(18, columns - 2);
  const lines = [];
  const add = (value, color = forge.text, wrap = "truncate") => {
    lines.push(h(Text, { key: lines.length, color, wrap }, value));
  };
  if (view.event) add(view.event);
  add(`Goal ${view.goalId}`, forge.muted, "wrap");
  add(`State ${view.state} · generation ${view.generation}`);
  const unmet = view.criteria.filter((criterion) => !criterion.accepted);
  add(`Remaining criteria ${unmet.length} of ${view.criteria.length}`);
  const displayed = Math.max(0, rows - 15);
  for (const criterion of unmet.slice(0, displayed)) {
    add(truncateToWidth(`  ${criterion.kind} · ${criterion.label}`, width), forge.muted);
  }
  if (unmet.length > displayed)
    add(`  ${unmet.length - displayed} more · inspect --json`, forge.muted);
  const remaining = view.remaining;
  add(`Budget left · ${remaining.rounds} rounds · ${remaining.tools} tools`);
  add(`  ${remaining.requests} requests · ${remaining.activeMs} ms`, forge.muted);
  const recent = view.lastOperation;
  add(recent ? `Last operation ${recent.kind} · ${recent.status}` : "No durable operation yet");
  return h(Box, { flexDirection: "column", paddingX: 1 }, ...lines);
}
