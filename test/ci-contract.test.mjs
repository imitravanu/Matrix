import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("hosted CI uses valid isolated job environments and every release gate", () => {
  const jobEnvironment = workflow.slice(
    workflow.indexOf("    env:"),
    workflow.indexOf("    steps:"),
  );
  assert.ok(jobEnvironment.length > 0, "the job-level environment must exist");
  assert.doesNotMatch(
    jobEnvironment,
    /\$\{\{\s*runner\./,
    "runner context is unavailable in jobs.<job_id>.env on GitHub Actions",
  );
  assert.match(jobEnvironment, /HOME: \/tmp\/matrix-ci-home/);
  assert.match(jobEnvironment, /MATRIX_HOME: \/tmp\/matrix-ci-home\/\.matrix/);

  for (const command of [
    "npm ci",
    "npm run check",
    "npm run pack:check",
    "npm audit",
    "npm test",
    "npm run smoke",
    "node bin/matrix.mjs bench --iterations 1",
  ]) {
    assert.ok(workflow.includes(command), `missing hosted gate: ${command}`);
  }
  for (const version of ['"22"', '"24"']) assert.ok(workflow.includes(version));
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
});
