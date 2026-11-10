import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  GOAL_LIMITS,
  JOURNAL_SCHEMA_VERSION,
  OPERATION_RECEIPT_SCHEMA_VERSION,
  amendGoalBudget,
  assertGoalFence,
  assertLeaseHeld,
  assertOperationAuthority,
  canonicalJson,
  completeGoal,
  createGoalLease,
  decodeJournalRecord,
  encodeJournalRecord,
  newGoalId,
  renewGoalLease,
  reserveOperationBudget,
  sealJournalRecord,
  settleOperationBudget,
  transitionGoal,
  validateGoalId,
  validateGoalPath,
  validateGoalRecord,
  validateGoalLease,
  validateOperationIntent,
  validateOperationReceipt,
  validateJournalChain,
  updateGoalBudget,
} from "./goal-contracts.mjs";
import { assertGoalLock, withStoreLock } from "./goal-lock.mjs";
import { writePinnedAtomic } from "./pinned-write.mjs";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CHECKPOINT = "checkpoint.json";
const JOURNAL = "journal.jsonl";
const PREVIOUS = "checkpoint.previous.json";
const METADATA_RESERVE = GOAL_LIMITS.checkpointBytes * 2 + GOAL_LIMITS.journalRecordBytes + 1;
const INVENTORY_LIMIT = 16_384;
const TEMP_FILE = /^\.matrix-integration-[a-f0-9]{32}\.tmp$/;
const EMPTY = Object.freeze({ rounds: 0, tools: 0, requests: 0, activeMs: 0 });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const descriptorPath = (fd) => `/proc/self/fd/${fd}`;

function requireStore(condition, message) {
  if (!condition) throw new Error(`goal store: ${message}`);
}

function privateEntry(stat, mode) {
  requireStore(
    stat.uid === process.getuid?.() && (stat.mode & 0o7777) === mode,
    "state must be private and owned by the current user",
  );
}

function withPrivateDirectory(path, use) {
  const fd = openSync(path, DIRECTORY);
  try {
    privateEntry(fstatSync(fd), 0o700);
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

function withHome(path, use) {
  let fd = openSync("/", DIRECTORY);
  try {
    for (const component of path.slice(1).split("/")) {
      const next = openSync(join(descriptorPath(fd), component), DIRECTORY);
      closeSync(fd);
      fd = next;
    }
    privateEntry(fstatSync(fd), 0o700);
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

function readBounded(path, limit) {
  const fd = openSync(path, READ);
  try {
    const stat = fstatSync(fd);
    requireStore(stat.isFile() && stat.nlink === 1, "state must be a regular file with one link");
    privateEntry(stat, 0o600);
    requireStore(stat.size <= limit, "state exceeds its byte limit");
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    requireStore(length === stat.size, "state changed during read");
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function encodeCheckpoint(body) {
  const options = { maxBytes: GOAL_LIMITS.checkpointBytes };
  const checksum = digest(canonicalJson(body, options));
  return canonicalJson({ ...body, checksum }, options);
}

function loadCheckpoint(bytes, goalId) {
  let record;
  try {
    record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("goal store: malformed checkpoint");
  }
  requireStore(
    record && typeof record === "object" && !Array.isArray(record),
    "invalid checkpoint schema",
  );
  const { checksum, ...body } = record;
  requireStore(
    (Object.keys(body).length === 4 ||
      ((Object.keys(body).length === 6 ||
        (Object.keys(body).length === 7 && Object.hasOwn(body, "receiptSlots"))) &&
        Object.hasOwn(body, "lease") &&
        Object.hasOwn(body, "counters"))) &&
      body.schemaVersion === 1 &&
      Number.isSafeInteger(body.journalBytes) &&
      body.journalBytes > 0 &&
      body.journalBytes <= GOAL_LIMITS.journalBytes &&
      isHash(body.journalChecksum),
    "invalid checkpoint schema",
  );
  const goal = validateGoalRecord(body.goal);
  requireStore(goal.id === goalId && goal.sequence > 0, "checkpoint goal identity mismatch");
  requireStore(
    bytes.equals(Buffer.from(encodeCheckpoint(body))) && typeof checksum === "string",
    "checkpoint bytes or checksum mismatch",
  );
  const counters = updateGoalBudget(
    goal.budget,
    body.counters ?? { used: EMPTY, reserved: EMPTY },
    "reserve",
    EMPTY,
  );
  const lease = body.lease == null ? null : validateGoalLease(body.lease);
  const hasReceiptSlots = Object.hasOwn(body, "receiptSlots");
  requireStore(
    !hasReceiptSlots ||
      (Number.isSafeInteger(body.receiptSlots) &&
        body.receiptSlots >= 0 &&
        body.receiptSlots <= (lease ? GOAL_LIMITS.operations : 0)),
    "invalid receipt reservation",
  );
  requireStore(
    (lease !== null) === ACTIVE.includes(goal.state) &&
      (lease === null || (lease.goalId === goal.id && lease.generation === goal.generation)),
    "checkpoint lease mismatch",
  );
  return {
    goal,
    counters,
    lease,
    receiptSlots: hasReceiptSlots ? body.receiptSlots : null,
    journalBytes: body.journalBytes,
    journalChecksum: body.journalChecksum,
  };
}

function pendingReceipts(lease, journal, records) {
  if (!lease) return 0;
  return journal.operations.filter(
    ({ dispatchSequence, receiptSequence }) =>
      dispatchSequence !== null &&
      receiptSequence === null &&
      records[dispatchSequence - 1].attemptId === lease.attemptId,
  ).length;
}

function lifecycleSlots(goal, lease) {
  if (lease) return 2; // Stop and then cancel.
  return goal.state === "completed" || goal.state === "cancelled" ? 0 : 1;
}

function loadGoal(directory, goalId, checkpointName = CHECKPOINT) {
  const checkpointBytes = readBounded(join(directory, checkpointName), GOAL_LIMITS.checkpointBytes);
  const checkpoint = loadCheckpoint(checkpointBytes, goalId);
  const journal = readBounded(join(directory, JOURNAL), GOAL_LIMITS.journalBytes);
  const committed = journal.subarray(0, checkpoint.journalBytes);
  requireStore(committed.length === checkpoint.journalBytes, "committed journal bytes are missing");
  const records = [];
  let start = 0;
  while (start < committed.length) {
    const end = committed.indexOf(10, start);
    requireStore(
      end > start && end - start <= GOAL_LIMITS.journalRecordBytes,
      "invalid journal frame",
    );
    requireStore(records.length < GOAL_LIMITS.journalRecords, "journal record limit exceeded");
    const frame = committed.subarray(start, end);
    const record = decodeJournalRecord(frame);
    requireStore(
      frame.equals(Buffer.from(encodeJournalRecord(record))),
      "noncanonical journal frame",
    );
    records.push(record);
    start = end + 1;
  }
  const summary = validateJournalChain(records, { goalId });
  requireStore(
    summary.sequence === checkpoint.goal.sequence &&
      summary.generation === checkpoint.goal.generation &&
      summary.checksum === checkpoint.journalChecksum,
    "checkpoint does not match the committed journal",
  );
  if (checkpoint.lease) {
    const workspace = checkpoint.goal.workspace;
    requireStore(
      checkpoint.lease.attemptId === records.at(-1)?.attemptId &&
        checkpoint.lease.workspace.path === workspace.path &&
        checkpoint.lease.workspace.device === workspace.device &&
        checkpoint.lease.workspace.inode === workspace.inode,
      "checkpoint lease identity mismatch",
    );
  }
  const receiptSlots = pendingReceipts(checkpoint.lease, summary, records);
  requireStore(
    checkpoint.receiptSlots === null || checkpoint.receiptSlots === receiptSlots,
    "checkpoint receipt reservation does not match the committed journal",
  );
  return {
    ...checkpoint,
    receiptSlots,
    journal: summary,
    uncommittedBytes: journal.length - committed.length,
    checkpointBytes,
    records,
  };
}

function status(value) {
  return {
    goal: value.goal,
    counters: value.counters,
    lease: value.lease,
    journal: value.journal,
    uncommittedBytes: value.uncommittedBytes,
  };
}

function scan(root, visit, depth = 0, limit = { entries: 0 }) {
  const directory = opendirSync(root);
  try {
    for (let entry; (entry = directory.readSync());) {
      requireStore(++limit.entries <= INVENTORY_LIMIT, "store inventory limit exceeded");
      const path = join(root, entry.name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        requireStore(depth === 0, "unexpected nested state directory");
        withPrivateDirectory(path, (fd) => {
          visit(entry.name, stat, depth, descriptorPath(fd));
          scan(descriptorPath(fd), visit, depth + 1, limit);
        });
      } else {
        requireStore(stat.isFile() && stat.nlink === 1, "unsafe store entry");
        privateEntry(stat, 0o600);
        visit(entry.name, stat, depth);
      }
    }
  } finally {
    directory.closeSync();
  }
  return limit.entries;
}

function requireCapacity(root, growth, { goalId, reservedFrames, entries }) {
  let bytes = 0;
  let slots = reservedFrames;
  const count = scan(root, (name, stat, depth, directory) => {
    if (!stat.isDirectory()) {
      bytes += stat.size;
    } else if (depth === 0 && name !== goalId && /^goal_[a-f0-9]{32}$/.test(name)) {
      const checkpoint = loadCheckpoint(
        readBounded(join(directory, CHECKPOINT), GOAL_LIMITS.checkpointBytes),
        name,
      );
      // Earlier checkpoints do not store their receipt count. Replay only those
      // active journals to preserve their reservations during migration.
      const receipts = checkpoint.lease
        ? (checkpoint.receiptSlots ?? loadGoal(directory, name).receiptSlots)
        : 0;
      slots += lifecycleSlots(checkpoint.goal, checkpoint.lease) + receipts;
    }
  });
  const reserved = slots * METADATA_RESERVE;
  requireStore(bytes + growth + reserved <= GOAL_LIMITS.storeBytes, "store capacity exceeded");
  requireStore(count + entries + 2 * slots <= INVENTORY_LIMIT, "store inventory capacity exceeded");
}

function blobName(hash) {
  requireStore(isHash(hash), "invalid blob hash");
  return `blob_${hash}`;
}

function readBlob(directory, hash) {
  const bytes = readBounded(join(directory, blobName(hash)), GOAL_LIMITS.blobBytes);
  requireStore(digest(bytes) === hash, "blob checksum mismatch");
  return bytes;
}

function operationBlobs(kind, payload) {
  if (kind === "receipt") return payload.evidence;
  const references = [];
  if (payload.arguments.blob !== null) {
    requireStore(
      payload.arguments.blob === payload.arguments.sha256,
      "argument blob hash mismatch",
    );
    references.push(payload.arguments.blob);
  }
  for (const image of [payload.edit?.before, payload.edit?.after]) {
    if (image?.exists) {
      requireStore(image.blob === image.sha256, "image blob hash mismatch");
      references.push(image.blob);
    }
  }
  return references;
}

function prepareBlobs(directory, hashes, supplied) {
  requireStore(Array.isArray(supplied) && supplied.length <= 16, "invalid supplied blobs");
  const required = new Set(hashes);
  const pending = new Map();
  let growth = 0;
  for (const bytes of supplied) {
    requireStore(
      Buffer.isBuffer(bytes) && bytes.length <= GOAL_LIMITS.blobBytes - growth,
      "invalid blob bytes or size",
    );
    const copy = Buffer.from(bytes);
    const hash = digest(copy);
    requireStore(required.has(hash) && !pending.has(hash), "unexpected or duplicate blob");
    pending.set(hash, copy);
    growth += copy.length;
  }
  for (const hash of required) {
    if (lstatSync(join(directory, blobName(hash)), { throwIfNoEntry: false })) {
      readBlob(directory, hash);
      const existing = pending.get(hash);
      if (existing) growth -= existing.length;
      pending.delete(hash);
    } else requireStore(pending.has(hash), "required recovery blob is missing");
  }
  let existingBytes = 0;
  let entries = 0;
  const dir = opendirSync(directory);
  try {
    for (let entry; (entry = dir.readSync());) {
      requireStore(++entries <= INVENTORY_LIMIT, "goal inventory limit exceeded");
      if (entry.name.startsWith("blob_"))
        existingBytes += lstatSync(join(directory, entry.name)).size;
    }
  } finally {
    dir.closeSync();
  }
  requireStore(existingBytes + growth <= GOAL_LIMITS.blobBytes, "goal blob capacity exceeded");
  return { pending, growth };
}

function appendFrame(directory, previousLength, frame) {
  const fd = openSync(
    join(directory, JOURNAL),
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    privateEntry(stat, 0o600);
    requireStore(
      stat.isFile() && stat.nlink === 1 && stat.size === previousLength,
      "journal changed before append",
    );
    const bytes = Buffer.from(frame);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      requireStore(written > 0, "journal append made no progress");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function publish(root, directory, current, next, event, verify, { hashes = [], blobs = [] } = {}) {
  const record = sealJournalRecord({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    goalId: next.goal.id,
    attemptId: event.attemptId,
    generation: next.goal.generation,
    sequence: next.goal.sequence,
    kind: event.kind,
    operationId: event.operationId ?? null,
    prevChecksum: current.journal.checksum,
    payload: event.payload,
  });
  const records = [...current.records, record];
  const journal = validateJournalChain(records, { goalId: next.goal.id });
  const frame = `${encodeJournalRecord(record)}\n`;
  const journalBytes = current.journalBytes + Buffer.byteLength(frame);
  const receiptSlots = pendingReceipts(next.lease, journal, records);
  const reservedFrames = lifecycleSlots(next.goal, next.lease) + receiptSlots;
  const reservedBytes = reservedFrames * (GOAL_LIMITS.journalRecordBytes + 1);
  requireStore(
    journalBytes + reservedBytes <= GOAL_LIMITS.journalBytes &&
      journal.count + reservedFrames <= GOAL_LIMITS.journalRecords,
    "journal capacity exceeded",
  );
  const checkpoint = encodeCheckpoint({
    schemaVersion: 1,
    ...next,
    receiptSlots,
    journalBytes,
    journalChecksum: record.checksum,
  });
  const prepared = prepareBlobs(directory, hashes, blobs);
  requireCapacity(
    root,
    prepared.growth +
      Buffer.byteLength(frame) +
      Buffer.byteLength(checkpoint) +
      current.checkpointBytes.length,
    { goalId: next.goal.id, reservedFrames, entries: 2 + prepared.pending.size },
  );
  verify();
  for (const [hash, bytes] of prepared.pending)
    writePinnedAtomic(join(directory, blobName(hash)), bytes, 0o600, { createOnly: true });
  writePinnedAtomic(join(directory, PREVIOUS), current.checkpointBytes, 0o600);
  verify();
  appendFrame(directory, current.journalBytes, frame);
  verify();
  writePinnedAtomic(join(directory, CHECKPOINT), checkpoint, 0o600);
  return status({ ...next, journal, uncommittedBytes: 0 });
}

const ACTIVE = ["running", "awaiting-approval", "reconciling"];

function removeUnpublishedFiles(directory, staged, limit) {
  const dir = opendirSync(directory);
  const paths = [];
  try {
    for (let entry; (entry = dir.readSync());) {
      requireStore(++limit.entries <= INVENTORY_LIMIT, "cleanup inventory limit exceeded");
      const removable =
        TEMP_FILE.test(entry.name) || (staged && [JOURNAL, CHECKPOINT].includes(entry.name));
      requireStore(!staged || removable, "unexpected staged entry");
      if (!removable) continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      requireStore(stat.isFile(), "unsafe unpublished file");
      privateEntry(stat, 0o600);
      paths.push(path);
    }
  } finally {
    dir.closeSync();
  }
  for (const path of paths) unlinkSync(path);
  return paths.length;
}

function assertAvailableWorkspace(root, goal) {
  const dir = opendirSync(root);
  let entries = 0;
  try {
    for (let entry; (entry = dir.readSync());) {
      requireStore(++entries <= INVENTORY_LIMIT, "store inventory limit exceeded");
      if (entry.name === goal.id || !/^goal_[a-f0-9]{32}$/.test(entry.name)) continue;
      const other = withPrivateDirectory(join(root, entry.name), (fd) =>
        loadCheckpoint(
          readBounded(join(descriptorPath(fd), CHECKPOINT), GOAL_LIMITS.checkpointBytes),
          entry.name,
        ),
      );
      if (!other.lease) continue;
      const workspace = other.goal.workspace;
      requireStore(
        workspace.path !== goal.workspace.path &&
          (workspace.device !== goal.workspace.device || workspace.inode !== goal.workspace.inode),
        "another goal owns the workspace",
      );
    }
  } finally {
    dir.closeSync();
  }
}

/** Private authoritative goal storage under an existing Linux MATRIX_HOME. */
export function createGoalStore(matrixHome) {
  requireStore(process.platform === "linux", "Linux descriptor paths are required");
  const home = validateGoalPath(matrixHome, true);
  const withGoals = (create, use) =>
    withHome(home, (fd) => {
      const path = join(descriptorPath(fd), "goals");
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        fsyncSync(fd);
      }
      return withPrivateDirectory(path, use);
    });
  const withGoal = (id, use) => {
    validateGoalId(id);
    return withGoals(false, (fd) => {
      const root = descriptorPath(fd);
      return withPrivateDirectory(join(root, id), (goalFd) => use(root, descriptorPath(goalFd)));
    });
  };
  const mutate = (id, { lock, fence, leaseId }, use) =>
    withGoal(id, (root, directory) =>
      withStoreLock(join(root, ".store.lock"), () => {
        const current = loadGoal(directory, id);
        assertGoalFence(current.goal, fence);
        requireStore(current.uncommittedBytes === 0, "uncommitted journal tail requires recovery");
        const workspace = current.goal.workspace;
        const owner = assertGoalLock(lock, workspace);
        const verify = () => {
          assertGoalLock(lock, workspace);
          const lease = current.lease;
          if (leaseId !== undefined) {
            requireStore(lease?.leaseId === leaseId, "stale or missing writer lease");
            assertLeaseHeld(lease, {
              goalId: id,
              attemptId: current.records.at(-1)?.attemptId,
              generation: current.goal.generation,
              workspace: { path: workspace.path, device: workspace.device, inode: workspace.inode },
              owner,
              now: Date.now(),
            });
          }
        };
        verify();
        return use(
          current,
          owner,
          (next, event, options) => publish(root, directory, current, next, event, verify, options),
          root,
        );
      }),
    );
  const activeMutation = (id, authority, use) => {
    validateGoalId(authority.leaseId, "lease");
    return mutate(id, authority, use);
  };

  return {
    home: matrixHome,
    create(record) {
      const goal = validateGoalRecord(record);
      requireStore(
        goal.state === "ready" &&
          goal.generation === 0 &&
          goal.sequence === 0 &&
          !goal.operations.length,
        "creation requires a fresh ready goal",
      );
      goal.sequence = 1;
      const initial = sealJournalRecord({
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        goalId: goal.id,
        attemptId: null,
        generation: 0,
        sequence: goal.sequence,
        kind: "state",
        operationId: null,
        prevChecksum: null,
        payload: { schemaVersion: 1, state: goal.state },
      });
      const journal = `${encodeJournalRecord(initial)}\n`;
      const checkpoint = encodeCheckpoint({
        schemaVersion: 1,
        goal,
        journalBytes: Buffer.byteLength(journal),
        journalChecksum: initial.checksum,
      });
      return withGoals(true, (fd) =>
        withStoreLock(join(descriptorPath(fd), ".store.lock"), () => {
          const root = descriptorPath(fd);
          const destination = join(root, goal.id);
          requireStore(!lstatSync(destination, { throwIfNoEntry: false }), "goal already exists");
          requireCapacity(root, Buffer.byteLength(journal) + Buffer.byteLength(checkpoint), {
            goalId: goal.id,
            reservedFrames: lifecycleSlots(goal, null),
            entries: 3,
          });
          const staging = mkdtempSync(join(root, ".new-goal-"));
          withPrivateDirectory(staging, (stageFd) => {
            const directory = descriptorPath(stageFd);
            writePinnedAtomic(join(directory, JOURNAL), journal, 0o600);
            writePinnedAtomic(join(directory, CHECKPOINT), checkpoint, 0o600);
            // Both files are already synced. Publish the nonempty directory in one
            // rename, so concurrent creators cannot replace a published goal.
            renameSync(staging, destination);
            fsyncSync(fd);
          });
          return goal;
        }),
      );
    },
    inspect(goalId) {
      return withGoal(goalId, (_root, directory) => status(loadGoal(directory, goalId)));
    },
    inspectPrevious(goalId) {
      return withGoal(goalId, (_root, directory) => status(loadGoal(directory, goalId, PREVIOUS)));
    },
    readJournal(goalId) {
      return withGoal(goalId, (_root, directory) => loadGoal(directory, goalId).records);
    },
    readBlob(goalId, hash) {
      return withGoal(goalId, (_root, directory) => readBlob(directory, hash));
    },
    /**
     * List goals whose workspace path or device/inode overlaps this workspace. The
     * durable surviving-execution boundary is workspace scoped, so authority
     * admission must be able to discover sibling goals before granting attempt
     * authority. Discovery runs under the caller's held workspace lock, which is
     * the serialization point for goal admission in one canonical workspace.
     * This is a small additive read over the accepted store; the per-goal lease,
     * fence and receipt contracts are unchanged.
     * @param {{ path?: string, device?: string | number, inode?: string | number }} workspace
     * @returns {Array<*>} the goal records of that workspace, empty when unbound
     */
    listWorkspaceGoals(workspace) {
      const target = {
        path: workspace?.path,
        device: String(workspace?.device ?? ""),
        inode: String(workspace?.inode ?? ""),
      };
      return withGoals(false, (fd) => {
        const root = descriptorPath(fd);
        const directory = opendirSync(root);
        const goals = [];
        const limit = { entries: 0 };
        try {
          for (let entry; (entry = directory.readSync());) {
            requireStore(++limit.entries <= INVENTORY_LIMIT, "store inventory limit exceeded");
            if (!/^goal_[a-f0-9]{32}$/.test(entry.name)) continue;
            const goal = withPrivateDirectory(
              join(root, entry.name),
              (goalFd) => loadGoal(descriptorPath(goalFd), entry.name).goal,
            );
            if (
              goal.workspace.path === target.path ||
              (String(goal.workspace.device) === target.device &&
                String(goal.workspace.inode) === target.inode)
            ) {
              goals.push(goal);
            }
          }
        } finally {
          directory.closeSync();
        }
        return goals;
      });
    },
    beginAttempt(goalId, { lock, fence, ttlMs = undefined }) {
      return mutate(goalId, { lock, fence, leaseId: undefined }, (current, owner, commit, root) => {
        requireStore(
          !current.lease && !ACTIVE.includes(current.goal.state),
          "active attempt requires verified recovery",
        );
        assertAvailableWorkspace(root, current.goal);
        const goal = transitionGoal(
          current.goal,
          current.goal.state === "ready" ? "running" : "reconciling",
          fence,
        );
        const attemptId = newGoalId("attempt");
        const lease = createGoalLease(goal, { attemptId, owner, now: Date.now(), ttlMs });
        return commit(
          { goal, counters: current.counters, lease },
          {
            attemptId,
            kind: "attempt",
            payload: { schemaVersion: 1, state: goal.state },
          },
        );
      });
    },
    append(goalId, authority, kind, input, { blobs = [] } = {}) {
      return activeMutation(goalId, authority, (current, owner, commit) => {
        requireStore(
          ["intent", "dispatch", "receipt"].includes(kind),
          "unsupported operation event",
        );
        const goal = { ...current.goal, sequence: current.goal.sequence + 1 };
        const lease = current.lease;
        let counters = current.counters;
        let payload;
        if (kind === "receipt") {
          payload = validateOperationReceipt(input);
          const intent = current.records.find(
            (entry) => entry.kind === "intent" && entry.operationId === payload.operationId,
          )?.payload;
          requireStore(intent, "receipt has no prepared intent");
          assertOperationAuthority(intent, { goal: current.goal, lease, owner, now: Date.now() });
          counters = settleOperationBudget(goal.budget, counters, intent, payload);
        } else {
          requireStore(current.goal.state === "running", "operation requires a running attempt");
          payload = validateOperationIntent(input);
          assertOperationAuthority(payload, { goal: current.goal, lease, owner, now: Date.now() });
          if (kind === "intent") {
            counters = reserveOperationBudget(goal.budget, counters, payload);
            goal.operations = [...goal.operations, payload.operationId];
          }
        }
        validateGoalRecord(goal);
        return commit(
          { goal, counters, lease },
          {
            attemptId: lease.attemptId,
            kind,
            operationId: payload.operationId,
            payload,
          },
          { hashes: operationBlobs(kind, payload), blobs },
        );
      });
    },
    /** Settle an interrupted dispatch after the recovery coordinator verifies its boundary. */
    recordRecoveredDispatch(goalId, { lock, fence }, operationId) {
      return mutate(goalId, { lock, fence, leaseId: undefined }, (current, _owner, commit) => {
        requireStore(!current.lease, "recovery receipt requires a stopped attempt");
        const entry = current.journal.operations.find((item) => item.operationId === operationId);
        requireStore(
          entry?.dispatchSequence && entry.receiptSequence === null,
          "recovery receipt requires an unobserved dispatch",
        );
        const intent = current.records[entry.intentSequence - 1].payload;
        const goal = { ...current.goal, sequence: current.goal.sequence + 1 };
        const payload = validateOperationReceipt({
          schemaVersion: OPERATION_RECEIPT_SCHEMA_VERSION,
          goalId,
          attemptId: intent.attemptId,
          generation: intent.generation,
          operationId,
          sequence: goal.sequence,
          status: "uncertain",
          files: [],
          process: null,
          usage: intent.reservation,
          evidence: [],
          uncertainty: {
            kind: "unknown-effect",
            detail: "Interrupted dispatch reconciled; original result is unknown.",
          },
        });
        const counters = settleOperationBudget(goal.budget, current.counters, intent, payload);
        return commit(
          { goal, counters, lease: null },
          {
            attemptId: current.records.at(-1).attemptId,
            kind: "recovery-receipt",
            operationId,
            payload,
          },
        );
      });
    },
    transition(goalId, authority, state, { evidence = undefined } = {}) {
      const stoppedCancellation = state === "cancelled" && authority.leaseId === undefined;
      const apply = (current, _owner, commit) => {
        if (stoppedCancellation)
          requireStore(!current.lease, "active attempt requires a writer lease");
        const goal =
          state === "completed"
            ? completeGoal(current.goal, evidence, authority.fence)
            : transitionGoal(current.goal, state, authority.fence);
        requireStore(
          goal.generation === current.goal.generation,
          "generation changes require a new attempt",
        );
        if (state === "completed")
          requireStore(
            current.journal.operations.every(
              (entry) => entry.dispatchSequence === null || entry.receiptSequence !== null,
            ),
            "attempt has an unobserved dispatch",
          );
        const terminal = !ACTIVE.includes(state);
        const payload =
          state === "completed"
            ? { schemaVersion: 1, state, evidence }
            : { schemaVersion: 1, state };
        return commit(
          { goal, counters: current.counters, lease: terminal ? null : current.lease },
          {
            attemptId: current.lease?.attemptId ?? current.records.at(-1)?.attemptId ?? null,
            kind: terminal ? "terminal" : "state",
            payload,
          },
        );
      };
      return stoppedCancellation
        ? mutate(goalId, authority, apply)
        : activeMutation(goalId, authority, apply);
    },
    /**
     * Clear the lease of an attempt whose owner is verifiably dead, moving it
     * to a stopped state with the lease removed in one committed record.
     * `lib/goal-policy.mjs` verifies the owner's death through the reviewed
     * process-identity rules before calling; this method enforces only the
     * store side of the contract. It consumes no authority, evidence or
     * reservation, never retries anything and never grants a new attempt.
     */
    reclaimAttempt(goalId, { lock, fence }) {
      return mutate(goalId, { lock, fence, leaseId: undefined }, (current, _owner, commit) => {
        requireStore(current.lease, "no active lease to reclaim");
        const state = current.goal.state;
        requireStore(
          ["running", "awaiting-approval", "reconciling"].includes(state),
          "only an active attempt can be reclaimed",
        );
        const next = state === "reconciling" ? "needs-attention" : "interrupted";
        const goal = transitionGoal(current.goal, next, fence);
        requireStore(
          goal.sequence === current.goal.sequence + 1 &&
            goal.generation === current.goal.generation,
          "generation changes require a new attempt",
        );
        return commit(
          { goal, counters: current.counters, lease: null },
          {
            attemptId: current.lease.attemptId,
            kind: "terminal",
            payload: { schemaVersion: 1, state: next },
          },
        );
      });
    },
    renew(goalId, authority, ttlMs = undefined) {
      return activeMutation(goalId, authority, (current, owner, commit) => {
        const goal = validateGoalRecord({ ...current.goal, sequence: current.goal.sequence + 1 });
        const lease = renewGoalLease(current.lease, { owner, now: Date.now(), ttlMs });
        return commit(
          { goal, counters: current.counters, lease },
          {
            attemptId: lease.attemptId,
            kind: "state",
            payload: { schemaVersion: 1, state: goal.state },
          },
        );
      });
    },
    amendBudget(goalId, { lock, fence, budget }) {
      return mutate(goalId, { lock, fence, leaseId: undefined }, (current, _owner, commit) => {
        requireStore(!current.lease, "budget amendment requires a stopped attempt");
        const goal = amendGoalBudget(current.goal, budget, current.counters, fence);
        return commit(
          { goal, counters: current.counters, lease: null },
          {
            attemptId: current.records.at(-1)?.attemptId ?? null,
            kind: "budget",
            payload: { schemaVersion: 1, budget: goal.budget },
          },
        );
      });
    },
    cleanupStaging() {
      return withGoals(false, (fd) => {
        const root = descriptorPath(fd);
        return withStoreLock(join(root, ".store.lock"), () => {
          const dir = opendirSync(root);
          let removed = 0;
          const limit = { entries: 0 };
          try {
            for (let entry; (entry = dir.readSync());) {
              requireStore(++limit.entries <= INVENTORY_LIMIT, "cleanup inventory limit exceeded");
              const staged = /^\.new-goal-[a-zA-Z0-9]{6}$/.test(entry.name);
              if (!staged && !/^goal_[a-f0-9]{32}$/.test(entry.name)) continue;
              const path = join(root, entry.name);
              withPrivateDirectory(path, (goalFd) => {
                const count = removeUnpublishedFiles(descriptorPath(goalFd), staged, limit);
                if (count) fsyncSync(goalFd);
                if (!staged) removed += count;
              });
              if (staged) {
                rmdirSync(path);
                removed++;
              }
            }
          } finally {
            dir.closeSync();
          }
          fsyncSync(fd);
          return removed;
        });
      });
    },
  };
}
