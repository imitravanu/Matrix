// A retained integration workspace starts as a verified private snapshot.
// Its lifecycle is independent from the short-lived agent leases.
import { captureManifest, diffManifests } from "./isolated-manifest.mjs";
import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from "./linux-snapshot.mjs";

/** Create a bounded copy whose content and modes match the approved base. */
export function createIntegrationWorkspace({ root, baseManifest, scratchDir, home, signal }) {
  if (!baseManifest?.complete || baseManifest.truncated) {
    throw new Error("Integration base manifest must be complete");
  }
  const snapshot = createWorkspaceSnapshot(root, {
    scratchDir,
    matrixHome: home,
    signal,
  });
  try {
    const manifest = captureManifest(snapshot.workspacePath, baseManifest.limits);
    if (!manifest.complete || manifest.truncated) {
      throw new Error("Integration workspace manifest is incomplete");
    }
    const differences = diffManifests(baseManifest, manifest);
    if (differences.length > 0) {
      throw new Error(`Integration workspace does not match the base: ${differences[0].path}`);
    }
    return {
      root: snapshot.workspacePath,
      manifest,
      cleanup() {
        return cleanupWorkspaceSnapshot(snapshot);
      },
    };
  } catch (error) {
    const cleanup = cleanupWorkspaceSnapshot(snapshot);
    if (!cleanup.ok) {
      throw new Error(`${error.message}; ${cleanup.error}`, { cause: error });
    }
    throw error;
  }
}
