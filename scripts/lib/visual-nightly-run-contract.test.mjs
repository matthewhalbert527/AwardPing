import { describe, expect, it } from "vitest";
import {
  classifyScheduledNightlyVisualRun,
  resolveVisualDiscoveryConfiguration,
} from "./visual-nightly-run-contract.mjs";

function canonicalOptions(overrides = {}) {
  return {
    run_trigger: "scheduled",
    limit: 50_000,
    include_not_due: true,
    discovery_mode: true,
    discovery_intent: "live_recurring",
    discovery_onboarding_batch_id: null,
    discover_pdf_subpages: true,
    discover_html_subpages: false,
    visual_review_mode: "batch",
    interpret_visual_changes: true,
    r2_snapshot_sync: true,
    ...overrides,
  };
}

describe("scheduled nightly visual run contract", () => {
  it("accepts only the canonical live recurring scan", () => {
    expect(classifyScheduledNightlyVisualRun({
      runIdentity: { trigger: "scheduled" },
      options: canonicalOptions(),
    })).toEqual({
      eligible: true,
      reason: "scheduled_live_recurring_discovery",
      option: null,
    });
  });

  it.each([
    ["historical onboarding", { discovery_onboarding_batch_id: "old-batch" }, "historical_onboarding"],
    ["localization repair", { localization_repair: true }, "repair_run"],
    ["disabled PDF discovery", { discover_pdf_subpages: false }, "pdf_discovery_disabled"],
    ["HTML discovery", { discover_html_subpages: true }, "html_discovery_not_canonical"],
    ["disabled review", { visual_review_mode: "none", interpret_visual_changes: false }, "visual_review_not_canonical"],
    ["disabled R2 sync", { r2_snapshot_sync: false }, "immutable_evidence_sync_disabled"],
  ])("fails closed for %s", (_label, overrides, reason) => {
    expect(classifyScheduledNightlyVisualRun({
      runIdentity: { trigger: "scheduled" },
      options: canonicalOptions(overrides),
    })).toMatchObject({ eligible: false, reason });
  });

  it("lets an explicit live CLI contract defeat poisoned persistent discovery state", () => {
    expect(resolveVisualDiscoveryConfiguration({
      args: {
        "discovery-intent": "live_recurring",
        "discovery-onboarding-batch-id": "",
      },
      env: {
        AWARDPING_DISCOVERY_INTENT: "historical_onboarding",
        AWARDPING_DISCOVERY_ONBOARDING_BATCH_ID: "stale-onboarding-batch",
      },
    })).toEqual({
      requestedIntent: "live_recurring",
      requestedOnboardingBatchId: "",
      discoveryIntent: "live_recurring",
    });
  });

  it("retains explicit manual historical onboarding configuration", () => {
    expect(resolveVisualDiscoveryConfiguration({
      args: {
        "discovery-intent": "historical_onboarding",
        "discovery-onboarding-batch-id": "manual-batch",
      },
      env: {},
    })).toEqual({
      requestedIntent: "historical_onboarding",
      requestedOnboardingBatchId: "manual-batch",
      discoveryIntent: "historical_onboarding",
    });
  });
});
