// Bounded before/after filesystem manifests for isolated execution and
// integration. Symlinks are inventoried, never followed.

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { isBinaryPath } from "./project.mjs";

export const MANIFEST_LIMITS = Object.freeze({
  entries: 16_384,
  depth: 48,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  symlinkBytes: 4096,
});

function normalizedLimits(overrides = {}) {
  const limits = { ...MANIFEST_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits)) throw new Error(`unsupported manifest limit: ${key}`);
    if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) {
      throw new Error(`manifest limit ${key} must be a positive integer within its cap`);
    }
    limits[key] = value;
  }
  return limits;
}

function pathOrder(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identity(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs];
}

function sameIdentity(left, right) {
  const a = identity(left);
  const b = identity(right);
  return a.every((value, index) => value === b[index]);
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseEntry(path, stat, type) {
  return {
    path,
    type,
    mode: Number(stat.mode) & 0o777,
    size: type === "file" ? Number(stat.size) : 0,
    hash: null,
    binary: false,
    utf8: null,
    target: null,
    targetBase64: null,
  };
}

function readRegular(path, before, limits, bytesAlready = 0) {
  if (
    before.size > BigInt(limits.fileBytes) ||
    bytesAlready + Number(before.size) > limits.totalBytes
  ) {
    throw new Error("manifest file exceeds its byte budget");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("manifest file identity changed while opening it");
    }
    const bytes = readFileSync(descriptor);
    const current = lstatSync(path, { bigint: true });
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes.length !== Number(opened.size) ||
      !sameIdentity(opened, current) ||
      !sameIdentity(opened, after)
    ) {
      throw new Error("manifest file changed while it was being read");
    }
    const text = bytes.toString("utf8");
    const utf8 = !text.includes("\u0000") && Buffer.from(text, "utf8").equals(bytes);
    return {
      bytes,
      hash: hash(bytes),
      binary: isBinaryPath(path) || !utf8,
      utf8,
    };
  } finally {
    closeSync(descriptor);
  }
}

function captureEntryAbsolute(path, rel, limits, bytesAlready = 0) {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink()) {
    const entry = baseEntry(rel, before, "symlink");
    const target = readlinkSync(path, { encoding: "buffer" });
    if (target.length > limits.symlinkBytes)
      throw new Error("manifest symlink target is too large");
    const current = lstatSync(path, { bigint: true });
    if (!sameIdentity(before, current))
      throw new Error("manifest symlink changed while being read");
    entry.target = target.toString("utf8");
    entry.targetBase64 = target.toString("base64");
    entry.size = target.length;
    return { entry, bytes: 0 };
  }
  if (before.isFile()) {
    const entry = baseEntry(rel, before, "file");
    const read = readRegular(path, before, limits, bytesAlready);
    entry.hash = read.hash;
    entry.binary = read.binary;
    entry.utf8 = read.utf8;
    return { entry, bytes: read.bytes.length };
  }
  if (before.isDirectory()) return { entry: baseEntry(rel, before, "directory"), bytes: 0 };
  return { entry: baseEntry(rel, before, "unsupported"), bytes: 0 };
}

function incomplete(manifest, reason) {
  manifest.complete = false;
  manifest.exact = false;
  manifest.truncated = true;
  manifest.reasons.push(reason);
  return manifest;
}

/**
 * Capture one complete bounded tree, or return explicit incomplete metadata.
 * `.git` administrative entries are intentional omissions, not exact content.
 */
export function captureManifest(root, options = {}) {
  const limits = normalizedLimits(options);
  const sourceRoot = resolve(root);
  const manifest = {
    version: 1,
    root: sourceRoot,
    limits,
    entries: [],
    complete: true,
    exact: true,
    truncated: false,
    omittedEntries: 0,
    unsupportedEntries: 0,
    bytes: 0,
    reasons: [],
  };
  const stack = [{ path: sourceRoot, rel: "", depth: 0 }];
  let visited = 0;

  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (current.depth > limits.depth) return incomplete(manifest, "directory-depth-cap");
      const directory = opendirSync(current.path);
      const entries = [];
      try {
        for (;;) {
          const entry = directory.readSync();
          if (entry == null) break;
          entries.push(entry);
        }
      } finally {
        directory.closeSync();
      }
      entries.sort((left, right) => pathOrder(left.name, right.name));

      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const name = entries[index].name;
        const absolute = join(current.path, name);
        const rel = current.rel ? `${current.rel}/${name}` : name;
        visited += 1;
        if (visited > limits.entries) return incomplete(manifest, "entry-cap");
        if (name === ".git") {
          manifest.omittedEntries += 1;
          manifest.exact = false;
          continue;
        }
        let captured;
        try {
          captured = captureEntryAbsolute(absolute, rel, limits, manifest.bytes);
        } catch (error) {
          return incomplete(manifest, error.message);
        }
        manifest.entries.push(captured.entry);
        manifest.bytes += captured.bytes;
        if (captured.entry.type === "unsupported") manifest.unsupportedEntries += 1;
        if (captured.entry.type === "directory") {
          stack.push({ path: absolute, rel, depth: current.depth + 1 });
        }
      }
    }
  } catch (error) {
    return incomplete(manifest, error.message);
  }

  manifest.entries.sort((left, right) => pathOrder(left.path, right.path));
  return manifest;
}

export function compareManifestPath(left, right) {
  return pathOrder(left, right);
}

export function manifestEntryMap(manifest) {
  return new Map((manifest?.entries ?? []).map((entry) => [entry.path, entry]));
}

/** Stable content/type/mode identity; mtimes are deliberately not write authority. */
export function manifestFingerprint(entry) {
  if (!entry) return null;
  return JSON.stringify([
    entry.path,
    entry.type,
    entry.mode,
    entry.size,
    entry.hash,
    entry.binary,
    entry.utf8,
    entry.targetBase64,
  ]);
}

export function diffManifests(before, after) {
  if (!before?.complete || !after?.complete) {
    throw new Error("Cannot compare incomplete workspace manifests");
  }
  const beforeMap = manifestEntryMap(before);
  const afterMap = manifestEntryMap(after);
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort(pathOrder);
  const changes = [];
  for (const path of paths) {
    const previous = beforeMap.get(path) ?? null;
    const next = afterMap.get(path) ?? null;
    if (manifestFingerprint(previous) === manifestFingerprint(next)) continue;
    const kind = !previous
      ? "create"
      : !next
        ? "delete"
        : previous.type !== next.type
          ? "type"
          : "modify";
    changes.push({ path, kind, before: previous, after: next });
  }
  return changes;
}

/** Validate a manifest-owned relative path and return its lexical absolute path. */
export function absoluteManifestPath(root, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || isAbsolute(rel)) {
    throw new Error("manifest path is invalid");
  }
  const base = resolve(root);
  const absolute = resolve(base, rel);
  const relativePath = relative(base, absolute);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error("manifest path escapes its root");
  }
  if (relativePath.split(sep).join("/") !== rel) throw new Error("manifest path is not canonical");
  return absolute;
}

/** Re-read one manifest entry without following its final symlink. */
export function captureManifestEntry(root, entryOrPath) {
  const rel = typeof entryOrPath === "string" ? entryOrPath : entryOrPath?.path;
  const absolute = absoluteManifestPath(root, rel);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isDirectory()) return baseEntry(rel, stat, "directory");
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolute);
    return {
      ...baseEntry(rel, stat, "symlink"),
      size: Buffer.byteLength(target),
      target,
      targetBase64: Buffer.from(target, "utf8").toString("base64"),
    };
  }
  if (!stat.isFile()) return baseEntry(rel, stat, "unsupported");
  const bytes = readFileSync(absolute);
  const text = bytes.toString("utf8");
  const utf8 = !text.includes("\u0000") && Buffer.from(text, "utf8").equals(bytes);
  return {
    ...baseEntry(rel, stat, "file"),
    size: bytes.length,
    hash: hash(bytes),
    binary: isBinaryPath(rel) || !utf8,
    utf8,
  };
}

/** Read exact text only after a fresh fingerprint match. */
export function readManifestText(root, expected) {
  const absolute = absoluteManifestPath(root, expected.path);
  const before = captureManifestEntry(root, expected);
  if (manifestFingerprint(before) !== manifestFingerprint(expected)) {
    throw new Error(`Manifest-backed file changed before reading: ${expected.path}`);
  }
  if (!before || before.type !== "file" || before.binary || before.utf8 !== true) {
    throw new Error(`Unsupported non-text integration input: ${expected.path}`);
  }
  const bytes = readFileSync(absolute);
  const after = captureManifestEntry(root, expected);
  if (
    manifestFingerprint(after) !== manifestFingerprint(expected) ||
    createHash("sha256").update(bytes).digest("hex") !== expected.hash
  ) {
    throw new Error(`Manifest-backed file changed while reading: ${expected.path}`);
  }
  return bytes.toString("utf8");
}
