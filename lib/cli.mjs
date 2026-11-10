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
  "parallel",
  "recover",
  "publish",
  "providers",
  "goal",
]);

export const GOAL_ACTIONS = new Set(["start", "resume", "pause", "cancel", "list", "inspect"]);

const GOAL_LIMIT_FLAGS = new Map([
  ["--rounds", "goalRounds"],
  ["--tools", "goalTools"],
  ["--requests", "goalRequests"],
  ["--active-ms", "goalActiveMs"],
]);

/** True when argv's first positional word names the goal subcommand. */
function isGoalInvocation(argv) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") return false;
    if (VALUE_FLAGS.has(token)) {
      if (!argv[i + 1]?.startsWith("-")) i++;
    } else if (!token.startsWith("-")) {
      return token.toLowerCase() === "goal";
    }
  }
  return false;
}

const VALUE_FLAGS = new Map([
  ["--model", "modelQuery"],
  ["-m", "modelQuery"],
  ["--provider", "providerId"],
  ["--id", "providerAddId"],
  ["--base-url", "providerBaseUrl"],
  ["--api-key-env", "providerApiKeyEnv"],
  ["--name", "providerName"],
  ["--auth", "providerAuth"],
  ["--remove-model", "providerRemoveModel"],
  ["--default-model", "providerDefaultModel"],
  ["--checks", "providerChecks"],
  ["--expected-digest", "providerExpectedDigest"],
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
  ["--allow-command", "approvedCommandPlanHash"],
  ["--criteria", "goalCriteriaFile"],
  ...GOAL_LIMIT_FLAGS,
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
  ["--refresh", "providerRefresh"],
  ["--no-color", "mono"],
  ["--enable-commands", "enableCommands"],
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

  only("modelQuery", ["interactive", "providers", "goal"], "--model");
  only("providerId", ["interactive", "goal"], "--provider");
  only("providerAddId", ["providers"], "--id");
  only("providerBaseUrl", ["providers"], "--base-url");
  only("providerApiKeyEnv", ["providers"], "--api-key-env");
  only("providerName", ["providers"], "--name");
  only("providerAuth", ["providers"], "--auth");
  only("providerRemoveModel", ["providers"], "--remove-model");
  only("providerDefaultModel", ["providers"], "--default-model");
  only("providerChecks", ["providers"], "--checks");
  only("providerRefresh", ["providers"], "--refresh");
  only("providerExpectedDigest", ["providers"], "--expected-digest");
  if (provided.has("providerId")) {
    if (options.offline) throw new Error("--provider and --offline are mutually exclusive");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(options.providerId))) {
      throw new Error("--provider expects a lowercase provider id");
    }
  }
  only("screen", ["dump"], "--screen");
  only("graphMode", ["vision"], "--mode");
  only("file", ["vision"], "--file");
  only("exportPng", ["vision"], "--png");
  only("benchIterations", ["bench"], "--iterations");
  only("sessionId", ["interactive"], "--session");
  only("resume", ["interactive"], "--resume");
  only("offline", ["interactive"], "--offline");
  only("autoApprove", ["interactive", "goal"], "--yes/--auto");
  only("goalCriteriaFile", ["goal"], "--criteria");
  for (const [key, flag] of [
    ["goalRounds", "--rounds"],
    ["goalTools", "--tools"],
    ["goalRequests", "--requests"],
    ["goalActiveMs", "--active-ms"],
  ]) {
    only(key, ["goal"], flag);
  }
  only("enableCommands", ["interactive"], "--enable-commands");
  only("approvedCommandPlanHash", ["interactive"], "--allow-command");
  if (provided.has("approvedCommandPlanHash")) {
    if (!provided.has("enableCommands")) {
      throw new Error("--allow-command requires --enable-commands");
    }
    if (!options.task) {
      throw new Error("--allow-command requires a headless task");
    }
    if (!/^[a-f0-9]{64}$/.test(options.approvedCommandPlanHash)) {
      throw new Error("--allow-command expects exactly 64 lowercase hex characters");
    }
  }
  only("noAltScreen", ["interactive", "parallel"], "--no-alt");
  only("noSync", ["interactive"], "--no-sync");
  only("cols", ["interactive", "parallel", "tour", "dump", "vision", "bench"], "--cols");
  only("rows", ["interactive", "parallel", "tour", "dump", "vision", "bench"], "--rows");
  only(
    "json",
    ["interactive", "doctor", "sessions", "smoke", "bench", "recover", "providers", "goal"],
    "--json",
  );
  if (provided.has("demo") && options.command === "parallel")
    throw new Error("--demo is not valid with matrix parallel");
  if (provided.has("demo") && options.command === "sessions")
    throw new Error("--demo is not valid with matrix sessions");
  if (options.command !== "interactive" && options.command !== "parallel" && options.task) {
    throw new Error(
      `${options.command} does not accept positional arguments (got ${options.task})`,
    );
  }
}

const NUMERIC_VALUE_KEYS = new Set([
  "cols",
  "rows",
  "benchIterations",
  "goalRounds",
  "goalTools",
  "goalRequests",
  "goalActiveMs",
]);

/**
 * Parse argv (without node/script). Throws Error with a readable message for
 * malformed input; the bin catches and prints a short help hint. Errors from a
 * `matrix goal ...` invocation carry exitCode 2 (frozen invalid-input mapping)
 * so malformed flags are rejected before any state is created.
 */
export function parseArgv(argv = [], options = {}) {
  try {
    return parseArgvInner(argv, options);
  } catch (error) {
    if (error instanceof Error && isGoalInvocation(argv)) Object.assign(error, { exitCode: 2 });
    throw error;
  }
}

function parseArgvInner(argv = [], { cwd = process.cwd() } = {}) {
  const args = [...argv];
  const options = {
    command: "interactive",
    task: "",
    cwd,
    modelQuery: null,
    providersAction: null,
    providerArg: null,
    providerAddId: null,
    providerBaseUrl: null,
    providerApiKeyEnv: null,
    providerName: null,
    providerAuth: null,
    providerRemoveModel: null,
    providerDefaultModel: null,
    providerChecks: null,
    providerExpectedDigest: null,
    providerProfileFile: null,
    providerRefresh: false,
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
    enableCommands: false,
    approvedCommandPlanHash: null,
    goalAction: null,
    goalObjective: "",
    goalId: null,
    goalCriteriaFile: null,
    goalRounds: null,
    goalTools: null,
    goalRequests: null,
    goalActiveMs: null,
    offline: false,
    noAltScreen: false,
    noSync: false,
    mono: false,
    json: false,
    help: false,
    version: false,
    parallelTasks: [],
    recoveryIntent: null,
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
      if (key === "approvedCommandPlanHash" && provided.has(key)) {
        throw new Error(`${arg} may only be supplied once`);
      }
      const value = args[++i];
      if (value === undefined) throw new Error(`${arg} expects a value`);
      const numeric = NUMERIC_VALUE_KEYS.has(key);
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
      if (key === "enableCommands" && provided.has(key)) {
        throw new Error(`${arg} may only be supplied once`);
      }
      provided.add(key);
      options[key] = true;
      continue;
    }

    if (arg.startsWith("--") && arg.includes("=")) {
      const [flag, ...rest] = arg.split("=");
      if (VALUE_FLAGS.has(flag)) {
        const key = VALUE_FLAGS.get(flag);
        if (key === "approvedCommandPlanHash" && provided.has(key)) {
          throw new Error(`${flag} may only be supplied once`);
        }
        const value = rest.join("=");
        if (value.length === 0) throw new Error(`${flag} expects a value`);
        provided.add(key);
        if (NUMERIC_VALUE_KEYS.has(key)) options[key] = intValue(value, flag);
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
  } else if (options.command === "parallel") {
    if (positional.length < 2 || positional.length > 8 || positional.some((task) => !task.trim())) {
      throw new Error("parallel requires two through eight separate quoted tasks");
    }
    options.parallelTasks = [...positional];
    positional.length = 0;
  } else if (options.command === "recover" || options.command === "publish") {
    if (positional.length !== 1 || !positional[0].trim())
      throw new Error(`${options.command} requires one integration-intent.json path`);
    options.recoveryIntent = positional.shift();
  } else if (options.command === "providers") {
    const action = (positional.shift() ?? "").toLowerCase();
    const flagNames = {
      providerAddId: "--id",
      providerBaseUrl: "--base-url",
      providerApiKeyEnv: "--api-key-env",
      providerName: "--name",
      providerAuth: "--auth",
      modelQuery: "--model",
      providerRemoveModel: "--remove-model",
      providerDefaultModel: "--default-model",
      providerChecks: "--checks",
      providerExpectedDigest: "--expected-digest",
    };
    const actionFlags = {
      list: [],
      add: [
        "providerAddId",
        "providerBaseUrl",
        "providerApiKeyEnv",
        "providerName",
        "providerAuth",
        "modelQuery",
      ],
      show: [],
      update: [
        "providerName",
        "providerBaseUrl",
        "providerApiKeyEnv",
        "providerAuth",
        "modelQuery",
        "providerRemoveModel",
        "providerDefaultModel",
      ],
      remove: [],
      models: [],
      test: ["modelQuery", "providerChecks"],
      replace: ["providerExpectedDigest"],
    };
    if (!Object.hasOwn(actionFlags, action)) {
      throw new Error(
        "providers expects one of: list, add, show, update, replace, remove, models, test",
      );
    }
    options.providersAction = action;
    for (const [key, flag] of Object.entries(flagNames)) {
      if (provided.has(key) && !actionFlags[action].includes(key)) {
        throw new Error(`${flag} is not valid with matrix providers ${action}`);
      }
    }
    if (action === "list" || action === "add") {
      if (positional.length > 0) {
        throw new Error(
          `providers ${action} does not accept positional arguments (got ${positional.join(" ")})`,
        );
      }
    } else if (action === "replace") {
      if (positional.length !== 2)
        throw new Error("providers replace requires a provider id and profile JSON file");
      options.providerArg = positional.shift();
      options.providerProfileFile = positional.shift();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.providerArg))
        throw new Error("providers replace expects a lowercase provider id");
      if (!/^[a-f0-9]{64}$/.test(options.providerExpectedDigest ?? ""))
        throw new Error(
          "providers replace requires --expected-digest with the current 64-character configuration digest",
        );
    } else {
      if (positional.length !== 1) {
        throw new Error(
          `providers ${action} requires exactly one provider id${positional.length ? ` (got ${positional.join(" ")})` : ""}`,
        );
      }
      const providerId = positional.shift();
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerId)) {
        throw new Error(`providers ${action} expects a lowercase provider id`);
      }
      options.providerArg = providerId;
    }
    if (action === "add") {
      if (!options.providerAddId) throw new Error("providers add requires --id");
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.providerAddId)) {
        throw new Error("providers add expects a lowercase provider id");
      }
      if (!options.providerBaseUrl) throw new Error("providers add requires --base-url");
      const auth = (options.providerAuth ?? "bearer").toLowerCase();
      if (auth === "bearer") {
        if (!options.providerApiKeyEnv) {
          throw new Error("providers add requires --api-key-env for bearer auth (or --auth none)");
        }
      } else if (auth === "none") {
        if (options.providerApiKeyEnv) {
          throw new Error("--api-key-env is not valid with --auth none");
        }
      } else {
        throw new Error('--auth expects "bearer" or "none"');
      }
      options.providerAuth = auth;
    }
    if (action === "update") {
      if (!actionFlags.update.some((key) => provided.has(key))) {
        throw new Error(
          "providers update requires at least one change (--name, --base-url, --api-key-env, --auth, --model, --remove-model, --default-model)",
        );
      }
      const auth = options.providerAuth === null ? null : options.providerAuth.toLowerCase();
      if (auth !== null && auth !== "bearer" && auth !== "none") {
        throw new Error('--auth expects "bearer" or "none"');
      }
      if (auth === "none" && options.providerApiKeyEnv !== null) {
        throw new Error("--api-key-env is not valid with --auth none");
      }
      if (options.modelQuery !== null && options.providerRemoveModel === options.modelQuery) {
        throw new Error("--model and --remove-model cannot name the same model");
      }
      options.providerAuth = auth;
    }
    if (action === "test") {
      if (!options.modelQuery) throw new Error("providers test requires --model <exact-id>");
      const checks = [];
      for (const raw of String(options.providerChecks ?? "text,tools").split(",")) {
        const check = raw.trim().toLowerCase();
        if (!check) continue;
        if (check !== "text" && check !== "tools") {
          throw new Error(`--checks expects text and/or tools (got ${raw.trim()})`);
        }
        if (!checks.includes(check)) checks.push(check);
      }
      if (checks.length === 0) throw new Error("--checks requires at least one of text, tools");
      options.providerChecks = checks;
    }
    if (options.providerRefresh && action !== "models") {
      throw new Error("--refresh is only valid with matrix providers models");
    }
  } else if (options.command === "goal" && !options.help) {
    const action = (positional.shift() ?? "").toLowerCase();
    if (!GOAL_ACTIONS.has(action)) {
      throw new Error(
        `goal expects one of: ${[...GOAL_ACTIONS].join(", ")} (got ${action || "nothing"})`,
      );
    }
    options.goalAction = action;
    const startOnly = (key, flag) => {
      if (provided.has(key) && action !== "start") {
        throw new Error(`${flag} is only valid with matrix goal start`);
      }
    };
    startOnly("goalCriteriaFile", "--criteria");
    startOnly("goalRounds", "--rounds");
    startOnly("goalTools", "--tools");
    startOnly("goalRequests", "--requests");
    startOnly("goalActiveMs", "--active-ms");
    startOnly("modelQuery", "--model");
    startOnly("providerId", "--provider");
    if (action === "start") {
      if (positional.length === 0 || !positional.join(" ").trim()) {
        throw new Error(
          'goal start requires an objective, for example: matrix goal start "fix the bug" --criteria criteria.json',
        );
      }
      options.goalObjective = positional.join(" ").trim();
      positional.length = 0;
      if (!options.goalCriteriaFile) throw new Error("goal start requires --criteria <file>");
    } else if (action === "list") {
      if (positional.length > 0) {
        throw new Error(
          `goal list does not accept positional arguments (got ${positional.join(" ")})`,
        );
      }
    } else {
      if (positional.length !== 1) {
        throw new Error(
          `goal ${action} requires exactly one goal id${positional.length ? ` (got ${positional.join(" ")})` : ""}`,
        );
      }
      const goalId = positional.shift();
      if (!/^goal_[a-f0-9]{32}$/.test(goalId)) {
        throw new Error(
          `goal ${action} expects a goal id like goal_<32 lowercase hex> (got ${goalId})`,
        );
      }
      options.goalId = goalId;
    }
    if (provided.has("autoApprove") && action !== "start" && action !== "resume") {
      throw new Error("--yes/--auto is only valid with matrix goal start or resume");
    }
  } else if (options.command === "goal" && options.help) {
    positional.length = 0;
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
  matrix parallel "task 1" "task 2"   review isolated concurrent agents
  matrix recover <intent.json>       reconstruct an interrupted result's undo session
  matrix publish <intent.json>       review and retry Git publication (interactive)
  matrix sessions             list saved sessions
  matrix dump                 print every screen at a fixed size
  matrix smoke                fast render sanity check

WORKSPACE
  -C, --cwd <dir>             operate on another directory
      --demo                  use the bundled demo project
      --resume                resume the latest session for this directory
      --session <id>          resume a specific session
      --model <id|short>      local, sonnet, gemini, gpt-mini, deepseek, qwen, ollama/<tag>
      --provider <id>         named profile or built-in (matrix, openrouter, ollama);
                              preselects that exact provider/model in the TUI

PROVIDERS
  matrix providers list [--json]                 named providers, models and freshness
  matrix providers add --id <id> --base-url <url> (--api-key-env <ENV> | --auth none)
                         [--name <label>] [--model <exact-id>]
  matrix providers show <id> [--json]            full profile, models and freshness
  matrix providers update <id> [--name <label>] [--base-url <url>]
                         [--api-key-env <ENV> | --auth bearer|none]
                         [--model <id>] [--remove-model <id>] [--default-model <id>]
  matrix providers remove <id>                   remove one profile by exact id
  matrix providers replace <id> <profile.json> --expected-digest <digest>
  matrix providers models <id> [--refresh] [--json]
      --refresh           explicit /models request; manual models never depend on it
  matrix providers test <id> --model <exact-id> [--checks text,tools] [--json]
                          opt-in synthetic stream probe; three requests, 30s total
      --checks            text observes completion, tools observes a no-op round trip

GOALS (durable, resumable coding goals; Linux)
  matrix goal start "objective" --criteria <file> [--provider <id>] [--model <id>] [--yes] [--allow-tests]
                    [--rounds <n>] [--tools <n>] [--requests <n>] [--active-ms <n>] [--json]
  matrix goal resume <id> [--yes] [--allow-tests] [--json]     fresh invocation authority; --model cannot change
  matrix goal pause <id> [--json]              verified owner channel; stops at the next safe boundary
  matrix goal cancel <id> [--json]             verified owner channel; no further actions start
  matrix goal list [--json]                    read-only; goals bound to the current workspace
  matrix goal inspect <id> [--json]            read-only status, criteria, budget, last operation
  The criteria file is bounded JSON: {"schemaVersion":1,"criteria":[{"kind":"artifact",
  "path":"src/a.mjs","sha256":"…"} | {"kind":"test","planHash":"…"} | {"kind":"human",
  "description":"…"}]}. list/inspect never spawn or mutate. Exit codes: 0 completed work or a
  successful read/control command, 1 incomplete/failed work, 2 invalid input or refusal,
  130 interrupted. Ordinary --resume for chat sessions is unchanged.

The base URL is an API directory (for example https://example.com/v1), not a
full /chat/completions endpoint. The key value itself is never accepted as an
argument; pass an environment variable name and export the value in your shell.
Unlisted model IDs work without discovery; unknown capabilities and prices stay
unknown. Refresh and test make explicit network requests and may incur charges.

AGENT
      --yes                   auto-approve edits (careful)
      --offline               force Local Forge
      --enable-commands       expose the OS-sandboxed command tool; interactive use still
                              requires a fresh y decision for every exact command plan
      --allow-command <hash>  with --enable-commands and a remote headless task, authorize one
                              exact 64-char lowercase-hex plan; copy from COMMAND TRUST

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
