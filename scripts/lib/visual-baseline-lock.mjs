import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";

export function withVisualBaselineLock({
  archiveRoot,
  sourceId,
  operation,
  timeoutMs = 30_000,
  staleAfterMs = 10 * 60_000,
  now = () => Date.now(),
} = {}) {
  if (!archiveRoot || !sourceId) throw new TypeError("archiveRoot and sourceId are required.");
  if (typeof operation !== "function") throw new TypeError("operation is required.");
  const { lockPath, token } = acquireLock({
    archiveRoot, sourceId, timeoutMs, staleAfterMs, now,
  });

  try {
    return operation({ lockPath, token });
  } finally {
    releaseOwnedLock(lockPath, token);
  }
}

export async function withVisualBaselineLockAsync({
  archiveRoot,
  sourceId,
  operation,
  timeoutMs = 30_000,
  staleAfterMs = 10 * 60_000,
  now = () => Date.now(),
} = {}) {
  if (!archiveRoot || !sourceId) throw new TypeError("archiveRoot and sourceId are required.");
  if (typeof operation !== "function") throw new TypeError("operation is required.");
  if (process.platform === "win32") {
    const lockPath = windowsBaselineMutexPath(archiveRoot, sourceId);
    const server = await acquireWindowsBaselineMutex({
      lockPath,
      sourceId,
      timeoutMs,
      now,
    });
    const token = randomUUID();
    try {
      return await operation({ lockPath, token });
    } finally {
      await closeServer(server);
    }
  }

  const { lockPath, token } = acquireLock({
    archiveRoot, sourceId, timeoutMs, staleAfterMs, now,
  });
  try {
    return await operation({ lockPath, token });
  } finally {
    releaseOwnedLock(lockPath, token);
  }
}

export function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

function tryCreateLock(path, token, timestamp) {
  let descriptor;
  try {
    descriptor = openSync(path, "wx");
    writeFileSync(descriptor, JSON.stringify({
      token,
      acquired_at_ms: timestamp,
      pid: process.pid,
    }), "utf8");
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function acquireLock({ archiveRoot, sourceId, timeoutMs, staleAfterMs, now }) {
  const lockPath = join(resolve(archiveRoot), "sources", sourceId, ".baseline.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const startedAt = now();
  let acquired = tryCreateLock(lockPath, token, now());
  while (!acquired) {
    acquired = recoverStaleLockAndCreate(lockPath, token, staleAfterMs, now());
    if (acquired) break;
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for visual baseline lock: ${sourceId}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return { lockPath, token };
}

function recoverStaleLockAndCreate(path, token, staleAfterMs, timestamp) {
  const recoveryPath = `${path}.recovery`;
  const recoveryToken = randomUUID();
  // Recovery markers are deliberately never reclaimed by pathname. Reading a
  // stale marker and then unlinking it allows a replacement owner's marker to
  // be deleted in the gap. Production Windows workers use the OS-owned named
  // pipe mutex above, which is released automatically when a process exits.
  if (!tryCreateLock(recoveryPath, recoveryToken, timestamp)) return false;
  try {
    const owner = readLock(path);
    if (owner?.pid && processIsAlive(owner.pid)) return false;
    const acquiredAt = Number(owner?.acquired_at_ms || fileModifiedAt(path));
    if (timestamp - acquiredAt < staleAfterMs) return false;
    const stalePath = `${path}.stale-${randomUUID()}`;
    try {
      renameSync(path, stalePath);
      unlinkSync(stalePath);
    } catch (error) {
      if (!["ENOENT", "EACCES", "EPERM"].includes(error?.code)) throw error;
    }
    return tryCreateLock(path, token, timestamp);
  } finally {
    releaseOwnedLock(recoveryPath, recoveryToken);
  }
}

function windowsBaselineMutexPath(archiveRoot, sourceId) {
  const identity = `${resolve(archiveRoot).toLowerCase()}\0${sourceId}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 40);
  return `\\\\.\\pipe\\awardping-visual-baseline-${digest}`;
}

async function acquireWindowsBaselineMutex({ lockPath, sourceId, timeoutMs, now }) {
  const startedAt = now();
  while (true) {
    try {
      return await listenOnNamedPipe(lockPath);
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
      if (now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for visual baseline lock: ${sourceId}`);
      }
      await delay(50);
    }
  }
}

function listenOnNamedPipe(lockPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error) => {
      server.removeListener("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolvePromise(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(lockPath);
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function processIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function fileModifiedAt(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

function releaseOwnedLock(path, token) {
  const owner = readLock(path);
  if (owner?.token !== token) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function readLock(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
