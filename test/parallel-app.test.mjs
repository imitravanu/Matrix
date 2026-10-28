import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { ParallelApp } from "../src/parallel-app.mjs";
import { checkFrame, renderAt } from "../src/render.mjs";
import { runParallelInteractive } from "../lib/parallel-interactive.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyParallelSwarmEvent, createParallelSwarmState } from "../lib/parallel-swarm.mjs";
import { parallelSwarmLines } from "../src/screens/parallel-swarm.mjs";
import { copyDemo, frameText, patchEnv, waitFor } from "./helpers.mjs";

const jobs = [{ task: "first" }, { task: "second" }];

test("parallel swarm tracks independent identities and never projects unrelated events", () => {
  let state = createParallelSwarmState(jobs);
  state = applyParallelSwarmEvent(state, { type: "agent:started", agentId: "agent-01" });
  state = applyParallelSwarmEvent(state, {
    type: "approval:request",
    agentId: "agent-02",
    kind: "edit",
  });
  assert.equal(state.agents[0].status, "running");
  assert.equal(state.agents[1].status, "waiting");
  assert.equal(applyParallelSwarmEvent(state, { type: "phase", agentId: "unknown" }), state);
  for (const width of [40, 60, 80, 100, 140]) {
    const lines = parallelSwarmLines(state, width, 10);
    assert.match(lines[0].text, /REAL PARALLEL/);
    assert.match(lines[1].text, /agent-01 running/);
    assert.match(lines[2].text, /agent-02 waiting/);
    assert.ok(lines.every((line) => line.text.length <= width));
  }
});

test("parallel Ink frame fits all required geometries with eight named agents", () => {
  const eight = Array.from({ length: 8 }, (_, index) => ({ task: `task ${index + 1}` }));
  for (const [columns, rows] of [
    [40, 20],
    [60, 22],
    [80, 26],
    [100, 30],
    [140, 40],
  ]) {
    const frame = renderAt(
      React.createElement(ParallelApp, { root: "/tmp", home: "/tmp/home", jobs: eight }),
      { columns, rows },
    );
    const check = checkFrame(frame, { columns, rows });
    assert.equal(check.ok, true, `${columns}x${rows}: ${check.problems.join(", ")}`);
    assert.match(frame, /agent-01 queued/);
    assert.match(frame, /agent-08 queued/);
  }
});

test("Ctrl+C denies a waiting review, signals abort and waits for completion", async (t) => {
  const restore = patchEnv({ MATRIX_COLS: "80", MATRIX_ROWS: "26" });
  t.after(restore);
  let seenSignal;
  let decision;
  let completed;
  const run = async ({ ask, write, signal }) => {
    write("Review before abort\n");
    decision = await ask("Approve? [y/N]");
    seenSignal = signal.aborted;
    return { status: "aborted" };
  };
  const app = render(
    React.createElement(ParallelApp, {
      root: "/tmp",
      home: "/tmp/home",
      jobs,
      run,
      onComplete: (value) => {
        completed = value;
      },
    }),
  );
  t.after(() => app.unmount());
  assert.ok(await waitFor(() => frameText(app).includes("Approve?")));
  app.stdin.write("\u0003");
  assert.ok(await waitFor(() => completed));
  assert.equal(seenSignal, true);
  assert.equal(decision, "n");
  assert.equal(completed.result.status, "aborted");
});

test("Ink parallel review scrolls complete content and submits only its active decision", async (t) => {
  const restore = patchEnv({ MATRIX_COLS: "40", MATRIX_ROWS: "20" });
  t.after(restore);
  let answer;
  const run = async ({ write, ask, onEvent }) => {
    onEvent({ type: "agent:started", agentId: "agent-01" });
    onEvent({ type: "approval:request", agentId: "agent-02", kind: "edit" });
    write(
      `START-OF-REVIEW\n${Array.from({ length: 50 }, (_, i) => `line-${i}`).join("\n")}\nEND-OF-REVIEW\n`,
    );
    answer = await ask("Approve this one request? [y/N] ");
    return { status: answer === "y" ? "success" : "denied" };
  };
  const app = render(
    React.createElement(ParallelApp, { root: "/tmp", home: "/tmp/home", jobs, run }),
  );
  t.after(() => app.unmount());
  const frame = await waitFor(
    () => /Approve this one request/.test(frameText(app)) && frameText(app),
  );
  assert.ok(frame);
  assert.match(frame, /agent-01 running/);
  assert.match(frame, /agent-02 waiting/);
  assert.match(frame, /START-OF-REVIEW/);
  assert.doesNotMatch(frame, /END-OF-REVIEW/);
  app.stdin.write("\u001b[F");
  const end = await waitFor(() => /END-OF-REVIEW/.test(frameText(app)) && frameText(app));
  assert.ok(end, "End reaches the complete review");
  app.stdin.write("y");
  app.stdin.write("\r");
  const finished = await waitFor(() => /Finished: success/.test(frameText(app)) && frameText(app));
  assert.ok(finished);
  assert.equal(answer, "y");
});

test("Ink parallel app completes a real isolated batch with explicit review and saved recovery", async (t) => {
  const demo = copyDemo("matrix-ink-parallel-");
  const home = join(demo.root, "home");
  const restore = patchEnv({ MATRIX_HOME: home, MATRIX_COLS: "80", MATRIX_ROWS: "30" });
  t.after(() => {
    restore();
    demo.cleanup();
  });
  const task = "Fix the off-by-one in the bounds slice in src/processor.py";
  const runJobs = [{ task }, { task }];
  const requests = [];
  let captured = "";
  let completed;
  const run = (options) =>
    runParallelInteractive({
      ...options,
      write(text) {
        captured += text;
        options.write(text);
      },
      ask(prompt) {
        requests.push({ prompt, content: captured });
        captured = "";
        return options.ask(prompt);
      },
    });
  const app = render(
    React.createElement(ParallelApp, {
      root: demo.workspace,
      home,
      jobs: runJobs,
      scratchDir: join(demo.root, "scratch"),
      run,
      onComplete(value) {
        completed = value;
      },
    }),
  );
  t.after(() => app.unmount());
  for (let index = 0; index < 10 && !completed; index += 1) {
    const ready = await waitFor(() => requests[index] || completed, {
      timeoutMs: 15000,
      intervalMs: 10,
    });
    assert.ok(ready, "the next decision or completion arrived");
    if (completed) break;
    const request = requests[index];
    const promptReady = await waitFor(
      () => frameText(app).includes(request.prompt.trim().slice(0, 25)),
      { timeoutMs: 5000, intervalMs: 10 },
    );
    assert.ok(promptReady, `visible question: ${request.prompt}`);
    assert.match(frameText(app), /REAL PARALLEL AGENTS/);
    let choice = "y";
    if (request.prompt.startsWith("Choose")) choice = "agent-01";
    else if (request.prompt.startsWith("Run this") || request.content.includes(" test approval "))
      choice = "n";
    app.stdin.write(choice);
    app.stdin.write("\r");
  }
  assert.ok(completed, "batch finished");
  assert.equal(completed.error, null);
  assert.equal(completed.result.result.integrationStatus, "integrated");
  assert.equal(completed.result.status, "unverified");
  assert.ok(completed.result.result.recoverySessionId);
  assert.ok(
    readFileSync(join(demo.workspace, "src", "processor.py"), "utf8").includes(
      "bounds[0:len(bounds)]",
    ),
  );
  assert.equal(
    requests.filter((request) => request.prompt.startsWith("Approve this")).length >= 2,
    true,
  );
  assert.ok(requests.some((request) => request.prompt.startsWith("Choose")));
  assert.ok(requests.some((request) => request.prompt.startsWith("Integrate")));
});

test("eight-agent conflict choices remain visible at 40 columns in reduced-motion screen-reader mode", async (t) => {
  const restore = patchEnv({
    MATRIX_COLS: "40",
    MATRIX_ROWS: "20",
    INK_SCREEN_READER: "1",
    MATRIX_REDUCED_MOTION: "1",
  });
  t.after(restore);
  const many = Array.from({ length: 8 }, (_, index) => ({ task: `task ${index + 1}` }));
  const run = async ({ ask }) => {
    await ask(
      "Choose base or agent-01, agent-02, agent-03, agent-04, agent-05, agent-06, agent-07, agent-08: ",
    );
    return { status: "denied" };
  };
  const app = render(
    React.createElement(ParallelApp, { root: "/tmp", home: "/tmp/home", jobs: many, run }),
  );
  t.after(() => app.unmount());
  const frame = await waitFor(() => frameText(app).includes("agent-08:") && frameText(app));
  assert.ok(frame, "the last available resolution is visible");
  assert.match(frame, /agent-01 queued/);
  assert.match(frame, /agent-08 queued/);
});
