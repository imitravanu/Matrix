import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { newGoalId, validateGoalId } from "./goal-contracts.mjs";
import { writePinnedAtomic } from "./pinned-write.mjs";

const MAX_BYTES = 2048;

function reviewPath(home, goal, criterion, create) {
  validateGoalId(goal.id);
  validateGoalId(criterion.id, "criterion");
  const directory = join(home, "goal-reviews");
  if (create) mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("goal review directory must be private and owned by the current user");
  }
  return join(directory, `${goal.id}-${criterion.id}.json`);
}

function binding(goal, criterion, sourceFingerprint) {
  return {
    schemaVersion: 1,
    goalId: goal.id,
    criterionId: criterion.id,
    revision: criterion.revision,
    manifest: goal.workspace.manifest,
    sourceFingerprint,
  };
}

export function readGoalReview(home, goal, criterion, sourceFingerprint) {
  const path = reviewPath(home, goal, criterion, false);
  if (!path) return null;
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > MAX_BYTES
    ) {
      throw new Error("unsafe goal review record");
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const received = readSync(fd, bytes, count, bytes.length - count, null);
      if (received === 0) break;
      count += received;
    }
    if (count !== stat.size) throw new Error("goal review record changed while reading");
    const value = JSON.parse(bytes.toString("utf8", 0, count));
    if (
      !value ||
      Object.entries(binding(goal, criterion, sourceFingerprint)).some(
        ([key, expected]) => value[key] !== expected,
      )
    )
      return null;
    return {
      decisionId: validateGoalId(value.decisionId, "decision"),
      revision: criterion.revision,
      accepted: true,
    };
  } finally {
    closeSync(fd);
  }
}

export function saveGoalReview(home, goal, criterion, sourceFingerprint) {
  const path = reviewPath(home, goal, criterion, true);
  const decisionId = newGoalId("decision");
  writePinnedAtomic(
    path,
    Buffer.from(
      JSON.stringify({
        ...binding(goal, criterion, sourceFingerprint),
        decisionId,
      }) + "\n",
    ),
    0o600,
  );
  return { decisionId, revision: criterion.revision, accepted: true };
}
