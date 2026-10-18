import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawn, spawnSync, stopTestChildren } from "./test-support/bounded-test-process.mjs";
import { removeTestDirectory } from "./test-support/temp-directory.mjs";

afterEach(stopTestChildren);

it("rejects detached fixtures before starting a process", () => {
  expect(() => spawn(process.execPath, [], { detached: true })).toThrow("Detached fixtures");
  expect(() => spawnSync(process.execPath, [], { detached: true })).toThrow("Detached fixtures");
});

it("retains ordinary output and exit status", () => {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(7)"]);
  expect(result).toMatchObject({ status: 7, stdout: "out", stderr: "err" });
  expect(result.error).toBeUndefined();
});

it("bounds a synchronous hung child independently of the test event loop", () => {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 400 });
  expect(result.error?.code).toBe("ETIMEDOUT");
  expect(Date.now() - started).toBeLessThan(15000);
}, 20000);

it.skipIf(process.platform !== "win32")("stops only its owned hung process tree, including a fixture grandchild", () => {
  const directory = mkdtempSync(join(tmpdir(), "awardping-test-tree-"));
  const pidFile = join(directory, "owned-child.pid");
  try {
    const code = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'inherit'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const result = spawnSync(process.execPath, ["-e", code], { timeout: 1000 });
    expect(result.error?.code).toBe("ETIMEDOUT");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { removeTestDirectory(directory, "awardping-test-tree-"); }
}, 20000);

it("closes an owned asynchronous child on cleanup", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await stopTestChildren();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});
