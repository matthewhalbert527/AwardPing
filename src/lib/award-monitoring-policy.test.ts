import { describe, expect, it } from "vitest";
import {
  hasRelativeAgeOnlyPolicyChange,
  isAlertBlockingMonitoringPolicyFlag,
  isPersistentMonitoringPolicyFlag,
  monitoringPolicyPromptLinesForScope,
} from "@/lib/award-monitoring-policy";

describe("award monitoring policy", () => {
  it("exposes policy prompts for visual snapshot review", () => {
    const prompt = monitoringPolicyPromptLinesForScope("visual_snapshot_ai").join(" ");

    expect(prompt).toContain("relative recency label churn");
    expect(prompt).toContain("8 days ago");
  });

  it("treats relative age timestamp churn as a global alert-blocking flag", () => {
    expect(isAlertBlockingMonitoringPolicyFlag("relative_age_timestamp_churn")).toBe(true);
    expect(isPersistentMonitoringPolicyFlag("relative_age_timestamp_churn")).toBe(true);
  });

  it("detects relative age-only news/listing changes", () => {
    expect(
      hasRelativeAgeOnlyPolicyChange({
        readerSummary:
          "The recent chapter news item now shows '9 days ago' instead of '8 days ago'.",
        section: "Recent chapter news",
        before: "Chapter Health, Reports and Online Communities 8 days ago",
        after: "Chapter Health, Reports and Online Communities 9 days ago",
        addedText: ["Chapter Health, Reports and Online Communities 9 days ago"],
        removedText: ["Chapter Health, Reports and Online Communities 8 days ago"],
      }),
    ).toBe(true);
  });

  it("does not reject real applicant-facing date changes", () => {
    expect(
      hasRelativeAgeOnlyPolicyChange({
        readerSummary:
          "The application deadline changed from March 1, 2026 to March 15, 2026.",
        before: "Applications are due March 1, 2026.",
        after: "Applications are due March 15, 2026.",
        dateChanges: ["Added March 15, 2026", "Removed March 1, 2026"],
      }),
    ).toBe(false);
  });
});
