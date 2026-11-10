// DUR-006 — goal terminal-UI tests.
//
// The goal UI surface is the bounded text projection renderer
// (src/goal-screen.mjs), which the CLI prints in real terminals and which the
// interactive path renders live. These tests pin the required content
// (remaining criteria, budget, last durable operation, stop reason, exact next
// command), responsive behavior at 40/60/80/100/140 columns including a
// 40-column narrow terminal, and the accessibility paths (plain text for
// screen readers, no animation under reduced motion).

import test from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToString } from "ink";
import { GoalScreen } from "../src/screens/goal.mjs";
import { renderGoalApp } from "../src/goal-app.mjs";

import { renderGoalStatus } from "../src/goal-screen.mjs";
import { displayWidth, stripAnsi } from "../lib/text.mjs";

const fullView = {
  schemaVersion: 1,
  goalId: "goal_0123456789abcdef0123456789abcdef",
  state: "needs-attention",
  generation: 2,
  criteria: [
    { id: "criterion_1", kind: "artifact", label: "src/a.mjs", accepted: false },
    { id: "criterion_2", kind: "artifact", label: "src/b.mjs", accepted: true },
    {
      id: "criterion_3",
      kind: "human",
      label: "A human must review the diff before this goal can complete",
      accepted: false,
    },
  ],
  remaining: { rounds: 5, tools: 20, requests: 27, activeMs: 500_000 },
  lastOperation: { id: "operation_abc", kind: "edit", status: "denied" },
  reason: "no grant was pre-issued for this exact edit",
  reasonCode: "tool-denied",
  nextCommand: "matrix goal resume goal_0123456789abcdef0123456789abcdef",
};

const WIDTHS = [40, 60, 80, 100, 140];

test("the goal view shows remaining criteria, budget, last operation, stop reason and next command", () => {
  const out = renderGoalStatus(fullView, 80);
  assert.match(out, /Goal goal_0123456789abcdef0123456789abcdef/);
  assert.match(out, /State needs-attention · generation 2/);
  assert.match(out, /Remaining criteria 2 of 3/);
  assert.match(out, /artifact · src\/a\.mjs/);
  assert.match(out, /human · A human must review/);
  assert.doesNotMatch(out, /src\/b\.mjs/, "accepted criteria are not listed as remaining");
  assert.match(out, /Remaining budget 5 rounds · 20 tools · 27 requests · 500000 ms/);
  assert.match(out, /Last operation edit · denied · operation_abc/);
  assert.match(out, /no grant was pre-issued for this exact edit/);
  assert.match(out, /Next command: matrix goal resume goal_0123456789abcdef0123456789abcdef/);
});

test("the goal view stays within every supported terminal width, including 40 columns", () => {
  for (const width of WIDTHS) {
    const out = renderGoalStatus(fullView, width);
    const lines = out.split("\n");
    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(
        displayWidth(line) <= width,
        `width ${width}: line "${line}" is ${displayWidth(line)} columns`,
      );
    }
  }
  // A very long objective and next command still wrap inside 40 columns.
  const wide = renderGoalStatus(
    {
      ...fullView,
      goalId: "goal_" + "f".repeat(32),
      nextCommand: `matrix goal resume goal_${"f".repeat(32)} --provider fake --model fake/model-1`,
    },
    40,
  );
  for (const line of wide.split("\n")) {
    assert.ok(displayWidth(line) <= 40, `narrow overflow: "${line}" (${displayWidth(line)})`);
  }
});

test("list views render goals, the empty state and the omission bound", () => {
  const goals = Array.from({ length: 3 }, (_, index) => ({
    id: `goal_${String(index).padStart(32, "0")}`,
    state: "paused",
    objective: `objective ${index}`,
  }));
  const out = renderGoalStatus({ schemaVersion: 1, goals }, 80);
  assert.match(out, /Goals in this workspace/);
  assert.match(out, /goal_0+0 · paused · objective 0/);
  assert.match(renderGoalStatus({ schemaVersion: 1, goals: [] }, 80), /No goals in this workspace/);
  const omitted = renderGoalStatus({ schemaVersion: 1, goals, omitted: 12 }, 60);
  assert.match(omitted, /12 more goals omitted/);
});

test("accessibility: output is plain text for screen readers and unchanged under reduced motion", () => {
  const cases = [
    { INK_SCREEN_READER: "1" },
    { MATRIX_REDUCED_MOTION: "1" },
    { INK_SCREEN_READER: "1", MATRIX_REDUCED_MOTION: "true" },
    {},
  ];
  const saved = { ...process.env };
  try {
    for (const env of cases) {
      for (const key of ["INK_SCREEN_READER", "MATRIX_REDUCED_MOTION"]) delete process.env[key];
      Object.assign(process.env, env);
      const out = renderGoalStatus(fullView, 80);
      assert.equal(
        stripAnsi(out),
        out,
        "goal output must stay plain text (no ANSI) for screen readers",
      );
      assert.match(out, /Next command:/);
      const list = renderGoalStatus({ schemaVersion: 1, goals: [] }, 40);
      assert.equal(stripAnsi(list), list);
    }
  } finally {
    for (const key of ["INK_SCREEN_READER", "MATRIX_REDUCED_MOTION"]) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("renderGoalStatus bounds and wraps arbitrary untrusted text safely", () => {
  const hostile = {
    ...fullView,
    reason: "x".repeat(5000) + " SECRET fake-goal-key-0123456789abcdef",
    criteria: [{ id: "c", kind: "artifact", label: "../".repeat(80), accepted: false }],
  };
  const out = renderGoalStatus(hostile, 60);
  for (const line of out.split("\n")) {
    assert.ok(displayWidth(line) <= 60, `overflow: "${line}"`);
  }
  // Rendering never mutates the projection it was given.
  assert.equal(fullView.reason, "no grant was pre-issued for this exact edit");
});

const bin = fileURLToPath(new URL("../bin/matrix.mjs", import.meta.url));
const view = {
  event: "Goal resumed and stopped",
  goalId: "goal_" + "a".repeat(32),
  state: "paused",
  generation: 2,
  criteria: [{ id: "criterion", accepted: false, kind: "artifact", label: "src/a.mjs" }],
  remaining: { rounds: 6, tools: 20, requests: 30, activeMs: 500000 },
  lastOperation: { kind: "provider", status: "uncertain" },
  reason: "Pause requested at a safe boundary.",
  nextCommand: "matrix goal resume goal_" + "a".repeat(32),
};

test("goal screen fits supported geometries and exposes a full textual continuation", (t) => {
  for (const [columns, rows] of [
    [40, 20],
    [60, 22],
    [80, 26],
    [100, 30],
    [140, 40],
  ]) {
    const rendered = renderToString(React.createElement(GoalScreen, { view, columns, rows }), {
      columns,
    });
    assert.match(rendered, /Remaining criteria 1 of 1/);
    assert.match(rendered, /Last operation provider/);
    assert.ok(rendered.split("\n").length <= rows);
    assert.ok(rendered.split("\n").every((line) => Array.from(line).length <= columns));
  }
  const saved = process.env.INK_SCREEN_READER;
  process.env.INK_SCREEN_READER = "1";
  t.after(() => {
    if (saved === undefined) delete process.env.INK_SCREEN_READER;
    else process.env.INK_SCREEN_READER = saved;
  });
  const accessible = renderGoalApp(view, { isTTY: true });
  assert.match(accessible, /Remaining criteria 1 of 1/);
  assert.match(accessible, /Pause requested at a safe boundary/);
  assert.ok(accessible.includes(view.nextCommand));
});

const DRIVER = String.raw`
import errno, fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
node, bin_path, root, state, mode, goal_id = sys.argv[1:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 40, 0, 0))
env = dict(os.environ, MATRIX_HOME=state, TERM='xterm-256color', MATRIX_REDUCED_MOTION='1', NO_COLOR='1')
args = ['resume', goal_id] if goal_id else ['start', 'rename a to b in src/a.mjs', '--criteria', 'criteria.json']
proc = subprocess.Popen([node, bin_path, 'goal', *args], cwd=root, stdin=slave, stdout=slave, stderr=slave, env=env)
os.close(slave)
answered = False
output = b''
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], .1)[0]:
            continue
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not data:
            break
        output += data
        if mode == 'human-stop' and not answered and b'Check the first artifact' in output:
            answered = True
            os.write(master, b'y\r')
        if mode == 'human-stop' and b'Check the second artifact' in output:
            os.write(master, b'\x03')
        if mode == 'human-resume' and not answered and b'Check the second artifact' in output:
            answered = True
            os.write(master, b'y\r')
        if not answered and b'Apply this exact edit?' in output:
            answered = True
            if mode == 'kill':
                proc.kill()
            else:
                os.write(master, b'\x03' if mode == 'interrupt' else b'y\r')
    code = proc.wait(timeout=2)
    print(json.dumps({'code':code, 'output':output.decode('utf8', 'replace'), 'answered':answered}))
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    os.close(master)
`;

for (const stop of ["interrupt", "kill"]) {
  test(
    `a real 40×20 terminal can resume after ${stop} at edit approval`,
    { skip: process.platform !== "linux", timeout: 30_000 },
    (t) => {
      const base = mkdtempSync(join(tmpdir(), "matrix-goal-pty-"));
      t.after(() => rmSync(base, { recursive: true, force: true }));
      const workspace = join(base, "work");
      const home = join(base, "state");
      const target = join(workspace, "src", "a.mjs");
      mkdirSync(join(workspace, "src"), { recursive: true });
      const before = "export const a = 1;\n";
      const after = "export const b = 1;\n";
      writeFileSync(target, before);
      writeFileSync(
        join(workspace, "criteria.json"),
        JSON.stringify({
          schemaVersion: 1,
          criteria: [
            {
              kind: "artifact",
              path: "src/a.mjs",
              sha256: createHash("sha256").update(after).digest("hex"),
            },
          ],
        }),
      );
      const run = (mode, goalId = "") => {
        const child = spawnSync(
          "python3",
          ["-c", DRIVER, process.execPath, bin, workspace, home, mode, goalId],
          {
            encoding: "utf8",
            timeout: 16_000,
            maxBuffer: 64 * 1024,
          },
        );
        assert.equal(child.status, 0, child.stderr || child.error?.message);
        return JSON.parse(child.stdout);
      };
      const interrupted = run(stop);
      assert.equal(interrupted.answered, true, interrupted.output);
      assert.equal(interrupted.code, stop === "kill" ? -9 : 130, interrupted.output);
      assert.match(interrupted.output, /Remaining criteria/);
      assert.equal(readFileSync(target, "utf8"), before);
      const id = readdirSync(join(home, "goals")).find((name) => name.startsWith("goal_"));
      const resumed = run("approve", id);
      assert.equal(resumed.code, 0, resumed.output);
      assert.match(resumed.output, /Goal completed/);
      assert.equal(readFileSync(target, "utf8"), after);
    },
  );
}

test(
  "trusted human acceptance survives restart and headless work cannot grant it",
  {
    skip: process.platform !== "linux",
    timeout: 30_000,
  },
  (t) => {
    const workspace = mkdtempSync(join(tmpdir(), "matrix-goal-human-"));
    const home = join(workspace, "state");
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    writeFileSync(
      join(workspace, "criteria.json"),
      JSON.stringify({
        schemaVersion: 1,
        criteria: [
          { kind: "human", description: "Check the first artifact" },
          { kind: "human", description: "Check the second artifact" },
        ],
      }),
    );
    const cli = (...args) =>
      spawnSync(process.execPath, [bin, "goal", ...args, "--json"], {
        cwd: workspace,
        env: { ...process.env, MATRIX_HOME: home },
        encoding: "utf8",
        timeout: 7000,
      });
    const tty = (mode, id) => {
      const result = spawnSync(
        "python3",
        ["-c", DRIVER, process.execPath, bin, workspace, home, mode, id],
        {
          encoding: "utf8",
          timeout: 16_000,
          maxBuffer: 64 * 1024,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return JSON.parse(result.stdout);
    };
    const start = cli("start", "review these artifacts", "--criteria", "criteria.json", "--yes");
    assert.equal(start.status, 1, start.stdout + start.stderr);
    const id = JSON.parse(start.stdout).goalId;
    assert.deepEqual(
      JSON.parse(start.stdout).criteria.map((criterion) => criterion.accepted),
      [false, false],
    );
    const stopped = tty("human-stop", id);
    assert.equal(stopped.code, 130, stopped.output);
    const inspected = cli("inspect", id);
    assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
    assert.deepEqual(
      JSON.parse(inspected.stdout).criteria.map((criterion) => criterion.accepted),
      [true, false],
    );
    const resumed = tty("human-resume", id);
    assert.equal(resumed.code, 0, resumed.output);
    assert.doesNotMatch(resumed.output, /Accept human criterion "Check the first artifact"/);
    assert.match(resumed.output, /Goal completed/);
  },
);
