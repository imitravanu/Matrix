import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useStdout } from "ink";

const h = React.createElement;

// ============================================================================
// 1. Theme Tokens (spec §3 - forge theme)
// ============================================================================
const forge = {
  text: "#E4E6EA", // primary text
  muted: "#A3AAB4", // secondary text, still readable
  dim: "#565C66", // rules and decoration ONLY, never readable text
  rule: "#3A3F47",
  accent: "#FF7A1F", // ember, the single accent
  steel: "#CBD2DA", // resting color of the wordmark
  // wordmark heat ramp: [k, color], k = 1 white-hot ... 0 cooled steel; interpolate linearly in RGB
  heat: [
    [0, "#CBD2DA"],
    [0.25, "#C9694A"],
    [0.5, "#FF7A1F"],
    [0.75, "#FFB25B"],
    [1, "#FFF6D6"],
  ],
  spark: { flash: "#FFF6D6", core: "#FFE08A" }, // the dot of the "i"
  ok: "#6FD08C",
  warn: "#FFB347",
  err: "#FF6B6B",
  info: "#6CB4FF",
};

// Heat ramp color interpolation in RGB
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

function heatColor(k) {
  if (k <= 0) return forge.heat[0][1];
  if (k >= 1) return forge.heat[forge.heat.length - 1][1];
  for (let i = 0; i < forge.heat.length - 1; i++) {
    const [k0, c0] = forge.heat[i];
    const [k1, c1] = forge.heat[i + 1];
    if (k >= k0 && k <= k1) {
      const f = (k - k0) / (k1 - k0);
      const rgb0 = hexToRgb(c0);
      const rgb1 = hexToRgb(c1);
      return rgbToHex(
        rgb0[0] + (rgb1[0] - rgb0[0]) * f,
        rgb0[1] + (rgb1[1] - rgb0[1]) * f,
        rgb0[2] + (rgb1[2] - rgb0[2]) * f
      );
    }
  }
  return forge.steel;
}

// ============================================================================
// 2. Wordmark Constants & Calculations (spec §5.2)
// ============================================================================
const WORDMARK = [
  "............................##",
  "........................##..##",
  "........................##..##",
  "............................##",
  ".####...#####...##..##..##..##",
  "....##..######..##..##..##..##",
  ".#####..##..##..##..##..##..##",
  "##..##..##..##...####...##..##",
  "##..##..##..##...####...##..##",
  ".#####..##..##....##....##..##",
];
const DOT = { x: [24, 25], y: [1, 2] };

function isDot(x, y) {
  return DOT.x.includes(x) && DOT.y.includes(y);
}

const arrival = (x, y) => 250 + 30 * Math.hypot(x - 24.5, y - 1.5); // ms
const getK = (t, x, y) => Math.max(0, 1 - (t - arrival(x, y)) / 700); // 1 hot, 0 cooled

function getPixelColor(t, x, y) {
  if (WORDMARK[y][x] !== "#") return null;
  if (isDot(x, y)) {
    if (t < 80) return null;
    if (t < 250) return forge.spark.flash;
    return x === 24 && y === 1 ? forge.spark.core : forge.accent;
  }
  if (t < 250) return null;
  const arr = arrival(x, y);
  if (t < arr) return null;
  return heatColor(getK(t, x, y));
}

function renderWordmarkRuns(t) {
  const textRows = [];
  for (let r = 0; r < 5; r++) {
    const yTop = r * 2;
    const yBottom = r * 2 + 1;
    const cells = [];
    for (let x = 0; x < 30; x++) {
      const top = getPixelColor(t, x, yTop);
      const bottom = getPixelColor(t, x, yBottom);
      if (!top && !bottom) cells.push({ ch: " ", fg: null, bg: null });
      else if (top && !bottom) cells.push({ ch: "▀", fg: top, bg: null });
      else if (!top && bottom) cells.push({ ch: "▄", fg: bottom, bg: null });
      else if (top === bottom) cells.push({ ch: "█", fg: top, bg: null });
      else cells.push({ ch: "▀", fg: top, bg: bottom });
    }
    // Group identical styled runs
    const runs = [];
    let cur = null;
    for (const c of cells) {
      if (cur && cur.fg === c.fg && cur.bg === c.bg) {
        cur.text += c.ch;
      } else {
        if (cur) runs.push(cur);
        cur = { fg: c.fg, bg: c.bg, text: c.ch };
      }
    }
    if (cur) runs.push(cur);
    textRows.push(runs);
  }
  return textRows;
}

// ============================================================================
// 3. Components
// ============================================================================

// Header (spec §4.1)
function Header({ state }) {
  const { stdout } = useStdout();
  const width = Math.max(20, (stdout?.columns ?? 80) - 2);

  // Pulsing state dot at 600ms when working
  const [pulse, setPulse] = useState(true);
  useEffect(() => {
    if (state !== "working") return;
    const iv = setInterval(() => setPulse((p) => !p), 600);
    return () => clearInterval(iv);
  }, [state]);

  const dotColor =
    state === "idle"
      ? forge.muted
      : state === "working"
      ? pulse
        ? forge.accent
        : forge.dim
      : forge.warn;

  const label =
    state === "idle"
      ? "idle"
      : state === "working"
      ? "working"
      : "waiting for you";

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Box,
      { justifyContent: "space-between" },
      h(
        Text,
        null,
        h(Text, { color: forge.accent }, "▲"),
        h(Text, { color: forge.text, bold: true }, "  anvil"),
        h(Text, { color: forge.text }, "  mitravanu"),
        h(Text, { color: forge.muted }, "  ⎇ main")
      ),
      h(
        Text,
        null,
        h(Text, { color: forge.text }, "Gemini 3.6 Flash"),
        h(Text, { color: forge.muted }, "  free  "),
        h(Text, { color: dotColor }, "● " + label)
      )
    ),
    h(Text, { color: forge.rule }, "─".repeat(width))
  );
}

// Status Bar (spec §4.3)
function StatusBar({ working }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const pct = 42;
  const filled = 4;
  const meter = "━".repeat(filled) + "─".repeat(10 - filled);
  const meterColor = pct < 60 ? forge.ok : pct <= 85 ? forge.warn : forge.err;
  const showHints = cols >= 70;

  return h(
    Box,
    { justifyContent: "space-between" },
    h(
      Text,
      null,
      h(Text, { color: meterColor }, meter),
      h(Text, { color: forge.text }, `  ${pct}%  ·  `),
      h(Text, { color: forge.muted }, "12.4k in · 3.1k out")
    ),
    showHints
      ? h(
          Text,
          { color: forge.muted },
          working ? "esc interrupt" : "ctrl+c exit  ·  /help"
        )
      : null
  );
}

// Input Box (spec §4.2)
function InputBox() {
  const { stdout } = useStdout();
  const width = Math.max(20, (stdout?.columns ?? 80) - 2);

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: forge.rule }, "─".repeat(width)),
    h(
      Box,
      { borderStyle: "round", borderColor: "#A2A9B3", paddingX: 1 },
      h(
        Text,
        null,
        h(Text, { color: forge.accent }, "› "),
        h(Text, { color: forge.text }, "█")
      )
    )
  );
}

// Empty Screen (spec §5)
function EmptyScreen({ animTime }) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  // Fallbacks (§5.5)
  if (rows < 10) return null;

  const isAscii = process.env.ANVIL_ASCII === "1";
  const useFallback = cols < 34 || rows < 16 || isAscii;

  if (useFallback) {
    return h(
      Box,
      {
        flexDirection: "column",
        alignItems: "center",
        flexGrow: 1,
        justifyContent: "center",
      },
      h(Text, { color: forge.text, bold: true }, "anvil"),
      h(Box, { height: 1 }),
      h(Text, { color: forge.muted }, "v1.0.0")
    );
  }

  const wordmarkRows = renderWordmarkRuns(animTime);

  return h(
    Box,
    {
      flexDirection: "column",
      alignItems: "center",
      flexGrow: 1,
      justifyContent: "center",
      marginTop: -2, // Shifted up 2 rows per spec §5.3
    },
    ...wordmarkRows.map((runs, i) =>
      h(
        Text,
        { key: i },
        ...runs.map((r, j) =>
          h(
            Text,
            {
              key: j,
              color: r.fg || undefined,
              backgroundColor: r.bg || undefined,
            },
            r.text
          )
        )
      )
    ),
    h(Box, { height: 1 }),
    h(Text, { color: forge.muted }, "v1.0.0")
  );
}

// Chat Screen (spec §6)
function ChatScreen() {
  const [spinIdx, setSpinIdx] = useState(0);
  const braille = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  useEffect(() => {
    const iv = setInterval(() => setSpinIdx((i) => (i + 1) % braille.length), 80);
    return () => clearInterval(iv);
  }, []);

  return h(
    Box,
    {
      flexDirection: "column",
      paddingX: 1,
      flexGrow: 1,
      justifyContent: "flex-end",
    },
    h(Box, { height: 1 }),
    // User message
    h(
      Text,
      null,
      h(Text, { color: forge.accent }, "▎ "),
      h(Text, { color: forge.text, bold: true }, "Fix the off-by-one in the processor")
    ),
    h(Box, { height: 1 }),
    // Thinking
    h(
      Box,
      { paddingLeft: 2 },
      h(Text, { color: forge.dim }, "✻ Thought for 4s")
    ),
    h(Box, { height: 1 }),
    // Assistant message
    h(
      Box,
      { paddingLeft: 2, flexDirection: "column" },
      h(Text, { color: forge.text }, "Found it — the slice bound excludes the last element:")
    ),
    h(Box, { height: 1 }),
    // Tool calls
    h(
      Box,
      { paddingLeft: 2, flexDirection: "column" },
      h(
        Text,
        null,
        h(Text, { color: forge.accent }, `  ${braille[spinIdx]} `),
        h(Text, { color: forge.text }, "read_file "),
        h(Text, { color: forge.muted }, "src/processor.py")
      ),
      h(
        Text,
        null,
        h(Text, { color: forge.ok }, "  ✓ "),
        h(Text, { color: forge.text }, "edit_file "),
        h(Text, { color: forge.muted }, "src/processor.py "),
        h(Text, { color: forge.dim }, "0.4s")
      ),
      h(
        Text,
        null,
        h(Text, { color: forge.err }, "  ✗ "),
        h(Text, { color: forge.text }, "verify_tests ")
      ),
      h(Text, { color: forge.err }, "      1 failed: test_bounds — expected 10, got 9")
    ),
    h(Box, { height: 1 })
  );
}

// Permission Screen (spec §7 & diffs §6)
function PermissionScreen() {
  return h(
    Box,
    { flexDirection: "column", paddingX: 1, flexGrow: 1, justifyContent: "flex-end" },
    h(Box, { height: 1 }),
    h(
      Text,
      null,
      h(Text, { color: forge.accent }, "▎ "),
      h(Text, { color: forge.text, bold: true }, "Edit src/processor.py")
    ),
    h(Box, { height: 1 }),
    h(Text, { color: forge.muted }, "  Preview of changes:"),
    h(Box, { height: 1 }),
    // Diff with subtle background tints
    h(Text, { color: forge.dim }, "  12  12 │ context"),
    h(
      Text,
      null,
      h(Text, { color: forge.err, backgroundColor: "#331B1B" }, "  13     │ − lo = bounds[0]")
    ),
    h(
      Text,
      null,
      h(Text, { color: forge.ok, backgroundColor: "#1B3322" }, "  13     │ + lo = bounds[0] + 1")
    ),
    h(Text, { color: forge.dim }, "  14  14 │ return lo"),
    h(Box, { height: 1 })
  );
}

// ============================================================================
// 4. Main Frame & Interactive State
// ============================================================================
function Frame({ screen, animTime }) {
  const waiting = screen === "permission";
  const { stdout } = useStdout();
  const height = Math.max(10, (stdout?.rows ?? 30) - 1);

  return h(
    Box,
    { flexDirection: "column", paddingX: 1, height },
    h(Header, { state: waiting ? "waiting" : screen === "chat" ? "working" : "idle" }),
    h(
      Box,
      { flexGrow: 1, flexDirection: "column" },
      screen === "empty"
        ? h(EmptyScreen, { animTime })
        : screen === "chat"
        ? h(ChatScreen, null)
        : h(PermissionScreen, null)
    ),
    waiting
      ? h(
          Box,
          { borderStyle: "round", borderColor: forge.warn, paddingX: 1 },
          h(
            Text,
            null,
            h(Text, { color: forge.accent }, "❯ "),
            h(Text, { color: forge.text }, "Edit src/processor.py?  "),
            h(Text, { color: forge.text, bold: true }, "y"),
            h(Text, { color: forge.muted }, " allow once  ·  "),
            h(Text, { color: forge.text, bold: true }, "a"),
            h(Text, { color: forge.muted }, " always allow  ·  "),
            h(Text, { color: forge.text, bold: true }, "n"),
            h(Text, { color: forge.muted }, " deny")
          )
        )
      : h(InputBox, null),
    h(StatusBar, { working: screen === "chat" }),
    h(Text, { color: forge.dim }, " 1 empty · 2 chat · 3 permission")
  );
}

function Demo() {
  const [screen, setScreen] = useState("empty");

  // Skip condition check (§5.4)
  const shouldSkipInitialAnim =
    !process.stdin.isTTY ||
    Boolean(process.env.NO_COLOR) ||
    process.env.ANVIL_NO_ANIM === "1";

  const [animTime, setAnimTime] = useState(shouldSkipInitialAnim ? 2000 : 0);
  const animRef = useRef(null);

  const startAnimation = () => {
    if (shouldSkipInitialAnim) {
      setAnimTime(2000);
      return;
    }
    if (animRef.current) clearInterval(animRef.current);
    const start = Date.now();
    setAnimTime(0);
    animRef.current = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed >= 1800) {
        setAnimTime(2000);
        clearInterval(animRef.current);
        animRef.current = null;
      } else {
        setAnimTime(elapsed);
      }
    }, 50);
  };

  useEffect(() => {
    startAnimation();
    return () => {
      if (animRef.current) clearInterval(animRef.current);
    };
  }, []);

  useInput((input) => {
    if (input === "1") {
      setScreen("empty");
      startAnimation();
      return;
    }
    if (input === "2") {
      setScreen("chat");
      return;
    }
    if (input === "3") {
      setScreen("permission");
      return;
    }
    // Any key skips intro animation (§5.4)
    if (animTime < 2000) {
      setAnimTime(2000);
      if (animRef.current) {
        clearInterval(animRef.current);
        animRef.current = null;
      }
    }
  });

  return h(Frame, { screen, animTime });
}

// Smoke and dump test modes
if (process.argv.includes("--smoke") || process.argv.includes("--dump")) {
  (async () => {
    const { render: testRender } = await import("ink-testing-library").catch(() => ({}));
    for (const s of ["empty", "chat", "permission"]) {
      const { unmount, lastFrame } = testRender
        ? testRender(h(Frame, { screen: s, animTime: 2000 }))
        : { unmount: () => undefined, lastFrame: () => "" };
      const frame = lastFrame();
      if (process.argv.includes("--dump")) {
        console.log(`\n=================== SCREEN: ${s.toUpperCase()} ===================\n`);
        console.log(frame);
      }
      if (!frame || frame.length < 100)
        throw new Error(`screen ${s} rendered empty frame`);
      unmount();
    }
    if (process.argv.includes("--smoke")) {
      console.log("smoke: 3 screens render ok (v2.2 forge spec)");
    }
  })();
} else {
  render(h(Demo, null));
}
