import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { join } from "node:path";

import { runLocalAgent } from "../lib/local-agent.mjs";
import { resolveModel } from "../lib/models.mjs";
import { detectProject } from "../lib/project.mjs";
import { parseScopes } from "../lib/scope.mjs";
import { applySwarmEvent, createSwarmState } from "../lib/swarm.mjs";
import { SCREENS, checkFrame, renderAllScreens, renderScreen, visible } from "../src/render.mjs";
import { SlashMenu } from "../src/screens/common.mjs";
import { SLASH_COMMANDS, slashMatches } from "../lib/input.mjs";
import { copyDemo, DEMO_ROOT, frameText } from "./helpers.mjs";
import { readFileSync } from "node:fs";

let fixture = null;
let demo = null;

before(async () => {
  demo = copyDemo("matrix-screens-");
  const previousHome = process.env.MATRIX_HOME;
  process.env.MATRIX_HOME = join(demo.root, "home");
  const project = detectProject(demo.workspace);
  const events = [];
  const result = await runLocalAgent({
    task: "Fix the off-by-one in the bounds slice in src/processor.py",
    project,
    autoApprove: true,
    onEvent: (event) => events.push(event),
  });
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
  for (const [columns, rows] of [[60, 22], [80, 26], [100, 30], [140, 40]]) {
    for (const screen of SCREENS) {
      const ansi = renderScreen(screen, fixture, { columns, rows });
      const report = checkFrame(ansi, { columns, rows });
      assert.equal(report.ok, true, `${screen} at ${columns}×${rows}: ${report.problems.join(", ")}`);
      assert.ok(visible(ansi).some((line) => line.trim().length > 0), `${screen} is empty`);
    }
  }
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
      })
    );
    try {
      const text = frameText(app);
      assert.ok(text.includes(commands[selected].name), `selected command ${commands[selected].name} is not visible`);
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
    })
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
  for (const screen of SCREENS) {
    const ansi = renderScreen(screen, fixture, { columns: 40, rows: 20 });
    const report = checkFrame(ansi, { columns: 40, rows: 20 });
    assert.equal(report.ok, true, `${screen} at 40×20: ${report.problems.join(", ")}`);
    const text = visible(ansi).join("\n");
    assert.match(text, /MATRIX\/FORGE/, `${screen} lost the header`);
  }
});

test("renderAllScreens and the backwards-compatible Frame path agree", () => {
  const all = renderAllScreens(fixture, { columns: 100, rows: 30 });
  assert.deepEqual(Object.keys(all).sort(), [...SCREENS].sort());
  const direct = renderScreen("scope", fixture, { columns: 100, rows: 30 });
  assert.equal(all.scope, direct);
  assert.ok(visible(direct).join("\n").includes("SCOPES"));
  assert.equal(checkFrame(direct, { columns: 100, rows: 30 }).ok, true);
});

test("all three vision modes render real data at every comfortable size", () => {
  const markers = { scope: /Scope flame/, workspace: /Workspace inventory/, telemetry: /Run telemetry/ };
  for (const mode of ["scope", "workspace", "telemetry"]) {
    for (const [columns, rows] of [[60, 22], [100, 30], [140, 40]]) {
      const ansi = renderScreen("vision", { ...fixture, visionMode: mode }, { columns, rows });
      const report = checkFrame(ansi, { columns, rows });
      assert.equal(report.ok, true, `${mode} at ${columns}×${rows}: ${report.problems.join(", ")}`);
      const lines = visible(ansi);
      assert.match(lines[3], markers[mode], `${mode} lost its graph title at ${columns} columns`);
      assert.ok(lines.slice(4).join("\n").trim().length > 0, `${mode} rendered an empty canvas at ${columns} columns`);
    }
  }
});
