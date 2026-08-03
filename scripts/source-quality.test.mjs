import { describe, expect, it } from "vitest";
import {
  isMonitorableAwardSource,
  isPublicAwardSource,
  isUsableAwardFactSource,
  sourceQualityDecision,
} from "./lib/source-quality.mjs";

const currentPrimaryFacts = {
  award_relevance: "primary",
  cycle_relevance: "current_or_upcoming",
  deadline: "February 1, 2027",
  eligibility: ["Graduate students"],
  confidence: "high",
};

function source(overrides = {}) {
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

describe("worker source quality gate", () => {
  it("rejects pharma spam upload pages", () => {
    const decision = sourceQualityDecision(
      source({
        url: "https://schmidtsciencefellows.org/wp-content/uploads/2026/06/apply.html",
        title: "Cialis pharmacy discount page",
        page_type: "homepage",
      }),
      { purpose: "monitoring" },
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("url_spam_upload_html");
  });

  it("rejects unrelated and sibling-program facts", () => {
    const daad = source({
      url: "https://www.daad.de/deutschland/stipendium/datenbank/en/21148-scholarship-database/?detail=57742121",
      page_metadata: {
        kind: "source_page_outline",
        baseline_facts: {
          ...currentPrimaryFacts,
          award_relevance: "unrelated",
          quality_flags: ["sibling-program"],
        },
      },
    });

    expect(isPublicAwardSource(daad)).toBe(false);
    expect(isUsableAwardFactSource(daad)).toBe(false);
    expect(isMonitorableAwardSource(daad)).toBe(false);
  });

  it("rejects careers, payment, and unclear FAQ sources", () => {
    expect(
      sourceQualityDecision(source({ url: "https://www.phikappaphi.org/careers/job/profile/123" }), {
        purpose: "monitoring",
      }).allowed,
    ).toBe(false);
    expect(
      sourceQualityDecision(source({ url: "https://bursar.temple.edu/payments/1098t" }), {
        purpose: "monitoring",
      }).allowed,
    ).toBe(false);
    expect(
      sourceQualityDecision(
        source({
          url: "https://sffilm.org/faq",
          page_type: "faq",
          page_metadata: {
            kind: "source_page_outline",
            baseline_facts: {
              award_relevance: "unclear",
              cycle_relevance: "unclear",
            },
          },
        }),
        { purpose: "monitoring" },
      ).allowed,
    ).toBe(false);
  });

  it("allows legitimate current application/deadline metadata", () => {
    expect(
      isMonitorableAwardSource(
        source({
          url: "https://knight-hennessy.stanford.edu/admission/application-deadlines",
          page_type: "deadline",
        }),
      ),
    ).toBe(true);
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
    const requestId = "62a291a2-e64d-5788-a876-f2dca551a021";
    const approved = source({
      page_metadata: {
        kind: "source_page_outline",
        baseline_facts: {
          award_relevance: "primary",
          cycle_relevance: "unclear",
        },
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
          source_page_request_id: requestId,
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

  it("rejects a forged or broadened Stage 1 monitoring approval", () => {
    const approved = source({
      page_metadata: {
        baseline_facts: { award_relevance: "primary", cycle_relevance: "unclear" },
        stage1_baseline_monitoring_approval: {
          decision: "monitoring_only",
          decision_item_sha256: "b".repeat(64),
          evidence_packet_sha256: "8a1c1d9aa8ccbdf1dcdbb7b2f4b83ac19c99dd9557a8949dff5f63dd22d1026f",
          exact_evidence_verified: true,
          fact_candidate_authority: true,
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

    expect(sourceQualityDecision(approved, { purpose: "monitoring" }).reason)
      .toBe("stage1_baseline_monitoring_approval_invalid");
  });

  it("keeps monitoring-only authority narrow even when the ordinary AI review is usable", () => {
    const approved = source();
    approved.page_metadata.stage1_baseline_monitoring_approval = {
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
    };

    expect(sourceQualityDecision(approved, { purpose: "monitoring" }).allowed).toBe(true);
    expect(sourceQualityDecision(approved, { purpose: "facts" }).allowed).toBe(false);
    expect(sourceQualityDecision(approved, { purpose: "public" }).allowed).toBe(false);
  });

  it("rejects known bad discovery URL shapes before insertion", () => {
    const badUrls = [
      "https://schmidtsciencefellows.org/wp-content/uploads/2026/06/cheap-cialis.html",
      "https://www.phikappaphi.org/careers/job/profile/123",
      "https://bursar.temple.edu/payments/1098t",
      "https://ask.loc.gov/security-question/access",
      "https://example.edu/find-programs?query=scholarship",
      "https://example.edu/scholarship-search?q=engineering",
      "https://example.edu/news/award-recipient-profile",
    ];

    for (const url of badUrls) {
      expect(
        sourceQualityDecision(
          source({
            url,
            title: url.includes("cialis") ? "Cheap Cialis pharmacy" : "Bad discovery candidate",
            page_type: "application",
            page_metadata: null,
            page_metadata_generated_at: null,
          }),
          { purpose: "discovery" },
        ).allowed,
      ).toBe(false);
    }
  });

  it("allows a clean discovery candidate URL to reach the award identity gate", () => {
    const decision = sourceQualityDecision(
      source({
        url: "https://example.edu/scholarship/application-guidelines",
        title: "Application guidelines",
        page_type: "application",
        page_metadata: null,
        page_metadata_generated_at: null,
      }),
      { purpose: "discovery" },
    );

    expect(decision.allowed).toBe(true);
  });
});
