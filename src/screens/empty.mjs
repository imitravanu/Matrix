// Empty screen: the resting forge, built from the real workspace, not sample
// project names. The wordmark is the existing Matrix pixel mark.

import React from "react";
import { Box, Text } from "ink";

import { forge } from "../../lib/forge.mjs";
import { useLayout } from "../../lib/term.mjs";
import { formatDuration, truncateToWidth } from "../../lib/text.mjs";
import { Wordmark } from "./common.mjs";

const h = React.createElement;

function fact(label, value, color = forge.text) {
  return h(
    Text,
    { key: label },
    h(Text, { color: forge.muted }, `${label} `),
    h(Text, { color }, value),
  );
}

export function EmptyScreen({ project = null, model = null, session = null, animTime = null }) {
  const { cols, rows } = useLayout();
  const compact = rows < 20 || cols < 52;
  const languages = (project?.languages ?? [])
    .slice(0, 3)
    .map((l) => l.name)
    .join(" · ");
  const test = project?.test ? project.test.framework : "no test runner";

  return h(
    Box,
    {
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      flexGrow: 1,
      overflow: "hidden",
    },
    h(Wordmark, { animTime, compact }),
    h(Box, { height: 1 }),
    h(Text, { color: forge.muted }, "S P A T I A L   A G E N T   W O R K B E N C H"),
    h(Box, { height: 1 }),
    !compact
      ? h(
          Box,
          { flexDirection: "column", alignItems: "center" },
          h(
            Text,
            { color: forge.muted },
            truncateToWidth(
              "real index · structural scopes · patch gate · real tests",
              Math.max(20, cols - 8),
            ),
          ),
          h(Box, { height: 1 }),
          h(
            Text,
            null,
            fact("workspace", project?.name ?? "none", forge.text),
            h(Text, { color: forge.dim }, "   "),
            fact("files", String(project?.fileCount ?? 0), forge.text),
            project?.branch ? h(Text, { color: forge.dim }, "   ") : null,
            project?.branch ? fact("branch", project.branch, forge.muted) : null,
          ),
          h(
            Text,
            null,
            fact("language", languages || "no source", forge.muted),
            h(Text, { color: forge.dim }, "   "),
            fact("tests", test, project?.test ? forge.accent : forge.warn),
            h(Text, { color: forge.dim }, "   "),
            fact("model", model?.name ?? "Local Forge", model?.remote ? forge.info : forge.accent),
          ),
          session
            ? h(
                Text,
                { color: forge.muted },
                `last session ${formatDuration(Date.now() - session.savedAt)} ago · ${session.history?.length ?? 0} messages · ${session.modelId ?? "local"}`,
              )
            : null,
        )
      : null,
    h(Box, { height: 1 }),
    h(
      Text,
      { color: forge.muted },
      h(Text, { color: forge.accent }, "❯"),
      " type a task, or ",
      h(Text, { color: forge.accent }, "/"),
      " for commands",
    ),
    !compact
      ? h(Text, { color: forge.muted }, "Alt+1-6 screens · Alt+M model · Alt+H help · / commands")
      : null,
  );
}
