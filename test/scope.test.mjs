import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
    ["widget.py", "Widget", "render"]
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
  for (const [source, name] of [["", "empty.py"], ["\n", "blank.py"], ["const x = 1;\n", "tiny.js"]]) {
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
  assert.equal(chainAtLine(parsed, 20).map((node) => node.name).join(" > "), "processor.py > DataProcessor > process_bounds");
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
