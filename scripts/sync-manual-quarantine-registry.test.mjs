import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { manualQuarantineFailureReceipt } from "./sync-manual-quarantine-registry.mjs";

const script = readFileSync(
  new URL("./sync-manual-quarantine-registry.mjs", import.meta.url),
  "utf8",
);
const scriptPath = resolve(
  import.meta.dirname,
  "sync-manual-quarantine-registry.mjs",
);

function runCli(args) {
  const env = { ...process.env };
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env,
    timeout: 5_000,
  });
}

function runCliAsync(args, envOverrides = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: resolve(import.meta.dirname, ".."),
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("manual quarantine CLI subprocess timed out"));
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

describe("manual quarantine sync CLI shutdown", () => {
  it("gracefully closes Supabase transport before Node tears down Windows handles", () => {
    expect(script).toContain("exitCode = await main();");
    expect(script).toContain("await closeSupabaseServiceTransport();");
    expect(script).toContain("process.exitCode = exitCode;");
    expect(script).toContain("import.meta.url === pathToFileURL(resolve(process.argv[1])).href");
    expect(script).not.toContain("process.exit(");
    expect(script).toContain("MANUAL_QUARANTINE_SYNC_FAILED ${syncError.message}`);");
    expect(script).toContain(
      "formatLaneFailureReceipt(manualQuarantineFailureReceipt(syncError))",
    );
  });

  it("returns success only after printing the durable state", () => {
    const successMarker = script.indexOf(
      'console.log("MANUAL_QUARANTINE_REGISTRY_SYNCED")',
    );
    const successReturn = script.indexOf("return 0;", successMarker);
    expect(successMarker).toBeGreaterThan(0);
    expect(successReturn).toBeGreaterThan(successMarker);
  });

  it("shows help before reading an environment file or contacting a service", () => {
    const result = runCli([
      "--help",
      "--env=Z:/definitely-missing/awardping.env",
    ]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("read-only by default");
    expect(result.stdout).toContain("--apply=true");
    expect(result.stderr).toBe("");
  });

  it("defaults to a local dry run with no credentials or network access", () => {
    const result = runCli(["--env=Z:/definitely-missing/awardping.env"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MANUAL_QUARANTINE_SYNC_DRY_RUN");
    expect(result.stdout).toContain('"remote_mutations": 0');
    expect(result.stdout).toContain('"paid_api_calls": 0');
    expect(result.stdout).not.toContain("MANUAL_QUARANTINE_REGISTRY_SYNCED");
    expect(result.stderr).toBe("");
  });

  it("rejects mutation-shaped flags unless apply is explicit", () => {
    const result = runCli(["--dry-run=false"]);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Remote mutation requires explicit --apply=true",
    );
    expect(result.stdout).not.toContain("MANUAL_QUARANTINE_REGISTRY_SYNCED");
  });

  it("turns a database timeout into an actionable zero-charge lane receipt", () => {
    expect(manualQuarantineFailureReceipt(
      new Error("canceling statement due to statement timeout"),
    )).toEqual(expect.objectContaining({
      lane_key: "manual_quarantine",
      failure_code: "database_statement_timeout",
      retry_automatic: true,
      creates_api_charge: false,
    }));
  });

  it("exits normally after a real HTTP timeout response without the Windows libuv assertion", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, {
        "content-type": "application/json",
        connection: "close",
      });
      response.end(JSON.stringify({
        code: "57014",
        message: "canceling statement due to statement timeout",
      }));
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    try {
      const result = await runCliAsync(["--apply=true"], {
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${address.port}`,
        SUPABASE_SERVICE_ROLE_KEY: "local-test-service-role-key",
      });

      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain(
        "MANUAL_QUARANTINE_SYNC_FAILED canceling statement due to statement timeout",
      );
      expect(result.stderr).toContain('"failure_code":"database_statement_timeout"');
      expect(result.stderr).not.toContain("Assertion failed");
      expect(result.stderr).not.toContain("UV_HANDLE_CLOSING");
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});
