// Model switcher: real IDs, real prices, honest key state.

import React from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { isFreeModel } from "../../lib/models.mjs";
import { truncateToWidth } from "../../lib/text.mjs";

const h = React.createElement;

function price(model) {
  if (!model.remote) return "offline · free";
  if (isFreeModel(model)) return "listed $0.00";
  const { input, output } = model.pricing ?? {};
  if (!Number.isFinite(input) || !Number.isFinite(output)) return "price unknown";
  return `est. $${input}/M in · $${output}/M out`;
}

function contextLength(model) {
  const n = model.context;
  if (!Number.isFinite(n) || n <= 0) return "ctx unknown";
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
  const inner = Math.max(20, width - 6);
  const rows = [];

  models.forEach((model, index) => {
    const isSelected = index === selected;
    const isCurrent = activeId ? model.id === activeId : false;
    const isOllama = model.provider === "ollama" || model.id.startsWith("ollama/");
    const needsKey = model.remote && !isOllama && !hasKey;
    const freeTier = isFreeModel(model);
    const toolLabel =
      model.tools === true ? "🛠 tools" : model.tools === false ? "no tools" : "tools unknown";

    // Badges
    const badgeText = !model.remote
      ? "[OFFLINE]"
      : isOllama
        ? "[OLLAMA]"
        : freeTier
          ? "[FREE]"
          : "[PRO]";
    const badgeColor = !model.remote
      ? forge.muted
      : isOllama
        ? forge.accent
        : freeTier
          ? forge.accent
          : forge.warn;

    rows.push(
      h(
        Box,
        {
          key: model.id,
          flexDirection: "column",
          width: inner,
          backgroundColor: isSelected ? forge.rule : undefined,
          paddingX: 1,
        },
        h(
          Text,
          { wrap: "truncate" },
          h(
            Text,
            { color: isSelected ? forge.accent : forge.text, bold: true },
            `${isSelected ? "❯ " : "  "}${model.name}`,
          ),
          h(Text, { color: badgeColor, bold: true }, ` ${badgeText}`),
          isCurrent ? h(Text, { color: forge.info, bold: true }, " [ACTIVE]") : null,
          h(
            Text,
            { color: forge.muted },
            `  ${model.provider ?? (model.remote ? "openrouter" : "matrix")}`,
          ),
          needsKey ? h(Text, { color: forge.warn }, "  · needs key") : null,
        ),
        h(
          Text,
          { color: isSelected ? forge.text : forge.muted, wrap: "truncate", width: inner },
          truncateToWidth(
            `   ${model.description ?? ""}  ·  ${contextLength(model)}  ·  ${price(model)}  ·  ${toolLabel}`,
            inner,
          ),
        ),
      ),
    );
  });

  const availHeight = Math.max(2, height - 6);
  const maxModels = Math.max(1, Math.floor(availHeight / 2));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maxModels / 2), Math.max(0, models.length - maxModels)),
  );
  const visibleRows = rows.slice(start, start + maxModels);

  const above = start;
  const below = Math.max(0, models.length - (start + maxModels));
  const scrollDetail = [];
  if (above > 0) scrollDetail.push(`▲ ${above} above`);
  if (below > 0) scrollDetail.push(`▼ ${below} below`);
  const scrollHint =
    models.length > maxModels
      ? `  [${selected + 1}/${models.length}${scrollDetail.length > 0 ? ` · ${scrollDetail.join(" ")}` : ""}]`
      : "";

  const freeCount = models.filter(isFreeModel).length;
  const filterNotice = filter ? ` · Filter: "${filter}"` : "";

  return h(
    Box,
    { flexDirection: "column", height, width, overflow: "hidden", flexShrink: 0 },
    h(
      Text,
      { color: forge.accent, bold: true },
      "MODEL ROUTER",
      h(
        Text,
        { color: forge.muted },
        `  ${freeCount} free options · prices are estimates${filterNotice}`,
      ),
    ),
    h(Box, { height: 1 }),
    h(
      Box,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: forge.accent,
        paddingX: 1,
        width: inner + 4,
        flexGrow: 0,
        overflow: "hidden",
      },
      ...visibleRows,
      h(Box, { height: 1 }),
      h(
        Text,
        { color: forge.muted, wrap: "truncate", width: inner },
        truncateToWidth(
          hasKey
            ? `↑/↓/wheel select · Enter apply · Esc cancel${scrollHint}`
            : `No OpenRouter key. Local Forge works fully offline.${scrollHint}`,
          inner,
        ),
      ),
    ),
  );
}
