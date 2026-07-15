import { describe, expect, it } from "vitest";
import {
  buildStableTextBlocks,
  captureProfileSettings,
  compareStableCaptureHashes,
  defaultCaptureProfile,
  defaultSectionExtractionProfile,
  normalizeCaptureProfile,
  normalizeSectionExtractionProfile,
  sectionExtractionProfileSettings,
  shouldUseExpansionForSource,
  shouldUseScrollActivationForSource,
} from "./lib/capture-stability.mjs";

describe("capture stability profiles", () => {
  it("defaults ordinary daily runs to stable-daily", () => {
    expect(defaultCaptureProfile()).toBe("stable-daily");
    expect(defaultCaptureProfile({ completeMissingBaselines: true })).toBe("baseline-rich");
    expect(defaultCaptureProfile({ discoveryMode: true })).toBe("discovery");
    expect(defaultCaptureProfile({ localizationRepair: true })).toBe("localization-repair");
    expect(normalizeCaptureProfile("stable_daily")).toBe("stable-daily");
    expect(defaultSectionExtractionProfile()).toBe("stable-daily");
    expect(defaultSectionExtractionProfile({ baselineRefresh: true })).toBe("baseline-rich");
    expect(normalizeSectionExtractionProfile("baseline_rich")).toBe("baseline-rich");
  });

  it("uses cheap structured section extraction for daily and richer extraction for baselines", () => {
    expect(sectionExtractionProfileSettings("stable-daily")).toMatchObject({
      profile: "stable-daily",
      naturalClicksOnly: true,
      allowForceOpenFallback: false,
      includeInBaselineFacts: false,
      captureEvidence: false,
    });
    expect(sectionExtractionProfileSettings("baseline-rich")).toMatchObject({
      profile: "baseline-rich",
      naturalClicksOnly: false,
      allowForceOpenFallback: true,
      includeInBaselineFacts: true,
      captureEvidence: false,
    });
    expect(sectionExtractionProfileSettings("evidence")).toMatchObject({
      profile: "evidence",
      captureEvidence: true,
    });
  });

  it("isolates expansion-state text from stable daily primary text", () => {
    const first = buildStableTextBlocks({
      rawText: "Application deadline March 1, 2027",
      mainText: "Application deadline March 1, 2027",
      expansionStates: [],
      profile: "stable-daily",
    });
    const second = buildStableTextBlocks({
      rawText: "Application deadline March 1, 2027",
      mainText: "Application deadline March 1, 2027",
      expansionStates: [{ label: "FAQ", text: "Hidden FAQ answer that was clicked open." }],
      profile: "stable-daily",
    });

    expect(second.expansion_hash).not.toBe(first.expansion_hash);
    expect(second.text_hash).toBe(first.text_hash);
    expect(second.main_content_hash).toBe(first.main_content_hash);
  });

  it("lets baseline-rich primary text include expansion-state text", () => {
    const first = buildStableTextBlocks({
      rawText: "Application deadline March 1, 2027",
      mainText: "Application deadline March 1, 2027",
      expansionStates: [],
      profile: "baseline-rich",
    });
    const second = buildStableTextBlocks({
      rawText: "Application deadline March 1, 2027",
      mainText: "Application deadline March 1, 2027",
      expansionStates: [{ label: "Requirements", text: "Two letters of recommendation." }],
      profile: "baseline-rich",
    });

    expect(second.text_hash).not.toBe(first.text_hash);
    expect(second.main_content_hash).toBe(first.main_content_hash);
  });

  it("treats screenshot/header churn as chrome-only when main content is stable", () => {
    const comparison = compareStableCaptureHashes(
      {
        image_hash: "old-image",
        text_hash: "old-text",
        main_content_hash: "same-main",
        nav_header_footer_hash: "old-nav",
      },
      {
        image_hash: "new-image",
        text_hash: "new-text",
        main_content_hash: "same-main",
        nav_header_footer_hash: "new-nav",
      },
      { profile: "stable-daily" },
    );

    expect(comparison).toMatchObject({
      screenshotChanged: true,
      textChanged: false,
      chromeOnlyHashChanged: true,
      comparisonHash: "main_content_hash",
    });
  });

  it("keeps rich profiles available for baseline extraction", () => {
    const homepage = { page_type: "homepage" };
    const faq = { page_type: "faq" };

    expect(shouldUseExpansionForSource(homepage, "stable-daily")).toBe(false);
    expect(shouldUseExpansionForSource(faq, "stable-daily")).toBe(false);
    expect(shouldUseExpansionForSource(homepage, "localization-repair")).toBe(false);
    expect(shouldUseExpansionForSource(faq, "localization-repair")).toBe(false);
    expect(shouldUseExpansionForSource(homepage, "baseline-rich")).toBe(true);
    expect(shouldUseScrollActivationForSource(homepage, "stable-daily", true)).toBe(false);
    expect(shouldUseScrollActivationForSource(faq, "stable-daily", true)).toBe(true);
    expect(shouldUseScrollActivationForSource(homepage, "localization-repair", true)).toBe(false);
    expect(shouldUseScrollActivationForSource(faq, "localization-repair", true)).toBe(true);
  });

  it("renders localization repair like the stable daily monitor", () => {
    const daily = captureProfileSettings("stable-daily");
    const repair = captureProfileSettings("localization-repair");

    expect(repair).toMatchObject({
      profile: "localization-repair",
      useMainContentHashForComparison: daily.useMainContentHashForComparison,
      allowExpansionScreenshots: daily.allowExpansionScreenshots,
      allowBroadExpansion: daily.allowBroadExpansion,
      allowScrollActivation: daily.allowScrollActivation,
      defaultMaxExpansionStateScreenshots: daily.defaultMaxExpansionStateScreenshots,
    });
  });
});
