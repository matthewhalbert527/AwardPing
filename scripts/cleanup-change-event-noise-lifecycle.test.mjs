import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const scriptPath = resolve(import.meta.dirname, "cleanup-change-event-noise.mjs");
const source = readFileSync(scriptPath, "utf8");

describe("scheduled suppression worker transport lifecycle", () => {
  it("uses graceful exit state and closes Supabase transport after network work", () => {
    expect(source).not.toContain("process.exit(");
    expect(source).toContain("process.exitCode = 1");
    expect(source).toContain("await closeSupabaseServiceTransport();");
  });

  it("exits normally after a real HTTP failure without the Windows libuv assertion", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, {
        "content-type": "application/json",
        connection: "close",
      });
      response.end(JSON.stringify({ code: "XX000", message: "forced local test failure" }));
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    try {
      const result = await runCli({
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${address.port}`,
        SUPABASE_SERVICE_ROLE_KEY: "local-test-service-role-key",
      });
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain("CHANGE_EVENT_NOISE_CLEANUP_FATAL");
      expect(result.stderr).not.toContain("Assertion failed");
      expect(result.stderr).not.toContain("UV_HANDLE_CLOSING");
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});

function runCli(envOverrides) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [scriptPath, "--apply=true"], {
      cwd: root,
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("suppression CLI subprocess timed out"));
    }, 15_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveResult({ status, signal, stdout, stderr });
    });
  });
}
