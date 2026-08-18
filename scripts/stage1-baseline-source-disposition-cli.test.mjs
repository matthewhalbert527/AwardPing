import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/apply-stage1-baseline-source-dispositions.mjs";
const source = readFileSync(scriptPath, "utf8");

describe("Stage 1 baseline-source disposition CLI", () => {
  it("loads help without credentials or database access", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--apply --plan=<preview.json> --confirm=<sha-or-exact-phrase>");
    expect(result.stdout).toContain("exactly one atomic RPC call");
  });

  it("hard-binds the nested operator review fields and one mutation surface", () => {
    expect(source).toContain("reviewRoot.review.operator_statement");
    expect(source).toContain("reviewRoot.review.reviewed_at");
    expect(source.match(/\.rpc\(/g)).toHaveLength(1);
    expect(source).toContain('"apply_reviewed_stage1_source_dispositions"');
    expect(source).not.toMatch(/\.from\([^\n]+\)\s*\.(?:insert|upsert|update|delete)\(/);
    expect(source).not.toContain("@google/generative-ai");
  });

  it("requires a reviewed preview and confirmation for apply", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--apply"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--plan is required");
    expect(result.stderr).toContain("Database writes: 0");
  });
});
