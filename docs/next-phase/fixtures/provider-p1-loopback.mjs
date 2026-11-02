import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDemo, makeTempDir, waitFor } from "../../../test/helpers.mjs";
import { stripAnsi } from "../../../lib/text.mjs";
import { addProviderProfile } from "../../../lib/provider-config.mjs";
const binary = fileURLToPath(new URL("../../../bin/matrix.mjs", import.meta.url));
const task = "Fix the off-by-one in the bounds slice in src/processor.py";
const id = "Vendor/Model-X:Free";
const key = 'sk-p1+fake/"canary"';
const reqs = [];
const server = createServer((req, res) => {
  let data = "";
  req.on("data", (x) => (data += x));
  req.on("end", () => {
    const b = JSON.parse(data);
    reqs.push({ url: req.url, auth: req.headers.authorization, model: b.model });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const tool = b.messages.some((m) => m.role === "tool");
    const chunk = tool
      ? { choices: [{ delta: { content: "loopback workflow complete" }, finish_reason: "stop" }] }
      : {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_fix",
                    type: "function",
                    function: {
                      name: "propose_edit",
                      arguments: JSON.stringify({
                        path: "src/processor.py",
                        start_line: 20,
                        end_line: 21,
                        replacement: "        context = bounds[0:len(bounds)]\n",
                        rationale: "include last item",
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
    res.end("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const home = makeTempDir("matrix-p1-home-");
const deny = copyDemo("matrix-p1-deny-");
const denyTest = copyDemo("matrix-p1-test-deny-");
const tty = copyDemo("matrix-p1-tty-");
let child;
const env = {
  PATH: process.env.PATH,
  HOME: home,
  MATRIX_HOME: home,
  LAB_P1_KEY: key,
  NO_COLOR: "1",
  TERM: "xterm-256color",
};
const file = join(tty.workspace, "src/processor.py");
const before = readFileSync(file);
const denyBefore = readFileSync(join(deny.workspace, "src/processor.py"));
const shQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const runHeadless = (workspace, extra = []) =>
  new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [binary, "--provider", "lab", "--model", id, ...extra, "--json", task],
      { cwd: workspace, env },
    );
    let out = "",
      err = "";
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
  });
try {
  await addProviderProfile(
    {
      id: "lab",
      name: "P1 Lab",
      baseUrl: `http://127.0.0.1:${server.address().port}/team/v1`,
      auth: { type: "bearer", env: "LAB_P1_KEY" },
      models: [],
    },
    { home },
  );
  const denied = await runHeadless(deny.workspace);
  const result = JSON.parse(denied.out);
  assert.equal(denied.code, 0, denied.err);
  assert.equal(result.result.status, "denied");
  assert.deepEqual(readFileSync(join(deny.workspace, "src/processor.py")), denyBefore);
  assert.equal(result.result.verifyTests, null);
  const noTests = await runHeadless(denyTest.workspace, ["--yes"]);
  const noTestsReport = JSON.parse(noTests.out);
  assert.equal(noTestsReport.result.verifyTests.trustStatus, "denied");
  assert.equal(noTestsReport.result.verifyTests.processOk, false);
  assert.ok(
    readFileSync(join(denyTest.workspace, "src/processor.py"), "utf8").includes(
      "context = bounds[0:len(bounds)]",
    ),
  );
  const command = [process.execPath, binary, "--provider", "lab", "--model", id]
    .map(shQuote)
    .join(" ");
  child = spawn("script", ["-qec", `stty cols 120 rows 35; ${command}`, "/dev/null"], {
    cwd: tty.workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (x) => (output += x));
  child.stderr.on("data", (x) => (output += x));
  const wait = async (pattern, label, timeoutMs = 20000) => {
    const found = await waitFor(() => pattern.test(stripAnsi(output)), {
      timeoutMs,
      intervalMs: 30,
    });
    if (!found) throw Error(label + " not found; last output " + stripAnsi(output).slice(-1800));
  };
  await wait(/Describe a task/, "initial prompt");
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.write(task);
  await wait(/Fix the off-by-one/, "typed task");
  child.stdin.write("\r");
  await wait(/PATCH GATE/, "patch gate");
  assert.deepEqual(readFileSync(file), before);
  child.stdin.write("y");
  await wait(/TEST TRUST.*WORKSPACE/, "workspace test trust");
  child.stdin.write("y");
  await wait(/TEST TRUST.*TEST PLAN/, "test plan trust");
  child.stdin.write("y");
  await wait(/4 passed.*0 failed/, "real tests", 30000);
  await wait(/loopback workflow complete/, "provider completion", 30000);
  assert.notDeepEqual(readFileSync(file), before);
  child.stdin.write("\x1bu");
  await wait(/restored src\/processor\.py/, "undo");
  assert.deepEqual(readFileSync(file), before);
  child.stdin.write("\x03");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("terminal failed to exit"));
    }, 5000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child = null;
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile()) {
        const data = readFileSync(path, "utf8");
        for (const value of [
          key,
          encodeURIComponent(key),
          JSON.stringify(key).slice(1, -1),
          Buffer.from(key).toString("base64"),
        ])
          assert.equal(data.includes(value), false, `secret in ${path}`);
      }
    }
  };
  scan(home);
  assert.ok(reqs.length >= 6);
  assert.ok(
    reqs.every(
      (r) => r.url === "/team/v1/chat/completions" && r.auth === `Bearer ${key}` && r.model === id,
    ),
  );
  assert.equal(output.includes(key), false);
  assert.equal(denied.out.includes(key), false);
  assert.equal(noTests.out.includes(key), false);
  assert.equal(noTests.err.includes(key), false);
  console.log(
    JSON.stringify({
      denied: result.result.status,
      headlessTestsDenied: true,
      terminalEditApproved: true,
      realTests: "4 passed",
      undoExact: true,
      requests: reqs.length,
      endpointAndExactId: true,
      canaryAbsent: true,
    }),
  );
} finally {
  if (child) child.kill("SIGKILL");
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  deny.cleanup();
  denyTest.cleanup();
  tty.cleanup();
  rmSync(home, { recursive: true, force: true });
}
