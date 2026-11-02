# Evaluation repair recheck — 2026-11-02

Verdict: CHANGES REQUIRED. Follow-up review within the implementation conversation;
not independent PRV-106 acceptance. No runtime edits.

The 14 provider-evaluation tests pass on Node 24.21.0. The original equivalent-edit
and credential reproductions now pass: `items.slice()` scores success, and all eight
credential observations across both verifications are null. Cancellation's pre-abort
and active-request regressions also pass.

## P1: early process exit is accepted as a correct solution

Location: `eval/provider-eval.mjs:224-225` and `:444`.

A loopback provider replaces the buggy return in `keepLast` with `process.exit(0);`.
The original test never completes its first assertion. Nevertheless, Node's test
runner reports the child test file as passed, and the evaluator accepts its aggregate
count as authoritative verification. All checks, including edit and verification,
report pass; taskSuccess is true. No test file or package modification is necessary.
A second reproduction prints forged TAP before exiting and also passes.

Required behavior: score actual completed behavioral assertions, with the verdict
controlled outside model-written code's process. A successful child exit or parsed
stdout count cannot establish that assertions ran. Reject early exit and forged
output while continuing to accept equivalent valid implementations.

Reproduction below uses a temporary home and a recording loopback provider; no live
keys or calls. Output: `/tmp/matrix-review-exit.log`. Tests:
`node --test test/provider-eval.test.mjs` (14 pass, no skips). This is a focused review,
not a full engineering or adversarial acceptance run.

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
  const replacement = "  process.exit(0);\n";
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
  for (mode of ["early-exit"]) {
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
