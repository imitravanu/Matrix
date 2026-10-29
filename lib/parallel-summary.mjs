// Shared final handoff for the review screen and the shell after Ink exits.
function quoteShell(value) {
  const text = String(value);
  if (
    Array.from(text).some(
      (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
    )
  )
    return null;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function formatParallelSummary(outcome) {
  const result = outcome?.result;
  if (!result) return `Final status: ${outcome?.status ?? "unknown"}\n`;
  const lines = ["\nFINAL RESULT"];
  if (result.resultWorkspace)
    lines.push(`Result workspace: ${JSON.stringify(result.resultWorkspace)}`);
  if (result.intentPath) lines.push(`Integration intent: ${JSON.stringify(result.intentPath)}`);
  if (result.recoverySessionId) {
    lines.push(`Recovery session: ${JSON.stringify(result.recoverySessionId)}`);
    const workspace = result.resultWorkspace && quoteShell(result.resultWorkspace);
    const session = quoteShell(result.recoverySessionId);
    if (workspace && session) lines.push(`Resume: matrix -C ${workspace} --session ${session}`);
  } else if (result.undoRun) {
    lines.push(
      `Recovery session unavailable; retained backups: ${JSON.stringify(result.undoRun.entries.map(({ file, backupPath, isCreation }) => ({ file, backupPath, isCreation })))}`,
    );
  }
  if (result.publication?.kind === "git") {
    lines.push(`Published branch: ${JSON.stringify(result.publication.ref)}`);
    lines.push(`Commit: ${result.publication.commit}`);
  }
  lines.push(`Integration: ${result.integrationStatus ?? "unknown"}`);
  lines.push(`Verification: ${result.verificationStatus ?? "not-run"}`);
  lines.push(`Publication: ${result.publicationStatus ?? "not-attempted"}`);
  lines.push(`Final status: ${outcome.status ?? "unknown"}`);
  if (result.publicationError)
    lines.push(`Publication error: ${JSON.stringify(result.publicationError)}`);
  else if (result.error && typeof result.error === "string")
    lines.push(`Integration error: ${JSON.stringify(result.error)}`);
  return `${lines.join("\n")}\n`;
}
