// ============================================================================
// CLI parsing.
//
// Subcommands, positional task text and every value-taking flag are parsed
// here. Malformed input throws instead of silently swallowing the next arg.
// ============================================================================

export const SUBCOMMANDS = new Set([
  "help",
  "version",
  "doctor",
  "tour",
  "vision",
  "dump",
  "smoke",
  "bench",
  "sessions",
]);

const VALUE_FLAGS = new Map([
  ["--model", "modelQuery"],
  ["-m", "modelQuery"],
  ["--cwd", "cwd"],
  ["-C", "cwd"],
  ["--cols", "cols"],
  ["--rows", "rows"],
  ["--screen", "screen"],
  ["--mode", "graphMode"],
  ["--file", "file"],
  ["--png", "exportPng"],
  ["--out", "exportPng"],
  ["--session", "sessionId"],
  ["--iterations", "benchIterations"],
  ["--bench-iterations", "benchIterations"],
]);

const BOOLEAN_FLAGS = new Map([
  ["--help", "help"],
  ["-h", "help"],
  ["--version", "version"],
  ["-v", "version"],
  ["--demo", "demo"],
  ["--resume", "resume"],
  ["--yes", "autoApprove"],
  ["--auto", "autoApprove"],
  ["--offline", "offline"],
  ["--no-alt", "noAltScreen"],
  ["--no-sync", "noSync"],
  ["--mono", "mono"],
  ["--json", "json"],
  ["--no-color", "mono"],
]);

function intValue(value, flag) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${flag} expects a positive integer`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error(`${flag} expects a positive integer`);
  return n;
}

function validateOptions(options, provided) {
  const only = (key, commands, flag) => {
    if (provided.has(key) && !commands.includes(options.command)) {
      throw new Error(
        `${flag} is only valid with ${commands.map((command) => `matrix ${command}`).join(" / ")}`,
      );
    }
  };

  only("modelQuery", ["interactive"], "--model");
  only("screen", ["dump"], "--screen");
  only("graphMode", ["vision"], "--mode");
  only("file", ["vision"], "--file");
  only("exportPng", ["vision"], "--png");
  only("benchIterations", ["bench"], "--iterations");
  only("sessionId", ["interactive"], "--session");
  only("resume", ["interactive"], "--resume");
  only("offline", ["interactive"], "--offline");
  only("autoApprove", ["interactive"], "--yes/--auto");
  only("noAltScreen", ["interactive"], "--no-alt");
  only("noSync", ["interactive"], "--no-sync");
  only("cols", ["interactive", "tour", "dump", "vision", "bench"], "--cols");
  only("rows", ["interactive", "tour", "dump", "vision", "bench"], "--rows");
  only("json", ["interactive", "doctor", "sessions", "smoke", "bench"], "--json");
  if (provided.has("demo") && options.command === "sessions")
    throw new Error("--demo is not valid with matrix sessions");
  if (options.command !== "interactive" && options.task) {
    throw new Error(
      `${options.command} does not accept positional arguments (got ${options.task})`,
    );
  }
}

/**
 * Parse argv (without node/script). Throws Error with a readable message for
 * malformed input; the bin catches and prints a short help hint.
 */
export function parseArgv(argv = [], { cwd = process.cwd() } = {}) {
  const args = [...argv];
  const options = {
    command: "interactive",
    task: "",
    cwd,
    modelQuery: null,
    cols: null,
    rows: null,
    screen: null,
    graphMode: "scope",
    file: null,
    exportPng: null,
    sessionId: null,
    demo: false,
    resume: false,
    autoApprove: false,
    offline: false,
    noAltScreen: false,
    noSync: false,
    mono: false,
    json: false,
    help: false,
    version: false,
    errors: [],
  };

  let commandChosen = false;
  let sawPositional = false;
  const positional = [];
  const provided = new Set();
  let afterDoubleDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (afterDoubleDash) {
      positional.push(arg);
      sawPositional = true;
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const key = VALUE_FLAGS.get(arg);
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} expects a value`);
      const numeric = key === "cols" || key === "rows" || key === "benchIterations";
      const recognizedFlag = VALUE_FLAGS.has(value) || BOOLEAN_FLAGS.has(value);
      if (recognizedFlag || (!numeric && value.startsWith("-") && value !== "-")) {
        throw new Error(`${arg} expects a value`);
      }
      provided.add(key);
      if (numeric) options[key] = intValue(value, arg);
      else options[key] = value;
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      const key = BOOLEAN_FLAGS.get(arg);
      provided.add(key);
      options[key] = true;
      continue;
    }

    if (arg.startsWith("--") && arg.includes("=")) {
      const [flag, ...rest] = arg.split("=");
      if (VALUE_FLAGS.has(flag)) {
        const key = VALUE_FLAGS.get(flag);
        const value = rest.join("=");
        if (value.length === 0) throw new Error(`${flag} expects a value`);
        provided.add(key);
        if (key === "cols" || key === "rows" || key === "benchIterations")
          options[key] = intValue(value, flag);
        else options[key] = value;
        continue;
      }
      if (BOOLEAN_FLAGS.has(flag)) throw new Error(`${flag} does not take a value`);
    }

    if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`unknown option: ${arg}`);
    }

    // Only the first positional word can name a subcommand. Words in the task
    // itself (for example "fix smoke output") must stay task text.
    if (!commandChosen && !sawPositional && SUBCOMMANDS.has(arg.toLowerCase())) {
      options.command = arg.toLowerCase();
      commandChosen = true;
      continue;
    }

    positional.push(arg);
    sawPositional = true;
  }

  if (options.command === "vision" && positional.length > 0) {
    const mode = positional[0].toLowerCase();
    if (!["scope", "workspace", "telemetry"].includes(mode)) {
      throw new Error(`vision expects scope, workspace or telemetry (got ${positional[0]})`);
    }
    options.graphMode = mode;
    positional.shift();
    if (positional.length > 0) {
      throw new Error(`vision does not accept positional arguments (got ${positional.join(" ")})`);
    }
  } else if (options.command !== "interactive" && positional.length > 0) {
    throw new Error(
      `${options.command} does not accept positional arguments (got ${positional.join(" ")})`,
    );
  }

  if (options.command === "version") options.version = true;
  if (options.command === "help") options.help = true;

  options.task = positional.join(" ").trim();
  if (options.command === "tour") options.autoApprove = true;
  if (options.command === "smoke" || options.command === "dump") {
    // Those are non-interactive render checks.
    options.autoApprove = true;
  }
  if (!["scope", "workspace", "telemetry"].includes(options.graphMode)) {
    throw new Error(`--mode expects scope, workspace or telemetry (got ${options.graphMode})`);
  }
  validateOptions(options, provided);

  return options;
}

export const HELP_TEXT = `
Matrix — spatial agent workbench

USAGE
  matrix                      interactive workbench in the current directory
  matrix "task"               open and run a task immediately
  matrix tour                 real end-to-end demo on a temp copy of demo-project
  matrix doctor               environment and capability report
  matrix vision [mode]        render the pixel canvas (scope|workspace|telemetry)
  matrix bench                rendering/layout benchmark
      --iterations <n>        frames per screen for bench
  matrix sessions             list saved sessions
  matrix dump                 print every screen at a fixed size
  matrix smoke                fast render sanity check

WORKSPACE
  -C, --cwd <dir>             operate on another directory
      --demo                  use the bundled demo project
      --resume                resume the latest session for this directory
      --session <id>          resume a specific session
      --model <id|short>      local, sonnet, gemini, gpt-mini, deepseek, qwen, ollama/<tag>

AGENT
      --yes                   auto-approve edits (careful)
      --offline               force Local Forge

RENDERING
      --cols <n> --rows <n>   fixed geometry for dump/vision
      --no-alt --no-sync      disable alt-screen / DEC 2026
      --mono                  no colour (also honors NO_COLOR)
      --png <path>            export a Vision canvas as a real PNG
      --json                  machine-readable output where supported
  -h, --help
  -v, --version

KEYS
  Enter send · Tab complete · ↑↓ prompt history
  Alt+1 empty · Alt+2 chat · Alt+3 gate · Alt+4 swarm · Alt+5 scope · Alt+6 vision
  y approve · a approve all · n deny · f fold gate · Alt+F fold run · Alt+U undo
  PgUp/PgDn scroll · Home/End jump · ←/→ lanes · Alt+M model · Alt+H help · / commands
  Ctrl+C abort a run / quit
`;
