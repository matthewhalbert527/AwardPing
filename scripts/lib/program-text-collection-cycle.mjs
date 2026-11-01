import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, stat } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const schema = "awardping.program-text-collection-cycle.v1";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const day = 86400000;
const expiry = 23 * 3600000;
const reportLease = 10 * 60000;
const terminal = new Set(["succeeded", "failed"]);
const hash = value => createHash("sha256").update(value).digest("hex");

export function collectionCycleBoundary(now, anchorMinuteUtc) {
  if (!Number.isFinite(now) || !Number.isInteger(anchorMinuteUtc) || anchorMinuteUtc < 0 || anchorMinuteUtc >= 1440) throw new Error("Invalid collection cycle clock");
  const boundary = Math.floor(now / day) * day + anchorMinuteUtc * 60000;
  return boundary > now ? boundary - day : boundary;
}

/** Local scheduling evidence only; this never changes source/fact/publication data.
 * A revision/epoch/clock scope can retain earlier roster seals for honest timeout
 * reports, but a single daily cycle cannot combine shards from different rosters.
 */
export function createCollectionCycleStore({ directory, epoch, revision, rosterSeal, anchorMinuteUtc, shardCount = 3,
  now = () => Date.now() } = {}) {
  if (typeof directory !== "string" || !directory || !uuid.test(epoch) || !revisionPattern.test(revision) ||
      !digest.test(rosterSeal) || shardCount !== 3 || !Number.isInteger(anchorMinuteUtc) || anchorMinuteUtc < 0 || anchorMinuteUtc >= 1440) {
    throw new Error("Invalid collection cycle scope");
  }
  const scope = hash(JSON.stringify({ epoch, revision, anchorMinuteUtc, shardCount }));
  const root = resolve(directory, scope);
  const filename = boundary => join(root, `${boundary}.json`);
  const time = () => { const t = now(); if (!Number.isFinite(t)) throw new Error("Invalid collection cycle time"); return t; };

  async function withLock(fn) {
    await mkdir(root, { recursive: true });
    // SQLite provides only the OS-owned mutex; JSON remains the audit journal.
    // The OS releases a crashed owner's lock without PID guesses or a reaper.
    const db = new DatabaseSync(join(root, ".mutex.sqlite"));
    const deadline = Date.now() + 5000;
    let owned = false;
    try {
      db.exec("PRAGMA busy_timeout=0");
      while (!owned) {
        try {
          db.exec("BEGIN IMMEDIATE"); owned = true;
        } catch (e) {
          if (![5, 6].includes((Number(e.errcode) || 0) & 255)) throw e;
          if (Date.now() >= deadline) throw new Error("Collection cycle state is busy");
          await new Promise(done => setTimeout(done, 20));
        }
      }
      const result = await fn();
      const commitDeadline = Date.now() + 5000;
      while (owned) {
        try { db.exec("COMMIT"); owned = false; }
        catch (e) {
          if (![5, 6].includes((Number(e.errcode) || 0) & 255)) throw e;
          if (Date.now() >= commitDeadline) throw new Error("Collection cycle state commit is busy");
          await new Promise(done => setTimeout(done, 20));
        }
      }
      return result;
    } finally {
      try { if (owned) db.exec("ROLLBACK"); } finally { db.close(); }
    }
  }

  function validate(row, boundary) {
    if (!row || row.schema !== schema || row.epoch !== epoch || row.revision !== revision || row.boundary !== boundary ||
        !Number.isSafeInteger(boundary) || boundary < 0 || collectionCycleBoundary(boundary, anchorMinuteUtc) !== boundary || row.expires_at !== boundary + expiry ||
        row.anchor_minute_utc !== anchorMinuteUtc || row.shard_count !== shardCount || !digest.test(row.roster_seal) ||
        !Array.isArray(row.shards) || row.shards.length !== shardCount ||
        row.shards.some((s, i) => s.index !== i || !["missing", "running", "succeeded", "failed"].includes(s.status) ||
          s.status !== "missing" && (!Number.isInteger(s.pid) || s.pid < 1 || !uuid.test(s.token) || !Number.isFinite(s.started_at) || s.started_at < boundary || s.started_at >= row.expires_at) ||
          terminal.has(s.status) && (!Number.isFinite(s.finished_at) || s.finished_at < s.started_at)) ||
        !row.report || !["waiting", "running", "succeeded", "failed"].includes(row.report.status) ||
        !Number.isInteger(row.report.attempts) || row.report.attempts < 0 || row.report.attempts > 2 ||
        row.report.status !== "waiting" && (!uuid.test(row.report.token) || !Number.isFinite(row.report.started_at)) ||
        row.report.status === "failed" && !Number.isFinite(row.report.retry_after)) throw new Error("Invalid collection cycle state");
    return row;
  }
  const fresh = boundary => ({ schema, epoch, revision, roster_seal: rosterSeal, anchor_minute_utc: anchorMinuteUtc,
    shard_count: shardCount, boundary, expires_at: boundary + expiry,
    shards: Array.from({ length: shardCount }, (_, index) => ({ index, status: "missing" })), report: { status: "waiting", attempts: 0 } });
  async function load(boundary) {
    try {
      const bytes = await readFile(filename(boundary));
      if (bytes.length > 65536) throw new Error("Collection cycle state is too large");
      return validate(JSON.parse(bytes.toString("utf8")), boundary);
    } catch (e) { if (e.code === "ENOENT") return fresh(boundary); throw e; }
  }
  async function save(row) {
    validate(row, row.boundary);
    const target = filename(row.boundary), temporary = `${target}.${randomUUID()}.tmp`;
    if (!target.startsWith(`${root}${sep}`)) throw new Error("Invalid collection cycle path");
    await writeFile(temporary, JSON.stringify(row), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }
  const ready = row => row.shards.every(shard => terminal.has(shard.status));
  const snapshot = (row, expired) => ({ cycle_id: `${scope}:${row.boundary}`, boundary_utc: new Date(row.boundary).toISOString(),
    epoch, revision, roster_seal: row.roster_seal, current_roster_seal: rosterSeal, expired,
    complete: ready(row) && row.shards.every(s => s.status === "succeeded"),
    shards: row.shards.map(s => ({ index: s.index, status: s.status,
      ...(s.reason ? { reason: s.reason } : {}), ...(expired && !terminal.has(s.status) ? { incomplete_reason: s.status === "missing" ? "collector_did_not_start" : "collector_did_not_finish" } : {}) })) });

  return {
    async begin(shardIndex, { pid = process.pid } = {}) {
      if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount || !Number.isInteger(pid) || pid < 1) throw new Error("Invalid collection shard");
      return withLock(async () => {
        const started = time(), boundary = collectionCycleBoundary(started, anchorMinuteUtc), row = await load(boundary);
        if (row.roster_seal !== rosterSeal) throw new Error("Collection roster changed within the scheduled cycle");
        if (started >= row.expires_at) throw new Error("Scheduled collection cycle has expired");
        const previous = row.shards[shardIndex];
        if (previous.status !== "missing") throw new Error("Scheduled collector already started for this cycle");
        const token = randomUUID();
        row.shards[shardIndex] = { index: shardIndex, status: "running", pid, token, started_at: started };
        await save(row);
        return Object.freeze({ scope, boundary, shardIndex, token });
      });
    },
    async finish(handle, { status, reason = null } = {}) {
      if (!handle || handle.scope !== scope || !Number.isSafeInteger(handle.boundary) || !terminal.has(status) ||
          !Number.isInteger(handle.shardIndex) || handle.shardIndex < 0 || handle.shardIndex >= shardCount || !uuid.test(handle.token) ||
          !(reason === null || typeof reason === "string" && /^[a-z0-9_:-]{1,160}$/.test(reason))) throw new Error("Invalid collection finish");
      return withLock(async () => {
        const row = await load(handle.boundary), shard = row.shards[handle.shardIndex];
        if (row.roster_seal !== rosterSeal || shard.status !== "running" || shard.token !== handle.token) throw new Error("Collection finish does not own this shard");
        Object.assign(shard, { status, finished_at: time(), ...(reason ? { reason } : {}) });
        await save(row);
        return { reportReady: ready(row), cycle: snapshot(row, time() >= row.expires_at) };
      });
    },
    async claimReport({ allowExpired = true } = {}) {
      return withLock(async () => {
        const current = time(), boundary = collectionCycleBoundary(current, anchorMinuteUtc);
        // Preserve an explicit missing-cycle record when a scheduled fallback
        // fires before any collector starts. It becomes reportable at expiry.
        const currentRow = await load(boundary);
        try { await stat(filename(boundary)); } catch (e) { if (e.code !== "ENOENT") throw e; await save(currentRow); }
        const names = (await readdir(root)).filter(name => /^\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
        for (const name of names) {
          const row = await load(Number(name.slice(0, -5))), expired = current >= row.expires_at;
          if (row.boundary > boundary || !(ready(row) || allowExpired && expired) || row.report.status === "succeeded" || row.report.attempts >= 2) continue;
          if (row.report.status === "running" && current < row.report.started_at + reportLease) continue;
          if (row.report.status === "failed" && current < row.report.retry_after) continue;
          const token = randomUUID();
          row.report = { status: "running", attempts: row.report.attempts + 1, token, started_at: current };
          await save(row);
          return Object.freeze({ scope, boundary: row.boundary, token, attempt: row.report.attempts, cycle: snapshot(row, expired) });
        }
        return null;
      });
    },
    async finishReport(claim, { status } = {}) {
      if (!claim || claim.scope !== scope || !Number.isSafeInteger(claim.boundary) || !uuid.test(claim.token) || !terminal.has(status)) throw new Error("Invalid report result");
      return withLock(async () => {
        const row = await load(claim.boundary);
        if (row.report.status !== "running" || row.report.token !== claim.token) throw new Error("Report claim changed");
        Object.assign(row.report, { status, finished_at: time(), ...(status === "failed" ? { retry_after: time() + day } : {}) });
        await save(row);
      });
    },
  };
}
