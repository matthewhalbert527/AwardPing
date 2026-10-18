// Test-only supervisor. Its event loop remains live while the test uses spawnSync.
import { spawn } from "node:child_process";
import { join } from "node:path";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const { command, args, options = {}, timeout = 20000 } = request;
if (!Number.isInteger(timeout) || timeout < 1 || timeout > 180000) throw new Error("Invalid test subprocess timeout");
if (options.detached) throw new Error("Detached fixtures are unsupported");
let stdout = "", stderr = "", failure, finished = false, stopping = false, terminal, terminationComplete = true;
const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const flush = () => {
  if (finished || !terminal || !terminationComplete) return;
  finished = true;
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ ...terminal, stdout, stderr, ...(failure ? { error: failure } : {}) }));
};
const finish = (status, signal) => { terminal = { status, signal }; flush(); };
function fallback() {
  // A fallback only targets this direct child. It is not proof that every
  // descendant was terminated; the tree-cleanup failure remains in the result.
  try { failure.fallback = child.kill("SIGKILL") ? "direct_child_signal_sent" : "direct_child_signal_not_sent"; }
  catch (error) { failure.fallback = error.code || "direct_child_signal_failed"; }
}
function stop(reason) {
  if (stopping || finished) return;
  stopping = true;
  failure = { code: reason, message: `Test subprocess ${reason}; termination requested for its exact owned process tree` };
  if (child.exitCode !== null || child.signalCode !== null) {
    // Supported fixtures retain their parent until descendants finish. Do not
    // taskkill a PID after its owning process has exited/released ownership.
    failure.code = "UNSUPPORTED_PARENT_EXIT";
    failure.message = "Fixture parent exited with pipes still open; descendant ownership and cleanup are unverified";
    child.stdout.destroy(); child.stderr.destroy();
    return;
  }
  if (process.platform === "win32") {
    // The live ChildProcess handle is our ownership evidence; never enumerate or
    // terminate by process name or by an install-root substring.
    terminationComplete = false;
    const killer = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const killTimer = setTimeout(() => { failure.cleanup = "tree_termination_timeout"; killer.kill(); fallback(); }, 10000);
    killer.once("close", code => {
      clearTimeout(killTimer);
      terminationComplete = true;
      if (code !== 0) { failure.cleanup ||= `tree_termination_exit_${code}`; fallback(); }
      flush();
    });
    killer.once("error", error => { clearTimeout(killTimer); failure.cleanup = error.code; terminationComplete = true; fallback(); flush(); });
  } else child.kill("SIGKILL");
}
const timer = setTimeout(() => stop("ETIMEDOUT"), timeout);
child.stdout.on("data", value => { stdout += value; if (stdout.length > 8 * 1024 * 1024) { stdout = stdout.slice(0, 8 * 1024 * 1024); stop("OUTPUT_LIMIT"); } });
child.stderr.on("data", value => { stderr += value; if (stderr.length > 8 * 1024 * 1024) { stderr = stderr.slice(0, 8 * 1024 * 1024); stop("OUTPUT_LIMIT"); } });
child.once("error", error => { failure = { code: error.code, message: error.message }; finish(null, null); });
child.once("close", finish);
child.stdin.on("error", () => {});
child.stdin.end(request.input ?? "");
