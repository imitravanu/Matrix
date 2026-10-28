// Line-oriented parallel review, kept separate from the single-run Ink UI.
import { createParallelRun } from "./parallel-run.mjs";
import { readManifestText } from "./isolated-manifest.mjs";

const REVIEW_LIMIT = 8 * 1024 * 1024;

export async function runParallelInteractive({
  root,
  home,
  jobs,
  ask,
  write,
  scratchDir,
  onEvent: observe = null,
  signal = null,
}) {
  if (typeof ask !== "function" || typeof write !== "function")
    throw new Error("Interactive I/O is required");
  let wake = null;
  let run;
  const onEvent = (event) => {
    if (typeof observe === "function") {
      try {
        observe(event);
      } catch {
        // A presentation observer cannot affect batch or approval state.
      }
    }
    if (event.type === "agent:started") write(`${event.agentId}: started\n`);
    if (event.type === "agent:settled")
      write(`${event.agentId}: ${event.result?.status ?? "settled"}\n`);
    if (wake) {
      const notify = wake;
      wake = null;
      notify();
    }
  };
  run = createParallelRun({ root, home, jobs, onEvent, ...(scratchDir ? { scratchDir } : {}) });
  const cancel = () => {
    run.abort();
    if (wake) {
      const notify = wake;
      wake = null;
      notify();
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let settledResult = null;
  const askBeforeIntegration = (prompt) => {
    if (!signal) return Promise.resolve().then(() => ask(prompt));
    return new Promise((resolve, reject) => {
      const aborted = () => {
        signal.removeEventListener("abort", aborted);
        reject(Object.assign(new Error("Parallel review aborted"), { name: "AbortError" }));
      };
      if (signal.aborted) {
        aborted();
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      Promise.resolve()
        .then(() => {
          if (signal.aborted)
            throw Object.assign(new Error("Parallel review aborted"), { name: "AbortError" });
          return ask(prompt);
        })
        .then(
          (answer) => {
            signal.removeEventListener("abort", aborted);
            resolve(answer);
          },
          (error) => {
            signal.removeEventListener("abort", aborted);
            reject(error);
          },
        );
    });
  };
  const execute = async () => {
    write(`PARALLEL BATCH ${run.batchId}: independent isolated agents\n`);
    while (run.getState().status !== "settled") {
      const pending = run.pendingApprovals()[0];
      if (pending) {
        const request = pending.request ?? {};
        write(`\n${pending.agentId} ${pending.kind} approval ${pending.approvalId}\n`);
        if (pending.kind === "edit") {
          const proposal = request.proposal ?? {};
          write(
            `File: ${JSON.stringify(proposal.file ?? "unknown")}\nPatch: ${JSON.stringify(proposal.patch ?? "")}\n`,
          );
        } else {
          write(`${JSON.stringify(request, null, 2)}\n`);
        }
        const answer = await askBeforeIntegration("Approve this one request? [y/N] ");
        run.decide({
          agentId: pending.agentId,
          approvalId: pending.approvalId,
          kind: pending.kind,
          decision: answer === "y" ? "y" : "n",
        });
      } else {
        await Promise.race([
          run.done,
          new Promise((resolve) => {
            wake = resolve;
          }),
        ]);
        wake = null;
      }
    }
    const settled = await run.done;
    settledResult = settled;
    if (settled.aborted || signal?.aborted) return { status: "aborted", settled };
    const analysis = run.analyze();
    if (analysis.changes.length === 0) return { status: "no-changes", settled };
    const resolutions = [];
    for (const path of analysis.requiredResolutions) {
      const changes = analysis.changes.filter((change) => change.path === path);
      const bytes = changes.reduce(
        (total, change) => total + (change.before?.size ?? 0) + (change.after?.size ?? 0),
        0,
      );
      if (bytes > REVIEW_LIMIT) throw new Error(`Conflict review exceeds its byte budget: ${path}`);
      write(`\nConflict: ${JSON.stringify(path)}\n`);
      for (const change of changes) {
        if (!change.supported) {
          write(`${change.agentId}: unsupported (${change.unsupportedReason})\n`);
          continue;
        }
        const before = change.before ? readManifestText(root, change.before) : "";
        const after = readManifestText(change.workspaceRoot, change.after);
        write(
          `${change.agentId} BEFORE ${JSON.stringify(before)}\n${change.agentId} AFTER ${JSON.stringify(after)}\n`,
        );
      }
      const eligible = changes.filter((change) => change.supported).map((change) => change.agentId);
      let selection;
      do {
        selection = await askBeforeIntegration(`Choose base or ${eligible.join(", ")}: `);
      } while (selection !== "base" && !eligible.includes(selection));
      resolutions.push(
        selection === "base"
          ? { path, source: "base" }
          : { path, source: "agent", agentId: selection },
      );
    }
    if (analysis.candidates.length === 0 && resolutions.every((item) => item.source === "base"))
      return { status: "no-changes", settled };
    const plan = run.createPlan(resolutions);
    const approval = run.requestIntegrationApproval(plan);
    const review = run.pendingApprovals().find((item) => item.approvalId === approval.approvalId);
    if (!review) throw new Error("Integration approval is unavailable");
    for (const change of review.request.changes) {
      write(
        `\n${JSON.stringify(change.path)} (${change.agentId})\nBEFORE ${JSON.stringify(change.original)}\nAFTER ${JSON.stringify(change.updatedText)}\n`,
      );
    }
    const answer = await askBeforeIntegration(
      "Integrate these exact changes into the original workspace? [y/N] ",
    );
    run.decide({
      agentId: "integration",
      approvalId: approval.approvalId,
      kind: "integration",
      decision: answer === "y" ? "y" : "n",
    });
    if (answer !== "y") return { status: "denied", settled };
    let result = run.integrate(plan, approval);
    write(
      `Integration: ${result.integrationStatus}; recovery session: ${result.recoverySessionId ?? "none"}\n`,
    );
    if (result.error) write(`Integration error: ${JSON.stringify(result.error)}\n`);
    if (result.undoRun && !result.recoverySessionId) {
      write(
        `Recovery session could not be saved. Retained backup paths: ${JSON.stringify(
          result.undoRun.entries.map((entry) => ({
            path: entry.file,
            backup: entry.backupPath,
            created: entry.isCreation,
          })),
        )}\n`,
      );
    }
    if (result.integrationStatus === "integrated") {
      result = await run.verify({
        signal,
        requestTestApproval: async (request) => {
          write(`\nCombined test trust:\n${JSON.stringify(request, null, 2)}\n`);
          return (await ask("Run this exact test plan? [y/N] ")) === "y" ? "y" : "n";
        },
      });
      write(`Combined verification: ${result.verificationStatus}\n`);
    }
    return { status: result.status, settled, result };
  };
  let result;
  let failure = null;
  try {
    result = await execute();
  } catch (error) {
    if (error?.name === "AbortError" && signal?.aborted) {
      result = { status: "aborted", settled: settledResult };
    } else {
      failure = error;
    }
  }
  signal?.removeEventListener("abort", cancel);
  const cleanup = await run.discard();
  if (!cleanup.ok) {
    throw new Error(`${failure ? `${failure.message}; ` : ""}Cleanup failed: ${cleanup.error}`);
  }
  if (failure) throw failure;
  return result;
}
