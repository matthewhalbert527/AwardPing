import { describe, expect, it } from "vitest";
import {
  aiDisabledReasonForOptions,
  missingAiProviderMessage,
  runRequiresAiFromOptions,
  selectAiProvider,
} from "./lib/capture-ai-requirements.mjs";

describe("capture AI requirements", () => {
  it("does not require AI for localization/R2 repair runs", () => {
    const options = {
      visualReviewMode: "none",
      extractBaselineInfo: false,
      backfillBaselineInfo: false,
      localizationRepair: true,
      r2SnapshotSync: true,
      r2RepairMissingSnapshots: true,
    };

    expect(runRequiresAiFromOptions(options)).toBe(false);
    expect(aiDisabledReasonForOptions(options)).toContain("localization_repair");
    expect(selectAiProvider("auto", {})).toBe(null);
  });

  it("does not require AI for capture-only runs with interpretation and extraction disabled", () => {
    expect(
      runRequiresAiFromOptions({
        visualReviewMode: "none",
        extractBaselineInfo: false,
        backfillBaselineInfo: false,
      }),
    ).toBe(false);
  });

  it("does not require AI for batch enqueue-only visual review", () => {
    const options = {
      visualReviewMode: "batch",
      extractBaselineInfo: false,
      backfillBaselineInfo: false,
    };

    expect(runRequiresAiFromOptions(options)).toBe(false);
    expect(aiDisabledReasonForOptions(options)).toContain("visual_review_batch_enqueue_only");
  });

  it("requires AI for baseline extraction and fails provider selection without keys", () => {
    expect(
      runRequiresAiFromOptions({
        visualReviewMode: "none",
        extractBaselineInfo: true,
        backfillBaselineInfo: false,
      }),
    ).toBe(true);
    expect(selectAiProvider("auto", {})).toBe(null);
    expect(missingAiProviderMessage("auto")).toContain("required by this run's options");
  });

  it("requires AI for immediate visual interpretation and explicit AI source-quality modes", () => {
    expect(
      runRequiresAiFromOptions({
        visualReviewMode: "immediate",
        extractBaselineInfo: false,
        backfillBaselineInfo: false,
      }),
    ).toBe(true);
    expect(
      runRequiresAiFromOptions({
        visualReviewMode: "none",
        extractBaselineInfo: false,
        backfillBaselineInfo: false,
        sourceQualityMode: "gemini-cli",
      }),
    ).toBe(true);
  });
});
