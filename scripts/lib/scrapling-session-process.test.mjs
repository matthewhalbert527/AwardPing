import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn, stopTestChildren } from "../test-support/bounded-test-process.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it, expect } from "vitest";
import { createScraplingBrowserSessionPool } from "./scrapling-session-process.mjs";
afterEach(stopTestChildren);

async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), "awardping-session-test-")), script = join(directory, "worker.mjs");
  await writeFile(script, `import {createInterface} from 'node:readline';
    for await (const line of createInterface({input:process.stdin})) {
      const request=JSON.parse(line);
      if(request.source_id==='invalid') process.stdout.write('bad-json\\n');
      else if(request.source_id==='exit') process.exit(2);
      else process.stdout.write(JSON.stringify({pid:process.pid,source_id:request.source_id})+'\\n');
    }`);
  const launches = [];
  const spawnImpl = (executable, args, options) => {
    if (executable === "taskkill.exe") return spawn(executable, args, options);
    launches.push({ executable, args, options });
    return spawn(process.execPath, [script], { ...options, detached: false, timeout: 10000 });
  };
  const pools = [];
  const pool = options => { const value = createScraplingBrowserSessionPool({ spawnImpl, ...options }); pools.push(value); return value; };
  try { return await action({ pool, launches }); } finally {
    for (const value of pools) await value.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const options = id => ({ pythonPath: "owned-python", executablePath: "owned-browser", request: { source_id: id }, timeoutMs: 1000 });
describe("run-scoped owned browser bridge", () => {
  it("reuses one owned process, bounds lifetime and never passes service credentials", async () => fixture(async ({ pool, launches }) => {
    const session = pool({ maxRequests: 2 });
    const first = await session.capture(options("a")), second = await session.capture(options("b"));
    expect(first.pid).toBe(second.pid); expect(launches).toHaveLength(1);
    const third = await session.capture(options("c"));
    expect(third.pid).not.toBe(first.pid); expect(launches).toHaveLength(2);
    expect(launches[0].args.at(-1)).toBe("--session-worker");
    expect(launches[0].options.env).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(launches[0].options.windowsHide).toBe(true);
    await session.close(); await expect(session.capture(options("d"))).rejects.toThrow("invalid_collector_session_state");
  }), 15000);
  it("discards a process after malformed output and permits a fresh later capture", async () => fixture(async ({ pool, launches }) => {
    const session = pool();
    await expect(session.capture(options("invalid"))).rejects.toThrow("invalid_collector_output");
    expect((await session.capture(options("new"))).source_id).toBe("new");
    expect(launches).toHaveLength(2);
  }), 15000);
  it("rejects concurrent use instead of mixing request or evidence streams", async () => fixture(async ({ pool }) => {
    const session = pool(), first = session.capture(options("one"));
    await expect(session.capture(options("two"))).rejects.toThrow("invalid_collector_session_state");
    expect((await first).source_id).toBe("one");
  }));
  it("holds an interrupted capture and starts a new process on the next call", async () => fixture(async ({ pool, launches }) => {
    const session = pool();
    await expect(session.capture(options("exit"))).rejects.toThrow("collector_session_exit");
    expect((await session.capture(options("new"))).source_id).toBe("new");
    expect(launches).toHaveLength(2);
  }));
});
