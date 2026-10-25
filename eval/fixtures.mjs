import { chmodSync, linkSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { detectProject } from "../lib/project.mjs";

function verificationPrelude() {
  return `import { readFileSync } from "node:fs";
let failures = 0;
function check(condition, message) {
  if (!condition) throw new Error(message);
}
try {
`;
}

function verificationFooter(noiseLines = 0) {
  return `} catch (error) {
  failures += 1;
  console.error(error.message);
}
for (let index = 0; index < ${noiseLines}; index += 1) {
  process.stdout.write(\`noise \${String(index).padStart(4, "0")} λ🙂\\n\`);
}
console.log("# tests 1");
console.log(\`# pass \${failures === 0 ? 1 : 0}\`);
console.log(\`# fail \${failures}\`);
console.log("# duration_ms 1");
process.exitCode = failures === 0 ? 0 : 1;
`;
}

export function verificationSource({ kind, noiseLines = 0 }) {
  let body;
  if (kind === "fix") {
    body = `  const source = readFileSync("src/bounds.js", "utf8");
  check(source.includes("bounds.length)"), "bounds fix is missing");
  check(!source.includes("bounds.length - 1"), "buggy bound remains");
  const { selectBounds } = await import("./src/bounds.js");
  check(JSON.stringify(selectBounds([1, 2, 3])) === "[1,2,3]", "last element is still dropped");
`;
  } else if (kind === "rename") {
    body = `  const renamed = await import("./src/rename.js");
  const other = await import("./src/other.js");
  check(typeof renamed.windowContext === "function", "limited rename did not land");
  check(renamed.context === undefined, "old target export remains");
  check(renamed.contextSuffix([1, 2]).length === 2, "identifier suffix was damaged");
  check(renamed.useContext([1, 2]).length === 2, "internal rename reference is broken");
  check(typeof other.context === "function", "rename escaped its target file");
`;
  } else if (kind === "create") {
    body = `  const expected = "export const answer = 42;\\n";
  check(readFileSync("src/generated.js", "utf8") === expected, "created bytes differ");
  const { answer } = await import("./src/generated.js");
  check(answer === 42, "created module does not execute");
`;
  } else {
    throw new Error(`unknown eval verification fixture: ${kind}`);
  }
  return `${verificationPrelude()}${body}${verificationFooter(noiseLines)}`;
}

function writeEntry(workspace, rel, entry) {
  const path = join(workspace, rel);
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  const content = entry.bytes ? Buffer.from(entry.bytes) : Buffer.from(entry.text ?? "", "utf8");
  writeFileSync(path, content, { mode: entry.mode ?? 0o640 });
  chmodSync(path, entry.mode ?? 0o640);
}

function normalizeDirectoryModes(directory) {
  chmodSync(directory, 0o750);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) normalizeDirectoryModes(join(directory, entry.name));
  }
}

export function createFixtureWorkspace(workspace, definition) {
  mkdirSync(workspace, { recursive: true, mode: 0o750 });
  for (const [rel, entry] of Object.entries(definition.fixture.files ?? {})) {
    if (entry.symlink !== undefined) {
      const path = join(workspace, rel);
      mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
      // The fixture definitions are static, reviewed relative symlinks.
      symlinkSync(entry.symlink, path);
    } else {
      writeEntry(workspace, rel, entry);
    }
  }

  if (definition.fixture.verification) {
    writeEntry(workspace, "verify.mjs", {
      text: verificationSource(definition.fixture.verification),
      mode: 0o750,
    });
  }

  if (definition.fixture.large) {
    const shape = definition.fixture.large;
    const directory = join(workspace, "tree");
    mkdirSync(directory, { recursive: true, mode: 0o750 });
    const source = "export function ordinaryFixture(value) { return value + 1; }\n";
    const seed = join(directory, "file-00000.js");
    writeFileSync(seed, source, { mode: 0o640 });
    chmodSync(seed, 0o640);
    for (let index = 1; index < shape.files; index += 1) {
      const path = join(directory, `file-${String(index).padStart(5, "0")}.js`);
      try {
        linkSync(seed, path);
      } catch {
        writeFileSync(path, source, { mode: 0o640 });
        chmodSync(path, 0o640);
      }
    }
  }
  normalizeDirectoryModes(workspace);
}

export function projectForFixture(workspace, definition) {
  const test = definition.fixture.verification
    ? {
        file: process.execPath,
        args: ["verify.mjs"],
        cwd: workspace,
        display: "node verify.mjs",
        framework: "node --test",
      }
    : null;
  const large = definition.fixture.large ?? {};
  return detectProject(workspace, {
    maxFiles: large.maxFiles ?? 2500,
    maxEntries: large.maxEntries ?? 50_000,
    maxDirectories: large.maxDirectories ?? 5000,
    maxDepth: 10,
    test,
    exec: () => {
      throw new Error("eval git execution disabled");
    },
  });
}
