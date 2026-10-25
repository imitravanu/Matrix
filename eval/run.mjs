#!/usr/bin/env node

import {
  compareReportToBaseline,
  createBaselineFromReport,
  loadBaseline,
  saveBaseline,
} from "./baseline.mjs";
import { formatEvalText, sanitizeReport, sanitizeValue, writeReports } from "./report.mjs";
import { runEvaluation } from "./runner.mjs";

function usage() {
  return `Usage: node eval/run.mjs [--stress] [--json]
       node eval/run.mjs [--stress] --update-baseline --reviewed-by <identity>

The default is serial, network-free, and compared with the reviewed baseline.
Stress is a separate opt-in profile. Baseline updates are manual and refused in CI.
`;
}

function parseArgs(argv) {
  const options = { profile: "default", json: false, updateBaseline: false, reviewedBy: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--stress") options.profile = "stress";
    else if (argument === "--json") options.json = true;
    else if (argument === "--update-baseline") options.updateBaseline = true;
    else if (argument === "--reviewed-by") {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new Error("--reviewed-by requires an identity");
      }
      options.reviewedBy = argv[index];
    } else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown eval argument: ${argument}`);
  }
  if (options.reviewedBy && !options.updateBaseline) {
    throw new Error("--reviewed-by is valid only with --update-baseline");
  }
  if (options.updateBaseline && !options.reviewedBy) {
    throw new Error("--update-baseline requires --reviewed-by");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.updateBaseline && process.env.CI && process.env.CI !== "false") {
    throw new Error("baseline updates are forbidden in CI");
  }

  let report = sanitizeReport(await runEvaluation({ profile: options.profile }));
  if (options.updateBaseline) {
    const baseline = createBaselineFromReport(report, {
      reviewedBy: options.reviewedBy,
      command: `node eval/run.mjs${options.profile === "stress" ? " --stress" : ""} --update-baseline`,
    });
    await saveBaseline(options.profile, baseline);
  } else {
    const comparison = compareReportToBaseline(report, loadBaseline(options.profile));
    report.baselineComparison = sanitizeValue(comparison);
    report.ok = report.ok && comparison.ok;
  }
  const written = await writeReports(options.profile, report);
  report = written.report;
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : formatEvalText(report),
  );
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`EVAL ERROR: ${sanitizeValue(error.message)}\n${usage()}`);
  process.exitCode = 1;
});
