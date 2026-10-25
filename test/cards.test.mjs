import test from "node:test";
import assert from "node:assert/strict";

import {
  formatCodeBlock,
  formatTokens,
  parseContentBlocks,
  renderContentWithCodeBlocks,
  renderEditFileCard,
  renderPlanCard,
  renderReadFileCard,
  renderThoughtCard,
  renderVerifyTestsCard,
  card,
  cardBottom,
  cardRow,
  cardTop,
} from "../src/cards.mjs";
import { buildChatLines, chatText } from "../src/screens/chat.mjs";
import { displayWidth } from "../lib/text.mjs";

function plain(lines) {
  return lines.map((line) => line.text).join("\n");
}

function assertWidth(lines, width) {
  for (const line of lines) {
    assert.ok(displayWidth(line.text) <= width, `"${line.text}" exceeds ${width}`);
  }
}

const PLAN = [
  { title: "Index workspace", status: "done", durationMs: 120 },
  { title: "Read processor.py", status: "done" },
  { title: "Propose patch", status: "active" },
  { title: "Verify tests", status: "pending" },
];

const PATCH = `--- a/src/processor.py
+++ b/src/processor.py
@@ -17,7 +17,7 @@
         if not bounds:
             return 0
         # comment
-        context = bounds[0:len(bounds) - 1]
+        context = bounds[0:len(bounds)]
         lo = bounds[0]
         return bounds[-1] if len(context) == len(bounds) else lo
`;

test("card primitives always produce exact-width boxes", () => {
  for (const width of [20, 40, 76]) {
    assert.equal(displayWidth(cardTop("TITLE", width).text), width);
    assert.equal(displayWidth(cardBottom(width).text), width);
    assert.equal(displayWidth(cardRow("hello", width).text), width);
    const long = cardRow("x".repeat(300), width);
    assert.equal(displayWidth(long.text), width);
  }
  const built = card("T", 40, ["one", { text: "two", bold: true }, null]);
  assert.equal(built.length, 5);
  assert.ok(built[1].text.includes("one"));
  assert.equal(built[0].color.length > 0, true);
});

test("plan cards show progress, durations, active and skipped states", () => {
  const lines = renderPlanCard(PLAN, 2, 60);
  const text = plain(lines);
  assert.match(text, /2\/4 · 50%/);
  assert.match(text, /1\. Index workspace \(120ms\)/);
  assert.match(text, /3\. Propose patch/);
  assert.match(text, /⠋ 3\. Propose patch/);
  assert.match(text, /4\. Verify tests/);
  assertWidth(lines, 60);
  const skipped = renderPlanCard([{ title: "x", status: "skipped" }], 0, 40);
  assert.match(plain(skipped), /skipped/);
  assert.match(plain(renderPlanCard([], 0, 40)), /no plan yet/);
});

test("thought cards collapse long reasoning unless expanded or streaming", () => {
  const reasoning = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const folded = renderThoughtCard(reasoning, 2, false, 60);
  const foldedText = plain(folded);
  assert.match(foldedText, /line 8/);
  assert.ok(!foldedText.includes("line 9"));
  assert.match(foldedText, /12 more lines · \/thoughts to expand/);
  const expanded = renderThoughtCard(reasoning, 2, false, 60, true);
  assert.match(plain(expanded), /line 20/);
  const streaming = renderThoughtCard("one\ntwo", 1, true, 60);
  assert.match(plain(streaming), /THINKING · 1s · 7 chars/);
  assert.match(plain(renderThoughtCard("", 0, false, 40)), /no reasoning emitted/);
  assertWidth(folded, 60);
});

test("a collapsed 1 MiB thought renders only a bounded preview", () => {
  const unit = "collapsed reasoning with spaces λ🙂 · ";
  const reasoning = `PREVIEW_START ${unit.repeat(Math.ceil((1024 * 1024) / unit.length))} PREVIEW_END`;
  assert.ok(reasoning.length >= 1024 * 1024);
  const folded = renderThoughtCard(reasoning, 2, false, 60);
  const text = plain(folded);
  assert.equal(folded.length, 11, "top + eight preview rows + fold hint + bottom");
  assert.match(text, /PREVIEW_START/);
  assert.match(text, /additional reasoning · \/thoughts to expand/);
  assert.ok(!text.includes("PREVIEW_END"));
  assertWidth(folded, 60);
});

test("read, edit and verification cards preserve real line numbers and status", () => {
  const read = renderReadFileCard(
    "src/processor.py",
    "class DataProcessor › def process_bounds",
    ["  20      context = ..."],
    "0.1s",
    70,
  );
  assert.match(plain(read), /READ FILE · src\/processor\.py · 0\.1s/);
  assert.match(plain(read), /process_bounds/);
  assertWidth(read, 70);
  const objectRead = renderReadFileCard(
    {
      path: "src/a.py",
      scope: "function f",
      snippet: ["  1  x"],
      duration: "2ms",
    },
    60,
  );
  assert.match(plain(objectRead), /src\/a\.py/);

  const edit = renderEditFileCard(
    "src/processor.py",
    "class DataProcessor › def process_bounds",
    PATCH.split("\n"),
    "approved",
    70,
  );
  const editText = plain(edit);
  assert.match(editText, /EDIT · src\/processor\.py/);
  assert.match(editText, /\+1 −1 · approved/);
  assert.match(editText, /len\(bounds\)\]/);
  assert.ok(!editText.includes("+++ b/"));
  assert.ok(edit.some((line) => line.bg));
  assertWidth(edit, 70);
  const denied = renderEditFileCard("a.py", "", ["-a", "+b"], "denied", 40);
  assert.match(plain(denied), /denied/);
  const expanded = renderEditFileCard("a.py", "", PATCH.split("\n"), "pending", 70, {
    expanded: true,
  });
  assert.equal(plain(expanded).includes("unchanged line"), false);

  const verify = renderVerifyTestsCard(
    "python3 -m pytest -q",
    [
      { name: "tests/test_x.py::test_a", pass: true },
      { name: "tests/test_x.py::test_b [1]", pass: false },
    ],
    "0.8s",
    76,
  );
  const verifyText = plain(verify);
  assert.match(verifyText, /\$ python3 -m pytest -q/);
  assert.match(verifyText, /✓ tests\/test_x\.py::test_a/);
  assert.match(verifyText, /✗ tests\/test_x\.py::test_b/);
  assert.match(verifyText, /1 passed · 1 failed · 0\.8s/);
  assertWidth(verify, 76);
  const authoritative = renderVerifyTestsCard(
    "npm test",
    [{ name: "failing test", pass: false }],
    "20ms",
    76,
    { passed: 2, failed: 2, summary: "2 failed, 2 passed" },
  );
  assert.match(plain(authoritative), /2 passed · 2 failed · 20ms/);
  assert.match(
    plain(renderVerifyTestsCard({ cmd: "npm test", skipped: true, results: [] }, 60)),
    /no test runner detected/,
  );
});

test("verification cards expose failure tails and every retained line when expanded", () => {
  const longLine = `LONG_${"z".repeat(180)}_END_OF_OUTPUT`;
  const output = Array.from({ length: 400 }, (_, index) => `retained line ${index + 50}`);
  output[200] = longLine;
  output[399] = "E EXPECTED_FAILURE_TAIL · retained line 449";
  const options = {
    results: [{ name: "diagnosable failure", pass: false }],
    passed: 0,
    failed: 1,
    ok: false,
    output,
    outputLineCount: 450,
    outputTruncated: true,
  };

  const collapsed = renderVerifyTestsCard({ cmd: "npm test", duration: "20ms", ...options }, 60);
  const collapsedText = plain(collapsed);
  assert.match(collapsedText, /retained output · last 400 of 450 lines/);
  assert.match(collapsedText, /showing last 8 retained · Alt\+O expand/);
  assert.match(collapsedText, /EXPECTED_FAILURE_TAIL/);
  assert.ok(!collapsedText.includes("retained line 50"));
  assert.ok(!collapsedText.includes("END_OF_OUTPUT"));

  const expanded = renderVerifyTestsCard(
    { cmd: "npm test", duration: "20ms", ...options, expanded: true },
    60,
  );
  const expandedText = plain(expanded);
  assert.match(expandedText, /retained output · last 400 of 450 lines/);
  assert.match(expandedText, /Alt\+O collapse · PgUp\/PgDn scroll/);
  assert.match(expandedText, /retained line 50/);
  assert.match(expandedText, /retained line 449/);
  assert.match(expandedText, /EXPECTED_FAILURE_TAIL/);
  assert.ok(expandedText.includes("END_OF_OUTPUT"));
  assert.equal((expandedText.match(/z/g) ?? []).length, 180);
  for (const line of [...collapsed, ...expanded]) assert.equal(displayWidth(line.text), 60);
});

test("verification output wraps long lines at narrow widths without losing content", () => {
  const output = [`prefix ${"q".repeat(160)} suffix`, "final failure"];
  for (const width of [20, 40, 60]) {
    const lines = renderVerifyTestsCard("npm test", [], "", width, {
      ok: false,
      failed: 1,
      summary: "1 failed",
      output,
      outputLineCount: 2,
      outputTruncated: false,
      expanded: true,
    });
    const text = plain(lines);
    assert.ok(text.includes("prefix"));
    assert.ok(text.includes("suffix"));
    assert.ok(text.includes("final failure"));
    assert.equal((text.match(/q/g) ?? []).length, 160);
    assert.match(text, /retained output/);
    assert.match(text, /2 lines retained/);
    for (const line of lines) assert.equal(displayWidth(line.text), width);
  }
});

test("edit cards wrap long changed lines without dropping their tail", () => {
  const long = `+const payload = "${"x".repeat(160)}"; END_OF_CHANGE`;
  const lines = renderEditFileCard("a.py", "", [long], "pending", 48, { expanded: true });
  const text = plain(lines);
  assert.ok(text.includes("END_OF_CHANGE"));
  assert.equal((text.match(/x/g) ?? []).length, 160);
  assertWidth(lines, 48);
});

test("content parsing handles fenced code, tildes and an unterminated stream", () => {
  const blocks = parseContentBlocks("Before\n```py\nprint(1)\n```\nAfter");
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["text", "code", "text"],
  );
  assert.equal(blocks[1].lang, "py");
  assert.deepEqual(blocks[1].lines, ["print(1)"]);
  const tilde = parseContentBlocks("~~~js\nconst x = 1;\n~~~");
  assert.equal(tilde[0].type, "code");
  assert.equal(tilde[0].lang, "js");
  const open = parseContentBlocks("```\nstill streaming");
  assert.equal(open[0].open, true);
  const rendered = renderContentWithCodeBlocks(
    "# Heading\n\n- bullet\n\n```js\nconst x = 1;\n```\n\nDone",
    40,
  );
  assertWidth(rendered, 40);
  assert.match(plain(rendered), /Heading/);
  assert.match(plain(rendered), /┌─ js/);
  assert.match(plain(rendered), /└─/);
  const code = formatCodeBlock(["const x = 1;", "# comment"], "js", 40);
  assertWidth(code, 40);
  assert.match(plain(code), /┌─ js/);
});

test("formatTokens is compact and honest for every scale", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(150_000), "150k");
  assert.equal(formatTokens(1_000_000), "1m");
  assert.equal(formatTokens(2_500_000), "2.5m");
  assert.equal(formatTokens(-1), "0");
});

test("buildChatLines renders a real transcript without overflowing", () => {
  const history = [
    { role: "user", content: "Please fix the bounds bug in src/processor.py" },
    {
      role: "assistant",
      modelName: "Local Forge",
      plan: PLAN,
      reasoning: "I will inspect the slice first.\nIt looks like an off-by-one.",
      readFile: {
        path: "src/processor.py",
        scope: "class DataProcessor › def process_bounds",
        snippet: ["  20      context = bounds[0:len(bounds) - 1]"],
        duration: "0.1s",
      },
      toolCards: [{ name: "read_file", ok: true, summary: "src/processor.py:17–23" }],
      editFile: {
        path: "src/processor.py",
        scope: "class DataProcessor › def process_bounds",
        diff: PATCH.split("\n"),
        stats: { adds: 1, dels: 1 },
        status: "approved",
      },
      verifyTests: {
        cmd: "python3 -m pytest -q",
        results: [{ name: "test_bounds", pass: true }],
        duration: "0.6s",
        passed: 4,
        failed: 0,
        ok: true,
      },
      content: "Fixed the off-by-one.\n\n```python\ncontext = bounds[0:len(bounds)]\n```",
      summary: "applied src/processor.py · 4 passed · 0 failed",
    },
    { role: "system", content: "restored src/processor.py" },
  ];
  for (const width of [40, 60, 76]) {
    const lines = buildChatLines({ history, width });
    assertWidth(lines, width);
    const text = plain(lines);
    assert.match(text, /EXECUTION PLAN/);
    assert.match(text, /THINKING/);
    assert.match(text, /READ FILE/);
    assert.match(text, /EDIT · src\/processor\.py/);
    assert.match(text, /VERIFICATION/);
    assert.match(text, /restored src\/processor\.py/);
  }
  const live = {
    plan: PLAN,
    activePlanIdx: 2,
    reasoning: "Working",
    content: "",
    task: "fix",
    modelName: "Local Forge",
    phase: "editing",
    error: false,
  };
  const liveLines = buildChatLines({ history: [], live, width: 50 });
  assertWidth(liveLines, 50);
  assert.match(plain(liveLines), /EXECUTION PLAN/);
  assert.match(plain(buildChatLines({ history: [], width: 50 })), /No messages yet/);
  assert.match(chatText({ history, width: 60 }), /applied src\/processor\.py/);
});
