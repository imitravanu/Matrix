import { relative, isAbsolute, sep, resolve } from "node:path";
import { createHash } from "node:crypto";
import { resolveModel } from "./models.mjs";
import { resolveProviderSelection } from "./provider-contracts.mjs";
import { loadProviderConfig } from "./provider-config.mjs";
import { bindProviderTarget, streamProviderChat } from "./provider-transport.mjs";
import { streamChatCompletions } from "./openrouter.mjs";
import { runLocalAgent } from "./local-agent.mjs";
import { readWorkspaceFileBounded } from "./goal-operations.mjs";
import { validateGoalPath } from "./goal-contracts.mjs";
import { resolveInside } from "./workspace.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const TOOL_BYTES = 32 * 1024;

export function bindGoalProvider({ home, options, saved }) {
  const providerId = saved?.id ?? options.providerId ?? null;
  const modelQuery = saved?.modelId ?? options.modelQuery ?? null;
  if (!providerId && modelQuery && !resolveModel(modelQuery, { fallback: false })) {
    throw new Error("unknown model; use --provider and an exact model ID");
  }
  const target = resolveProviderSelection({
    providerId,
    modelQuery,
    ...(providerId ? { config: loadProviderConfig({ home }).config } : {}),
  }).target;
  const binding = target.kind === "local" ? null : bindProviderTarget(target);
  if (binding && !binding.ok) throw new Error(binding.error);
  const identity = {
    id: target.providerId,
    modelId: target.modelId,
    digest: hash(
      JSON.stringify([
        target.providerId,
        target.modelId,
        target.configDigest,
        binding?.endpoint ?? target.baseUrl,
      ]),
    ),
  };
  if (saved && Object.keys(identity).some((key) => identity[key] !== saved[key])) {
    throw new Error(
      "the saved goal provider or endpoint has changed; restore its configuration before resuming",
    );
  }
  return { identity, target, binding };
}

function functionTool(name, description, properties, required) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

async function remoteTurn(provider, input, planHash, redactor) {
  const { target, binding } = provider;
  const tools = [
    functionTool("read", "Read a workspace file.", { path: { type: "string" } }, ["path"]),
    functionTool(
      "edit",
      "Propose exact replacement text or deletion of a workspace file.",
      {
        path: { type: "string" },
        content: { type: ["string", "null"] },
        mode: { type: "integer" },
      },
      ["path", "content"],
    ),
  ];
  if (planHash)
    tools.push(
      functionTool(
        "test",
        `Run the exact workspace test plan ${planHash}.`,
        {
          planHash: { type: "string", enum: [planHash] },
        },
        ["planHash"],
      ),
    );
  // One provider request is already reserved by the executor for this turn.
  const stream =
    target.kind === "custom"
      ? streamProviderChat({
          target,
          credential: binding.credential,
          messages: input.messages,
          tools,
          signal: input.signal,
          maxRetries: 0,
        })
      : streamChatCompletions({
          endpoint: binding.endpoint,
          apiKey: binding.credential,
          payload: {
            model: target.modelId,
            messages: input.messages,
            tools,
            max_tokens: 2048,
            stream: true,
          },
          signal: input.signal,
          maxRetries: 0,
        });
  let content = "";
  let argumentBytes = 0;
  const calls = new Map();
  for await (const event of stream) {
    if (event.type === "error") throw new Error(redactor.text(event.error));
    if (event.type === "content") content = (content + event.text).slice(0, 4096);
    if (event.type !== "tool_call") continue;
    const entry = calls.get(event.key) ?? { name: null, arguments: "" };
    if (event.name && entry.name && event.name !== entry.name)
      throw new Error("provider changed the tool name mid-call");
    if (event.name) entry.name = event.name;
    argumentBytes += Buffer.byteLength(event.arguments);
    if (argumentBytes > TOOL_BYTES || (!calls.has(event.key) && calls.size >= 8)) {
      throw new Error("provider tool proposals exceeded the turn limit");
    }
    entry.arguments += event.arguments;
    calls.set(event.key, entry);
  }
  const toolCalls = [];
  for (const { name, arguments: raw } of calls.values()) {
    if (!["read", "edit", "test"].includes(name))
      throw new Error("provider returned an unsupported goal tool");
    if (redactor.text(raw) !== raw)
      throw new Error("provider tool arguments contained protected text");
    toolCalls.push({ name, arguments: JSON.parse(raw) });
  }
  // The executor builds fresh context between turns. Ask for one operation at
  // a time so approval is based on the actual state at this boundary.
  if (toolCalls.length > 1)
    throw new Error("the goal provider must propose one operation per turn");
  return { content: redactor.text(content), toolCalls };
}

function safeGoalPath(workspace, home, path) {
  validateGoalPath(path);
  const target = resolveInside(workspace, path);
  if (!target.ok) throw new Error("goal tool path escapes the workspace");
  const statePath = relative(resolve(home), target.path);
  if (
    statePath === "" ||
    (!isAbsolute(statePath) && statePath !== ".." && !statePath.startsWith(".." + sep))
  ) {
    throw new Error("goal tools cannot access Matrix state files");
  }
  for (const name of [path, target.rel]) {
    const parts = name.toLowerCase().split("/");
    const base = parts.at(-1);
    if (
      parts.some((part) => [".git", ".matrix", ".ssh"].includes(part)) ||
      /^\.env(?:\.|$)/.test(base) ||
      /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(?:\.|$)/.test(base) ||
      /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(base)
    ) {
      throw new Error("goal tools cannot access credential or internal workspace paths");
    }
  }
  return path;
}

export function createGoalEngine({ provider, project, home, testPlanHash, redactor, approve }) {
  let proposed = false;
  let tested = false;
  return {
    async turn(input) {
      let result;
      if (provider.target.kind === "local") {
        if (!proposed) {
          proposed = true;
          let proposal = null;
          await runLocalAgent({
            task: input.goal.objective,
            project: { ...project, test: null },
            signal: input.signal,
            requestApproval: (edit) => {
              proposal = edit;
              return "n";
            },
          });
          if (proposal) {
            result = {
              content: "",
              toolCalls: [
                { name: "edit", arguments: { path: proposal.file, content: proposal.updatedText } },
              ],
            };
          }
        }
        if (!result && !tested && testPlanHash) {
          tested = true;
          result = {
            content: "",
            toolCalls: [{ name: "test", arguments: { planHash: testPlanHash } }],
          };
        }
        result ??= { content: "Local Forge has no further supported operation.", toolCalls: [] };
      } else {
        result = await remoteTurn(provider, input, testPlanHash, redactor);
      }
      for (const call of result.toolCalls) {
        if (call.name === "read" || call.name === "edit") {
          const args = call.arguments;
          safeGoalPath(project.root, home, args.path);
          if (
            [args.path, args.content].some(
              (value) => typeof value === "string" && redactor.text(value) !== value,
            )
          ) {
            throw new Error("goal tool proposal contained protected text");
          }
        }
        await approve(call, input);
      }
      return result;
    },
  };
}

export function goalReadTool(workspace, home, redactor) {
  return {
    description: "Read a small workspace file",
    run({ args }) {
      const path = safeGoalPath(workspace, home, args.path);
      const file = readWorkspaceFileBounded(workspace, path, 4096);
      return {
        status: file.exists ? "succeeded" : "failed",
        path,
        exists: file.exists,
        sha256: file.sha256,
        summary: file.exists
          ? redactor.text(file.bytes.toString("utf8")).slice(0, 1100)
          : "File is absent",
      };
    },
  };
}
