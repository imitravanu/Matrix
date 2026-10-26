import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { join } from "node:path";

import { runLocalAgent } from "../lib/local-agent.mjs";
import { resolveModel } from "../lib/models.mjs";
import { detectProject } from "../lib/project.mjs";
import { parseScopes } from "../lib/scope.mjs";
import { makeUnifiedDiff, parseUnifiedDiff } from "../lib/diff.mjs";
import { applySwarmEvent, createSwarmState } from "../lib/swarm.mjs";
import { createTestPolicy, withTestExecutionContext } from "../lib/test-policy.mjs";
import { checkFrame, renderAllScreens, renderScreen, visible } from "../src/render.mjs";
import { SlashMenu } from "../src/screens/common.mjs";
import { HelpScreen } from "../src/screens/help.mjs";
import { buildPermissionLines } from "../src/screens/permission.mjs";
import { buildCommandTrustLines } from "../src/screens/command-trust.mjs";
import { displayWidth } from "../lib/text.mjs";
import { SLASH_COMMANDS, slashMatches } from "../lib/input.mjs";
import { ALL_VIEW_NAMES, copyDemo, frameText, patchEnv } from "./helpers.mjs";
import { readFileSync } from "node:fs";

let fixture = null;
let demo = null;

before(async () => {
  demo = copyDemo("matrix-screens-");
  const previousHome = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = join(demo.root, "home");
  const project = detectProject(demo.workspace);
  const events = [];
  const home = join(demo.root, "home");
  const policy = createTestPolicy({ home, allowTests: true });
  const result = await withTestExecutionContext({ home, policy }, () =>
    runLocalAgent({
      task: "Fix the off-by-one in the bounds slice in src/processor.py",
      project,
      autoApprove: true,
      onEvent: (event) => events.push(event),
    }),
  );
  const proposal = events.find((event) => event.type === "proposal")?.proposal ?? result.proposal;
  const source = readFileSync(join(demo.workspace, "src", "processor.py"), "utf8");
  const parsed = parseScopes(source, "src/processor.py");
  let swarmState = createSwarmState({ task: "fix", project });
  for (const event of events) swarmState = applySwarmEvent(swarmState, event);
  const history = [
    { role: "user", content: "Fix the off-by-one in the bounds slice in src/processor.py" },
    {
      ...result,
      role: "assistant",
      modelName: "Local Forge",
      elapsedTime: 0,
    },
  ];
  fixture = {
    project,
    model: resolveModel("local"),
    chatHistory: history,
    history,
    prompt: "",
    inputValue: "",
    permission: proposal ? { ...proposal, status: "pending" } : null,
    proposal,
    choice: null,
    isDiffExpanded: false,
    swarmState,
    scopeFile: "src/processor.py",
    scopeSource: source,
    scopeParsed: parsed,
    scopeSelection: 2,
    scopeFiles: project.files.filter((file) => file.language === "python").map((file) => file.rel),
    visionMode: "scope",
    activeLine: 20,
    usage: result.usage ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 },
    metrics: result.metrics ?? { elapsedMs: 0 },
    testResult: result.verifyTests,
    modelName: "Local Forge",
    visionStatus: "ready",
    models: [resolveModel("local"), resolveModel("sonnet"), resolveModel("gemini")],
    pickerIndex: 1,
    hasKey: false,
    session: null,
    animTime: 2000,
    status: "4 passed",
    tokenStats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 },
  };
  const restore = () => {
    if (previousHome === undefined) delete process.env.MATRIX_HOME;
    else process.env.MATRIX_HOME = previousHome;
  };
  after(restore);
});

after(() => {
  demo?.cleanup();
});

test("all eight screens render cleanly at four terminal geometries", () => {
  const markers = {
    empty: /workspace|S P A T I A L|MATRIX\/FORGE/,
    chat: /crucible/i,
    permission: /PATCH GATE/,
    swarm: /PLANNER|FORGE|RADAR/,
    scope: /scope lens|SCOPES/i,
    vision: /VISION/,
    model: /MODEL ROUTER/,
    help: /KEYMAP/,
  };
  for (const [columns, rows] of [
    [60, 22],
    [80, 26],
    [100, 30],
    [140, 40],
  ]) {
    for (const screen of ALL_VIEW_NAMES) {
      const ansi = renderScreen(screen, fixture, { columns, rows });
      const report = checkFrame(ansi, { columns, rows });
      assert.equal(
        report.ok,
        true,
        `${screen} at ${columns}×${rows}: ${report.problems.join(", ")}`,
      );
      const text = visible(ansi).join("\n");
      assert.ok(text.trim().length > 0, `${screen} is empty`);
      assert.match(
        text,
        markers[screen],
        `${screen} lost meaningful content at ${columns}×${rows}`,
      );
    }
  }
});

test("the narrow scope lens keeps its header and every selected scope visible", () => {
  const labels = ["class DataProcessor", "__init__", "process_bounds", "flush_window"];
  for (const [scopeSelection, label] of labels.entries()) {
    const lines = visible(
      renderScreen("scope", { ...fixture, scopeSelection }, { columns: 60, rows: 22 }),
    );
    const divider = lines.findIndex((line, index) => index > 3 && /─{10}/.test(line));
    const tree = lines.slice(3, divider).join("\n");
    assert.match(tree, /SCOPES\s+4/);
    assert.ok(tree.includes(label), `${label} should be visible in the scope tree`);
    assert.doesNotMatch(tree, /L\d+-\d+scope/);
  }
});

test("the scope lens labels truncated source explicitly", () => {
  const parsed = parseScopes("class DataProcessor:\n    pass\n", "src/processor.py", {
    truncated: true,
  });
  const text = visible(renderScreen("scope", { ...fixture, scopeParsed: parsed })).join("\n");
  assert.match(text, /PARTIAL/);
});

test("each screen exposes its real content and labels", () => {
  const cases = {
    empty: [/MATRIX\/FORGE/, /SPATIAL|S P A T I A L|workspace/, /demo-project/],
    chat: [/crucible/i, /src\/processor\.py/, /Verification passed/],
    permission: [/PATCH GATE/, /src\/processor\.py/, /y apply/],
    swarm: [/PLANNER/, /FORGE/, /RADAR/],
    scope: [/scope lens/i, /SCOPES/, /processor\.py/, /DataProcessor/],
    vision: [/VISION/, /scope/],
    model: [/MODEL ROUTER/, /Local Forge/, /Claude Sonnet 4\.6/],
    help: [/KEYMAP/, /Ctrl\+C/, /\/help/],
  };
  for (const [screen, patterns] of Object.entries(cases)) {
    const text = visible(renderScreen(screen, fixture, { columns: 100, rows: 30 })).join("\n");
    for (const pattern of patterns) assert.match(text, pattern, `${screen} missing ${pattern}`);
  }
});

test("the patch gate wraps complete long lines instead of clipping them", () => {
  const source = `context = "${"x".repeat(160)}"; END_OF_CHANGE`;
  const proposal = {
    file: "a.py",
    status: "pending",
    stats: { adds: 1, dels: 0 },
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        rows: [{ type: "add", text: source, oldLine: null, newLine: 1 }],
      },
    ],
  };
  const lines = buildPermissionLines({ proposal, width: 44, expanded: true });
  const changed = lines.filter((line) => line.bg);
  assert.ok(changed.length > 1);
  assert.equal(changed.map((line) => line.text.slice(14)).join(""), source);
  for (const line of lines) assert.ok(displayWidth(line.text) <= 44);
});

test("the patch gate surfaces EOL and final-newline changes", () => {
  const cases = [
    ["a\n", "a\r\n", /EOL {2}CRLF/],
    ["a", "a\n", /EOF {2}final newline: yes/],
  ];
  for (const [original, updated, pattern] of cases) {
    const hunks = parseUnifiedDiff(makeUnifiedDiff(original, updated)).hunks;
    const proposal = { file: "x.txt", status: "pending", stats: { adds: 1, dels: 1 }, hunks };
    const text = buildPermissionLines({ proposal, width: 60, expanded: true })
      .map((line) => line.text)
      .join("\n");
    assert.match(text, pattern);
  }
});

test("a resolved patch gate does not advertise approval actions", () => {
  const permission = { ...fixture.permission, status: "approved" };
  const text = visible(
    renderScreen("permission", { ...fixture, permission }, { columns: 100, rows: 30 }),
  ).join("\n");
  assert.match(text, /approved · f fold/);
  assert.doesNotMatch(text, /y apply|a apply all|n deny/);
});

test("command trust shows exact plans/scripts and scrolls at every required geometry", () => {
  const request = {
    kind: "sandboxed-command",
    origin: "run_sandboxed_command",
    executable: "/usr/bin/node",
    argv: ["-e", "console.log('exact argv')"],
    cwd: "/workspace/project",
    workspace: "/workspace/project",
    command: "/usr/bin/node -e \"console.log('exact argv')\"",
    script: "const exact = 'INLINE_SCRIPT_CANARY';\nconsole.log(exact);",
    scriptFile: {
      path: "/workspace/project/script.mjs",
      relative: "script.mjs",
      sha256: "b".repeat(64),
      content: "const fileExact = 'FILE_SCRIPT_CANARY';\nconsole.log(fileExact);",
    },
    planHash: "a".repeat(64),
  };
  const all = buildCommandTrustLines(request, 44)
    .map((line) => line.text)
    .join("\n");
  for (const expected of [
    "/usr/bin/node",
    "argv[1]  \"console.log('exact argv')\"",
    "/workspace/project",
    "INLINE_SCRIPT_CANARY",
    "FILE_SCRIPT_CANARY",
    "network  disabled",
    "writes discarded",
    "undo not applicable",
    "y approve this exact command once",
  ]) {
    assert.ok(all.includes(expected), `command trust omitted ${expected}`);
  }
  assert.ok(all.replaceAll("\n", "").includes(request.planHash));
  assert.doesNotMatch(all, /apply all|a approve|o run once/);

  for (const [columns, rows] of [
    [40, 20],
    [60, 22],
    [80, 26],
    [100, 30],
    [140, 40],
  ]) {
    for (const commandTrustScroll of [0, 9999]) {
      const ansi = renderScreen(
        "permission",
        { ...fixture, permission: null, commandTrustRequest: request, commandTrustScroll },
        { columns, rows },
      );
      const report = checkFrame(ansi, { columns, rows });
      assert.equal(
        report.ok,
        true,
        `command trust at ${columns}×${rows}: ${report.problems.join(", ")}`,
      );
      assert.match(visible(ansi).join("\n"), /COMMAND TRUST/);
      assert.doesNotMatch(visible(ansi).join("\n"), /apply all|a approve|o run once/);
    }
  }
  const bottom = visible(
    renderScreen(
      "permission",
      { ...fixture, permission: null, commandTrustRequest: request, commandTrustScroll: 9999 },
      { columns: 40, rows: 20 },
    ),
  ).join("\n");
  assert.match(bottom, /Ctrl\+C abort run/);
});

test("the slash menu scrolls its window instead of clamping the highlight", () => {
  const commands = slashMatches("/");
  assert.equal(commands.length, SLASH_COMMANDS.length);
  for (let selected = 0; selected < commands.length; selected++) {
    const app = render(
      React.createElement(SlashMenu, {
        value: "/",
        selected,
        width: 80,
        maxRows: 5,
      }),
    );
    try {
      const text = frameText(app);
      assert.ok(
        text.includes(commands[selected].name),
        `selected command ${commands[selected].name} is not visible`,
      );
    } finally {
      app.unmount();
    }
  }

  const last = render(
    React.createElement(SlashMenu, {
      value: "/",
      selected: commands.length - 1,
      width: 80,
      maxRows: 5,
    }),
  );
  try {
    const text = frameText(last);
    assert.equal(text.includes("/help"), false);
    assert.ok(text.includes(commands.at(-1).name));
  } finally {
    last.unmount();
  }
});

test("the triple-lane swarm shows every lane at 140 columns", () => {
  const text = visible(renderScreen("swarm", fixture, { columns: 140, rows: 40 })).join("\n");
  assert.match(text, /PLANNER/);
  assert.match(text, /FORGE/);
  assert.match(text, /RADAR/);
  assert.match(text, /Local Forge/);
  assert.match(text, /tests · telemetry|4 passed/);
});

test("a 40-column terminal still produces a complete, non-overflowing frame", () => {
  for (const screen of ALL_VIEW_NAMES) {
    const ansi = renderScreen(screen, fixture, { columns: 40, rows: 20 });
    const report = checkFrame(ansi, { columns: 40, rows: 20 });
    assert.equal(report.ok, true, `${screen} at 40×20: ${report.problems.join(", ")}`);
    const text = visible(ansi).join("\n");
    assert.match(text, /MATRIX\/FORGE/, `${screen} lost the header`);
  }
});

test("expanded retained output scrolls at every terminal geometry without changing frame widths", () => {
  const output = Array.from({ length: 400 }, (_, index) => `retained line ${index + 50}`);
  output[200] = `LONG_${"z".repeat(180)}_END_OF_OUTPUT`;
  output[399] = "EXPECTED_FAILURE_TAIL";
  const chatHistory = [
    {
      role: "assistant",
      modelName: "matrix/test",
      content: "Tests failed. The output is above.",
      error: true,
      verifyTests: {
        cmd: "npm test",
        results: [{ name: "diagnosable failure", pass: false }],
        passed: 0,
        failed: 1,
        ok: false,
        summary: "1 failed",
        output,
        outputLineCount: 450,
        outputTruncated: true,
      },
    },
  ];

  for (const [columns, rows] of [
    [40, 20],
    [60, 22],
    [80, 26],
    [100, 30],
    [140, 40],
  ]) {
    for (const chatScroll of [0, 100000]) {
      const ansi = renderScreen(
        "chat",
        { ...fixture, chatHistory, outputExpanded: true, chatScroll },
        { columns, rows },
      );
      const report = checkFrame(ansi, { columns, rows });
      assert.equal(
        report.ok,
        true,
        `retained output at ${columns}×${rows}: ${report.problems.join(", ")}`,
      );
    }
  }

  const top = visible(
    renderScreen(
      "chat",
      {
        ...fixture,
        chatHistory,
        outputExpanded: true,
        chatScroll: 100000,
      },
      { columns: 40, rows: 20 },
    ),
  ).join("\n");
  assert.match(top, /retained output/);
  assert.match(top, /last 400 of 450 lines/);
  assert.match(top, /retained line 50/);
  const bottom = visible(
    renderScreen(
      "chat",
      {
        ...fixture,
        chatHistory,
        outputExpanded: true,
        chatScroll: 0,
      },
      { columns: 40, rows: 20 },
    ),
  ).join("\n");
  assert.match(bottom, /EXPECTED_FAILURE_TAIL/);
});

test("the help viewport reaches every key and slash command at 40 columns", () => {
  const frames = [0, 10, 100].map((scrollOffset) => {
    const app = render(React.createElement(HelpScreen, { width: 38, height: 15, scrollOffset }));
    try {
      return frameText(app);
    } finally {
      app.unmount();
    }
  });
  assert.match(frames[0], /Alt\+1\/2/);
  assert.match(frames[1], /SLASH COMMANDS/);
  assert.match(frames.at(-1), /\/quit/);
  assert.match(frames.at(-1), /\d+-\d+\/\d+/);
});

test("every Vision mode has a complete textual summary in screen-reader mode", () => {
  const restore = patchEnv({ INK_SCREEN_READER: "true" });
  try {
    const cases = {
      scope: [/src\/processor\.py/, /active: line 20/, /process_bounds/],
      workspace: [/demo-project/, /python/, /pytest/],
      telemetry: [/Local Forge/, /usage unavailable|input/, /4 passed · 0 failed/],
    };
    for (const [visionMode, patterns] of Object.entries(cases)) {
      const text = visible(
        renderScreen("vision", { ...fixture, visionMode }, { columns: 60, rows: 22 }),
      ).join("\n");
      for (const pattern of patterns)
        assert.match(text, pattern, `${visionMode} missing ${pattern}`);
      assert.equal(text.includes("▄"), false, `${visionMode} rendered pixels instead of text`);
    }
  } finally {
    restore();
  }
});

test("screen-reader mode retains approval, error, and verification content", () => {
  const restore = patchEnv({ INK_SCREEN_READER: "true" });
  try {
    const permission = visible(renderScreen("permission", fixture, { columns: 60, rows: 22 })).join(
      "\n",
    );
    assert.match(permission, /PATCH GATE/);
    assert.match(permission, /src\/processor\.py/);
    assert.match(permission, /y apply/);
    assert.match(permission, /context = bounds/);

    const chat = visible(renderScreen("chat", fixture, { columns: 100, rows: 30 })).join("\n");
    assert.match(chat, /Verification passed: 4 passed · 0 failed/);

    const failure = visible(
      renderScreen(
        "chat",
        {
          ...fixture,
          chatHistory: [{ role: "assistant", error: true, summary: "stream failed", content: "" }],
        },
        { columns: 60, rows: 22 },
      ),
    ).join("\n");
    assert.match(failure, /stream failed/);
  } finally {
    restore();
  }
});

test("renderAllScreens and the backwards-compatible Frame path agree", () => {
  const all = renderAllScreens(fixture, { columns: 100, rows: 30 });
  assert.deepEqual(Object.keys(all).sort(), [...ALL_VIEW_NAMES].sort());
  const direct = renderScreen("scope", fixture, { columns: 100, rows: 30 });
  assert.equal(all.scope, direct);
  assert.ok(visible(direct).join("\n").includes("SCOPES"));
  assert.equal(checkFrame(direct, { columns: 100, rows: 30 }).ok, true);
});

test("all three vision modes render real data at every comfortable size", () => {
  const markers = {
    scope: /Scope flame/,
    workspace: /Workspace inventory/,
    telemetry: /Run telemetry/,
  };
  for (const mode of ["scope", "workspace", "telemetry"]) {
    for (const [columns, rows] of [
      [60, 22],
      [100, 30],
      [140, 40],
    ]) {
      const ansi = renderScreen("vision", { ...fixture, visionMode: mode }, { columns, rows });
      const report = checkFrame(ansi, { columns, rows });
      assert.equal(report.ok, true, `${mode} at ${columns}×${rows}: ${report.problems.join(", ")}`);
      const lines = visible(ansi);
      assert.match(lines[3], markers[mode], `${mode} lost its graph title at ${columns} columns`);
      assert.ok(
        lines.slice(4).join("\n").trim().length > 0,
        `${mode} rendered an empty canvas at ${columns} columns`,
      );
    }
  }
});
