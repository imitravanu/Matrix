import test from "node:test";
import assert from "node:assert/strict";

import { createApprovalBroker } from "../lib/parallel-approvals.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("approval review payloads are isolated from callers and event observers", () => {
  const source = { planHash: "approved-hash", changes: [{ updatedText: "approved content" }] };
  const events = [];
  const broker = createApprovalBroker({
    batchId: "batch-review-snapshots",
    onEvent(event) {
      events.push(event);
      event.request.changes[0].updatedText = "observer replacement";
      event.request.planHash = "observer hash";
    },
  });
  const issued = broker.issue({ agentId: "integration", kind: "integration", request: source });
  source.changes[0].updatedText = "source replacement";
  issued.request.changes[0].updatedText = "issued replacement";
  const pending = broker.pending()[0];
  assert.equal(pending.request.changes[0].updatedText, "approved content");
  assert.equal(pending.request.planHash, "approved-hash");
  pending.request.changes[0].updatedText = "pending replacement";
  const result = broker.decide({ ...issued, decision: "y" });
  result.request.planHash = "result replacement";
  const inspected = broker.inspect(issued);
  assert.equal(inspected.request.changes[0].updatedText, "approved content");
  assert.equal(inspected.request.planHash, "approved-hash");
  assert.equal(events.length, 2);
  assert.equal(broker.consume(issued), true);
});

test("edit, test, command, and integration decisions remain independent one-shot authorities", async () => {
  const events = [];
  const broker = createApprovalBroker({
    batchId: "batch-authorities",
    onEvent: (event) => events.push(event),
  });
  const edit = broker.issue({ agentId: "agent-01", kind: "edit", request: { path: "a" } });
  const testTrust = broker.issue({ agentId: "agent-01", kind: "test", request: { planHash: "t" } });
  const command = broker.issue({
    agentId: "agent-01",
    kind: "command",
    request: { planHash: "c" },
  });
  const integration = broker.issue({
    agentId: "integration",
    kind: "integration",
    request: { planHash: "i" },
  });

  assert.equal(broker.pending().length, 4);
  assert.equal(
    broker.decide({ agentId: "agent-01", approvalId: edit.approvalId, kind: "test", decision: "y" })
      .ok,
    false,
  );
  assert.equal(broker.decide({ ...edit, decision: "y" }).ok, true);
  assert.equal(await broker.wait(edit), "y");
  assert.equal(broker.decide({ ...edit, decision: "n" }).ok, false, "resolved edit is stale");
  assert.equal(broker.pending().length, 3);

  broker.decide({ ...testTrust, decision: "once" });
  broker.decide({ ...command, decision: "y" });
  broker.decide({ ...integration, decision: "y" });
  assert.equal(await broker.wait(testTrust), "once");
  assert.equal(await broker.wait(command), "y");
  assert.equal(
    broker.consume({ agentId: "agent-01", approvalId: command.approvalId, kind: "test" }),
    false,
    "a command grant cannot be consumed as test authority",
  );
  assert.equal(broker.consume(command), true);
  assert.equal(broker.consume(command), false, "command grant cannot replay");
  assert.equal(broker.consume(integration), true);
  assert.equal(broker.consume(integration), false);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["edit", "test", "command", "integration", "edit", "test", "command", "integration"],
  );
});

test("one command or test decision is never multiplied into a sibling grant", async () => {
  const broker = createApprovalBroker({ batchId: "batch-siblings" });
  const first = broker.issue({
    agentId: "agent-01",
    kind: "command",
    request: { planHash: "same" },
  });
  const second = broker.issue({
    agentId: "agent-02",
    kind: "command",
    request: { planHash: "same" },
  });
  const firstTest = broker.issue({
    agentId: "agent-01",
    kind: "test",
    request: { planHash: "same" },
  });
  const secondTest = broker.issue({
    agentId: "agent-02",
    kind: "test",
    request: { planHash: "same" },
  });

  broker.decide({ ...first, decision: "y" });
  broker.decide({ ...firstTest, decision: "y" });
  assert.equal(await broker.wait(first), "y");
  assert.equal(await broker.wait(firstTest), "y");
  assert.equal(broker.inspect(second).status, "pending");
  assert.equal(broker.inspect(secondTest).status, "pending");
  assert.equal(broker.decide({ ...second, agentId: "agent-01", decision: "y" }).ok, false);
  assert.equal(broker.inspect(second).status, "pending");
});

test("abort denies every pending approval, rejects stale decisions, and closes new requests", async () => {
  const broker = createApprovalBroker({ batchId: "batch-approval-abort" });
  const waiting = broker.issue({ agentId: "agent-01", kind: "edit" });
  const executing = broker.issue({ agentId: "agent-02", kind: "test" });
  let waitingValue = null;
  let executingValue = null;
  void broker.wait(waiting).then((value) => {
    waitingValue = value;
  });
  void broker.wait(executing).then((value) => {
    executingValue = value;
  });

  assert.equal(broker.abort(), 2);
  await tick();
  assert.equal(waitingValue, "n");
  assert.equal(executingValue, "n");
  assert.equal(broker.inspect(waiting).status, "aborted");
  assert.equal(broker.decide({ ...waiting, decision: "y" }).ok, false);
  assert.throws(() => broker.issue({ agentId: "agent-03", kind: "command" }), /closed/);
});
