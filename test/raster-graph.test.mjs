import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import {
  createCanvas,
  drawDashedLine,
  drawLine,
  drawText,
  encodePNG,
  fillRect,
  getPixel,
  halfBlockAnsi,
  halfBlockRuns,
  halfBlockText,
  measureText,
  mixColor,
  parseColor,
  rgbToHex,
  setPixel,
  strokeRect,
  toAscii,
  writePng,
} from "../lib/raster.mjs";
import {
  buildScopeGraph,
  buildTelemetryGraph,
  buildVision,
  buildWorkspaceGraph,
  emptyVision,
} from "../lib/graph.mjs";
import { detectProject } from "../lib/project.mjs";
import { parseScopes } from "../lib/scope.mjs";
import { copyDemo } from "./helpers.mjs";
import { readFileSync as read } from "node:fs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canvasDigests(canvas) {
  return {
    pixels: sha256(Buffer.from(canvas.data)),
    runs: sha256(JSON.stringify(halfBlockRuns(canvas))),
    text: sha256(halfBlockText(canvas)),
    ansi: sha256(halfBlockAnsi(canvas)),
  };
}

function nestedScopes(count) {
  const flat = [
    {
      id: "module",
      parentId: null,
      kind: "module",
      depth: 0,
      startLine: 1,
      endLine: count + 1,
      label: "module",
      name: "module",
    },
  ];
  for (let index = 0; index < count; index++) {
    flat.push({
      id: `scope-${index}`,
      parentId: index === 0 ? "module" : `scope-${index - 1}`,
      kind: index % 17 === 0 ? "class" : "function",
      depth: index + 1,
      startLine: 1,
      endLine: count - index + 1,
      label: `scope_${index}`,
      name: `scope_${index}`,
    });
  }
  return { flat, lineCount: count + 1 };
}

function halfBlockFixture() {
  const canvas = createCanvas(7, 5, "#0b0c0e");
  canvas.data.set([
    11, 12, 14, 255, 0, 255, 65, 255, 0, 255, 65, 255, 0, 0, 0, 0, 230, 248, 238, 255, 27, 56, 43,
    255, 248, 113, 113, 255, 11, 12, 14, 255, 11, 12, 14, 255, 0, 255, 65, 128, 0, 255, 65, 255, 27,
    56, 43, 255, 248, 113, 113, 255, 11, 12, 14, 0, 0, 200, 83, 255, 0, 200, 83, 255, 251, 191, 36,
    255, 0, 0, 0, 0, 132, 169, 140, 255, 11, 12, 14, 255, 18, 61, 39, 255, 0, 200, 83, 255, 0, 0, 0,
    0, 251, 191, 36, 255, 0, 200, 83, 255, 11, 12, 14, 255, 11, 12, 14, 255, 18, 61, 39, 128, 0,
    200, 83, 255, 230, 248, 238, 255, 0, 255, 65, 255, 0, 200, 83, 255, 0, 200, 83, 0, 248, 113,
    113, 255, 0, 255, 65, 255,
  ]);
  return canvas;
}

function parsePng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let offset = 8;
  const chunks = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  const ihdr = chunks.find((chunk) => chunk.type === "IHDR");
  const idat = chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data);
  return {
    chunks,
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8],
    colorType: ihdr.data[9],
    raw: inflateSync(Buffer.concat(idat)),
  };
}

// Deflate bytes can vary across supported Node/zlib versions. The portable
// contract is an identical RGBA image, not one particular compressed stream.
function assertPngMatchesCanvas(canvas) {
  const parsed = parsePng(encodePNG(canvas));
  assert.equal(parsed.width, canvas.width);
  assert.equal(parsed.height, canvas.height);
  assert.equal(parsed.bitDepth, 8);
  assert.equal(parsed.colorType, 6);
  const scanlines = [];
  const rowBytes = canvas.width * 4;
  for (let y = 0; y < canvas.height; y++) {
    scanlines.push(
      Buffer.from([0]),
      Buffer.from(canvas.data.subarray(y * rowBytes, (y + 1) * rowBytes)),
    );
  }
  assert.deepEqual(parsed.raw, Buffer.concat(scanlines));
}

test("color parsing, blending and hex output are deterministic", () => {
  assert.deepEqual(parseColor("#0f0"), [0, 255, 0, 255]);
  assert.deepEqual(parseColor("#00ff4180"), [0, 255, 65, 128]);
  assert.deepEqual(parseColor("transparent"), [0, 0, 0, 0]);
  assert.deepEqual(parseColor([1, 2, 3]), [1, 2, 3, 255]);
  assert.equal(rgbToHex(0, 255, 65), "#00ff41");
  assert.equal(rgbToHex(-1, 300, 128), "#00ff80");
  assert.equal(mixColor("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(mixColor("#000000", "#ffffff", 2), "#ffffff");
});

test("canvas clipping, alpha blending and primitives stay inside the buffer", () => {
  const canvas = createCanvas(4, 3, "#000000");
  assert.equal(canvas.width, 4);
  assert.deepEqual(getPixel(canvas, 0, 0), [0, 0, 0, 255]);
  setPixel(canvas, 1, 1, "#ff0000");
  assert.deepEqual(getPixel(canvas, 1, 1), [255, 0, 0, 255]);
  setPixel(canvas, 2, 1, [255, 255, 255, 128]);
  const blended = getPixel(canvas, 2, 1);
  assert.ok(blended[0] > 120 && blended[0] < 140);
  assert.equal(blended[3], 255);
  setPixel(canvas, -1, 0, "#fff");
  setPixel(canvas, 99, 99, "#fff");
  assert.deepEqual(getPixel(canvas, 0, 0), [0, 0, 0, 255]);
  fillRect(canvas, -2, -2, 3, 3, "#00ff00");
  assert.deepEqual(getPixel(canvas, 0, 0), [0, 255, 0, 255]);
  strokeRect(canvas, 1, 1, 3, 2, "#ffffff");
  assert.equal(getPixel(canvas, 1, 1)[1], 255);
  drawLine(canvas, 0, 0, 3, 2, "#ff00ff");
  assert.deepEqual(getPixel(canvas, 3, 2), [255, 0, 255, 255]);
  drawDashedLine(canvas, 0, 2, 3, 2, "#123456");
  assert.equal(getPixel(canvas, 0, 2)[0] > 0, true);
});

test("the 3x5 font draws real pixels and measures consistently", () => {
  const canvas = createCanvas(48, 12, "#000000");
  assert.equal(measureText(""), 0);
  assert.equal(measureText("AB"), 7);
  assert.equal(measureText("A", 2), 6);
  const used = drawText(canvas, "MATRIX", 2, 2, "#00ff41");
  assert.ok(used > 0);
  let lit = 0;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (getPixel(canvas, x, y)[1] > 0) lit++;
    }
  }
  assert.ok(lit > 20);
  const scaled = createCanvas(20, 20, "#000");
  drawText(scaled, "A", 1, 1, "#fff", { scale: 2 });
  assert.ok(getPixel(scaled, 1, 1)[0] > 0);
});

test("half-block output preserves both pixel rows and truecolor runs", () => {
  const canvas = createCanvas(2, 2, "#000000");
  setPixel(canvas, 0, 0, "#ff0000");
  setPixel(canvas, 0, 1, "#0000ff");
  setPixel(canvas, 1, 0, "#00ff00");
  setPixel(canvas, 1, 1, "#00ff00");
  const rows = halfBlockRuns(canvas);
  assert.equal(rows.length, 1);
  const text = halfBlockText(canvas);
  assert.equal(text.length, 2);
  assert.match(text, /▀/);
  assert.match(text, /█/);
  const ansi = halfBlockAnsi(canvas);
  // The assertion deliberately verifies the emitted ANSI ESC byte.
  // eslint-disable-next-line no-control-regex
  assert.match(ansi, /\x1b\[38;2;255;0;0(?:;48;2;0;0;255)?m/);
  assert.match(ansi, /48;2;0;0;255/);
  const ascii = toAscii(canvas, { width: 2 });
  assert.equal(ascii.split("\n").length, 1);
  assert.equal(ascii.length, 2);
});

test("numeric half-block conversion is byte-equivalent for alpha, odd rows and run grouping", () => {
  const canvas = halfBlockFixture();
  assert.deepEqual(halfBlockRuns(canvas), [
    [
      { text: " ", fg: null, bg: null },
      { text: "▀█▄", fg: "#00ff41", bg: null },
      { text: "▀", fg: "#e6f8ee", bg: "#1b382b" },
      { text: "▀", fg: "#1b382b", bg: "#f87171" },
      { text: "▀", fg: "#f87171", bg: null },
    ],
    [
      { text: "█▀", fg: "#00c853", bg: null },
      { text: "█", fg: "#fbbf24", bg: null },
      { text: "▄", fg: "#00c853", bg: null },
      { text: "▀", fg: "#84a98c", bg: null },
      { text: " ", fg: null, bg: null },
      { text: "█", fg: "#123d27", bg: null },
    ],
    [
      { text: "▀", fg: "#00c853", bg: null },
      { text: "▀", fg: "#e6f8ee", bg: null },
      { text: "▀", fg: "#00ff41", bg: null },
      { text: "▀", fg: "#00c853", bg: null },
      { text: " ", fg: null, bg: null },
      { text: "▀", fg: "#f87171", bg: null },
      { text: "▀", fg: "#00ff41", bg: null },
    ],
  ]);
  assert.deepEqual(canvasDigests(canvas), {
    pixels: "499f7f1644b7b95e513b3863def3229da81cfdfc4ddfbbde3d31f13e46c71c52",
    runs: "c68b5af1adfe8e548cb0c59bf19b0272f803f03ecc8217b0631a986677388181",
    text: "a8ed2eb023b7c9a9483e00374ef7d684dac59221a2aef0b55d6dcb1e3029bdbd",
    ansi: "49f91a6d851174ab719be95e058e70bb7bbd6a155ae990e11e368cd1a3a21c38",
  });
  assertPngMatchesCanvas(canvas);
  assert.equal(
    sha256(JSON.stringify(halfBlockRuns(canvas, { background: "#000000" }))),
    "b9417f822a965a5078e3bcef342144b13c038e4f7d3fb9e5b0216d7dab3ce525",
  );
});

test("encodePNG writes a valid RGBA PNG with the right scanlines", () => {
  const canvas = createCanvas(3, 2, "#000000");
  setPixel(canvas, 0, 0, "#ff0000");
  setPixel(canvas, 1, 0, "#00ff00");
  setPixel(canvas, 2, 0, "#0000ff");
  setPixel(canvas, 0, 1, "#ffffff");
  const png = encodePNG(canvas);
  const parsed = parsePng(png);
  assert.equal(parsed.width, 3);
  assert.equal(parsed.height, 2);
  assert.equal(parsed.bitDepth, 8);
  assert.equal(parsed.colorType, 6);
  assert.deepEqual(
    parsed.chunks.map((chunk) => chunk.type),
    ["IHDR", "IDAT", "IEND"],
  );
  assert.equal(parsed.raw.length, (3 * 4 + 1) * 2);
  assert.equal(parsed.raw[0], 0);
  assert.deepEqual([...parsed.raw.subarray(1, 5)], [255, 0, 0, 255]);
  assert.deepEqual([...parsed.raw.subarray(5, 9)], [0, 255, 0, 255]);
  assert.equal(parsed.raw[13], 0);
  assert.deepEqual([...parsed.raw.subarray(14, 18)], [255, 255, 255, 255]);
});

test("writePng writes real bytes to disk", (t) => {
  const root = mkdtempSync(join(tmpdir(), "matrix-png-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canvas = createCanvas(9, 5, "#000000");
  const path = join(root, "fresh", "home", "vision.png");
  const written = writePng(canvas, path);
  const bytes = readFileSync(path);
  assert.equal(written.width, 9);
  assert.equal(written.height, 5);
  assert.equal(written.bytes, bytes.length);
  const parsed = parsePng(bytes);
  assert.equal(parsed.width, 9);
  assert.equal(parsed.height, 5);
});

test("scope and workspace graphs are derived from the real demo", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const project = detectProject(demo.workspace);
  const source = read(join(demo.workspace, "src", "processor.py"), "utf8");
  const parsed = parseScopes(source, "src/processor.py");
  const scope = buildScopeGraph(parsed, {
    file: "src/processor.py",
    width: 96,
    height: 32,
    activeLine: 20,
  });
  assert.equal(scope.canvas.width, 96);
  assert.equal(scope.canvas.height, 32);
  assert.equal(scope.meta.scopes, 4);
  assert.ok(scope.meta.drawn >= 4);
  for (const height of [24, 32, 36]) {
    const small = buildScopeGraph(parsed, {
      file: "src/processor.py",
      width: 80,
      height,
      activeLine: 20,
    });
    assert.ok(small.meta.drawn >= 1, `scope graph should draw a visible bar at ${height} rows`);
  }
  assert.ok(halfBlockText(scope.canvas).trim().length > 0);
  const workspace = buildWorkspaceGraph(project, { width: 96, height: 32 });
  assert.equal(workspace.canvas.width, 96);
  assert.equal(workspace.meta.files, 2);
  assert.ok(workspace.meta.languages >= 1);
  assert.ok(halfBlockText(workspace.canvas).length > 0);
  const vision = buildVision({
    mode: "scope",
    parsed,
    file: "src/processor.py",
    activeLine: 20,
    project,
    width: 80,
    height: 28,
  });
  assert.equal(vision.title, "Scope flame");
  assert.equal(vision.canvas.width, 80);
  assert.equal(vision.canvas.height, 28);
});

test("scope parent lookup preserves exact graph pixels, ANSI runs and PNG scanlines", () => {
  const graph = buildScopeGraph(nestedScopes(9), {
    file: "src/fixture.js",
    width: 96,
    height: 44,
    activeLine: 1,
  });
  assert.deepEqual(canvasDigests(graph.canvas), {
    pixels: "6843dbbd2d2e1a9b60d8a66e2a5916513cd12739f8f6d1bb29a0129a02989abc",
    runs: "5c57c809f09fdbc7a5e3cfbc0e0f236b16bbf999e41376038ed2751aeaba3f64",
    text: "1eb550abd72ac3b0251e52e033a54a56dc6023f2e23d1e6f536ca55c16125313",
    ansi: "1b5da186fd6e39533d0a0736d50340ab4d0c4e3a66c72bfc7dceac33bf2626f4",
  });
  assertPngMatchesCanvas(graph.canvas);
});

test("an 8,000-scope graph avoids linear parent scans with byte-equivalent output", () => {
  const parsed = nestedScopes(8_000);
  parsed.flat.find = () => {
    throw new Error("scope graph used a linear parent scan");
  };
  const graph = buildScopeGraph(parsed, {
    file: "stress.js",
    width: 120,
    height: 68,
    activeLine: 1,
  });
  assert.deepEqual(graph.meta, { scopes: 8_000, lines: 8_001, drawn: 7 });
  assert.equal(
    sha256(Buffer.from(graph.canvas.data)),
    "5710dc9a908a2c7d49efd097bef18187676d96ed939dfe20c2791057a071ea3c",
  );
  assert.equal(
    sha256(JSON.stringify(halfBlockRuns(graph.canvas))),
    "87befe956ff1ca0d38582378c8f284962d41031c4495d9d5d5943cd9e3867949",
  );
  assert.equal(
    sha256(halfBlockAnsi(graph.canvas)),
    "6c90a02fdc100e144fc9523a1d1f0298f801a752d8923b285906f8f1a3167f4c",
  );
  assertPngMatchesCanvas(graph.canvas);
});

test("telemetry and empty vision render real values and honest empty states", () => {
  const telemetry = buildTelemetryGraph({
    usage: { prompt_tokens: 1200, completion_tokens: 300, cached_tokens: 400 },
    metrics: { cost: 0.0123, elapsedMs: 4321, rounds: 3, toolCalls: 4 },
    testResult: { passed: 4, failed: 1, skipped: false },
    modelName: "Claude Sonnet 4.6",
    width: 100,
    height: 32,
  });
  assert.equal(telemetry.canvas.width, 100);
  assert.equal(telemetry.canvas.height, 32);
  assert.equal(telemetry.meta.elapsed, 4321);
  assert.equal(telemetry.meta.cost, 0.0123);
  assert.ok(halfBlockText(telemetry.canvas).length > 0);
  const empty = buildTelemetryGraph({ width: 60, height: 24 });
  assert.equal(empty.canvas.width, 60);
  assert.ok(halfBlockText(empty.canvas).length > 0);
  const noFile = emptyVision(60, 24, "no file");
  assert.equal(noFile.title, "Vision");
  assert.equal(noFile.canvas.width, 60);
  assert.equal(noFile.canvas.height, 24);
  assert.equal(
    buildVision({ mode: "workspace", project: null, width: 40, height: 20 }).canvas.width,
    40,
  );
  const fallback = buildVision({ parsed: null, file: "none", width: 40, height: 20 });
  assert.equal(fallback.canvas.width, 40);
});

test("telemetry and workspace canvases stay readable on short terminals", () => {
  const usage = { prompt_tokens: 1200, completion_tokens: 300, cached_tokens: 400 };
  const metrics = { cost: 0.0123, elapsedMs: 4321, rounds: 3, toolCalls: 4 };
  const testResult = { passed: 4, failed: 0 };
  for (const height of [20, 24, 40, 52, 66]) {
    const graph = buildTelemetryGraph({
      usage,
      metrics,
      testResult,
      modelName: "Local Forge",
      width: 58,
      height,
    });
    let lit = 0;
    for (let y = 11; y < graph.canvas.height; y++) {
      for (let x = 0; x < graph.canvas.width; x++) {
        if (getPixel(graph.canvas, x, y).some((channel, index) => index < 3 && channel > 20)) lit++;
      }
    }
    assert.ok(
      lit > 40,
      `telemetry should paint real content at ${height}px, found ${lit} lit pixels`,
    );
  }
  const workspace = buildWorkspaceGraph(detectProject("demo-project"), { width: 58, height: 20 });
  let workspaceLit = 0;
  for (let y = 11; y < workspace.canvas.height; y++) {
    for (let x = 0; x < workspace.canvas.width; x++) {
      if (getPixel(workspace.canvas, x, y).some((channel, index) => index < 3 && channel > 20))
        workspaceLit++;
    }
  }
  assert.ok(
    workspaceLit > 40,
    `workspace should paint content at 20px, found ${workspaceLit} lit pixels`,
  );
});
