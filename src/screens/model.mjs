// Model switcher: real IDs, real prices, honest key state.

import React from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

function price(model) {
  if (!model.remote) return "offline · free";
  const { input, output } = model.pricing ?? {};
  return `$${input}/M in · $${output}/M out`;
}

function contextLength(model) {
  const n = model.context ?? 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k ctx`;
  return `${n} ctx`;
}

export function ModelScreen({
  models = [],
  selected = 0,
  hasKey = false,
  width = 78,
  height = 20,
}) {
  const inner = Math.max(20, width - 4);
  const rows = [];
  models.forEach((model, index) => {
    const active = index === selected;
    const needsKey = model.remote && !hasKey;
    rows.push(
      h(
        Box,
        {
          key: model.id,
          flexDirection: "column",
          backgroundColor: active ? forge.rule : undefined,
          paddingX: active ? 1 : 1,
        },
        h(
          Text,
          { wrap: "truncate" },
          h(Text, { color: active ? forge.accent : forge.text, bold: true }, `${active ? "❯ " : "  "}${model.name}`),
          h(Text, { color: forge.dim }, `  ${model.remote ? "remote" : "matrix"}`),
          needsKey ? h(Text, { color: forge.warn }, "  · needs key") : null
        ),
        h(
          Text,
          { color: forge.muted, wrap: "truncate" },
          truncateToWidth(
            `   ${model.description ?? ""}  ·  ${contextLength(model)}  ·  ${price(model)}`,
            inner
          )
        )
      )
    );
  });

  const availHeight = Math.max(2, height - 6);
  const maxModels = Math.max(1, Math.floor(availHeight / 2));
  const start = Math.max(0, Math.min(selected - Math.floor(maxModels / 2), Math.max(0, models.length - maxModels)));
  const visibleRows = rows.slice(start, start + maxModels);
  const scrollHint = models.length > maxModels ? `  [${selected + 1}/${models.length}]` : "";

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    h(
      Text,
      { color: forge.accent, bold: true },
      "MODEL ROUTER",
      h(Text, { color: forge.dim }, "  local is deterministic; remote calls are real and billed")
    ),
    h(Box, { height: 1 }),
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: forge.accent,
        paddingX: 1,
        flexGrow: 1,
        overflow: "hidden",
      },
      ...visibleRows,
      h(Box, { height: 1 }),
      h(
        Text,
        { color: forge.dim, wrap: "truncate" },
        truncateToWidth(
          hasKey ? `↑/↓ select · Enter apply · Esc cancel${scrollHint}` : `No OpenRouter key. Local Forge works fully offline.${scrollHint}`,
          inner
        )
      )
    )
  );
}
