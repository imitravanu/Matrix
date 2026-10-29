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
  readlinkSync,
  readSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

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
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("manifest file identity changed while opening it");
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error("manifest file was truncated while being read");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, null) !== 0) {
      throw new Error("manifest file grew while being read");
    }
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
  if (before.isDirectory())
    return { entry: baseEntry(rel, before, "directory"), bytes: 0, directoryStat: before };
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
  const stack = [{ rel: "", depth: 0, directoryStat: null }];
  let visited = 0;
  let rootDescriptor;

  try {
    if (process.platform !== "linux") throw new Error("Manifest-safe traversal requires Linux");
    rootDescriptor = openSync(
      sourceRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const rootStat = fstatSync(rootDescriptor, { bigint: true });
    while (stack.length > 0) {
      const current = stack.pop();
      if (current.depth > limits.depth) return incomplete(manifest, "directory-depth-cap");
      let descriptor = openSync(
        `/proc/self/fd/${rootDescriptor}/.`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        for (const component of current.rel ? current.rel.split("/") : []) {
          const next = openSync(
            `/proc/self/fd/${descriptor}/${component}`,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          closeSync(descriptor);
          descriptor = next;
        }
        if (
          current.directoryStat &&
          !sameIdentity(current.directoryStat, fstatSync(descriptor, { bigint: true }))
        ) {
          throw new Error("manifest directory changed while opening it");
        }
        const openedStat = fstatSync(descriptor, { bigint: true });
        const directory = opendirSync(`/proc/self/fd/${descriptor}`);
        const entries = [];
        try {
          for (;;) {
            const entry = directory.readSync();
            if (entry == null) break;
            if (visited + entries.length >= limits.entries)
              return incomplete(manifest, "entry-cap");
            entries.push(entry);
          }
        } finally {
          directory.closeSync();
        }
        entries.sort((left, right) => pathOrder(left.name, right.name));

        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const name = entries[index].name;
          const absolute = `/proc/self/fd/${descriptor}/${name}`;
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
            stack.push({ rel, depth: current.depth + 1, directoryStat: captured.directoryStat });
          }
        }
        if (!sameIdentity(openedStat, fstatSync(descriptor, { bigint: true }))) {
          throw new Error("manifest directory changed while scanning it");
        }
      } finally {
        closeSync(descriptor);
      }
    }
    if (!sameIdentity(rootStat, fstatSync(rootDescriptor, { bigint: true }))) {
      throw new Error("manifest root changed while scanning it");
    }
  } catch (error) {
    return incomplete(manifest, error.message);
  } finally {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
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

/** Traverse through held directory descriptors without following symlinked ancestors. */
export function withManifestParent(root, rel, callback, { rootIdentity = null } = {}) {
  absoluteManifestPath(root, rel);
  if (process.platform !== "linux") throw new Error("Manifest-safe traversal requires Linux");
  const components = rel.split("/");
  const leaf = components.pop();
  let descriptor = openSync(
    resolve(root),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (rootIdentity !== null) {
      const info = fstatSync(descriptor, { bigint: true });
      if (`${info.dev}:${info.ino}` !== rootIdentity) throw new Error("Workspace identity changed");
    }
    for (const component of components) {
      const next = openSync(
        `/proc/self/fd/${descriptor}/${component}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      closeSync(descriptor);
      descriptor = next;
    }
    return callback(`/proc/self/fd/${descriptor}/${leaf}`);
  } finally {
    closeSync(descriptor);
  }
}

/** Capture an entry through an already pinned parent directory. */
export function capturePinnedManifestEntry(absolute, rel) {
  try {
    return captureEntryAbsolute(absolute, rel, MANIFEST_LIMITS).entry;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Re-read one entry without following final or ancestor symlinks. */
export function captureManifestEntry(root, entryOrPath) {
  const rel = typeof entryOrPath === "string" ? entryOrPath : entryOrPath?.path;
  try {
    return withManifestParent(root, rel, (absolute) => capturePinnedManifestEntry(absolute, rel));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Read exact text only from an anchored, revalidated regular file. */
export function readManifestText(root, expected) {
  return withManifestParent(root, expected.path, (absolute) => {
    const before = lstatSync(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Unsupported non-text integration input: ${expected.path}`);
    }
    const read = readRegular(absolute, before, MANIFEST_LIMITS);
    const entry = {
      ...baseEntry(expected.path, before, "file"),
      hash: read.hash,
      binary: read.binary,
      utf8: read.utf8,
    };
    if (manifestFingerprint(entry) !== manifestFingerprint(expected)) {
      throw new Error(`Manifest-backed file changed before reading: ${expected.path}`);
    }
    if (entry.binary || entry.utf8 !== true) {
      throw new Error(`Unsupported non-text integration input: ${expected.path}`);
    }
    return read.bytes.toString("utf8");
  });
}
