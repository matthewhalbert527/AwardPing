import { createHash } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { normalizePublicHttpUrl } from "./public-network-safety.mjs";

const schema = "awardping.program-text-host-gate.v1";
const digest = value => createHash("sha256").update(value).digest("hex");
const busy = error => [5, 6].includes((error?.errcode || 0) & 255) || /database (?:is )?(?:locked|busy)/i.test(error?.message || "");

/** One SQLite transaction per host: OS locks recover on process death, without stale-file eviction. */
export function createProgramTextHostPacer({ directory, delayMs = 1500, waitTimeoutMs = 300000, pollMs = 100 } = {}) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 13) throw new Error("Shared host pacing requires Node.js 22.13 or newer");
  if (typeof directory !== "string" || !directory || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000 ||
      !Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 3600000 ||
      !Number.isInteger(pollMs) || pollMs < 1) throw new Error("Invalid host pacing options");
  const root = resolve(directory);
  async function acquire(host, deadline) {
    const { DatabaseSync } = await import("node:sqlite");
    await mkdir(root, { recursive: true });
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Invalid shared host pacing directory");
    const path = join(root, `${digest(host)}.sqlite`);
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Invalid shared host pacing database");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    while (Date.now() < deadline) {
      let database;
      try {
        database = new DatabaseSync(path);
        database.exec("PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS host_gate (singleton INTEGER PRIMARY KEY CHECK(singleton=1), schema TEXT NOT NULL, completed_at INTEGER NOT NULL CHECK(completed_at>=0)); BEGIN IMMEDIATE;");
        const row = database.prepare("SELECT schema, completed_at FROM host_gate WHERE singleton=1").get();
        if (row && (row.schema !== schema || !Number.isSafeInteger(row.completed_at) || row.completed_at < 0 || row.completed_at > Date.now() + 60000))
          throw new Error("Invalid shared host pacing timestamp");
        return { database, nextAt: row ? row.completed_at + delayMs : 0 };
      } catch (error) {
        database?.close();
        if (!busy(error)) throw error;
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new Error("Shared host pacing wait timed out");
  }
  async function release(lease, completedAt) {
    try {
      lease.database.prepare("INSERT INTO host_gate(singleton,schema,completed_at) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET schema=excluded.schema,completed_at=excluded.completed_at")
        .run(schema, completedAt);
      const deadline = Date.now() + 5000;
      while (true) {
        try { lease.database.exec("COMMIT"); break; }
        catch (error) {
          // A contender's brief schema read can delay a rollback-journal
          // commit. Retain our transaction and retry only this local barrier.
          if (!busy(error) || Date.now() >= deadline) throw error;
          await sleep(Math.min(pollMs, 25));
        }
      }
    } finally { lease.database.close(); }
  }
  return Object.freeze({
    async run(urls, action) {
      if (!Array.isArray(urls) || !urls.length || urls.length > 21 || typeof action !== "function") throw new Error("Invalid paced capture");
      const hosts = [...new Set(urls.map(url => normalizePublicHttpUrl(url).hostname.toLowerCase()))].sort();
      const leases = [], deadline = Date.now() + waitTimeoutMs;
      try {
        // Stable ordering avoids deadlock for explicitly approved cross-host redirects.
        for (const host of hosts) leases.push(await acquire(host, deadline));
        const nextAt = Math.max(...leases.map(lease => lease.nextAt));
        if (nextAt > deadline) throw new Error("Shared host pacing wait timed out");
        while (nextAt > Date.now()) await sleep(nextAt - Date.now());
        return await action();
      } finally {
        const completedAt = Date.now();
        const released = await Promise.allSettled(leases.reverse().map(lease => release(lease, completedAt)));
        const failure = released.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
      }
    },
  });
}
