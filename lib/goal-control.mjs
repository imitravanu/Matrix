// A private local channel for cooperative control of the exact active lease.
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

const REQUEST_TIMEOUT = 2_000;
const FRAME_LIMIT = 1024;

function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === "Z") return null;
    return {
      pid,
      startTime: fields[19],
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    };
  } catch {
    return null;
  }
}

function sameOwner(a, b) {
  return a?.pid === b.pid && a.startTime === b.startTime && a.bootId === b.bootId;
}

function openChannel(home, goalId, owner, create) {
  const directory = join(home, "goal-control");
  if (create) mkdirSync(directory, { mode: 0o700, recursive: true });
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const stat = fstatSync(fd);
    if (stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) {
      throw new Error("goal control directory must be private and owned by the current user");
    }
    const name = createHash("sha256")
      .update(JSON.stringify([goalId, owner.pid, owner.startTime, owner.bootId]))
      .digest("hex");
    // Keep long MATRIX_HOME paths within Linux's Unix socket path bound.
    return { fd, path: `/proc/self/fd/${fd}/${name}.sock` };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readFrame(socket, onFrame) {
  let frame = "";
  socket.setEncoding("utf8");
  socket.setTimeout(REQUEST_TIMEOUT, () => socket.destroy());
  socket.on("data", (data) => {
    frame += data;
    if (Buffer.byteLength(frame) > FRAME_LIMIT) {
      socket.destroy();
    } else if (frame.includes("\n")) {
      socket.removeAllListeners("data");
      try {
        onFrame(JSON.parse(frame));
      } catch {
        socket.destroy();
      }
    }
  });
}

export async function startGoalControl({ home, store, goalId, runtime }) {
  const owner = processIdentity(process.pid);
  if (!owner) throw new Error("cannot establish goal control identity");
  const channel = openChannel(home, goalId, owner, true);
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    readFrame(socket, (request) => {
      const { lease } = store.inspect(goalId);
      if (
        !lease ||
        !sameOwner(lease.owner, owner) ||
        request.leaseId !== lease.leaseId ||
        request.generation !== lease.generation ||
        !["pause", "cancel"].includes(request.action)
      ) {
        socket.end(JSON.stringify({ accepted: false }) + "\n");
        return;
      }
      runtime[request.action]();
      socket.end(JSON.stringify({ accepted: true }) + "\n");
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(channel.path, resolve);
    });
  } catch (error) {
    closeSync(channel.fd);
    throw error;
  }
  return async () => {
    try {
      for (const socket of sockets) socket.end();
      await new Promise((resolve) => server.close(resolve));
    } finally {
      closeSync(channel.fd);
    }
  };
}

export function goalOwnerIsLive(lease) {
  return Boolean(lease && sameOwner(processIdentity(lease.owner.pid), lease.owner));
}

export async function requestGoalControl({ home, goalId, lease, action }) {
  if (!goalOwnerIsLive(lease)) {
    throw new Error("the goal has no verified live owner");
  }
  const channel = openChannel(home, goalId, lease.owner, false);
  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection(channel.path);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("the goal owner did not acknowledge control")));
      socket.once("connect", () =>
        socket.write(
          JSON.stringify({ action, leaseId: lease.leaseId, generation: lease.generation }) + "\n",
        ),
      );
      readFrame(socket, (response) => {
        if (response.accepted === true) resolve(undefined);
        else reject(new Error("the goal owner refused stale control authority"));
        socket.destroy();
      });
    });
  } finally {
    closeSync(channel.fd);
  }
}
