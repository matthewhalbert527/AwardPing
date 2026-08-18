import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliUrl = new URL("./import-reviewed-stage1-candidates.mjs", import.meta.url);
const cliPath = fileURLToPath(cliUrl);
const source = readFileSync(cliUrl, "utf8");

describe("reviewed Stage 1 candidate-import CLI", () => {
  it("documents preview, exact confirmation, apply, and a separate receipt", () => {
    const result = spawnSync(process.execPath, [cliPath, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--apply");
    expect(result.stdout).toContain("--confirm=<phrase>");
    expect(result.stdout).toContain("--apply-result=<path>");
    expect(result.stdout).toContain("zero paid API calls");
  });

  it("rejects receipt paths outside apply and writes receipts once", () => {
    const result = spawnSync(process.execPath, [
      cliPath,
      "--apply-result=receipt.json",
    ], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--apply-result is accepted only with --apply");
    expect(source).toContain("--apply-result must be separate from the preview --output path");
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("buildStage1CandidateImportApplyReceipt");
  });
});
