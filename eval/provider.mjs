import { EVAL_CANARY } from "./cases.mjs";

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function toolChunks(call, callIndex) {
  const split = Math.max(1, Math.floor(call.arguments.length / 2));
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: callIndex,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments.slice(0, split) },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: callIndex, function: { arguments: call.arguments.slice(split) } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function responseFor(step) {
  if (!step) throw new Error("deterministic eval provider exhausted its canned responses");
  if (step.type === "throw") throw new Error(step.message);
  if (step.type === "http") {
    return new Response(step.body ?? "retry", {
      status: step.status,
      headers: {
        "content-type": "text/plain",
        ...(step.retryAfter === undefined ? {} : { "retry-after": step.retryAfter }),
      },
    });
  }
  if (step.type === "malformed-transport") {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }
  if (step.type === "tools") {
    const chunks = step.calls.flatMap((call, callIndex) => toolChunks(call, callIndex));
    if (step.usage) chunks.push({ usage: step.usage });
    return sseResponse(chunks);
  }
  if (step.type === "content") {
    const chunks = [
      { choices: [{ delta: { content: step.content } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ];
    if (step.usage) chunks.push({ usage: step.usage });
    return sseResponse(chunks);
  }
  throw new Error(`unknown canned eval response: ${step.type}`);
}

/** A fetch implementation, not a model: every response is fixture data. */
export function createProviderMock(definition) {
  const calls = [];
  let index = 0;
  const fetchMock = async (url, init = {}) => {
    const started = performance.now();
    const rawBody = typeof init.body === "string" ? init.body : "";
    let payload = null;
    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      // The transport will receive the original body; malformed requests are
      // still recorded without serializing their contents into the report.
    }
    const record = {
      index: calls.length + 1,
      responseIndex: index,
      url: String(url),
      model: payload?.model ?? null,
      messageCount: Array.isArray(payload?.messages) ? payload.messages.length : null,
      requestBytes: Buffer.byteLength(rawBody),
      runCommandAdvertised: Boolean(
        payload?.tools?.some((candidate) => candidate?.function?.name === "run_command"),
      ),
      canaryForwarded: rawBody.includes(EVAL_CANARY),
      status: null,
      error: null,
      headerLatencyMs: null,
    };
    calls.push(record);
    try {
      const response = responseFor(definition.scenario.responses[index]);
      index += 1;
      record.status = response.status;
      return response;
    } catch (error) {
      record.error = error.message;
      throw error;
    } finally {
      record.headerLatencyMs = performance.now() - started;
    }
  };
  return { calls, fetchMock };
}
