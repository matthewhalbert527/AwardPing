import { describe, expect, it, vi } from "vitest";
import {
  applyAwardFactScanWatermark,
  awardFactsAreCurrent,
  awardFactScanWatermark,
} from "./lib/award-fact-aggregation-window.mjs";

describe("award fact aggregation scan window", () => {
  it("adds the fixed run-start upper bound to the source query", () => {
    const query = {
      lte: vi.fn(() => "bounded-query"),
    };
    const watermark = "2026-07-14T18:00:00.000Z";

    expect(applyAwardFactScanWatermark(query, watermark)).toBe("bounded-query");
    expect(query.lte).toHaveBeenCalledWith("page_metadata_generated_at", watermark);
  });

  it("leaves a source written during the run pending for the next aggregate", () => {
    const scanStartedAt = awardFactScanWatermark("2026-07-14T18:00:00.000Z");
    const sourceWrittenDuringRun = "2026-07-14T18:03:00.000Z";
    const runFinishedAt = "2026-07-14T18:05:00.000Z";

    expect(awardFactsAreCurrent(scanStartedAt, sourceWrittenDuringRun)).toBe(false);
    expect(awardFactsAreCurrent(runFinishedAt, sourceWrittenDuringRun)).toBe(true);
  });

  it("treats invalid or absent timestamps as not current", () => {
    expect(awardFactsAreCurrent(null, "2026-07-14T18:03:00.000Z")).toBe(false);
    expect(awardFactsAreCurrent("2026-07-14T18:00:00.000Z", null)).toBe(false);
  });

  it("leaves an exact watermark tie for one safe follow-up pass", () => {
    const boundary = "2026-07-14T18:00:00.000Z";

    expect(awardFactsAreCurrent(boundary, boundary)).toBe(false);
    expect(awardFactsAreCurrent("2026-07-14T18:00:00.001Z", boundary)).toBe(true);
  });
});
