import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("immutable visual evidence cleanup wiring", () => {
  it("retires an admin source atomically instead of partially deleting its history", () => {
    const route = read("src/app/api/admin/page-issues/[sourceId]/route.ts");
    expect(route).toContain('admin.rpc("retire_shared_award_source_preserving_visual_history"');
    expect(route).not.toContain('.from("shared_award_change_events")');
    expect(route).not.toContain(".delete()");
  });

  it("suppresses noise events while preserving their immutable evidence", () => {
    for (const path of [
      "scripts/cleanup-recent-update-accuracy-issues.mjs",
      "scripts/cleanup-roster-retrieval-update-noise.mjs",
    ]) {
      const source = read(path);
      expect(source).toContain('suppressed_at:');
      expect(source).toContain('suppression_reason:');
      expect(source).toContain('suppression_source:');
      expect(source).not.toContain('suppressed_reason:');
      expect(source).not.toContain('suppressed_by:');
      expect(source).not.toMatch(/from\("shared_award_change_events"\)[\s\S]{0,160}\.delete\(\)/);
    }
  });

  it("retires source-cleanup rows through the preserving RPC", () => {
    for (const path of [
      "scripts/audit-shared-source-coverage.mjs",
      "scripts/post-crawl-cleanup-report.mjs",
    ]) {
      const source = read(path);
      expect(source).toContain('rpc("retire_shared_award_source_preserving_visual_history"');
      expect(source).not.toContain('deleteWhereIn("shared_award_change_events"');
      expect(source).not.toContain('deleteWhereIn("shared_award_sources"');
    }
  });
});
