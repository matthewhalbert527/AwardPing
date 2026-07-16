import { describe, expect, it } from "vitest";
import {
  alertBlockingMonitoringPolicyFlagIds as appAlertBlockingFlagIds,
  candidateMonitoringPolicyFlagIds as appCandidateFlagIds,
  awardMonitoringPolicy as appMonitoringPolicy,
  awardMonitoringPolicyIdentity as appPolicyIdentity,
  buildMonitoringPolicyAliasIndex as buildAppAliasIndex,
  changeEventSuppressionPolicyIdentity as appSuppressionPolicyIdentity,
  isAlertBlockingMonitoringPolicyFlag as appIsAlertBlockingFlag,
  isCandidateMonitoringPolicyFlag as appIsCandidateFlag,
  isPersistentMonitoringPolicyFlag as appIsPersistentFlag,
  isReviewableMonitoringPolicyFlag as appIsReviewableFlag,
  monitoringPolicyAliasConflicts as appAliasConflicts,
  monitoringPolicyFlagIdForAlias as appCanonicalFlagId,
  monitoringPromotionMatcherIdentity as appMatcherIdentity,
  monitoringPolicyPromptLinesForScope as appPromptLinesForScope,
  monitoringPolicyRuleDefinitionForReview as appRuleDefinition,
  reviewableMonitoringPolicyFlagIds as appReviewableFlagIds,
  visualReviewBatchPolicyIdentity as appVisualPolicyIdentity,
  visualReviewBatchPolicyCoverageGaps as appCoverageGaps,
} from "../../src/lib/award-monitoring-policy.ts";
import {
  alertBlockingMonitoringPolicyFlagIds as workerAlertBlockingFlagIds,
  candidateMonitoringPolicyFlagIds as workerCandidateFlagIds,
  awardMonitoringPolicy as workerMonitoringPolicy,
  awardMonitoringPolicyIdentity as workerPolicyIdentity,
  buildMonitoringPolicyAliasIndex as buildWorkerAliasIndex,
  changeEventSuppressionPolicyIdentity as workerSuppressionPolicyIdentity,
  isAlertBlockingMonitoringPolicyFlag as workerIsAlertBlockingFlag,
  isCandidateMonitoringPolicyFlag as workerIsCandidateFlag,
  isPersistentMonitoringPolicyFlag as workerIsPersistentFlag,
  isReviewableMonitoringPolicyFlag as workerIsReviewableFlag,
  monitoringPolicyAliasConflicts as workerAliasConflicts,
  monitoringPolicyFlagIdForAlias as workerCanonicalFlagId,
  monitoringPromotionMatcherIdentity as workerMatcherIdentity,
  monitoringPolicyPromptLinesForScope as workerPromptLinesForScope,
  monitoringPolicyRuleDefinitionForReview as workerRuleDefinition,
  reviewableMonitoringPolicyFlagIds as workerReviewableFlagIds,
  visualReviewBatchPolicyIdentity as workerVisualPolicyIdentity,
  visualReviewBatchPolicyCoverageGaps as workerCoverageGaps,
} from "./award-monitoring-policy.mjs";
import {
  monitoringPromotionMatcherBundleDigestFromManifest,
  monitoringPromotionMatcherBundleHash,
  monitoringPromotionMatcherBundleManifest,
  monitoringPromotionMatcherBundleSources,
} from "./monitoring-promotion-matcher-bundle.mjs";

describe("worker award monitoring policy", () => {
  it("matches the app policy bundle identity and normalized blocking flags", () => {
    expect(workerPolicyIdentity).toEqual(appPolicyIdentity);
    expect(workerVisualPolicyIdentity).toEqual(appVisualPolicyIdentity);
    expect(workerSuppressionPolicyIdentity).toEqual(appSuppressionPolicyIdentity);
    expect(workerSuppressionPolicyIdentity.hash).not.toBe(workerVisualPolicyIdentity.hash);
    expect(workerAlertBlockingFlagIds).toEqual(appAlertBlockingFlagIds);
    expect(workerReviewableFlagIds).toEqual(appReviewableFlagIds);
    expect(workerCandidateFlagIds).toEqual(appCandidateFlagIds);
    expect(workerMatcherIdentity).toEqual(appMatcherIdentity);
    expect(workerMatcherIdentity).toMatchObject({
      id: "awardping-monitoring-promotion-matcher-bundle",
      version: "source-bundle-sha256-v1",
      source: "scripts/lib/monitoring-promotion-matcher-bundle.mjs",
      hash: monitoringPromotionMatcherBundleHash,
    });
    expect(workerMonitoringPolicy.promotion_matcher.sources).toEqual(
      monitoringPromotionMatcherBundleSources,
    );
    expect(workerRuleDefinition("donation_prompt")).toEqual(
      appRuleDefinition("donation_prompt"),
    );
    expect(workerRuleDefinition("donation_prompt")?.matcher_digest).toBe(
      monitoringPromotionMatcherBundleHash,
    );
  });

  it.each(monitoringPromotionMatcherBundleSources)(
    "invalidates the matcher bundle when only %s changes",
    (changedSource) => {
      const changedManifest = monitoringPromotionMatcherBundleManifest.map((entry) => ({
        ...entry,
        sha256:
          entry.source === changedSource
            ? entry.sha256 === "0".repeat(64)
              ? "1".repeat(64)
              : "0".repeat(64)
            : entry.sha256,
      }));

      expect(
        monitoringPromotionMatcherBundleDigestFromManifest(changedManifest),
      ).not.toBe(monitoringPromotionMatcherBundleHash);
    },
  );

  it("has complete, identical visual review batch policy coverage", () => {
    expect(workerCoverageGaps()).toEqual([]);
    expect(appCoverageGaps()).toEqual([]);
    expect(workerPromptLinesForScope("visual_review_batch")).toEqual(
      appPromptLinesForScope("visual_review_batch"),
    );
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
  ])("canonicalizes legacy flag %s to %s in both runtimes", (alias, expected) => {
    expect(workerCanonicalFlagId(alias)).toBe(expected);
    expect(appCanonicalFlagId(alias)).toBe(expected);
  });

  it("has no active alias conflicts", () => {
    expect(workerAliasConflicts()).toEqual([]);
    expect(appAliasConflicts()).toEqual([]);
  });

  it("detects active/inactive alias collisions regardless of rule order in both runtimes", () => {
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
    for (const buildIndex of [buildWorkerAliasIndex, buildAppAliasIndex]) {
      for (const flags of [
        [active, inactive],
        [inactive, active],
      ]) {
        const index = buildIndex(flags);
        expect(index.active.get("shared_candidate_alias")).toBe("active_rule");
        expect(index.conflicts).toEqual([
          {
            alias: "shared_candidate_alias",
            ids: ["active_rule", "inactive_rule"],
          },
        ]);
      }
    }
  });

  it("honors active false in prompts, blocking, and persistence checks", () => {
    const workerRule = workerMonitoringPolicy.policy_flags.find(
      (flag) => flag.id === "fundraising_form_change",
    );
    const appRule = appMonitoringPolicy.policy_flags.find(
      (flag) => flag.id === "fundraising_form_change",
    );
    expect(workerRule).toBeDefined();
    expect(appRule).toBeDefined();
    if (!workerRule || !appRule) return;

    const workerActive = workerRule.active;
    const appActive = appRule.active;
    const workerPromotionTestMode = workerRule.promotion_test_mode;
    const appPromotionTestMode = appRule.promotion_test_mode;
    workerRule.active = false;
    appRule.active = false;
    workerRule.promotion_test_mode = "deterministic";
    appRule.promotion_test_mode = "deterministic";
    try {
      expect(workerPromptLinesForScope("visual_review_batch").join(" ")).not.toContain(
        "fundraising_form_change",
      );
      expect(appPromptLinesForScope("visual_review_batch").join(" ")).not.toContain(
        "fundraising_form_change",
      );
      expect(workerIsAlertBlockingFlag("donation_prompt")).toBe(false);
      expect(appIsAlertBlockingFlag("donation_prompt")).toBe(false);
      expect(workerIsPersistentFlag("donation_prompt")).toBe(false);
      expect(appIsPersistentFlag("donation_prompt")).toBe(false);
      expect(workerIsReviewableFlag("donation_prompt")).toBe(true);
      expect(appIsReviewableFlag("donation_prompt")).toBe(true);
      expect(workerIsCandidateFlag("donation_prompt")).toBe(true);
      expect(appIsCandidateFlag("donation_prompt")).toBe(true);
    } finally {
      if (workerActive === undefined) delete workerRule.active;
      else workerRule.active = workerActive;
      if (appActive === undefined) delete appRule.active;
      else appRule.active = appActive;
      if (workerPromotionTestMode === undefined) delete workerRule.promotion_test_mode;
      else workerRule.promotion_test_mode = workerPromotionTestMode;
      if (appPromotionTestMode === undefined) delete appRule.promotion_test_mode;
      else appRule.promotion_test_mode = appPromotionTestMode;
    }
  });
});
