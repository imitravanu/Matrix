import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceDirectories = ["bin", "bench", "eval", "lib", "src", "scripts", "test"];

function modulesIn(directory) {
  const modules = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) modules.push(...modulesIn(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) modules.push(path);
  }
  return modules;
}

const modules = [
  ...sourceDirectories.flatMap((directory) => modulesIn(resolve(root, directory))),
  resolve(root, "eslint.config.mjs"),
].sort();
let failed = 0;

for (const modulePath of modules) {
  const result = spawnSync(process.execPath, ["--check", modulePath], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0 && !result.error) continue;
  failed += 1;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`${modulePath}: ${result.error.message}`);
}

if (failed > 0) {
  console.error(`Syntax check failed for ${failed} of ${modules.length} modules.`);
  process.exitCode = 1;
} else {
  console.log(`Syntax checked ${modules.length} .mjs modules with ${process.version}.`);
}
