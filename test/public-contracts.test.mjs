import test from "node:test";
import assert from "node:assert/strict";

import { createRunController } from "../lib/controller.mjs";
import { detectProject } from "../lib/project.mjs";
import { makeLive, reduceRunEvent } from "../src/event-reducer.mjs";
import { projectResult } from "../src/result-projection.mjs";

/** @typedef {import("../lib/contracts.mjs").Project} Project */
/** @typedef {import("../lib/contracts.mjs").RunController} RunController */
/** @typedef {import("../lib/contracts.mjs").ControllerStartResult} ControllerStartResult */
/** @typedef {import("../lib/contracts.mjs").RunEvent} RunEvent */
/** @typedef {import("../lib/contracts.mjs").RunResult} RunResult */

test("public project, event, result, and controller JSDoc contracts compose", async (t) => {
  /** @type {Project} */
  const project = detectProject("demo-project");
  /** @type {RunController} */
  const controller = createRunController();
  t.after(() => controller.dispose());

  /** @type {ControllerStartResult} */
  const rejected = await controller.start({ task: "", project, model: null });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "Task is empty");
  assert.equal(controller.isRunning(), false);
  assert.equal(controller.currentRun(), null);

  /** @type {RunEvent} */
  const startEvent = {
    type: "run:start",
    task: "Explain the workspace",
    plan: [{ id: "inspect", title: "Inspect", status: "active" }],
  };
  const started = reduceRunEvent(startEvent, {
    live: makeLive("", "Local Forge"),
    modelName: "Local Forge",
  });
  assert.equal(started.runStart, true);
  assert.equal(started.live.plan[0].status, "active");

  /** @type {RunResult} */
  const finalResult = {
    role: "assistant",
    content: "No edit was needed.",
    summary: "Analysis complete",
    metrics: { elapsedMs: 12 },
  };
  const finished = reduceRunEvent({ type: "result", result: finalResult }, { live: started.live });
  assert.equal(finished.hasResult, true);
  assert.equal(finished.result.content, finalResult.content);

  const { normalized, finalMetrics, message } = projectResult(finished.result, {
    modelName: "Local Forge",
    now: () => 42,
  });
  assert.equal(normalized.status, "success");
  assert.equal(finalMetrics.elapsedMs, 12);
  assert.equal(message.id, "asst-42");
  assert.equal(message.outcome, "success");
});
