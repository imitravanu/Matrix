import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export const COVERAGE_THRESHOLDS = Object.freeze({
  "lib/controller.mjs": { line: 90, branch: 70, functions: 90 },
  "lib/diff.mjs": { line: 95, branch: 85, functions: 90 },
  "lib/local-agent.mjs": { line: 95, branch: 80, functions: 95 },
  "lib/model-agent.mjs": { line: 90, branch: 75, functions: 95 },
  "lib/openrouter.mjs": { line: 90, branch: 82, functions: 95 },
  "lib/outcome.mjs": { line: 95, branch: 90, functions: 100 },
  "lib/process.mjs": { line: 90, branch: 85, functions: 90 },
  "lib/project.mjs": { line: 90, branch: 75, functions: 95 },
  "lib/session.mjs": { line: 90, branch: 78, functions: 95 },
  "lib/workspace.mjs": { line: 95, branch: 90, functions: 100 },
  "src/event-reducer.mjs": { line: 90, branch: 85, functions: 100 },
  "src/result-projection.mjs": { line: 100, branch: 60, functions: 100 },
});

const testArguments = [
  "--experimental-test-coverage",
  "--test-coverage-include=lib/*.mjs",
  "--test-coverage-include=src/*.mjs",
  "--test-coverage-include=src/screens/*.mjs",
  "--test-coverage-include=bin/*.mjs",
  "--test",
  "test/*.test.mjs",
];

function reportContent(line) {
  // Node may color its reporter; strip CSI bytes before parsing the table.
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r$/, "");
  const prefixed = /^\s*(?:ℹ\uFE0F?|#)\s?(.*)$/.exec(clean);
  return prefixed ? prefixed[1] : clean;
}

function metric(value, path, name) {
  const text = value.trim();
  if (!/^(?:\d{1,2}(?:\.\d+)?|100(?:\.0+)?)$/.test(text)) {
    throw new Error(`Malformed ${name} coverage for ${path}: ${JSON.stringify(text)}`);
  }
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`Invalid ${name} coverage for ${path}: ${JSON.stringify(text)}`);
  }
  return number;
}

function metrics(cells, path) {
  return {
    line: metric(cells[1], path, "line"),
    branch: metric(cells[2], path, "branch"),
    functions: metric(cells[3], path, "functions"),
  };
}

/** Parse Node 22/24's built-in text coverage table, rejecting partial reports. */
export function parseCoverageReport(output) {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("Coverage report is missing or empty");
  }

  const reportLines = [];
  let started = false;
  let ended = false;
  for (const rawLine of output.split("\n")) {
    const line = reportContent(rawLine);
    const marker = line.trim();
    if (marker === "start of coverage report") {
      if (started) throw new Error("Coverage report has multiple start markers");
      started = true;
      continue;
    }
    if (marker === "end of coverage report") {
      if (!started || ended) throw new Error("Coverage report has an unexpected end marker");
      ended = true;
      continue;
    }
    if (started && !ended) reportLines.push(line);
    else if (ended && marker === "start of coverage report") {
      throw new Error("Coverage report has multiple reports");
    }
  }
  if (!started || !ended) throw new Error("Coverage report is incomplete");

  const files = new Map();
  const directories = [];
  let summary = null;
  let sawHeader = false;

  for (const line of reportLines) {
    if (!line.trim() || /^[\s-]+$/.test(line)) continue;
    const cells = line.split("|");
    if (cells.length < 4) throw new Error(`Malformed coverage row: ${JSON.stringify(line)}`);
    const label = cells[0].trim();

    if (label === "file") {
      if (sawHeader) throw new Error("Coverage report has multiple headers");
      const headings = cells.slice(1, 4).map((cell) => cell.trim());
      if (
        headings[0] !== "line %" ||
        headings[1] !== "branch %" ||
        !["funcs %", "functions %"].includes(headings[2])
      ) {
        throw new Error(`Unsupported coverage headings: ${headings.join(", ")}`);
      }
      sawHeader = true;
      continue;
    }
    if (!sawHeader) throw new Error(`Coverage row precedes its header: ${JSON.stringify(line)}`);
    if (!label || label.includes("\0")) throw new Error("Coverage row has an invalid file name");

    const indent = cells[0].length - cells[0].trimStart().length;
    while (directories.at(-1)?.indent >= indent) directories.pop();
    const parent = directories.at(-1);
    const path = parent ? `${parent.path}/${label}` : label;

    if (cells.slice(1, 4).every((cell) => !cell.trim())) {
      if (label === "all files") throw new Error("Coverage summary has no metrics");
      directories.push({ indent, path });
      continue;
    }

    const parsed = metrics(cells, path);
    if (label === "all files") {
      if (summary) throw new Error("Coverage report has multiple summaries");
      summary = parsed;
      continue;
    }
    if (files.has(path)) throw new Error(`Coverage report repeats ${path}`);
    files.set(path, parsed);
  }

  if (!sawHeader || !summary || files.size === 0) {
    throw new Error("Coverage report is missing its header, summary, or file rows");
  }
  return { files, summary };
}

export function evaluateCoverage(report, thresholds = COVERAGE_THRESHOLDS) {
  const failures = [];
  const rows = [];
  for (const [path, floor] of Object.entries(thresholds)) {
    const actual = report.files.get(path);
    if (!actual) {
      failures.push(`${path}: missing from coverage report`);
      rows.push({ path, actual: null, floor });
      continue;
    }
    rows.push({ path, actual, floor });
    for (const name of ["line", "branch", "functions"]) {
      if (actual[name] < floor[name]) {
        failures.push(
          `${path}: ${name} ${actual[name].toFixed(2)}% is below ${floor[name].toFixed(2)}%`,
        );
      }
    }
  }
  return { failures, rows };
}

export async function runCoverage({
  spawnImpl = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const child = spawnImpl(process.execPath, testArguments, {
    cwd: root,
    stdio: ["inherit", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    stdout.write(chunk);
  });

  const completion = await new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ code: 1, error }));
    child.once("close", (code, signal) => resolvePromise({ code, signal, error: null }));
  });
  if (completion.error) {
    stderr.write(`Could not run coverage tests: ${completion.error.message}\n`);
    return 1;
  }
  if (completion.code !== 0) {
    stderr.write(
      `Coverage tests failed (${completion.signal ?? `exit ${completion.code}`}); thresholds were not evaluated.\n`,
    );
    return completion.code || 1;
  }

  try {
    const report = parseCoverageReport(output);
    const { failures, rows } = evaluateCoverage(report);
    for (const { path, actual, floor } of rows) {
      if (!actual) {
        stderr.write(`✗ ${path}: missing\n`);
        continue;
      }
      const mark = failures.some((failure) => failure.startsWith(`${path}:`)) ? "✗" : "✓";
      stdout.write(
        `${mark} ${path}: ${actual.line.toFixed(2)}/${actual.branch.toFixed(2)}/${actual.functions.toFixed(2)} ` +
          `(floor ${floor.line}/${floor.branch}/${floor.functions})\n`,
      );
    }
    stdout.write(
      `Coverage summary: ${report.summary.line.toFixed(2)}% lines / ` +
        `${report.summary.branch.toFixed(2)}% branches / ${report.summary.functions.toFixed(2)}% functions\n`,
    );
    if (failures.length > 0) {
      for (const failure of failures) stderr.write(`Coverage ratchet: ${failure}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    stderr.write(`Coverage report rejected: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCoverage();
}
