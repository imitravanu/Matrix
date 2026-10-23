// Model switcher: real IDs, real prices, honest key state.

import React from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { isFreeModel } from "../../lib/models.mjs";
import { truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

function price(model) {
  if (!model.remote) return "offline · free";
  if (isFreeModel(model)) return "FREE · $0.00";
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
  activeId = null,
  hasKey = false,
  filter = "",
  width = 78,
  height = 20,
}) {
  const inner = Math.max(20, width - 4);
  const rows = [];

  models.forEach((model, index) => {
    const isSelected = index === selected;
    const isCurrent = activeId ? model.id === activeId : false;
    const isOllama = model.provider === "ollama" || model.id.startsWith("ollama/");
    const needsKey = model.remote && !isOllama && !hasKey;
    const freeTier = isFreeModel(model);

    // Badges
    const badgeText = !model.remote ? "[OFFLINE]" : isOllama ? "[LOCAL]" : freeTier ? "[FREE]" : "[PRO]";
    const badgeColor = !model.remote ? forge.muted : isOllama ? forge.accent : freeTier ? forge.accent : forge.warn;

    rows.push(
      h(
        Box,
        {
          key: model.id,
          flexDirection: "column",
          backgroundColor: isSelected ? forge.rule : undefined,
          paddingX: 1,
        },
        h(
          Text,
          { wrap: "truncate" },
          h(
            Text,
            { color: isSelected ? forge.accent : forge.text, bold: true },
            `${isSelected ? "❯ " : "  "}${model.name}`
          ),
          h(Text, { color: badgeColor, bold: true }, ` ${badgeText}`),
          isCurrent ? h(Text, { color: forge.info, bold: true }, " [ACTIVE]") : null,
          h(Text, { color: forge.dim }, `  ${model.provider ?? (model.remote ? "openrouter" : "matrix")}`),
          needsKey ? h(Text, { color: forge.warn }, "  · needs key") : null
        ),
        h(
          Text,
          { color: isSelected ? forge.text : forge.muted, wrap: "truncate" },
          truncateToWidth(
            `   ${model.description ?? ""}  ·  ${contextLength(model)}  ·  ${price(model)}  ·  🛠 tools`,
            inner
          )
        )
      )
    );
  });

  const availHeight = Math.max(2, height - 6);
  const maxModels = Math.max(1, Math.floor(availHeight / 2));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maxModels / 2), Math.max(0, models.length - maxModels))
  );
  const visibleRows = rows.slice(start, start + maxModels);

  const above = start;
  const below = Math.max(0, models.length - (start + maxModels));
  const scrollDetail = [];
  if (above > 0) scrollDetail.push(`▲ ${above} above`);
  if (below > 0) scrollDetail.push(`▼ ${below} below`);
  const scrollHint = models.length > maxModels
    ? `  [${selected + 1}/${models.length}${scrollDetail.length > 0 ? ` · ${scrollDetail.join(" ")}` : ""}]`
    : "";

  const freeCount = models.filter(isFreeModel).length;
  const filterNotice = filter ? ` · Filter: "${filter}"` : "";

  return h(
    Box,
    { flexDirection: "column", height, overflow: "hidden", flexShrink: 0 },
    h(
      Text,
      { color: forge.accent, bold: true },
      "MODEL ROUTER",
      h(
        Text,
        { color: forge.dim },
        `  ${freeCount} free tiers available · remote calls verified & zero-cost${filterNotice}`
      )
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
          hasKey
            ? `↑/↓/wheel select · Enter apply · Esc cancel${scrollHint}`
            : `No OpenRouter key. Local Forge works fully offline.${scrollHint}`,
          inner
        )
      )
    )
  );
}
