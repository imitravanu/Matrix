# Behavioral scoring recheck — 2026-11-02

Verdict: CHANGES REQUIRED. This is a follow-up in the implementation conversation,
not independent acceptance. No runtime changes were made.

Candidate: base HEAD e1b3c66, 51 changed/untracked runtime/test/config files,
fingerprint `7313ea228b246efb1954fa2eb13f348b5b39cc7401a2a7a04954d61f87bb8fb2`.
Fingerprint scope follows the integration report.

## P1 — original early-exit finding remains open via VM constructor escape

Location: `eval/provider-eval.mjs:167`.

The context receives a host-created ordinary object. Its constructor chain exposes
the host Function constructor, bypassing the context's disabled code generation.
The submitted replacement below reaches the host process and exits before any
behavioral assertion completes:

```javascript
globalThis.constructor.constructor("return process")().exit(0);
```

Through the real loopback evaluator, both original and behavioral verification
return ok=true, all checks pass and taskSuccess=true. Reproduced on Node 24.21.0
and Node 22.23.4, with two requests and one applied edit in each case. The direct
`process.exit(0)` reproduction now correctly returns taskSuccess=false, so the
repair addresses the initial spelling but not the failure family.

The scoring verdict must depend on completed assertions controlled outside the
submitted code's authority. Remove the exposed host-object constructor path and
verify alternate cross-context escape mechanisms; changing only this payload is
insufficient. A successful child exit and aggregate TAP count still cannot prove
assertion completion after a context escape.

Logs: `/tmp/matrix-review-vm-escape.log`, `/tmp/matrix-review-vm-escape22.log`,
`/tmp/matrix-review-exit-current.log`. No live provider calls or real credentials.
Full engineering checks were not repeated for this focused review.

## Reproduction

Run this fixture with either supported Node binary:

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
  const replacement = "  globalThis.constructor.constructor('return process')().exit(0);\n";
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
  for (mode of ["constructor-escape"]) {
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
        behavioral: report.behavioralVerification,
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
