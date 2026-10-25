import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import {
  chainAtLine,
  describeScope,
  detectLanguage,
  flatten,
  formatScopeChain,
  parseScopes,
  scopeAtLine,
  scopeStats,
} from "../lib/scope.mjs";
import { copyDemo } from "./helpers.mjs";

const PY = `import os

@decorator
class Widget:
    """doc"""
    def __init__(self, size):
        self.size = size

    def render(self, value):
        if value:
            return f"{value}"
        return ""

def top_level(x):
    return x + 1
`;

const JS = `// a comment with { braces }
export class Panel {
  label = "}";
  render(value) {
    const text = "function fake() {";
    if (value) {
      return text + value;
    }
    return text;
  }
}

function helper(x) {
  return x * 2;
}
`;

test("detectLanguage covers Python, JS/TS, Rust, Go, Ruby and generic", () => {
  assert.equal(detectLanguage("a.py"), "python");
  assert.equal(detectLanguage("a.tsx"), "javascript");
  assert.equal(detectLanguage("a.rs"), "rust");
  assert.equal(detectLanguage("a.rb"), "ruby");
  assert.equal(detectLanguage("a.txt"), "generic");
});

test("Python scopes use indentation and include decorators", () => {
  const parsed = parseScopes(PY, "widget.py");
  assert.equal(parsed.language, "python");
  assert.equal(parsed.lineCount, 16);
  assert.equal(parsed.flat[0].kind, "module");
  const widget = parsed.flat.find((node) => node.name === "Widget");
  assert.equal(widget.kind, "class");
  assert.equal(widget.startLine, 3); // decorator line
  assert.equal(widget.endLine, 12);
  const init = parsed.flat.find((node) => node.name === "__init__");
  const render = parsed.flat.find((node) => node.name === "render");
  const top = parsed.flat.find((node) => node.name === "top_level");
  assert.equal(init.parentId, widget.id);
  assert.equal(init.startLine, 6);
  assert.equal(init.endLine, 7);
  assert.equal(render.startLine, 9);
  assert.equal(render.endLine, 12);
  assert.equal(top.parentId, "scope-0");
  assert.equal(scopeAtLine(parsed, 10)?.name, "render");
  assert.deepEqual(
    chainAtLine(parsed, 10).map((node) => node.name),
    ["widget.py", "Widget", "render"],
  );
  assert.equal(describeScope(render), "function render · L9–12");
  assert.equal(scopeStats(parsed).classes, 1);
  assert.equal(scopeStats(parsed).functions, 3);
});

test("JavaScript parser masks comments and strings before matching braces", () => {
  const parsed = parseScopes(JS, "panel.js");
  assert.equal(parsed.language, "javascript");
  const panel = parsed.flat.find((node) => node.name === "Panel");
  const helper = parsed.flat.find((node) => node.name === "helper");
  const render = parsed.flat.find((node) => node.name === "render");
  assert.ok(panel, "Panel class should be found");
  assert.ok(helper, "helper function should be found");
  assert.ok(render, "render method should be found");
  assert.equal(panel.parentId, "scope-0");
  assert.equal(helper.parentId, "scope-0");
  assert.equal(render.parentId, panel.id);
  assert.equal(panel.startLine, 2);
  assert.ok(panel.endLine >= 11);
  assert.equal(helper.startLine, 13);
  assert.equal(scopeAtLine(parsed, 6)?.name, "render");
});

test("TypeScript generic return types do not hide the function body", () => {
  const source = `export function load(): Result<{ ok: boolean }> {
  return read();
}

export function plain(): { ok: boolean } {
  return { ok: true };
}

export class Box<T> {
  get(): Record<string, { id: number }> {
    return map;
  }
}
`;
  const parsed = parseScopes(source, "typed.ts");
  const load = parsed.flat.find((node) => node.name === "load");
  const plain = parsed.flat.find((node) => node.name === "plain");
  const box = parsed.flat.find((node) => node.name === "Box");
  const get = parsed.flat.find((node) => node.name === "get");
  assert.ok(load && plain && box && get);
  assert.equal(load.endLine, 3);
  assert.equal(plain.endLine, 7);
  assert.equal(box.endLine, 13);
  assert.equal(get.parentId, box.id);
  assert.equal(get.endLine, 12);
});

test("generic parser handles Rust-style declarations", () => {
  const source = `struct Point {\n    x: i32,\n}\n\nimpl Point {\n    fn norm(&self) -> i32 {\n        self.x\n    }\n}\n\nfn main() {\n    let p = Point { x: 1 };\n}\n`;
  const parsed = parseScopes(source, "point.rs");
  assert.equal(parsed.language, "rust");
  assert.ok(parsed.flat.some((node) => node.name === "Point" && node.kind === "class"));
  assert.ok(parsed.flat.some((node) => node.name === "main" && node.kind === "function"));
});

test("parseScopes handles empty and tiny files without throwing", () => {
  for (const [source, name] of [
    ["", "empty.py"],
    ["\n", "blank.py"],
    ["const x = 1;\n", "tiny.js"],
  ]) {
    const parsed = parseScopes(source, name);
    assert.equal(parsed.flat[0].kind, "module");
    assert.equal(parsed.module.id, "scope-0");
    assert.equal(typeof parsed.lineCount, "number");
    assert.deepEqual(flatten(parsed), parsed.flat);
    assert.equal(scopeAtLine(parsed, 1)?.kind, "module");
  }
});

test("the real demo processor has one class and three functions", (t) => {
  const demo = copyDemo();
  t.after(() => demo.cleanup());
  const source = readFileSync(`${demo.workspace}/src/processor.py`, "utf8");
  const parsed = parseScopes(source, "src/processor.py");
  const stats = scopeStats(parsed);
  assert.equal(stats.classes, 1);
  assert.equal(stats.functions, 3);
  assert.equal(stats.count, 4);
  assert.equal(
    chainAtLine(parsed, 20)
      .map((node) => node.name)
      .join(" > "),
    "processor.py > DataProcessor > process_bounds",
  );
});

test("formatScopeChain caps width and drops the filename before the path", () => {
  const chain = [
    { label: "a_very_long_file_name.py" },
    { label: "class DataProcessor" },
    { label: "def process_bounds(self, bounds)" },
  ];
  const short = formatScopeChain(chain, { maxWidth: 45 });
  assert.ok(short.length <= 45);
  assert.ok(short.includes("Processor"));
  assert.ok(!short.includes("a_very_long_file_name.py"));
  assert.equal(formatScopeChain([], {}), "");
});

function pythonFlatSource(count) {
  const lines = [];
  for (let i = 0; i < count; i++)
    lines.push(`def flat_${i}(value):`, `    return value + ${i}`, "");
  return lines.join("\n");
}

function pythonNestedSource(count) {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(`${" ".repeat(i * 4)}def nested_${i}():`);
  lines.push(`${" ".repeat(count * 4)}return ${count}`);
  return lines.join("\n");
}

function javascriptNestedSource(count) {
  const lines = [];
  for (let i = 0; i < count; i++) lines.push(`function nested_${i}() {`);
  lines.push(`return ${count};`);
  for (let i = 0; i < count; i++) lines.push("}");
  return lines.join("\n");
}

function javascriptFlatSource(count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(`function flat_${i}(value) {`, `  return value + ${i};`, "}", "");
  }
  return lines.join("\n");
}

function javascriptAdversarialSource(count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      `// function fake_${i}() { ( [ ] )`,
      `const text_${i} = "function fake() { ( [ ] ) }";`,
      `const pattern_${i} = /[{}()]+/g;`,
      `function real_${i}(value = /[{}()]/) {`,
      "  return value;",
      "}",
      "",
    );
  }
  return lines.join("\n");
}

test("Python flat and deeply nested boundaries remain exact", () => {
  const flatSource = Array.from(
    { length: 250 },
    (_, i) => `def flat_${i}():\n    return ${i}\n`,
  ).join("\n");
  const flat = parseScopes(flatSource, "flat.py");
  const flatFunctions = flat.flat.filter((node) => node.kind === "function");
  assert.equal(flatFunctions.length, 250);
  for (let i = 0; i < flatFunctions.length; i++) {
    assert.equal(flatFunctions[i].parentId, flat.module.id);
    assert.equal(flatFunctions[i].startLine, i * 3 + 1);
    assert.equal(flatFunctions[i].endLine, i * 3 + 2);
  }

  const count = 350;
  const nested = parseScopes(pythonNestedSource(count), "nested.py");
  const functions = nested.flat.filter((node) => node.kind === "function");
  assert.equal(functions.length, count);
  assert.equal(scopeStats(nested).maxDepth, count);
  for (let i = 0; i < functions.length; i++) {
    assert.equal(functions[i].name, `nested_${i}`);
    assert.equal(functions[i].startLine, i + 1);
    assert.equal(functions[i].endLine, count + 1);
    assert.equal(functions[i].parentId, i === 0 ? nested.module.id : functions[i - 1].id);
  }
  assert.equal(chainAtLine(nested, count + 1).length, count + 1);
});

test("JavaScript delimiter matching and scope IDs survive 6000 nested declarations", () => {
  const count = 6000;
  const parsed = parseScopes(javascriptNestedSource(count), "deep.js");
  const functions = parsed.flat.filter((node) => node.kind === "function");
  assert.equal(functions.length, count);
  assert.equal(scopeStats(parsed).maxDepth, count);
  assert.equal(functions[0].endLine, count * 2 + 1);
  assert.equal(functions[count - 1].endLine, count + 2);
  assert.equal(functions[0].parentId, parsed.module.id);
  for (let i = 1; i < functions.length; i++) {
    assert.equal(functions[i].parentId, functions[i - 1].id);
  }
  const chain = chainAtLine(parsed, count + 1);
  assert.equal(chain.length, count + 1);
  assert.equal(chain[0], parsed.module);
  assert.equal(chain[count], functions[count - 1]);
});

test("adversarial masked delimiters preserve JS arrows, fields and methods", () => {
  const source = `const pattern = /[{}()]+/g;
const text = "function fake() { ( [ ] ) }";
function outer(value = /[{}()]/) {
  const arrow = async (item = /[{}()]/) => {
    return item;
  };
  return arrow(value);
}
class Box {
  field = (item) => {
    return item;
  };
  method(item = "()") {
    return item;
  }
}
`;
  const parsed = parseScopes(source, "adversarial.js");
  const byName = new Map(parsed.flat.map((node) => [node.name, node]));
  for (const name of ["outer", "arrow", "Box", "field", "method"])
    assert.ok(byName.has(name), name);
  assert.equal(byName.get("arrow").parentId, byName.get("outer").id);
  assert.equal(byName.get("field").parentId, byName.get("Box").id);
  assert.equal(byName.get("method").parentId, byName.get("Box").id);
  assert.equal(byName.get("outer").endLine, 8);
  assert.equal(byName.get("arrow").endLine, 6);

  const many = parseScopes(javascriptAdversarialSource(500), "many.js");
  assert.equal(many.flat.filter((node) => node.kind === "function").length, 500);
  assert.equal(
    many.flat.some((node) => node.name.startsWith("fake")),
    false,
  );
});

test("partial scope input is labelled and ancestor lookup is cycle-safe", () => {
  const partial = parseScopes("function visible() {\n", "partial.js", { truncated: true });
  assert.equal(partial.truncated, true);
  assert.equal(partial.partial, true);

  const parsed = parseScopes(javascriptNestedSource(3), "cycle.js");
  const functions = parsed.flat.filter((node) => node.kind === "function");
  const originalParent = functions[2].parentId;
  functions[2].parentId = "missing-scope";
  assert.deepEqual(
    chainAtLine(parsed, 4).map((node) => node.name),
    ["nested_2"],
  );

  functions[2].parentId = originalParent;
  functions[1].parentId = functions[2].id;
  const cycle = chainAtLine(parsed, 4);
  assert.ok(cycle.length <= 2);
  assert.equal(new Set(cycle).size, cycle.length);
});

test("scope scaling benchmark uses deterministic flat, nested and adversarial corpora", (t) => {
  const cases = [
    ["python-flat-1000", pythonFlatSource(1000), "flat.py", null],
    ["python-nested-1000", pythonNestedSource(1000), "nested.py", 1001],
    ["javascript-flat-1000", javascriptFlatSource(1000), "flat.js", null],
    ["javascript-nested-4000", javascriptNestedSource(4000), "nested.js", 4001],
    ["javascript-adversarial-1000", javascriptAdversarialSource(1000), "adversarial.js", null],
  ];

  for (const [name, source, file, chainLine] of cases) {
    parseScopes(source, file); // warmup
    const samples = [];
    let parsed;
    for (let iteration = 0; iteration < 3; iteration++) {
      const started = performance.now();
      parsed = parseScopes(source, file);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    if (chainLine !== null)
      assert.equal(chainAtLine(parsed, chainLine).length, Number(name.match(/(\d+)$/)[1]) + 1);
    t.diagnostic(
      `${name}: ${samples[1].toFixed(3)} ms median; ${Buffer.byteLength(source)} bytes; ${parsed.flat.length} scopes`,
    );
  }
});
