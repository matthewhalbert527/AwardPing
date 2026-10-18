import { spawn as nativeSpawn, spawnSync as nativeSpawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const supervisor = fileURLToPath(new URL("./bounded-process-runner.mjs", import.meta.url));
const children = new Set();
const cleanupFailures = [];

export function spawnSync(command, args, options = {}) {
  if (options.detached) throw new Error("Detached fixtures are unsupported");
  const { timeout = 20000, input, ...childOptions } = options;
  delete childOptions.encoding;
  delete childOptions.maxBuffer;
  const result = nativeSpawnSync(process.execPath, [supervisor], {
    input: JSON.stringify({ command, args, options: childOptions, input, timeout }),
    encoding: "utf8", windowsHide: true, timeout: timeout + 15000, maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Test process supervisor failed: ${result.stderr}`);
  const value = JSON.parse(result.stdout);
  if (value.error) value.error = Object.assign(new Error(value.error.message), value.error);
  return value;
}

export function spawn(command, args, options = {}) {
  if (options.detached) throw new Error("Detached fixtures are unsupported");
  const { timeout = 60000, ...childOptions } = options;
  const child = nativeSpawn(command, args, { ...childOptions, windowsHide: true });
  children.add(child);
  const nativeKill = child.kill.bind(child);
  child.kill = () => {
    if (!child.pid || !children.has(child)) return false;
    if (child.exitCode !== null || child.signalCode !== null) {
      child.testCleanupError = new Error("Unsupported fixture: parent exited with pipes still open; descendant cleanup unverified");
      cleanupFailures.push(child.testCleanupError);
      child.stdout?.destroy(); child.stderr?.destroy();
      return false;
    }
    if (process.platform !== "win32") return nativeKill("SIGKILL");
    const stopped = nativeSpawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8", timeout: 10000 });
    if (stopped.error || stopped.status !== 0) {
      child.testCleanupError = stopped.error || new Error(`Owned test tree termination exited ${stopped.status}: ${stopped.stderr}`);
      cleanupFailures.push(child.testCleanupError);
      try { child.testCleanupError.fallback = nativeKill("SIGKILL") ? "direct_child_signal_sent" : "direct_child_signal_not_sent"; }
      catch (error) { child.testCleanupError.fallback = error.code || "direct_child_signal_failed"; }
      return false;
    }
    return stopped.status === 0;
  };
  const timer = setTimeout(() => { child.testTimeout = true; child.kill(); }, timeout);
  child.once("close", () => { clearTimeout(timer); children.delete(child); });
  child.once("error", () => { clearTimeout(timer); children.delete(child); });
  return child;
}

export async function stopTestChildren() {
  const pending = [...children];
  await Promise.all(pending.map(child => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Owned test child ${child.pid} did not close after termination`)), 12000);
    child.once("close", () => { clearTimeout(deadline); resolve(); });
    child.kill();
  })));
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures.splice(0), "Fixture process cleanup was not fully verified");
}
