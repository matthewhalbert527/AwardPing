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

    expect(sourceQualityDecision(missingRelevance, { purpose: "public" }).reason).toBe("award_relevance_unclear");
    expect(sourceQualityDecision(missingRelevance, { purpose: "facts" }).reason).toBe("award_relevance_unclear");
    expect(sourceQualityDecision(missingRelevance, { purpose: "monitoring" }).reason).toBe("award_relevance_unclear");
  });

  it("does not let missing baseline facts feed public facts but allows protected pages to be monitored", () => {
    const missingFacts = source({
      page_type: "application",
      page_metadata_generated_at: null,
      page_metadata: {},
    });

    expect(sourceQualityDecision(missingFacts, { purpose: "facts" }).reason).toBe("missing_baseline_facts");
    expect(sourceQualityDecision(missingFacts, { purpose: "public" }).reason).toBe("missing_baseline_facts");
    expect(isMonitorableAwardSource(missingFacts)).toBe(true);
  });
});
