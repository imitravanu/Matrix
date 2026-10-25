import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packAllowlist = [
  "bin/",
  "lib/",
  "src/",
  "demo-project/",
  "README.md",
  "MATRIX.md",
  "LICENSE",
  "CHANGELOG.md",
];
const requiredFiles = ["package.json", "README.md", "MATRIX.md", "LICENSE", "CHANGELOG.md"];
const sourceDirectories = [
  ["bin", ".mjs"],
  ["lib", ".mjs"],
  ["src", ".mjs"],
  ["demo-project", ".py"],
];

function sourceFiles(directory, extension) {
  const files = [];

  function visit(absoluteDirectory) {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(relative(root, absolutePath).split("\\").join("/"));
      }
    }
  }

  visit(join(root, directory));
  return files;
}

function onePackResult(report) {
  let results;
  if (Array.isArray(report)) results = report;
  else if (report && typeof report === "object" && Array.isArray(report.files)) results = [report];
  else if (report && typeof report === "object") results = Object.values(report);
  else throw new Error("npm pack returned an invalid JSON report");

  if (results.length !== 1 || !results[0] || !Array.isArray(results[0].files)) {
    throw new Error("npm pack must return exactly one package with a file list");
  }
  return results[0];
}

function assertPackPosture(manifest) {
  if (manifest.private !== true) throw new Error("Matrix must remain private/internal");
  if (manifest.main !== "src/matrix.mjs") throw new Error("The compatibility main entry changed");
  if (manifest.bin?.matrix !== "./bin/matrix.mjs")
    throw new Error("The matrix CLI bin entry changed");
  if (JSON.stringify(manifest.files) !== JSON.stringify(packAllowlist)) {
    throw new Error("package.json#files differs from the reviewed pack allowlist");
  }
  for (const dependency of ["ink", "react"]) {
    if (!manifest.dependencies?.[dependency]) {
      throw new Error(`${dependency} must remain a production dependency`);
    }
  }
}

function assertPackContents(result, manifest) {
  if (result.name !== manifest.name || result.version !== manifest.version) {
    throw new Error("npm pack identity does not match package.json");
  }

  const actualPaths = result.files.map((file) => file.path);
  if (new Set(actualPaths).size !== actualPaths.length) {
    throw new Error("npm pack returned duplicate file paths");
  }
  const actual = new Set(actualPaths);
  const expected = new Set([
    ...requiredFiles,
    ...sourceDirectories.flatMap(([directory, extension]) => sourceFiles(directory, extension)),
  ]);
  const missing = [...expected].filter((path) => !actual.has(path)).sort();
  const unexpected = [...actual].filter((path) => !expected.has(path)).sort();
  if (missing.length || unexpected.length) {
    throw new Error(
      `Pack contents mismatch; missing: ${JSON.stringify(missing)}; ` +
        `unexpected: ${JSON.stringify(unexpected)}`,
    );
  }
  if (result.entryCount !== actual.size) throw new Error("npm pack entryCount is inconsistent");

  const filesByPath = new Map(result.files.map((file) => [file.path, file]));
  for (const path of [manifest.main, manifest.bin.matrix.replace(/^\.\//, "")]) {
    if (!filesByPath.has(path)) throw new Error(`Required entry point is missing: ${path}`);
  }
  const bin = filesByPath.get("bin/matrix.mjs");
  if ((bin.mode & 0o111) === 0) throw new Error("The matrix CLI bin is not executable");
}

const destination = mkdtempSync(join(tmpdir(), "matrix-pack-check-"));
try {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assertPackPosture(manifest);

  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", "--pack-destination", destination],
    { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (packed.error) throw packed.error;
  if (packed.status !== 0) {
    throw new Error(
      `npm pack --dry-run failed (${packed.signal ?? `exit ${packed.status}`})\n` +
        `${packed.stderr}${packed.stdout}`,
    );
  }

  let report;
  try {
    report = JSON.parse(packed.stdout);
  } catch (error) {
    throw new Error(`Could not parse npm pack JSON: ${error.message}\n${packed.stdout}`, {
      cause: error,
    });
  }
  const result = onePackResult(report);
  assertPackContents(result, manifest);
  if (readdirSync(destination).length !== 0) {
    throw new Error("npm pack --dry-run unexpectedly created a file");
  }

  console.log(
    `Pack check passed for ${result.name}@${result.version}: ${result.entryCount} files, ` +
      `${result.size} bytes packed (dry-run), ${result.unpackedSize} bytes unpacked.`,
  );
  console.log("Private/main/bin posture verified; no tarball created and nothing published.");
} catch (error) {
  console.error(`Pack inspection failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(destination, { recursive: true, force: true });
}
