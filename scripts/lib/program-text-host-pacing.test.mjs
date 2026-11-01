import { mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn, stopTestChildren } from "../test-support/bounded-test-process.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, it, expect } from "vitest";
import { createProgramTextHostPacer } from "./program-text-host-pacing.mjs";

const key = createHash("sha256").update("example.edu").digest("hex");
const url = "https://example.edu/award";
afterEach(stopTestChildren);
async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), "awardping-host-gate-"));
  try { return await action(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
describe("cross-process source host pacing", () => {
  it("serializes independent workers for one hostname and applies the cooldown after failures", async () => fixture(async directory => {
    const first = createProgramTextHostPacer({ directory, delayMs: 40, pollMs: 5 });
    const second = createProgramTextHostPacer({ directory, delayMs: 40, pollMs: 5 });
    const events = [];
    await Promise.all([
      first.run([url], async () => { events.push(["first", Date.now()]); await sleep(30); events.push(["end", Date.now()]); }),
      second.run([url + "/second"], async () => { events.push(["second", Date.now()]); }),
    ]);
    const starts = events.filter(([kind]) => kind !== "end").map(([, time]) => time);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(38);
    await expect(first.run([url], () => { throw new Error("source_failed"); })).rejects.toThrow("source_failed");
    const database = new DatabaseSync(join(directory, `${key}.sqlite`));
    const failureAt = database.prepare("SELECT completed_at FROM host_gate").get().completed_at; database.close();
    await second.run([url], () => expect(Date.now() - failureAt).toBeGreaterThanOrEqual(40));
  }));
  it("also excludes approved redirect hosts, independent of URL order", async () => fixture(async directory => {
    const a = createProgramTextHostPacer({ directory, delayMs: 0, pollMs: 5 });
    const b = createProgramTextHostPacer({ directory, delayMs: 0, pollMs: 5 });
    let active = 0;
    const action = async () => { expect(active++).toBe(0); await sleep(10); active--; };
    await Promise.all([a.run([url, "https://other.edu/award"], action), b.run(["https://other.edu/else", url], action)]);
  }));
  it("bounds waits for active owners while independent hosts remain parallel", async () => fixture(async directory => {
    let entered, unblock;
    const ready = new Promise(resolve => { entered = resolve; }), blocking = new Promise(resolve => { unblock = resolve; });
    const first = createProgramTextHostPacer({ directory, delayMs: 0 }).run([url], async () => { entered(); await blocking; });
    await ready;
    try {
      await expect(createProgramTextHostPacer({ directory, delayMs: 0, pollMs: 5, waitTimeoutMs: 30 }).run([url], () => {})).rejects.toThrow("wait timed out");
      await createProgramTextHostPacer({ directory, delayMs: 0, pollMs: 5, waitTimeoutMs: 30 }).run(["https://independent.edu/award"], () => {});
    } finally { unblock(); await first; }
  }));
  it("recovers automatically when an owned child dies while holding its host transaction", async () => fixture(async directory => {
    const moduleUrl = new URL("./program-text-host-pacing.mjs", import.meta.url).href;
    const script = `import {createProgramTextHostPacer} from ${JSON.stringify(moduleUrl)};
      await createProgramTextHostPacer({directory:process.argv[1],delayMs:0}).run(['https://example.edu/award'],async()=>{
        process.stdout.write('held\\n'); await new Promise(()=>{setInterval(()=>{},1000)});});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, directory], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => child.once("close", resolve));
    try {
      await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); child.once("exit", () => reject(new Error("Owned crash fixture exited before acquiring"))); });
      child.kill("SIGKILL"); await exited;
      await createProgramTextHostPacer({ directory, delayMs: 0, waitTimeoutMs: 1000, pollMs: 5 }).run([url], () => {});
    } finally { child.kill("SIGKILL"); await exited; }
  }), 15000);
  it("coordinates actual child processes against one shared host", async () => fixture(async directory => {
    const moduleUrl = new URL("./program-text-host-pacing.mjs", import.meta.url).href;
    const script = `import {createProgramTextHostPacer} from ${JSON.stringify(moduleUrl)};
      import {appendFile} from 'node:fs/promises'; import {setTimeout} from 'node:timers/promises';
      await createProgramTextHostPacer({directory:process.argv[1],delayMs:35,pollMs:5}).run(['https://example.edu/award'],async()=>{
        await appendFile(process.argv[2],JSON.stringify({kind:'start',pid:process.pid,time:Date.now()})+'\\n');
        await setTimeout(25);
        await appendFile(process.argv[2],JSON.stringify({kind:'end',pid:process.pid,time:Date.now()})+'\\n');});`;
    const log = join(directory, "events.jsonl");
    const child = () => new Promise((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", script, directory, log], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let errors = ""; process.stderr.on("data", data => { errors += data; });
      process.once("error", reject); process.once("close", code => code === 0 ? resolve() : reject(new Error(errors)));
    });
    const children = await Promise.allSettled([child(), child(), child()]);
    const failed = children.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    const events = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    expect(events.map(row => row.kind)).toEqual(["start", "end", "start", "end", "start", "end"]);
    expect(events[2].time - events[1].time).toBeGreaterThanOrEqual(30);
    expect(events[4].time - events[3].time).toBeGreaterThanOrEqual(30);
  }), 15000);
});
