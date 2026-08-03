import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const worker = readFileSync(resolve("scripts/capture-visual-snapshots.mjs"), "utf8");

describe("Stage 1 baseline-only monitoring approval wiring", () => {
  it("preserves the narrow approval when later baseline metadata is refreshed", () => {
    expect(worker).toContain(
      "const protectedStage1Approval = stage1BaselineMonitoringApprovalMetadata(source);",
    );
    expect(worker.match(/\.\.\.protectedStage1Approval/g)).toHaveLength(2);
    expect(worker).toContain(
      "jsonObjectOrEmpty(source?.page_metadata).stage1_baseline_monitoring_approval",
    );
  });
});
