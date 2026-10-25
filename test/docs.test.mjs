import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HELP_TEXT } from "../lib/cli.mjs";
import { SLASH_COMMANDS } from "../lib/input.mjs";
import { TOOL_SCHEMAS } from "../lib/model-agent.mjs";
import { ALL_VIEW_NAMES, PACKAGE_ROOT } from "./helpers.mjs";

const read = (name) => readFileSync(`${PACKAGE_ROOT}/${name}`, "utf8");
const README = read("README.md");
const INTERNALS = read("MATRIX.md");
const REVIEW = read("ENGINEERING_REVIEW.md");
const PLAN = read("ENGINEERING_PLAN.md");

test("README and help expose every canonical slash command and current shortcut", () => {
  for (const command of SLASH_COMMANDS)
    assert.ok(README.includes(command.name), `README is missing ${command.name}`);
  assert.ok(
    README.includes("Alt+1") && README.includes("Alt+6"),
    "README is missing the screen-key range",
  );
  for (const key of ["Alt+m", "Alt+u", "Alt+h", "Alt+f"]) {
    assert.ok(README.includes(key), `README is missing ${key}`);
  }
  assert.match(HELP_TEXT, /Alt\+1 empty/);
  assert.match(HELP_TEXT, /Alt\+M model/);
  assert.match(HELP_TEXT, /Alt\+H help/);
  assert.doesNotMatch(README, /press u to restore|Press u to restore/);
  assert.match(README, /MATRIX_REDUCED_MOTION/);
  assert.match(README, /INK_SCREEN_READER/);
});

test("architecture documents describe the actual six-tool surface and recovery model", () => {
  assert.equal(TOOL_SCHEMAS.length, 6);
  for (const tool of TOOL_SCHEMAS)
    assert.ok(
      INTERNALS.includes(`\`${tool.function.name}\``),
      `MATRIX.md is missing ${tool.function.name}`,
    );
  assert.doesNotMatch(INTERNALS, /\| `run_command` \|/);
  assert.match(INTERNALS, /run_command.*disabled/);
  assert.match(INTERNALS, /undoRun/);
  assert.match(INTERNALS, /metrics → phase → result →\s*done/);
  assert.match(INTERNALS, /processOk.*verified.*verificationStatus/);
});

test("engineering review task IDs and primary/all-view lists stay synchronized", () => {
  assert.deepEqual(ALL_VIEW_NAMES, [
    "empty",
    "chat",
    "permission",
    "swarm",
    "scope",
    "vision",
    "model",
    "help",
  ]);
  const reviewIds = new Set(REVIEW.match(/[A-Z]+-\d{3}/g) ?? []);
  assert.ok(reviewIds.size >= 20);
  for (const id of reviewIds) assert.ok(PLAN.includes(id), `ENGINEERING_PLAN is missing ${id}`);
  for (const id of [
    "SAFE-001",
    "CORE-002",
    "PROV-005",
    "SEC-001",
    "CI-001",
    "DOC-002",
    "EVAL-001",
    "ADV-001",
    "ADV-002",
  ]) {
    assert.ok(reviewIds.has(id) || PLAN.includes(id), `${id} is not tracked`);
  }
});
