import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workerSource = readFileSync(
  resolve(import.meta.dirname, "capture-visual-snapshots.mjs"),
  "utf8",
);

describe("scheduled visual source inventory worker wiring", () => {
  it("independently enumerates an exact active/open inventory before capture", () => {
    expect(workerSource).toContain("loadAuthoritativeScheduledSourceInventory()");
    expect(workerSource).toContain('{ count: "exact", head: true }');
    expect(workerSource).toContain('.eq("shared_awards.status", "active")');
    expect(workerSource).toContain('.eq("admin_review_status", "open")');
    expect(workerSource).toContain('.order("id", { ascending: true })');
    expect(workerSource).toContain('.gt("id", lastSourceId)');
    expect(workerSource).toContain(
      "authoritativeInventory.filter(sourceMatchesShard).slice(0, limit)",
    );

    const proofLoad = workerSource.indexOf("const authoritativeInventory = isScheduledNightlyVisualRun");
    const captureLoop = workerSource.indexOf("if (visualWebConcurrency > 1)");
    expect(proofLoad).toBeGreaterThan(0);
    expect(captureLoop).toBeGreaterThan(proofLoad);
  });

  it("persists and fails closed on the count/hash comparison", () => {
    expect(workerSource).toContain("buildVisualSourceInventoryProof({");
    expect(workerSource).toContain("source_inventory: report.source_inventory || null");
    expect(workerSource).toContain("if (!report.source_inventory.proof_complete)");
    expect(workerSource).toContain("Scheduled source inventory proof failed:");
  });
});
