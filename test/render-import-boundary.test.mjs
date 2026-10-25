import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const moduleUrl = (path) => pathToFileURL(resolve(root, path)).href;

test("render-only imports never load the orchestrator, agents, controller, or provider transport", () => {
  const renderUrl = moduleUrl("src/render.mjs");
  const frameUrl = moduleUrl("src/frame.mjs");
  const forbidden = [
    "src/matrix.mjs",
    "lib/controller.mjs",
    "lib/local-agent.mjs",
    "lib/model-agent.mjs",
    "lib/openrouter.mjs",
  ].map(moduleUrl);
  const script = `
    import { register } from "node:module";
    const renderUrl = ${JSON.stringify(renderUrl)};
    const frameUrl = ${JSON.stringify(frameUrl)};
    const forbidden = ${JSON.stringify(forbidden)};
    const shared = new SharedArrayBuffer((forbidden.length + 2) * Int32Array.BYTES_PER_ELEMENT);
    const flags = new Int32Array(shared);
    const hook = \`
      let flags;
      let renderUrl;
      let frameUrl;
      let forbidden;
      export function initialize(data) {
        flags = new Int32Array(data.shared);
        renderUrl = data.renderUrl;
        frameUrl = data.frameUrl;
        forbidden = data.forbidden;
      }
      export async function load(url, context, nextLoad) {
        if (url === renderUrl) Atomics.store(flags, 0, 1);
        if (url === frameUrl) Atomics.store(flags, 1, 1);
        const forbiddenIndex = forbidden.indexOf(url);
        if (forbiddenIndex >= 0) Atomics.store(flags, forbiddenIndex + 2, 1);
        return nextLoad(url, context);
      }
    \`;
    register("data:text/javascript," + encodeURIComponent(hook), {
      data: { shared, renderUrl, frameUrl, forbidden },
    });
    await import(renderUrl);
    process.stdout.write(JSON.stringify({
      renderLoaded: Atomics.load(flags, 0) === 1,
      frameLoaded: Atomics.load(flags, 1) === 1,
      forbiddenLoaded: forbidden.filter((_, index) => Atomics.load(flags, index + 2) === 1),
    }));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    timeout: 30_000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const trace = JSON.parse(child.stdout);
  assert.equal(trace.renderLoaded, true);
  assert.equal(trace.frameLoaded, true);
  assert.deepEqual(trace.forbiddenLoaded, []);
});
