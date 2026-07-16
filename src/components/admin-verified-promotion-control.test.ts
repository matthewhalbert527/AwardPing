import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  AdminVerifiedPromotionControl,
  parseLegitimateNegativeEventIds,
  promotionControlAction,
  workflowRequestIdAfterAcceptedResponse,
  workflowRequestIdAfterHttpResponse,
  workflowRequestIdForSubmission,
} from "@/components/admin-verified-promotion-control";
import { monitoringFeedbackPromotionStages } from "@/lib/monitoring-feedback-promotion";

describe("AdminVerifiedPromotionControl", () => {
  it("exposes only the normal server-approved operator actions without a failed gate", () => {
    expect(promotionControlAction(null)).toBeNull();
    expect(promotionControlAction("triaged")?.action).toBe("confirm_cluster");
    expect(promotionControlAction("similar_feedback_clustered")?.action).toBe("draft_rule");
    expect(
      promotionControlAction("retroactive_sweep", false, true, true)?.action,
    ).toBe("resolve");
    expect(
      promotionControlAction("retroactive_sweep", false, true, false),
    ).toBeNull();

    for (const stage of monitoringFeedbackPromotionStages) {
      if (["triaged", "similar_feedback_clustered"].includes(stage)) {
        continue;
      }
      expect(promotionControlAction(stage)).toBeNull();
    }
  });

  it("does not invent a second triage action after feedback submission", () => {
    const html = renderControl(null);

    expect(html).toContain("Automatic verification in progress");
    expect(html).not.toContain("<button");
  });

  it("requires a stable rule ID and boundary at the drafting checkpoint", () => {
    const html = renderControl("similar_feedback_clustered");

    expect(html).toContain("Save draft rule");
    expect(html).toContain("Implemented candidate rule");
    expect(html).toContain("Rule boundary");
    expect(html.match(/required=""/g) || []).toHaveLength(3);
    expect(html).toContain("routine listing timestamp churn");
    expect(html).toContain("Preserve applicant-facing deadline changes.");
    expect(html).toContain("Known real update IDs this rule must keep visible");
    expect(html).toContain("40000000-0000-4000-8000-000000000004");
    expect(html).toContain("never chooses an easy example");
  });

  it("offers an audited return to draft only after a pre-activation gate fails", () => {
    const failedHtml = renderControl("historical_shadow_test", true);
    const ordinaryHtml = renderControl("historical_shadow_test", false);

    expect(promotionControlAction("historical_shadow_test", true)?.action).toBe(
      "restart_draft",
    );
    expect(failedHtml).toContain("Revise the draft rule");
    expect(failedHtml).toContain("Automatic retries continue");
    expect(failedHtml).toContain("prior reports stay in the audit history");
    expect(ordinaryHtml).toContain("Automatic verification in progress");
    expect(ordinaryHtml).not.toContain("Revise the draft rule");
  });

  it("blocks redrafting while a failed rule is still active globally", () => {
    const html = renderControl("historical_shadow_test", true, true);

    expect(promotionControlAction("historical_shadow_test", true, true)).toBeNull();
    expect(html).toContain("Deactivate before redrafting");
    expect(html).toContain("already live");
    expect(html).not.toContain("Revise the draft rule");
  });

  it("normalizes and deduplicates retained real-update IDs", () => {
    expect(
      parseLegitimateNegativeEventIds(
        "40000000-0000-4000-8000-000000000004,\n50000000-0000-4000-8000-000000000005 40000000-0000-4000-8000-000000000004",
      ),
    ).toEqual([
      "40000000-0000-4000-8000-000000000004",
      "50000000-0000-4000-8000-000000000005",
    ]);
  });

  it("reuses an ambiguous request but rotates before the next accepted action", () => {
    const createRequestId = vi
      .fn()
      .mockReturnValueOnce("10000000-0000-4000-8000-000000000001")
      .mockReturnValueOnce("20000000-0000-4000-8000-000000000002");

    const firstActionRequestId = workflowRequestIdForSubmission(
      "",
      createRequestId,
    );
    const ambiguousRetryRequestId = workflowRequestIdForSubmission(
      firstActionRequestId,
      createRequestId,
    );
    const secondActionRequestId = workflowRequestIdForSubmission(
      workflowRequestIdAfterAcceptedResponse(),
      createRequestId,
    );

    expect(ambiguousRetryRequestId).toBe(firstActionRequestId);
    expect(secondActionRequestId).not.toBe(firstActionRequestId);
    expect(secondActionRequestId).toBe(
      "20000000-0000-4000-8000-000000000002",
    );
    expect(createRequestId).toHaveBeenCalledTimes(2);
  });

  it("rotates after deterministic 4xx rejection but retains ambiguous failures", () => {
    const requestId = "10000000-0000-4000-8000-000000000001";
    const createRequestId = vi
      .fn()
      .mockReturnValue("20000000-0000-4000-8000-000000000002");

    const rejectedRequestId = workflowRequestIdAfterHttpResponse(requestId, 409);
    const nextAfterRejection = workflowRequestIdForSubmission(
      rejectedRequestId,
      createRequestId,
    );
    const retainedAfterServerFailure = workflowRequestIdAfterHttpResponse(
      requestId,
      500,
    );
    const retainedAfterNetworkFailure = workflowRequestIdForSubmission(
      requestId,
      createRequestId,
    );

    expect(nextAfterRejection).toBe(
      "20000000-0000-4000-8000-000000000002",
    );
    expect(retainedAfterServerFailure).toBe(requestId);
    expect(retainedAfterNetworkFailure).toBe(requestId);
  });

  it("shows automation ownership instead of a manual gate-skipping action", () => {
    const html = renderControl("regression_tests_pass");

    expect(html).toContain("Automatic verification in progress");
    expect(html).toContain("workflow service owns this stage");
    expect(html).not.toContain("<button");
  });

  it("states that activation requires the reviewed app and worker deployment", () => {
    const html = renderControl("six_pm_canary");

    expect(html).toContain("Activation deployment required");
    expect(html).toContain("Change only the drafted candidate to active");
    expect(html).not.toContain("<button");
  });

  it("does not tell an operator to activate a rule that is already live", () => {
    const html = renderControl("six_pm_canary", false, true);

    expect(html).toContain("App activation detected; worker parity pending");
    expect(html).toContain("active in the current app policy");
    expect(html).toContain("activated worker identity has not been re-attested");
    expect(html).toContain("bounded historical sweep");
    expect(html).not.toContain("Change only the drafted candidate to active");
  });

  it("explains automatic no-charge recovery after post-canary evidence drift", () => {
    const activeHtml = renderControl("six_pm_canary", true, true, true);
    const rolledBackHtml = renderControl("six_pm_canary", true, false, true);
    const partialSweepHtml = renderControl("retroactive_sweep", true, false, true);

    expect(activeHtml).toContain("Rollback deployment required");
    expect(activeHtml).toContain("Deactivate this rule");
    expect(activeHtml).toContain("checks the rollback identities hourly at no API charge");
    expect(rolledBackHtml).toContain("Rollback verification in progress");
    expect(rolledBackHtml).toContain("Keep this candidate inactive");
    expect(rolledBackHtml).not.toContain("Activation deployment required");
    expect(partialSweepHtml).toContain("Rollback verification in progress");
    expect(partialSweepHtml).toContain("reverses partial");
    expect(partialSweepHtml).not.toContain("Resolve verified pattern");
  });

  it("shows final resolution only after the retroactive sweep stage", () => {
    const waitingHtml = renderControl("retroactive_sweep", false, true, false, false);
    const sweepHtml = renderControl("retroactive_sweep", false, true, false, true);
    const deactivatedHtml = renderControl("retroactive_sweep", false, false);
    const resolvedHtml = renderControl("resolved");

    expect(waitingHtml).toContain("Final hourly attestation pending");
    expect(waitingHtml).toContain("Resolve stays locked");
    expect(waitingHtml).not.toContain("Resolve verified pattern");
    expect(sweepHtml).toContain("Resolve verified pattern");
    expect(sweepHtml).toContain("completed sweep artifact");
    expect(sweepHtml).toContain("next normal hourly, zero-charge matching worker attestation");
    expect(sweepHtml).toContain("does not require another 6 PM scan");
    expect(deactivatedHtml).toContain("Rule deactivation detected");
    expect(deactivatedHtml).toContain("Do not resolve this cluster");
    expect(deactivatedHtml).not.toContain("Resolve verified pattern");
    expect(resolvedHtml).toContain("Verification complete");
    expect(resolvedHtml).not.toContain("<button");
  });

  it("requires rollback instead of waiting when post-sweep identity drifts", () => {
    const html = renderControl(
      "retroactive_sweep",
      true,
      true,
      false,
      false,
      true,
      "Post-sweep identity drift blocks resolution: matcher/verifier bundle changed.",
    );

    expect(html).toContain("Post-sweep identity drift requires rollback");
    expect(html).toContain("matcher/verifier bundle changed");
    expect(html).toContain("restore the exact inactive app and worker deployment");
    expect(html).toContain("Do not resolve this cluster");
    expect(html).not.toContain("Final hourly attestation pending");
  });
});

function renderControl(
  stage: Parameters<typeof AdminVerifiedPromotionControl>[0]["stage"],
  hasFailedGate = false,
  ruleActive = false,
  activationBlocked = false,
  resolutionReady = false,
  resolutionIdentityDrifted = false,
  resolutionIdentityDriftReason: string | null = null,
) {
  return renderToStaticMarkup(
    createElement(AdminVerifiedPromotionControl, {
      candidateRuleIds: ["routine_listing_timestamp_churn"],
      expectedVersion: 3,
      stage,
      workflowId: "11111111-1111-4111-8111-111111111111",
      defaultPolicyRuleId: "routine_listing_timestamp_churn",
      defaultDraftSummary: "Preserve applicant-facing deadline changes.",
      defaultLegitimateNegativeEventIds: [
        "40000000-0000-4000-8000-000000000004",
      ],
      hasFailedGate,
      ruleActive,
      activationBlocked,
      resolutionReady,
      resolutionIdentityDrifted,
      resolutionIdentityDriftReason,
    }),
  );
}
