import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const error = reason => Object.assign(new Error(reason), { pilotReason: reason });
const collector = fileURLToPath(new URL("../scrapling/collector.py", import.meta.url));
async function completedWithin(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

/** One owned Python/browser process per run. Every request still owns a new context and proxy. */
export function createScraplingBrowserSessionPool({ spawnImpl = spawn, maxRequests = 20, idleTimeoutMs = 60000 } = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 100 ||
      !Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 100 || idleTimeoutMs > 600000) throw new Error("Invalid browser session limits");
  let processState = null, busy = false, closed = false;
  function stop(state) {
    if (!state) return Promise.resolve();
    if (state.stopping) return state.stopping;
    state.stopped = true; clearTimeout(state.idle);
    state.pending?.reject(error("collector_session_closed")); state.pending = null;
    state.stopping = (async () => {
      state.child.stdin.end();
      // EOF runs Python's finally and closes its browser normally. Only an
      // unresponsive owned process tree receives a forced termination.
      if (await completedWithin(state.completion, 3000)) return;
      if (state.child.pid && !state.exited) {
        if (process.platform === "win32") {
          const killed = new Promise(done => {
            const killer = spawnImpl("taskkill.exe", ["/PID", String(state.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            killer.once("error", () => { state.child.kill(); done(); }); killer.once("close", done);
          });
          if (!await completedWithin(killed, 5000)) throw error("collector_session_shutdown_failed");
        } else {
          try { process.kill(-state.child.pid, "SIGKILL"); } catch { state.child.kill("SIGKILL"); }
        }
      }
      if (!await completedWithin(state.completion, 5000)) throw error("collector_session_shutdown_failed");
    })();
    return state.stopping;
  }
  function start(pythonPath, executablePath) {
    const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATH", "COMSPEC", "PATHEXT"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    env.PYTHONUTF8 = "1"; env.PYTHONDONTWRITEBYTECODE = "1";
    const child = spawnImpl(pythonPath, ["-B", collector, "--session-worker"], { windowsHide: true, detached: process.platform !== "win32", shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
    const state = { child, pythonPath, executablePath, requests: 0, startedAt: Date.now(), pending: null, chunks: [], bytes: 0,
      stopped: false, exited: false, idle: null };
    state.completion = new Promise(done => {
      child.once("close", () => { state.exited = true; state.pending?.reject(error("collector_session_exit")); state.pending = null; done(); });
      child.once("error", () => { state.exited = true; state.pending?.reject(error("collector_start_failed")); state.pending = null; done(); });
    });
    child.stderr.on("data", () => {}); child.stdin.on("error", () => {});
    child.stdout.on("data", chunk => {
      if (!state.pending || state.stopped) { void stop(state).catch(() => {}); return; }
      state.bytes += chunk.length;
      if (state.bytes > state.pending.maxBytes) { state.pending.reject(error("collector_output_limit")); state.pending = null; void stop(state).catch(() => {}); return; }
      state.chunks.push(chunk);
      if (!chunk.includes(10)) return;
      const output = Buffer.concat(state.chunks), end = output.indexOf(10);
      const pending = state.pending; state.pending = null; state.chunks = []; state.bytes = 0;
      try {
        if (end !== output.length - 1) throw error("invalid_collector_output");
        const value = JSON.parse(output.subarray(0, end).toString("utf8"));
        if (value.error) throw error(/^[a-z][a-z0-9_]{0,100}$/.test(value.error) ? value.error : "collector_failed");
        pending.resolve(value);
      } catch (failure) { pending.reject(failure?.pilotReason ? failure : error("invalid_collector_output")); void stop(state).catch(() => {}); }
    });
    return state;
  }
  return Object.freeze({
    async capture({ pythonPath, executablePath, request, timeoutMs = 90000, publisherJsonProfile }) {
      if (closed || busy || !pythonPath || !executablePath || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000)
        throw error("invalid_collector_session_state");
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > 16384) throw error("request_size_limit");
      busy = true;
      let state;
      try {
        if (processState && (processState.stopped || processState.exited || processState.pythonPath !== pythonPath ||
            processState.executablePath !== executablePath || processState.requests >= maxRequests || Date.now() - processState.startedAt > 600000)) {
          await stop(processState); processState = null;
        }
        state = processState ||= start(pythonPath, executablePath); clearTimeout(state.idle); state.requests++;
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { reject(error("capture_timeout")); void stop(state).catch(() => {}); }, timeoutMs);
          state.pending = { maxBytes: publisherJsonProfile ? 2 * 1024 * 1024 : 24 * 1024 * 1024,
            resolve: value => { clearTimeout(timer); resolve(value); }, reject: failure => { clearTimeout(timer); reject(failure); } };
          state.child.stdin.write(input + "\n");
        });
      } catch (failure) { await stop(state); throw failure; }
      finally {
        busy = false;
        if (state && !state.stopped && !state.exited) {
          state.idle = setTimeout(() => { void stop(state).catch(() => {}); }, idleTimeoutMs);
          state.idle.unref?.();
        }
      }
    },
    async close() { closed = true; await stop(processState); processState = null; },
  });
}
