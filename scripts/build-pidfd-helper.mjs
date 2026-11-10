#!/usr/bin/env node
// Build the MATRIX_HOME-local pidfd helper used by the durable goal
// process-ownership boundary (lib/goal-policy.mjs). The helper is deliberately
// not shipped inside the package: the pack allowlist carries .mjs sources
// only, and a prebuilt blob cannot be audited. Operators build it once per
// machine with a C toolchain; until then durable goals fail closed and Doctor
// reports the capability as unavailable.
//
// Usage:
//   node scripts/build-pidfd-helper.mjs            # build into MATRIX_HOME/bin
//   node scripts/build-pidfd-helper.mjs --out DIR  # build into DIR
//   node scripts/build-pidfd-helper.mjs --check    # probe an existing helper
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE = join(PACKAGE_ROOT, "scripts", "matrix-pidfd-helper.c");

function matrixHome() {
  return process.env.MATRIX_HOME || join(homedir(), ".matrix");
}

function parseArguments(argv) {
  const options = { out: null, check: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      options.out = resolve(argv[++index] ?? "");
      if (!options.out) throw new Error("--out requires a directory");
    } else if (arg === "--check") {
      options.check = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

export function helperPath(home = matrixHome()) {
  return join(home, "bin", "matrix-pidfd-helper");
}

function ccCandidates() {
  return process.env.CC ? [process.env.CC] : ["cc", "gcc", "clang"];
}

function compile(target) {
  const sourceBytes = readFileSync(SOURCE);
  const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
  const candidates = ccCandidates();
  const attempts = [];
  for (const cc of candidates) {
    // Prefer a static binary; fall back to the toolchain default when static
    // libc is unavailable. Either way the helper is auditable from source.
    for (const flags of [["-static"], []]) {
      const args = [
        "-O2",
        "-s",
        "-std=c11",
        "-D_GNU_SOURCE",
        "-Wall",
        "-Wextra",
        "-Werror",
        ...flags,
        "-o",
        target,
        SOURCE,
      ];
      const result = spawnSync(cc, args, { encoding: "utf8" });
      attempts.push({ cc, static: flags.length > 0, status: result.status });
      if (result.status === 0) return { cc, static: flags.length > 0, sourceDigest, attempts };
      // A failed static attempt may leave a partial binary; remove it.
      try {
        rmSync(target, { force: true });
      } catch {
        // best effort
      }
    }
  }
  throw new Error(
    `no C compiler produced the helper (tried: ${attempts
      .map((attempt) => `${attempt.cc}${attempt.static ? " -static" : ""} -> ${attempt.status}`)
      .join(", ")})`,
  );
}

function probe(target) {
  const result = spawnSync(target, ["probe"], { encoding: "utf8", timeout: 5000 });
  if (result.error || result.status !== 0) {
    throw new Error(
      `built helper failed its own probe (exit ${result.status ?? "error"}): ${
        result.stderr || result.stdout || result.error?.message || "no output"
      }`,
    );
  }
  const parsed = JSON.parse(result.stdout.trim());
  if (parsed?.ok !== true || parsed?.pidfd !== true) {
    throw new Error("built helper reported pidfd unavailable; refusing to install it");
  }
  return parsed;
}

const options = parseArguments(process.argv);
const home = matrixHome();
const target = options.out ? join(options.out, "matrix-pidfd-helper") : helperPath(home);

if (options.check) {
  const parsed = probe(target);
  console.log(JSON.stringify({ path: target, ...parsed }));
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const built = compile(target);
chmodSync(target, 0o700);
const stat = statSync(target);
if (!stat.isFile()) throw new Error("built helper is not a regular file");
const parsed = probe(target);
console.log(
  JSON.stringify({
    path: target,
    cc: built.cc,
    static: built.static,
    sourceSha256: built.sourceDigest,
    bytes: stat.size,
    probe: parsed,
  }),
);
