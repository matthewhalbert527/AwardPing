import { describe, expect, it } from "vitest";
import {
  alertBlockingMonitoringPolicyFlagIds as appAlertBlockingFlagIds,
  awardMonitoringPolicy as appMonitoringPolicy,
  awardMonitoringPolicyIdentity as appPolicyIdentity,
  changeEventSuppressionPolicyIdentity as appSuppressionPolicyIdentity,
  isAlertBlockingMonitoringPolicyFlag as appIsAlertBlockingFlag,
  isPersistentMonitoringPolicyFlag as appIsPersistentFlag,
  monitoringPolicyAliasConflicts as appAliasConflicts,
  monitoringPolicyFlagIdForAlias as appCanonicalFlagId,
  monitoringPolicyPromptLinesForScope as appPromptLinesForScope,
  visualReviewBatchPolicyIdentity as appVisualPolicyIdentity,
  visualReviewBatchPolicyCoverageGaps as appCoverageGaps,
} from "../../src/lib/award-monitoring-policy.ts";
import {
  alertBlockingMonitoringPolicyFlagIds as workerAlertBlockingFlagIds,
  awardMonitoringPolicy as workerMonitoringPolicy,
  awardMonitoringPolicyIdentity as workerPolicyIdentity,
  changeEventSuppressionPolicyIdentity as workerSuppressionPolicyIdentity,
  isAlertBlockingMonitoringPolicyFlag as workerIsAlertBlockingFlag,
  isPersistentMonitoringPolicyFlag as workerIsPersistentFlag,
  monitoringPolicyAliasConflicts as workerAliasConflicts,
  monitoringPolicyFlagIdForAlias as workerCanonicalFlagId,
  monitoringPolicyPromptLinesForScope as workerPromptLinesForScope,
  visualReviewBatchPolicyIdentity as workerVisualPolicyIdentity,
  visualReviewBatchPolicyCoverageGaps as workerCoverageGaps,
} from "./award-monitoring-policy.mjs";

describe("worker award monitoring policy", () => {
  it("matches the app policy bundle identity and normalized blocking flags", () => {
    expect(workerPolicyIdentity).toEqual(appPolicyIdentity);
    expect(workerVisualPolicyIdentity).toEqual(appVisualPolicyIdentity);
    expect(workerSuppressionPolicyIdentity).toEqual(appSuppressionPolicyIdentity);
    expect(workerSuppressionPolicyIdentity.hash).not.toBe(workerVisualPolicyIdentity.hash);
    expect(workerAlertBlockingFlagIds).toEqual(appAlertBlockingFlagIds);
  });

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
    workerRule.active = false;
    appRule.active = false;
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
    } finally {
      if (workerActive === undefined) delete workerRule.active;
      else workerRule.active = workerActive;
      if (appActive === undefined) delete appRule.active;
      else appRule.active = appActive;
    }
  });
});
