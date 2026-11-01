import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { spawn, stopTestChildren } from "../test-support/bounded-test-process.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { collectionCycleBoundary, createCollectionCycleStore } from "./program-text-collection-cycle.mjs";

const directories = [];
const epoch = "11111111-1111-4111-8111-111111111111", revision = "a".repeat(40), rosterSeal = "b".repeat(64);
async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "awardping-collection-cycle-")); directories.push(directory);
  let clock = Date.parse("2026-11-01T23:00:01Z");
  const options = { directory, epoch, revision, rosterSeal, anchorMinuteUtc: 1380, now: () => clock, ...overrides };
  return { directory, options, store: createCollectionCycleStore(options), set: value => { clock = Date.parse(value); } };
}
afterEach(async () => { await stopTestChildren(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("collection completion coverage scheduling", () => {
  it("uses the scheduled UTC boundary across midnight, local DST and a late start", () => {
    for (const now of ["2026-11-01T23:00:00Z", "2026-11-02T00:15:00Z", "2026-11-02T01:30:00-06:00"])
      expect(new Date(collectionCycleBoundary(Date.parse(now), 1380)).toISOString()).toBe("2026-11-01T23:00:00.000Z");
    expect(new Date(collectionCycleBoundary(Date.parse("2026-11-01T23:59:00Z"), 10)).toISOString()).toBe("2026-11-01T00:10:00.000Z");
  });
  it("waits for every shard and permits exactly one concurrent report claim", async () => {
    const f = await fixture(), handles = await Promise.all([0, 1, 2].map(i => f.store.begin(i)));
    await f.store.finish(handles[0], { status: "succeeded" });
    await f.store.finish(handles[1], { status: "succeeded" });
    expect(await f.store.claimReport()).toBeNull();
    expect((await f.store.finish(handles[2], { status: "succeeded" })).reportReady).toBe(true);
    const claims = await Promise.all([f.store.claimReport(), createCollectionCycleStore(f.options).claimReport()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean);
    expect(claim.cycle.complete).toBe(true);
    await f.store.finishReport(claim, { status: "succeeded" });
    expect(await f.store.claimReport()).toBeNull();
  });
  it("reports a failed collector after all three finish, without claiming full coverage", async () => {
    const f = await fixture();
    for (const i of [0, 1, 2]) {
      const handle = await f.store.begin(i);
      await f.store.finish(handle, { status: i === 1 ? "failed" : "succeeded", reason: i === 1 ? "source_capture_failed" : null });
    }
    const claim = await f.store.claimReport();
    expect(claim.cycle.complete).toBe(false);
    expect(claim.cycle.shards[1]).toEqual({ index: 1, status: "failed", reason: "source_capture_failed" });
  });
  it("reports lost and unstarted shards only after the bounded cycle expires", async () => {
    const f = await fixture(); await f.store.begin(0);
    f.set("2026-11-02T21:59:59Z"); expect(await f.store.claimReport()).toBeNull();
    f.set("2026-11-02T22:00:00Z");
    const claim = await f.store.claimReport();
    expect(claim.cycle).toMatchObject({ complete: false, expired: true });
    expect(claim.cycle.shards[0].incomplete_reason).toBe("collector_did_not_finish");
    expect(claim.cycle.shards[1].incomplete_reason).toBe("collector_did_not_start");
  });
  it("retains entirely missed cycles and prioritizes their expired report over a new unfinished cycle", async () => {
    const f = await fixture(); expect(await f.store.claimReport()).toBeNull();
    f.set("2026-11-02T23:30:00Z");
    const claim = await f.store.claimReport();
    expect(claim.cycle.boundary_utc).toBe("2026-11-01T23:00:00.000Z");
    expect(claim.cycle.shards.every(s => s.status === "missing")).toBe(true);
  });
  it("cannot mix revisions, rosters, duplicate starts or the next daily cycle", async () => {
    const f = await fixture(), first = await f.store.begin(0);
    await expect(f.store.begin(0)).rejects.toThrow("already started");
    const changed = createCollectionCycleStore({ ...f.options, rosterSeal: "c".repeat(64) });
    await expect(changed.begin(1)).rejects.toThrow("roster changed");
    const separate = createCollectionCycleStore({ ...f.options, revision: "d".repeat(40) });
    await separate.begin(0);
    f.set("2026-11-02T23:00:01Z");
    const next = await f.store.begin(0);
    expect(next.boundary).not.toBe(first.boundary);
    await expect(f.store.finish({ ...next, token: first.token }, { status: "succeeded" })).rejects.toThrow("does not own");
  });
  it("can report an expired earlier roster without presenting it as the current one", async () => {
    const f = await fixture(); await f.store.begin(0);
    f.set("2026-11-02T23:30:00Z");
    const claim = await createCollectionCycleStore({ ...f.options, rosterSeal: "c".repeat(64) }).claimReport();
    expect(claim.cycle.roster_seal).toBe(rosterSeal);
    expect(claim.cycle.current_roster_seal).toBe("c".repeat(64));
    expect(claim.cycle.complete).toBe(false);
  });
  it("bounds retries and rejects a superseded report claim", async () => {
    const f = await fixture();
    for (const i of [0, 1, 2]) await f.store.finish(await f.store.begin(i), { status: "succeeded" });
    const first = await f.store.claimReport();
    f.set("2026-11-01T23:11:00Z");
    const second = await f.store.claimReport();
    expect(second.attempt).toBe(2);
    await expect(f.store.finishReport(first, { status: "succeeded" })).rejects.toThrow("claim changed");
    await f.store.finishReport(second, { status: "failed" });
    f.set("2026-11-02T23:30:00Z"); expect(await f.store.claimReport()).toBeNull();
  });
  it("rejects corrupted expiry and ownership metadata", async () => {
    const f = await fixture(); await f.store.begin(0);
    const [scope] = await readdir(f.directory), [name] = (await readdir(join(f.directory, scope))).filter(x => x.endsWith(".json"));
    const path = join(f.directory, scope, name), row = JSON.parse(await readFile(path, "utf8"));
    row.expires_at = 0; await writeFile(path, JSON.stringify(row));
    await expect(f.store.claimReport()).rejects.toThrow("Invalid collection cycle state");
  });
  it("recovers the OS mutex after an actual child exits while holding it", async () => {
    const f = await fixture(); await f.store.claimReport();
    const [scope] = await readdir(f.directory);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(${JSON.stringify(join(f.directory, scope, ".mutex.sqlite"))});
      db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked'); setInterval(()=>{},1000);
    `], { stdio: ["ignore", "pipe", "pipe"], timeout: 12000 });
    await new Promise((done, reject) => {
      const deadline = setTimeout(() => reject(new Error("Owned lock fixture did not start")), 8000);
      child.stdout.once("data", () => { clearTimeout(deadline); done(); });
      child.once("error", error => { clearTimeout(deadline); reject(error); });
    });
    const closed = once(child, "close"); child.kill(); await closed;
    const handle = await f.store.begin(0);
    expect(handle.shardIndex).toBe(0);
  }, 20000);
  it("merges three independent process completions without dropping a shard", async () => {
    const f = await fixture();
    const options = { ...f.options, now: undefined };
    const results = await Promise.all([0, 1, 2].map(async index => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { createCollectionCycleStore } from ${JSON.stringify(new URL("./program-text-collection-cycle.mjs", import.meta.url).href)};
        const store=createCollectionCycleStore({...${JSON.stringify(options)},now:()=>Date.parse('2026-11-01T23:00:01Z')});
        const handle=await store.begin(${index}); await store.finish(handle,{status:'succeeded'});
      `], { stdio: ["ignore", "pipe", "pipe"], timeout: 12000 });
      let error = ""; child.stderr.on("data", data => { error += data; });
      const [code] = await once(child, "close");
      return { code, error };
    }));
    for (const result of results) expect(result.code, result.error).toBe(0);
    expect((await f.store.claimReport()).cycle.complete).toBe(true);
  }, 20000);
  it("waits for a real SQLite reader while initializing and committing the mutex database", async () => {
    const f = await fixture();
    const scope = createHash("sha256").update(JSON.stringify({ epoch, revision, anchorMinuteUtc: 1380, shardCount: 3 })).digest("hex");
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { mkdir } from 'node:fs/promises'; import { DatabaseSync } from 'node:sqlite';
      await mkdir(${JSON.stringify(join(f.directory, scope))},{recursive:true});
      const db=new DatabaseSync(${JSON.stringify(join(f.directory, scope, ".mutex.sqlite"))});
      db.exec('BEGIN; SELECT count(*) FROM sqlite_schema'); process.stdout.write('reader');
      process.stdin.once('data',data=>{
        if(data.toString().trim()!=='release')throw Error('Unexpected reader command');
        db.exec('COMMIT');db.close();process.stdin.destroy();
      });process.stdin.resume();
    `], { stdio: ["pipe", "pipe", "pipe"], timeout: 12000 });
    await new Promise((done, reject) => {
      const deadline = setTimeout(() => reject(new Error("Owned reader fixture did not start")), 8000);
      child.stdout.once("data", () => { clearTimeout(deadline); done(); });
      child.once("error", error => { clearTimeout(deadline); reject(error); });
    });
    const closed = once(child, "close");
    let settled = false, failure, handle;
    const operation = f.store.begin(0).then(value => { handle = value; settled = true; }, error => { failure = error; settled = true; });
    // A retained JSON row proves the protected operation reached its commit;
    // the reader remains held until this parent explicitly releases it.
    const row = join(f.directory, scope, `${Date.parse('2026-11-01T23:00:00Z')}.json`);
    const deadline = Date.now() + 4000;
    while (true) {
      try { await readFile(row); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Date.now() >= deadline || settled) throw failure || new Error("Owned writer did not reach its commit");
      await new Promise(done => setTimeout(done, 10));
    }
    expect(settled).toBe(false);
    child.stdin.end("release\n");
    await operation;
    if (failure) throw failure;
    const [code] = await closed;
    expect(code).toBe(0); expect(handle.shardIndex).toBe(0);
  }, 20000);
});
