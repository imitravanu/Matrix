import test from "node:test";
import assert from "node:assert/strict";

import { buildChatLines, createChatLayout } from "../src/screens/chat.mjs";

function expectedSlice(all, height, scrollOffset) {
  const maxOffset = Math.max(0, all.length - height);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const start = Math.max(0, maxOffset - offset);
  return { lines: all.slice(start, start + height), total: all.length, maxOffset, offset, start };
}

function assertViewport(view, all, height, scrollOffset) {
  const expected = expectedSlice(all, height, scrollOffset);
  assert.equal(view.total, expected.total);
  assert.equal(view.maxOffset, expected.maxOffset);
  assert.equal(view.offset, expected.offset);
  assert.equal(view.start, expected.start);
  assert.deepEqual(view.lines, expected.lines);
  assert.ok(view.lines.length <= height);
}

test("cached chat viewports exactly match pure line descriptors at every scroll bound", () => {
  const history = [
    { id: "user-1", role: "user", content: `Inspect λ🙂 ${"request ".repeat(12)}` },
    {
      id: "assistant-1",
      version: 1,
      role: "assistant",
      modelName: "matrix/test",
      plan: [
        { title: "Inspect", status: "done" },
        { title: "Render", status: "active" },
      ],
      reasoning: Array.from({ length: 20 }, (_, index) => `reasoning ${index + 1}`).join("\n"),
      elapsedTime: 2,
      readFile: { path: "a.js", scope: "render()", snippet: ["  1  render"], duration: "1ms" },
      toolCards: [{ name: "read_file", ok: true, summary: "a.js" }],
      editFile: { path: "a.js", diff: ["@@ -1 +1 @@", "-old", "+new"], status: "pending" },
      verifyTests: {
        cmd: "npm test",
        results: [{ name: "failure", pass: false }],
        passed: 0,
        failed: 1,
        ok: false,
        output: Array.from({ length: 30 }, (_, index) => `output ${index + 1}`),
        outputLineCount: 30,
      },
      content: "Result\n\n```js\nconsole.log('λ🙂');\n```",
      summary: "rendered a.js",
    },
    { id: "system-1", role: "system", content: "restored a.js" },
    null,
  ];
  const live = {
    plan: [{ title: "Stream", status: "active" }],
    reasoning: "live reasoning\nwith another row",
    verifyTests: { cmd: "node --test", running: true, output: ["live output"] },
    content: "streaming answer",
    modelName: "matrix/test",
  };
  const layout = createChatLayout();
  const foldStates = [
    { thoughtsExpanded: false, diffExpanded: false, outputExpanded: false },
    { thoughtsExpanded: true, diffExpanded: false, outputExpanded: true },
    { thoughtsExpanded: false, diffExpanded: true, outputExpanded: true },
  ];

  for (const width of [20, 58]) {
    for (const folds of foldStates) {
      for (const frame of [0, 1]) {
        const options = { history, live, width, frame, ...folds };
        const all = buildChatLines(options);
        for (const height of [1, 7, 18]) {
          const maxOffset = Math.max(0, all.length - height);
          const offsets = [0, 1, Math.floor(maxOffset / 2), maxOffset, maxOffset + 100];
          for (const scrollOffset of offsets) {
            const view = layout.viewport({ ...options, height, scrollOffset });
            assertViewport(view, all, height, scrollOffset);
          }
        }
      }
    }
  }
});

test("warm updates reuse all stable history and build only changed live content", () => {
  const history = Array.from({ length: 500 }, (_, index) => ({
    id: `message-${index}`,
    version: 1,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `stable message ${index} λ🙂`,
    plan: index % 2 === 0 ? undefined : [{ title: "Completed", status: "done" }],
  }));
  const layout = createChatLayout();
  const cold = layout.viewport({ history, width: 60, height: 12 });
  assert.equal(cold.stats.messageBuilds, 500);
  assert.equal(cold.stats.cacheHits, 0);
  assert.equal(cold.lines.length, 12);

  for (let iteration = 0; iteration < 5; iteration++) {
    const live = {
      content: `live update ${iteration}`,
      reasoning: "",
      plan: [],
      modelName: "matrix/test",
    };
    const options = { history, live, width: 60, height: 12, frame: iteration + 1 };
    const warm = layout.viewport(options);
    assert.equal(warm.stats.cacheHits, 500);
    assert.equal(warm.stats.messageBuilds, 1);
    assertViewport(warm, buildChatLines(options), 12, 0);

    const unchanged = layout.viewport(options);
    assert.equal(unchanged.stats.cacheHits, 501);
    assert.equal(unchanged.stats.messageBuilds, 0);
    assert.deepEqual(unchanged.lines, warm.lines);
  }
});

test("message replacement, versions, and top-level edits cannot serve stale layouts", () => {
  const original = {
    id: "stable",
    version: 3,
    role: "assistant",
    content: "old content",
    plan: [],
  };
  const layout = createChatLayout();
  layout.viewport({ history: [original], width: 50, height: 8 });

  const equivalent = { ...original };
  const reused = layout.viewport({ history: [equivalent], width: 50, height: 8 });
  assert.equal(
    reused.stats.cacheHits,
    1,
    "explicit ID/version permits equivalent immutable replacements",
  );
  assert.equal(reused.stats.messageBuilds, 0);

  const changed = { ...equivalent, content: "new content" };
  const invalidated = layout.viewport({ history: [changed], width: 50, height: 8 });
  assert.equal(
    invalidated.stats.messageBuilds,
    1,
    "content is validated even when ID/version is unchanged",
  );
  assertViewport(invalidated, buildChatLines({ history: [changed], width: 50 }), 8, 0);

  const versioned = { ...changed, version: 4 };
  const versionInvalidated = layout.viewport({ history: [versioned], width: 50, height: 8 });
  assert.equal(versionInvalidated.stats.messageBuilds, 1);
  versioned.content = "mutated content";
  const mutationInvalidated = layout.viewport({ history: [versioned], width: 50, height: 8 });
  assert.equal(mutationInvalidated.stats.messageBuilds, 1);
  assert.ok(mutationInvalidated.lines.some((line) => line.text.includes("mutated content")));
});

test("offscreen immutable changes invalidate one entry and preserve Home/End slices", () => {
  const history = Array.from({ length: 30 }, (_, index) => ({
    id: `offscreen-${index}`,
    role: "user",
    content: index === 0 ? "OLD_OFFSCREEN" : `message ${index}`,
  }));
  const layout = createChatLayout();
  layout.viewport({ history, width: 44, height: 6 });
  const changed = [{ ...history[0], content: "NEW_OFFSCREEN" }, ...history.slice(1)];

  const bottom = layout.viewport({ history: changed, width: 44, height: 6, scrollOffset: 0 });
  assert.equal(bottom.stats.cacheHits, 29);
  assert.equal(bottom.stats.messageBuilds, 1);
  assertViewport(bottom, buildChatLines({ history: changed, width: 44 }), 6, 0);

  const top = layout.viewport({ history: changed, width: 44, height: 6, scrollOffset: 100000 });
  assertViewport(top, buildChatLines({ history: changed, width: 44 }), 6, 100000);
  assert.ok(top.lines.some((line) => line.text.includes("NEW_OFFSCREEN")));
  assert.ok(!top.lines.some((line) => line.text.includes("OLD_OFFSCREEN")));
});

test("nested card replacement invalidates retained-output layouts", () => {
  const original = {
    id: "verification",
    role: "assistant",
    content: "",
    verifyTests: { cmd: "npm test", ok: false, failed: 1, output: ["OLD_OUTPUT"] },
  };
  const layout = createChatLayout();
  const options = { history: [original], width: 50, height: 20, outputExpanded: true };
  layout.viewport(options);
  const changed = [
    { ...original, verifyTests: { ...original.verifyTests, output: ["NEW_OUTPUT"] } },
  ];
  const nextOptions = { ...options, history: changed };
  const view = layout.viewport(nextOptions);
  assert.equal(view.stats.messageBuilds, 1);
  assertViewport(view, buildChatLines(nextOptions), 20, 0);
  assert.ok(view.lines.some((line) => line.text.includes("NEW_OUTPUT")));
  assert.ok(!view.lines.some((line) => line.text.includes("OLD_OUTPUT")));
});

test("layout caches are isolated and bounded by entries, lines, and code units", () => {
  const layout = createChatLayout({ maxEntries: 3, maxLines: 6, maxCodeUnits: 18 });
  const history = Array.from({ length: 12 }, (_, index) => ({
    role: "user",
    content: `m${index}`,
  }));
  const view = layout.viewport({ history, width: 40, height: 4 });
  assertViewport(view, buildChatLines({ history, width: 40 }), 4, 0);
  assert.ok(view.stats.cacheEntries <= 3);
  assert.ok(view.stats.cacheLines <= 6);
  assert.ok(view.stats.cacheCodeUnits <= 18);

  const uncacheable = createChatLayout({ maxEntries: 3, maxLines: 2, maxCodeUnits: 100 });
  const large = [{ role: "user", content: "x".repeat(200) }];
  const largeView = uncacheable.viewport({ history: large, width: 20, height: 4 });
  assertViewport(largeView, buildChatLines({ history: large, width: 20 }), 4, 0);
  assert.equal(largeView.stats.cacheEntries, 0, "an over-budget entry is not retained");

  layout.clear();
  const empty = layout.viewport({ history: [], width: 40, height: 4 });
  assert.equal(empty.stats.cacheEntries, 0);
  assert.deepEqual(empty.lines, buildChatLines({ history: [], width: 40 }));
});
