import test from "node:test";
import assert from "node:assert/strict";
import { formatParallelSummary } from "../lib/parallel-summary.mjs";

test("final handoff includes exact destination, recovery, status, and Git publication", () => {
  const output = formatParallelSummary({
    status: "unverified",
    result: {
      resultWorkspace: "/tmp/work space/it's here",
      intentPath: "/tmp/intent",
      recoverySessionId: "session-1",
      integrationStatus: "integrated",
      verificationStatus: "unverified",
      publicationStatus: "published",
      publication: { kind: "git", ref: "refs/heads/matrix/result", commit: "abc123" },
    },
  });
  for (const text of [
    "Result workspace:",
    "Integration intent:",
    "Recovery session:",
    "Published branch:",
    "Commit: abc123",
    "Verification: unverified",
    "Publication: published",
    "Final status: unverified",
  ])
    assert.ok(output.includes(text), text);
  assert.ok(
    output.includes("Resume: matrix -C '/tmp/work space/it'\\''s here' --session 'session-1'"),
  );
});

test("final handoff escapes displayed paths and never writes terminal control characters", () => {
  const output = formatParallelSummary({
    status: "failed",
    result: {
      resultWorkspace: "/tmp/\u001b[2J\npath",
      intentPath: "/tmp/\nintent",
      publicationStatus: "failed",
      publicationError: "bad\u001b[2J",
      recoverySessionId: "id",
    },
  });
  assert.equal(output.includes(String.fromCharCode(27)), false);
  assert.doesNotMatch(output, /Resume:/);
  assert.match(output, /Publication: failed/);
});
