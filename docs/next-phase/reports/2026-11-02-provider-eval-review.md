# Provider evaluation review — 2026-11-02

Verdict: **CHANGES REQUIRED**. This is a follow-up review in the ongoing
implementation conversation, not the independent PRV-106 acceptance audit.
No runtime code was edited. Three new counterexamples used a recording loopback
server, temporary homes/workspaces and a fake credential; no live provider ran.

Candidate: HEAD `e1b3c66`, with 51 changed/untracked runtime/test/config files,
fingerprint `4d86da977a7eb9988abfcee448455b75220bafe71f4014a818a41e2e0b12e463`.
Fingerprint procedure matches the integration evidence report. Runtime: Node 24.21.0.

## R1 — P1: first verification exposes a custom provider credential

Location: `eval/provider-eval.mjs:365-372`, controller invocation, and
`lib/model-agent.mjs:1012-1016`, ordinary test execution.

The authoritative second verification uses an allowlisted environment, but the
controller's first verification inherits the ambient environment and only filters
credential-like variable names. Provider configuration accepts arbitrary valid env
names. With auth bound to `MATRIX_REVIEW_VALUE`, model-written source read the fake
credential and wrote it to a temporary marker during the first test run. The second
verification saw null. Output redaction cannot undo code reading the credential.

Expected: both verification paths use an isolated environment that excludes provider
credentials regardless of variable naming. Actual marker: first entry contains
`fake-review-canary-123`, second entry contains null. The README's claim that
model-written source cannot read ambient provider credentials is therefore false.
Pass a dedicated allowlisted test environment through the controller, preserving
the separately bound provider credential for HTTP only. Also test the ordinary
custom-provider test path, not just authoritative verification.

## R2 — P2: evaluation cancellation does not cancel the controller

Location: `eval/provider-eval.mjs:364-382`.

Passing an already-aborted signal to `runProviderEvaluation` still sent two HTTP
requests and applied one edit. The signal is used only for final authoritative
verification. Mid-run cancellation likewise has no connection to the controller.
Check cancellation before network work and wire it to controller abort and cleanup;
verify that no further request, edit approval or test starts after cancellation.

## R3 — P2: exact source comparison rejects correct solutions

Location: `eval/provider-eval.mjs:429`.

The fake provider replaced the buggy return with `return items.slice();`. Both the
agent's test and the original authoritative fixture passed. Scope, test-file and
package integrity passed, but `checks.edit` failed and `taskSuccess` was false
because the solution differed from the hard-coded reference string. The task asks
for correct behavior, not that spelling. Use behavioral verification plus scope
and integrity checks, or explicitly identify the metric as exact-reference matching.
An alternate correctly formatted equivalent solution should also be accepted.

## Reproduction

Run the following as an `.mjs` file with Node 24 from this machine. It prints one
record per case and removes all temporary workspaces. The observed output is also
in `/tmp/matrix-review-repro.log`. Full engineering checks were not repeated during
this read-only runtime review; the earlier 741-test results did not cover these
counterexamples. This review does not complete the full PV-01–PV-24 matrix.

```javascript
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProviderProfile } from "/home/mitravanu/matrix/lib/provider-config.mjs";
import { runProviderEvaluation } from "/home/mitravanu/matrix/eval/provider-eval.mjs";
const root = mkdtempSync(join(tmpdir(), "matrix-review-"));
const marker = join(root, "observed.jsonl");
const saved = process.env.MATRIX_REVIEW_VALUE;
process.env.MATRIX_REVIEW_VALUE = "fake-review-canary-123";
let mode,
  requests = 0;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  requests++;
  const body = JSON.parse(raw);
  const follow = body.messages.some((m) => m.role === "tool");
  const replacement =
    mode === "credential"
      ? `  process.getBuiltinModule('fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify({canary:process.env.MATRIX_REVIEW_VALUE ?? null})+'\\n'); return items.slice(0, items.length);\n`
      : "  return items.slice();\n";
  const delta = follow
    ? { content: "Fixed." }
    : {
        tool_calls: [
          {
            index: 0,
            id: "review_edit",
            type: "function",
            function: {
              name: "propose_edit",
              arguments: JSON.stringify({
                path: "src/bounds.js",
                start_line: 2,
                end_line: 3,
                replacement,
                rationale: "keep all elements",
              }),
            },
          },
        ],
      };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: follow ? "stop" : "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
try {
  const home = join(root, "home");
  await addProviderProfile(
    {
      id: "lab",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      auth: { type: "bearer", env: "MATRIX_REVIEW_VALUE" },
      models: [{ id: "review", capabilities: { tools: "supported" } }],
    },
    { home },
  );
  for (mode of ["cancel", "equivalent", "credential"]) {
    requests = 0;
    const ac = new AbortController();
    if (mode === "cancel") ac.abort();
    const report = await runProviderEvaluation({
      home,
      providerId: "lab",
      modelId: "review",
      signal: ac.signal,
      timeoutMs: 10000,
    });
    console.log(
      JSON.stringify({
        mode,
        requests,
        applied: report.applied,
        checks: report.checks,
        taskSuccess: report.taskSuccess,
        authoritative: report.authoritativeVerification,
        observed: mode === "credential" ? readFileSync(marker, "utf8") : null,
      }),
    );
  }
} finally {
  if (saved === undefined) delete process.env.MATRIX_REVIEW_VALUE;
  else process.env.MATRIX_REVIEW_VALUE = saved;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
}
```
