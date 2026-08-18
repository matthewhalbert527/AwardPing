import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "scripts/read-stage1-cohort-readiness.mjs");

describe("Stage 1 readiness CLI boundary", () => {
  it("prints help before loading credentials or querying remote state", () => {
    const output = execFileSync(process.execPath, [cli, "--help"], {
      cwd: root,
      encoding: "utf8",
      env: {},
      timeout: 5_000,
    });
    expect(output).toContain("read-only evidence queries");
    expect(output).toContain("without loading credentials");
    expect(output).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("rejects unknown options before loading credentials or querying remote state", () => {
    const result = spawnSync(process.execPath, [cli, "--apply"], {
      cwd: root,
      encoding: "utf8",
      env: {},
      timeout: 5_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option --apply");
    expect(result.stderr).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("rejects missing path values before loading credentials", () => {
    const result = spawnSync(process.execPath, [cli, "--output"], {
      cwd: root,
      encoding: "utf8",
      env: {},
      timeout: 5_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--output requires a value");
    expect(result.stderr).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
