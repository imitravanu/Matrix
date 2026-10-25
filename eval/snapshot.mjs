import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, sep } from "node:path";

import { canonicalJson } from "./versions.mjs";

function comparePaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function entryType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isBlockDevice()) return "block-device";
  if (stat.isCharacterDevice()) return "character-device";
  if (stat.isFIFO()) return "fifo";
  if (stat.isSocket()) return "socket";
  return "other";
}

function snapshotEntry(path, rel) {
  const stat = lstatSync(path);
  const type = entryType(stat);
  const entry = {
    path: rel.split(sep).join("/"),
    type,
    mode: type === "symlink" ? null : stat.mode & 0o7777,
    bytes: type === "file" ? stat.size : null,
    sha256: null,
    symlinkTarget: null,
  };
  if (type === "file") {
    const content = readFileSync(path);
    entry.sha256 = createHash("sha256").update(content).digest("hex");
    entry.bytes = content.length;
  } else if (type === "symlink") {
    entry.symlinkTarget = readlinkSync(path);
  }
  return entry;
}

/** Complete lstat tree inventory. Symlinks are recorded, never followed. */
export function snapshotTree(root) {
  const entries = [];
  const visit = (directory, parentRel = "") => {
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const path = join(directory, name);
      const rel = parentRel ? join(parentRel, name) : name;
      const entry = snapshotEntry(path, rel);
      entries.push(entry);
      if (entry.type === "directory") visit(path, rel);
    }
  };
  visit(root);
  entries.sort(comparePaths);
  return {
    complete: true,
    entries,
    digest: createHash("sha256").update(canonicalJson(entries)).digest("hex"),
  };
}

export function emptySnapshot() {
  return { complete: false, entries: [], digest: null };
}

export function snapshotMap(snapshot) {
  return new Map((snapshot?.entries ?? []).map((entry) => [entry.path, entry]));
}

export function diffSnapshots(before, after) {
  const left = snapshotMap(before);
  const right = snapshotMap(after);
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes = [];
  for (const path of paths) {
    const previous = left.get(path) ?? null;
    const current = right.get(path) ?? null;
    if (previous && current && canonicalJson(previous) === canonicalJson(current)) continue;
    changes.push({
      path,
      change: !previous ? "added" : !current ? "removed" : "modified",
      before: previous,
      after: current,
    });
  }
  return changes;
}
