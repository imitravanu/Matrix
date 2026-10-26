// ============================================================================
// Shared chrome: header, status line, input, slash palette and the animated
// wordmark. Everything is sized from lib/term.mjs so the frame cannot drift.
// ============================================================================

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useAnimation } from "ink";

import { forge } from "../../lib/forge.mjs";
import { canDrawWordmark, reducedMotion, useLayout } from "../../lib/term.mjs";
import { renderWordmarkRuns, REST_TIME } from "../../lib/wordmark.mjs";
import { displayWidth, padToWidth, truncateToWidth } from "../../lib/text.mjs";
import { inputSegments, slashMatches } from "../../lib/input.mjs";
import { formatCost, modelLabel } from "../../lib/models.mjs";
import { formatTokens } from "../cards.mjs";

const h = React.createElement;

const SCREEN_LABELS = {
  empty: "FORGE",
  chat: "CRUCIBLE",
  permission: "PATCH GATE",
  swarm: "SWARM",
  scope: "SCOPE LENS",
  vision: "VISION",
  model: "MODELS",
  help: "KEYS",
};

export function statusText({ running, waiting, phase }) {
  if (waiting) return { label: "WAITING", color: forge.warn, glyph: "◈" };
  if (running)
    return {
      label: (phase ?? "RUNNING").toUpperCase().slice(0, 12),
      color: forge.accent,
      glyph: "◐",
    };
  return { label: "READY", color: forge.muted, glyph: "●" };
}

export function Header({
  screen = "chat",
  model = null,
  project = null,
  running = false,
  waiting = false,
  phase = "idle",
  tokenStats = null,
  commandTrust = false,
  testTrust = false,
}) {
  const { cols } = useLayout();
  const status = statusText({ running, waiting, phase });
  const narrow = cols < 70;
  const veryNarrow = cols < 46;
  const screenLabel =
    screen === "permission" && commandTrust
      ? "COMMAND TRUST"
      : screen === "permission" && testTrust
        ? "TEST TRUST"
        : (SCREEN_LABELS[screen] ?? screen);
  const modelName = model?.name ?? "Local Forge";
  const tokens = tokenStats ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 };
  const provenanceLabel =
    {
      provider: "provider-reported",
      estimated: "estimated",
      mixed: "mixed",
      unavailable: "unavailable",
      legacy: "legacy",
    }[tokens.costProvenance ?? "unavailable"] ?? "unavailable";
  const partial = Number.isFinite(tokens.cost) && tokens.costComplete === false ? " · partial" : "";
  const cost = `${formatCost(tokens.cost)}${model?.remote ? ` · ${provenanceLabel}${partial}` : ""}`;

  return h(
    Box,
    { flexDirection: "column", flexShrink: 0 },
    h(
      Box,
      { justifyContent: "space-between", height: 1 },
      h(
        Text,
        { wrap: "truncate" },
        h(Text, { color: forge.accent, bold: true }, "MATRIX"),
        h(Text, { color: forge.dim }, "/"),
        h(Text, { color: forge.text, bold: true }, "FORGE"),
        !veryNarrow ? h(Text, { color: forge.dim }, "  ") : null,
        !veryNarrow ? h(Text, { color: forge.muted }, String(screenLabel).toLowerCase()) : null,
      ),
      h(
        Text,
        { wrap: "truncate" },
        h(Text, { color: status.color }, `${status.glyph} `),
        h(Text, { color: status.color }, status.label),
      ),
    ),
    h(
      Box,
      { justifyContent: "space-between", height: 1 },
      h(
        Text,
        { wrap: "truncate" },
        h(Text, { color: forge.muted }, project?.name ?? "no workspace"),
        !narrow && project?.branch
          ? h(Text, { color: forge.muted }, `  ⎇ ${project.branch}`)
          : null,
        !narrow && project?.fileCount != null
          ? h(Text, { color: forge.muted }, `  ${project.fileCount} files`)
          : null,
        !narrow && project?.test
          ? h(Text, { color: forge.muted }, `  ${project.test.framework}`)
          : null,
      ),
      h(
        Text,
        { wrap: "truncate" },
        h(
          Text,
          { color: model?.remote ? forge.info : forge.accent },
          truncateToWidth(modelName, narrow ? 16 : 24),
        ),
        !veryNarrow
          ? h(
              Text,
              { color: forge.muted },
              `  ↑${formatTokens(tokens.inputTokens)} ↓${formatTokens(tokens.outputTokens)} ${cost}`,
            )
          : null,
      ),
    ),
    h(Text, { color: forge.rule }, "─".repeat(Math.max(1, cols - 2))),
  );
}

export function KeyHints({
  screen = "chat",
  running = false,
  autoApprove = false,
  cols = 80,
  waiting = false,
  commandTrust = false,
  testTrust = false,
}) {
  let hint;
  if (screen === "permission" && commandTrust) {
    hint = "y approve once · n deny · Esc deny · ↑/↓ scroll · Ctrl+C abort";
  } else if (screen === "permission" && testTrust) {
    hint = "y trust · o run once · n deny · Esc cancel";
  } else if (screen === "permission") {
    hint = waiting
      ? cols >= 86
        ? "y apply · a apply all · n deny · f fold diff · ↑/↓ scroll · Esc deny"
        : "y/a/n decide · f fold · ↑/↓ scroll · Esc deny"
      : "f fold · ↑/↓ scroll · Alt+2 chat · Alt+4 swarm · Alt+5 scope · Alt+6 vision";
  } else if (screen === "swarm") {
    hint = "←/→ focus lane · Alt+2 chat · Alt+5 scope · Alt+6 vision";
  } else if (screen === "scope") {
    hint = "←/→ files · ↑/↓ scope · Alt+2 chat · Alt+4 swarm · Alt+6 vision";
  } else if (screen === "vision") {
    hint = "←/→ view · /export PNG · Alt+2 chat · Alt+5 scope";
  } else if (screen === "model") {
    hint = "↑/↓ or j/k select · Enter apply · Esc cancel · 1-6 screens";
  } else if (screen === "help") {
    hint = "↑/↓ or j/k scroll · PgUp/PgDn · Home/End · Esc close · 1-6 screens";
  } else {
    hint = running
      ? "Ctrl+C abort · PgUp scroll · Alt+F fold · Alt+4 swarm"
      : cols >= 100
        ? "Enter send · / commands · Alt+1-6 screens · Alt+M model · Alt+U undo · Alt+H help"
        : "Enter send · / commands · Alt+1-6 screens · Alt+H help";
  }
  return h(
    Text,
    { color: forge.muted, wrap: "truncate" },
    truncateToWidth(hint, Math.max(10, cols - 2)),
    autoApprove ? h(Text, { color: forge.warn }, "  · AUTO") : null,
  );
}

export function StatusBar({
  screen: _screen = "chat",
  model = null,
  running = false,
  autoApprove = false,
  status = "",
  cols = 80,
  scroll = null,
}) {
  const line =
    status && status.length > 0
      ? status
      : running
        ? "agent running · every edit stops at the gate"
        : model?.provider === "ollama"
          ? `${modelLabel(model)} · Ollama endpoint · cost not metered`
          : model?.remote
            ? `${modelLabel(model)} · ${model.free ? "listed free tier" : "estimated per-token pricing"}`
            : "Local Forge · deterministic · offline";
  return h(
    Box,
    { height: 1, justifyContent: "space-between", flexShrink: 0 },
    h(
      Text,
      { color: forge.muted, wrap: "truncate" },
      truncateToWidth(line, Math.max(8, cols - 20)),
    ),
    h(
      Text,
      { color: forge.muted, wrap: "truncate" },
      scroll
        ? `L ${scroll.start}-${scroll.end}/${scroll.total}`
        : autoApprove
          ? "auto-approve"
          : "",
    ),
  );
}

export function SlashMenu({ value = "", selected = 0, width = 80, maxRows = 7 }) {
  const all = useMemo(() => slashMatches(value), [value]);
  if (all.length === 0) return null;
  const rows = Math.max(1, maxRows);
  const selectedIndex = Math.max(0, Math.min(all.length - 1, Math.floor(selected)));
  // Scroll the window instead of clamping the highlight: every command stays
  // reachable, and the row highlighted by Enter is always the row shown.
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(rows / 2), all.length - rows));
  const matches = all.slice(start, start + rows);
  return h(
    Box,
    { flexDirection: "column", flexShrink: 0, paddingX: 1 },
    ...matches.map((item, index) => {
      const isSelected = start + index === selectedIndex;
      return h(
        Box,
        {
          key: item.name,
          height: 1,
          backgroundColor: isSelected ? forge.rule : undefined,
        },
        h(
          Text,
          { color: isSelected ? forge.accent : forge.text, bold: isSelected },
          padToWidth(` ${item.name}`, 12),
        ),
        h(
          Text,
          { color: forge.muted, wrap: "truncate" },
          truncateToWidth(item.description, Math.max(6, width - 16)),
        ),
      );
    }),
  );
}

function visibleInput(input, cursor, available) {
  const { before, at, after } = inputSegments({ ...input, cursor });
  const beforeChars = [...before];
  const afterChars = [...after];
  const atText = at || " ";
  const budget = Math.max(4, available);
  const cursorCol = beforeChars.length;
  let start = 0;
  if (cursorCol + 1 > budget) start = cursorCol - budget + 2;
  const visibleBefore = beforeChars.slice(start).join("");
  const remaining = Math.max(0, budget - displayWidth(visibleBefore));
  const visibleCursor = atText;
  const visibleAfter = truncateToWidth(afterChars.join(""), Math.max(0, remaining - 1), "");
  return { before: visibleBefore, at: visibleCursor, after: visibleAfter, shifted: start > 0 };
}

export function InputBar({
  input,
  placeholder = "Describe a task, or type / for commands",
  disabled = false,
  focused = true,
  autoApprove = false,
  running = false,
  phase = "idle",
}) {
  const { cols } = useLayout();
  const hasText = Boolean(input?.value);
  const width = Math.max(8, cols - 4);
  const segments = visibleInput(input, input?.cursor ?? 0, width - 12);
  const prompt = running ? (phase === "verifying" ? "verify ❯" : "working ❯") : "matrix ❯";
  return h(
    Box,
    {
      borderStyle: "round",
      borderColor: disabled
        ? forge.dim
        : hasText
          ? forge.accent
          : focused
            ? forge.muted
            : forge.rule,
      paddingX: 1,
      height: 3,
      flexShrink: 0,
    },
    h(
      Text,
      null,
      h(Text, { color: running ? forge.warn : forge.accent }, `${prompt} `),
      !hasText && focused && !disabled
        ? h(Text, { backgroundColor: forge.rule, color: "#0B0C0E" }, " ")
        : null,
      hasText
        ? h(Text, { color: forge.text }, segments.shifted ? "…" : "", segments.before)
        : h(
            Text,
            { color: forge.muted, wrap: "truncate" },
            truncateToWidth(placeholder, Math.max(8, width - 12)),
          ),
      hasText && focused && !disabled
        ? h(Text, { backgroundColor: forge.accent, color: "#0B0C0E" }, segments.at || " ")
        : null,
      hasText && !disabled ? h(Text, { color: forge.text }, segments.after) : null,
      autoApprove ? h(Text, { color: forge.warn }, "  auto") : null,
    ),
  );
}

export function Wordmark({ animTime = null, compact = false }) {
  const { cols, rows } = useLayout();
  const reduceMotion = reducedMotion();
  const drawWordmark = !compact && canDrawWordmark({ cols, rows });
  const [introSettled, setIntroSettled] = useState(false);
  const animation = useAnimation({
    interval: 80,
    isActive: animTime === null && !reduceMotion && drawWordmark && !introSettled,
  });
  const time = reduceMotion ? REST_TIME : (animTime ?? (introSettled ? REST_TIME : animation.time));
  useEffect(() => {
    if (animTime === null && animation.time >= REST_TIME) setIntroSettled(true);
  }, [animTime, animation.time]);
  const rowsOut = useMemo(() => renderWordmarkRuns(time), [time]);
  if (!drawWordmark) {
    return h(
      Box,
      { flexDirection: "column", alignItems: "center" },
      h(Text, { color: forge.accent, bold: true }, "matrix"),
      h(Text, { color: forge.dim }, "forge"),
    );
  }
  return h(
    Box,
    { flexDirection: "column", alignItems: "center" },
    ...rowsOut.map((runs, index) =>
      h(
        Text,
        { key: index },
        ...runs.map((run, j) =>
          h(
            Text,
            { key: j, color: run.fg || undefined, backgroundColor: run.bg || undefined },
            run.text,
          ),
        ),
      ),
    ),
  );
}

export function Rule({ width, color = forge.rule, char = "─" }) {
  return h(Text, { color }, char.repeat(Math.max(1, width)));
}

export function Chip({ label, color = forge.muted, bg = null, bold = false }) {
  return h(Text, { color, backgroundColor: bg ?? undefined, bold }, label);
}

export { formatTokens };
