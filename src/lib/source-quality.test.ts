import { describe, expect, it } from "vitest";
import {
  isMonitorableAwardSource,
  isPublicAwardSource,
  isUsableAwardFactSource,
  sourceQualityDecision,
} from "@/lib/source-quality";

const currentPrimaryFacts = {
  award_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  deadline: "February 1, 2027",
  eligibility: ["Graduate students"],
  confidence: "high",
};

function source(overrides: Record<string, unknown>) {
  return {
    id: "source-1",
    url: "https://example.edu/scholarship/apply",
    title: "Application",
    page_type: "application",
    page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
    page_metadata_model: "gemini-test",
    page_metadata: {
      kind: "source_page_outline",
      baseline_facts: currentPrimaryFacts,
    },
    ...overrides,
  };
}

describe("source quality gate", () => {
  it("rejects Schmidt Science Fellows-style pharma spam upload pages", () => {
    const decision = sourceQualityDecision(
      source({
        url: "https://schmidtsciencefellows.org/wp-content/uploads/2026/06/award-info.html",
        title: "Buy Levitra online without prescription",
        page_type: "homepage",
      }),
      { purpose: "monitoring" },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("url_spam_upload_html");
  });

  it("rejects DAAD unrelated scholarship database detail pages", () => {
    const daad = source({
      url: "https://www.daad.de/deutschland/stipendium/datenbank/en/21148-scholarship-database/?detail=57742121",
      page_metadata: {
        kind: "source_page_outline",
        baseline_facts: {
          ...currentPrimaryFacts,
          award_relevance: "unrelated",
          page_description: "A different DAAD scholarship database detail page.",
        },
      },
    });

    expect(isPublicAwardSource(daad)).toBe(false);
    expect(isUsableAwardFactSource(daad)).toBe(false);
    expect(isMonitorableAwardSource(daad)).toBe(false);
  });

  it("rejects Phi Kappa Phi careers and job profile pages even with protected page types", () => {
    const decision = sourceQualityDecision(
      source({
        url: "https://www.phikappaphi.org/careers/job/profile/12345",
        page_type: "requirements",
      }),
      { purpose: "monitoring" },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("url_not_monitorable");
  });

  it("rejects Temple bursar/payment/1098T pages", () => {
    const decision = sourceQualityDecision(
      source({
        url: "https://bursar.temple.edu/payments/1098t",
        page_type: "deadline",
      }),
      { purpose: "monitoring" },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("url_not_monitorable");
  });

  it("rejects SFFILM FAQ pages marked unclear", () => {
    const unclearFaq = source({
      url: "https://sffilm.org/artist-development/find-a-grant/faq",
      title: "FAQ",
      page_type: "faq",
      page_metadata: {
        kind: "source_page_outline",
        baseline_facts: {
          award_relevance: "unclear",
          cycle_relevance: "unclear",
          page_description: "FAQ content cannot be matched to this exact award.",
          confidence: "medium",
        },
      },
    });

    expect(isPublicAwardSource(unclearFaq)).toBe(false);
    expect(isUsableAwardFactSource(unclearFaq)).toBe(false);
    expect(isMonitorableAwardSource(unclearFaq)).toBe(false);
  });

  it("lets a later explicit operator restore an AI-unclear source for monitoring only", () => {
    const restored = source({
      url: "https://www.marshallscholarship.org/apply/faqs/",
      page_type: "faq",
      page_metadata: {
        kind: "source_page_outline",
        generated_at: "2026-07-08T02:10:45.237Z",
        ai_review_coverage_backfill: { at: "2026-07-10T21:13:19.463Z" },
        baseline_facts: {
          award_relevance: "primary",
          cycle_relevance: "unclear",
          confidence: "high",
          quality_flags: [],
        },
      },
      admin_review_status: "open",
      admin_reviewed_at: "2026-08-10T14:57:25.644Z",
      admin_reviewed_by: "codex-stage1-marshall-review",
      admin_review_note:
        "Restored by explicit Stage 1 Marshall source review after checking the official FAQ.",
    });

    expect(sourceQualityDecision(restored, { purpose: "monitoring" })).toMatchObject({
      allowed: true,
      reason: "operator_review_restored_ai_unclear_monitoring_only",
    });
    expect(sourceQualityDecision(restored, { purpose: "facts" })).toMatchObject({
      allowed: false,
      reason: "ai_review_reviewed_unclear_needs_manual_review_cycle_relevance_unclear",
    });
    expect(sourceQualityDecision(restored, { purpose: "public" }).allowed).toBe(false);

    const adminRestore = {
      ...restored,
      admin_review_note:
        "monitoring_restore_v1: Explicitly restored by a site admin for monitoring only.",
      admin_reviewed_by: "operator@example.edu",
    };
    expect(sourceQualityDecision(adminRestore, { purpose: "monitoring" }).allowed).toBe(true);
    expect(
      sourceQualityDecision(
        { ...adminRestore, admin_review_note: null },
        { purpose: "monitoring" },
      ).allowed,
    ).toBe(false);
  });

  it("keeps stale, automated, and hard-rejected operator-looking restores blocked", () => {
    const base = source({
      page_metadata: {
        kind: "source_page_outline",
        generated_at: "2026-07-08T02:10:45.237Z",
        ai_review_coverage_backfill: { at: "2026-07-10T21:13:19.463Z" },
        baseline_facts: {
          award_relevance: "primary",
          cycle_relevance: "unclear",
          confidence: "high",
        },
      },
      admin_review_status: "open",
      admin_reviewed_at: "2026-08-10T14:57:25.644Z",
      admin_reviewed_by: "operator@example.edu",
    });

    expect(
      sourceQualityDecision(
        { ...base, admin_reviewed_at: "2026-07-09T00:00:00.000Z" },
        { purpose: "monitoring" },
      ).allowed,
    ).toBe(false);
    expect(
      sourceQualityDecision(
        { ...base, admin_reviewed_by: "open-source-ai-coverage-backfill" },
        { purpose: "monitoring" },
      ).allowed,
    ).toBe(false);
    expect(
      sourceQualityDecision(
        {
          ...base,
          page_metadata: {
            ...(base.page_metadata as Record<string, unknown>),
            baseline_facts: {
              award_relevance: "primary",
              cycle_relevance: "unclear",
              confidence: "high",
              quality_flags: ["sibling-program"],
            },
          },
        },
        { purpose: "monitoring" },
      ).allowed,
    ).toBe(false);
  });

  it("allows legitimate current application, deadline, and requirements metadata", () => {
    const legitimate = source({
      url: "https://knight-hennessy.stanford.edu/admission/application-deadlines",
      title: "Application Deadlines",
      page_type: "deadline",
    });

    expect(isPublicAwardSource(legitimate)).toBe(true);
    expect(isUsableAwardFactSource(legitimate)).toBe(true);
    expect(isMonitorableAwardSource(legitimate)).toBe(true);
  });

  it("treats missing Gemini relevance fields as unclear and rejects them", () => {
    const missingRelevance = source({
      page_metadata: {
        kind: "source_page_outline",
        baseline_facts: {
          display_title: "Application information",
          evidence_quotes: ["Application information"],
        },
      },
    });

    expect(sourceQualityDecision(missingRelevance, { purpose: "public" }).reason).toBe(
      "ai_review_reviewed_invalid_or_incomplete_missing_award_relevance",
    );
    expect(sourceQualityDecision(missingRelevance, { purpose: "facts" }).reason).toBe(
      "ai_review_reviewed_invalid_or_incomplete_missing_award_relevance",
    );
    expect(sourceQualityDecision(missingRelevance, { purpose: "monitoring" }).reason).toBe(
      "ai_review_reviewed_invalid_or_incomplete_missing_award_relevance",
    );
  });

  it("honors an exact Stage 1 monitoring-only approval without granting fact authority", () => {
    const approved = source({
      page_metadata: {
        baseline_facts: { award_relevance: "primary", cycle_relevance: "unclear" },
        stage1_baseline_monitoring_approval: {
          decision: "monitoring_only",
          decision_item_sha256: "b".repeat(64),
          evidence_packet_sha256: "8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f",
          exact_evidence_verified: true,
          fact_candidate_authority: false,
          notification_mode: "baseline_only",
          policy_version: "stage1-baseline-source-disposition-v1",
          public_fact_authority: false,
          reviewed_roles: ["funding"],
          schema_version: "awardping.stage1.baseline-monitoring-approval.v1",
          shared_award_source_id: "source-1",
          source_page_request_id: "62a291a2-e64d-5788-a876-f2dca551a021",
        },
      },
    });

    expect(sourceQualityDecision(approved, { purpose: "monitoring" })).toMatchObject({
      allowed: true,
      reason: "stage1_baseline_monitoring_only",
    });
    expect(sourceQualityDecision(approved, { purpose: "facts" }).reason)
      .toBe("stage1_baseline_monitoring_only_no_fact_authority");
    expect(sourceQualityDecision(approved, { purpose: "public" }).reason)
      .toBe("stage1_baseline_monitoring_only_no_fact_authority");
    expect(sourceQualityDecision(approved, { purpose: "discovery" }).reason)
      .toBe("stage1_baseline_monitoring_only_no_discovery_authority");
  });

  it("does not let missing baseline facts feed public facts or daily monitoring", () => {
    const missingFacts = source({
      page_type: "application",
      page_metadata_generated_at: null,
      page_metadata_model: null,
      page_metadata: {},
    });

    expect(sourceQualityDecision(missingFacts, { purpose: "facts" }).reason).toBe(
      "ai_review_unreviewed_missing_page_metadata_generated_at_and_baseline_facts",
    );
    expect(sourceQualityDecision(missingFacts, { purpose: "public" }).reason).toBe(
      "ai_review_unreviewed_missing_page_metadata_generated_at_and_baseline_facts",
    );
    expect(isMonitorableAwardSource(missingFacts)).toBe(false);
  });
});
