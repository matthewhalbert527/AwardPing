import { describe, expect, it } from "vitest";
import {
  alertBlockingMonitoringPolicyFlagIds,
  candidateMonitoringPolicyFlagIds,
  assertVisualReviewBatchPolicyCoverage,
  awardDecisionMemory,
  awardMonitoringPolicy,
  awardMonitoringPolicyHash,
  awardMonitoringPolicyIdentity,
  awardMonitoringPolicyVersion,
  buildMonitoringPolicyAliasIndex,
  changeEventSuppressionBehaviorVersion,
  changeEventSuppressionPolicyHash,
  changeEventSuppressionPolicyIdentity,
  decisionMemoryPromptLinesForScope,
  hasRelativeAgeOnlyPolicyChange,
  isAlertBlockingMonitoringPolicyFlag,
  isCandidateMonitoringPolicyFlag,
  isPersistentMonitoringPolicyFlag,
  isReviewableMonitoringPolicyFlag,
  monitoringPolicyAliasConflicts,
  monitoringPolicyFlagIdForAlias,
  monitoringPromotionMatcherIdentity,
  monitoringPolicyPromptLinesForScope,
  monitoringPolicyRuleDefinitionForReview,
  reviewableMonitoringPolicyFlagIds,
  visualReviewBatchPolicyHash,
  visualReviewBatchPolicyIdentity,
  visualReviewBatchPolicyVersion,
  visualReviewBatchPolicyCoverageGaps,
} from "@/lib/award-monitoring-policy";

describe("award monitoring policy", () => {
  it("seals the executable promotion matcher dependency bundle", () => {
    expect(monitoringPromotionMatcherIdentity).toMatchObject({
      id: "awardping-monitoring-promotion-matcher-bundle",
      version: "source-bundle-sha256-v1",
      source: "scripts/lib/monitoring-promotion-matcher-bundle.mjs",
    });
    expect(monitoringPromotionMatcherIdentity.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      monitoringPolicyRuleDefinitionForReview("fundraising_form_change")
        ?.matcher_digest,
    ).toBe(monitoringPromotionMatcherIdentity.hash);
  });

  it("exposes policy prompts for visual snapshot review", () => {
    const prompt = monitoringPolicyPromptLinesForScope("visual_snapshot_ai").join(" ");

    expect(prompt).toContain("relative recency label churn");
    expect(prompt).toContain("8 days ago");
  });

  it("loads user decision memory prompts for baseline facts", () => {
    const prompt = decisionMemoryPromptLinesForScope("baseline_facts").join(" ");

    expect(awardDecisionMemory.entries.length).toBeGreaterThan(10);
    expect(prompt).toContain("same named award");
    expect(prompt).toContain("Do not create, title, or list a monitored source or subpage as Overview");
    expect(prompt).toContain("Important dates must always include what the date means");
  });

  it("includes decision memory in combined monitoring prompt lines", () => {
    const prompt = monitoringPolicyPromptLinesForScope("visual_snapshot_ai").join(" ");

    expect(prompt).toContain("Reject relative recency label churn");
    expect(prompt).toContain("Reject changes caused by accordions");
    expect(prompt).toContain("Only call text added");
  });

  it("loads every active alert-blocking rule and update-review decision into batch review", () => {
    const prompt = monitoringPolicyPromptLinesForScope("visual_review_batch").join(" ");
    const configuredAlertBlockingIds = awardMonitoringPolicy.policy_flags
      .filter(
        (flag) =>
          (flag as typeof flag & { active?: boolean }).active !== false &&
          flag.alert_blocking,
      )
      .map((flag) => flag.id);

    expect(visualReviewBatchPolicyCoverageGaps()).toEqual([]);
    expect(alertBlockingMonitoringPolicyFlagIds).toEqual(configuredAlertBlockingIds);
    expect(prompt).toContain("Reject relative recency label churn");
    expect(prompt).toContain("Reject raw scrape artifacts");
    expect(prompt).toContain("Reject a candidate when no concrete applicant-facing fact");
    expect(prompt).toContain("Reject changes caused by accordions");
    expect(prompt).toContain("Important dates must always include what the date means");
  });

  it("fails coverage validation when an active blocking rule loses the batch scope", () => {
    const rule = awardMonitoringPolicy.policy_flags.find(
      (flag) => flag.id === "relative_age_timestamp_churn",
    );
    expect(rule).toBeDefined();
    if (!rule) return;

    const originalScopes = [...rule.prompt_scopes];
    rule.prompt_scopes = originalScopes.filter((scope) => scope !== "visual_review_batch");
    try {
      expect(visualReviewBatchPolicyCoverageGaps()).toContainEqual({
        source: "policy_flag",
        id: "relative_age_timestamp_churn",
        missing: ["visual_review_batch scope"],
      });
      expect(() => assertVisualReviewBatchPolicyCoverage()).toThrow(
        /policy_flag:relative_age_timestamp_churn/,
      );
    } finally {
      rule.prompt_scopes = originalScopes;
    }
  });

  it("exposes a deterministic policy-bundle identity for scan metadata", () => {
    expect(awardMonitoringPolicyVersion).toBe("policy-3.memory-2");
    expect(awardMonitoringPolicyHash).toMatch(/^fnv1a32x2-utf16:[0-9a-f]{16}$/);
    expect(awardMonitoringPolicyIdentity).toEqual({
      id: `awardping-monitoring-policy@${awardMonitoringPolicyVersion}+${awardMonitoringPolicyHash}`,
      version: awardMonitoringPolicyVersion,
      hash: awardMonitoringPolicyHash,
      policyVersion: 3,
      decisionMemoryVersion: 2,
    });
  });

  it("treats relative age timestamp churn as a global alert-blocking flag", () => {
    expect(isAlertBlockingMonitoringPolicyFlag("relative_age_timestamp_churn")).toBe(true);
    expect(isAlertBlockingMonitoringPolicyFlag("relative-age-timestamp-churn")).toBe(true);
    expect(isPersistentMonitoringPolicyFlag("relative_age_timestamp_churn")).toBe(true);
    expect(isPersistentMonitoringPolicyFlag("relative-age-timestamp-churn")).toBe(true);
  });

  it("exposes alert-blocking rules for dark promotion review", () => {
    expect(reviewableMonitoringPolicyFlagIds).toContain(
      "relative_age_timestamp_churn",
    );
    expect(isReviewableMonitoringPolicyFlag("donation_prompt")).toBe(true);
    expect(isReviewableMonitoringPolicyFlag("not_a_policy_rule")).toBe(false);
    expect(candidateMonitoringPolicyFlagIds).toEqual([]);
    expect(isCandidateMonitoringPolicyFlag("donation_prompt")).toBe(false);
    expect(monitoringPolicyRuleDefinitionForReview("donation_prompt")).toMatchObject({
      id: "fundraising_form_change",
      alert_blocking: true,
      persistent: true,
    });
  });

  it.each([
    ["donation_prompt", "fundraising_form_change"],
    ["unsupported_added_text", "unsupported_structured_fact"],
    ["unsupported_removed_text", "unsupported_structured_fact"],
    ["unsupported_date_change", "unsupported_structured_fact"],
    ["before_text_not_found", "unsupported_structured_fact"],
    ["after_text_not_found", "unsupported_structured_fact"],
    ["after_text_already_present", "no_actual_changed_fact"],
    ["before_text_still_present", "no_actual_changed_fact"],
  ])("canonicalizes legacy policy alias %s", (alias, expected) => {
    expect(monitoringPolicyFlagIdForAlias(alias)).toBe(expected);
  });

  it("has a separate deterministic effective Batch policy identity", () => {
    expect(monitoringPolicyAliasConflicts()).toEqual([]);
    expect(visualReviewBatchPolicyVersion).toBe("visual-review-batch-1");
    expect(visualReviewBatchPolicyHash).toMatch(/^fnv1a32x2-utf16:[0-9a-f]{16}$/);
    expect(visualReviewBatchPolicyIdentity).toEqual({
      id: `awardping-visual-review-batch@${visualReviewBatchPolicyHash}`,
      version: visualReviewBatchPolicyVersion,
      hash: visualReviewBatchPolicyHash,
    });
  });

  it("detects candidate alias conflicts regardless of active/inactive rule order", () => {
    const active = {
      id: "active_rule",
      active: true,
      aliases: ["shared-candidate-alias"],
    };
    const inactive = {
      id: "inactive_rule",
      active: false,
      aliases: ["shared-candidate-alias"],
    };
    for (const flags of [
      [active, inactive],
      [inactive, active],
    ]) {
      const index = buildMonitoringPolicyAliasIndex(flags);
      expect(index.active.get("shared_candidate_alias")).toBe("active_rule");
      expect(index.conflicts).toEqual([
        {
          alias: "shared_candidate_alias",
          ids: ["active_rule", "inactive_rule"],
        },
      ]);
    }
  });

  it("versions deterministic suppression matcher behavior in the sweep identity", () => {
    expect(changeEventSuppressionBehaviorVersion).toBe("change-event-suppression-3");
    expect(changeEventSuppressionPolicyHash).toMatch(/^fnv1a32x2-utf16:[0-9a-f]{16}$/);
    expect(changeEventSuppressionPolicyIdentity).toEqual({
      id: `awardping-change-event-suppression@${changeEventSuppressionPolicyHash}`,
      version: changeEventSuppressionBehaviorVersion,
      hash: changeEventSuppressionPolicyHash,
    });
    expect(changeEventSuppressionPolicyHash).not.toBe(visualReviewBatchPolicyHash);
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

  it("does not let relative-age churn hide a simultaneous application closure", () => {
    expect(
      hasRelativeAgeOnlyPolicyChange({
        readerSummary:
          "Applications are now closed, while the latest-news label changed from 8 days ago to 9 days ago.",
        before: "Applications are open. Latest news 8 days ago.",
        after: "Applications are now closed. Latest news 9 days ago.",
        addedText: ["Applications are now closed. Latest news 9 days ago."],
        removedText: ["Applications are open. Latest news 8 days ago."],
      }),
    ).toBe(false);
  });
});
