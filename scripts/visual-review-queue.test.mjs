import { describe, expect, it } from "vitest";
import {
  buildVisualReviewPromptPayload,
  classifyVisualReviewCandidate,
  expandableSectionCandidateRejectReason,
  normalizeVisualBatchResult,
  normalizeVisualReviewMode,
  validateVisualBatchReview,
  visualReviewCandidateSignature,
} from "./lib/visual-review-queue.mjs";

const source = {
  id: "source-1",
  shared_award_id: "award-1",
  url: "https://example.edu/scholarships/example-award/apply",
  title: "Example Award Application",
  page_type: "application",
  admin_review_status: "open",
  page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
  page_metadata_model: "gemini-test",
  page_metadata: {
    baseline_facts: {
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      display_title: "Example Award Application",
      quality_flags: [],
    },
  },
};

const candidate = {
  id: "candidate-1",
  shared_award_source_id: "source-1",
  candidate_signature: "signature",
  deterministic_diff: {
    added_text: ["Application deadline: March 15, 2027"],
    removed_text: ["Application deadline: March 1, 2027"],
  },
  prompt_payload: {
    include_images: false,
    new_text_excerpt: "Application deadline: March 15, 2027",
    previous_text_excerpt: "Application deadline: March 1, 2027",
  },
};

function sourceFixture(overrides = {}) {
  return {
    ...source,
    ...overrides,
    page_metadata: {
      ...source.page_metadata,
      ...(overrides.page_metadata || {}),
      baseline_facts: {
        ...source.page_metadata.baseline_facts,
        ...(overrides.page_metadata?.baseline_facts || {}),
      },
    },
  };
}

describe("visual review queue helpers", () => {
  it("normalizes visual review mode values", () => {
    expect(normalizeVisualReviewMode("batch", "immediate")).toBe("batch");
    expect(normalizeVisualReviewMode("false", "batch")).toBe("none");
    expect(normalizeVisualReviewMode("true", "batch")).toBe("batch");
    expect(normalizeVisualReviewMode("immediate", "batch")).toBe("immediate");
  });

  it("builds stable signatures from hashes and deterministic diff", () => {
    const first = visualReviewCandidateSignature({
      source,
      baseline: { text_hash: "a", image_hash: "b" },
      capture: { text_hash: "c", image_hash: "d" },
      diff: { added_text: ["Application deadline: March 15, 2027"] },
      deterministic: { classification: "candidate_change" },
      behaviorVersion: 6,
    });
    const second = visualReviewCandidateSignature({
      source,
      baseline: { image_hash: "b", text_hash: "a" },
      capture: { image_hash: "d", text_hash: "c" },
      diff: { added_text: ["Application deadline: March 15, 2027"] },
      deterministic: { classification: "candidate_change" },
      behaviorVersion: 6,
    });
    expect(first).toHaveLength(64);
    expect(second).toBe(first);
  });

  it("allows a supported primary award fact change", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [
        {
          fact: "Application deadline changed",
          before: "Application deadline: March 1, 2027",
          after: "Application deadline: March 15, 2027",
          added_text: "Application deadline: March 15, 2027",
          removed_text: "Application deadline: March 1, 2027",
        },
      ],
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The application deadline changed from March 1 to March 15, 2027.",
      advisor_impact: "Advisors should update deadline guidance.",
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toEqual({
      allowed: true,
      reason: "approved",
    });
  });

  it("accepts the strict changed_facts and exact evidence fields", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      source_relevance_reason: "The source is the award application page.",
      changed_facts: [
        {
          fact: "Application deadline changed",
          before: "Application deadline: March 1, 2027",
          after: "Application deadline: March 15, 2027",
        },
      ],
      exact_before: "Application deadline: March 1, 2027",
      exact_after: "Application deadline: March 15, 2027",
      evidence_location: "Deadline row",
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
      reader_summary: "The application deadline changed from March 1 to March 15, 2027.",
      advisor_impact: "Advisors should update deadline guidance.",
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toEqual({
      allowed: true,
      reason: "approved",
    });
  });

  it("rejects unclear source relevance", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "unclear",
      changed_award_facts: [{ fact: "Deadline changed", added_text: "Application deadline: March 15, 2027" }],
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toMatchObject({
      allowed: false,
      reason: "source_relevance_unclear",
    });
  });

  it("rejects unsupported changed facts", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [{ fact: "Award amount changed", after: "$5,000" }],
      exact_before: "Application deadline: March 1, 2027",
      exact_after: "Application deadline: March 15, 2027",
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Funding",
      change_type: "funding",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toMatchObject({
      allowed: false,
      reason: "changed_facts_not_supported_by_evidence",
    });
  });

  it("rejects a high-confidence result when one critical claim lacks exact evidence", () => {
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [
        {
          fact: "Application deadline changed",
          before: "Application deadline: March 1, 2027",
          after: "Application deadline: March 15, 2027",
        },
        {
          fact: "Award amount changed",
          before: "$4,000",
          after: "$5,000",
        },
      ],
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines and funding",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
    }, { candidate, source });

    expect(validateVisualBatchReview({ candidate, source, result })).toMatchObject({
      allowed: false,
      reason: "changed_facts_not_supported_by_evidence",
    });
  });

  it("rejects source-quality failures at publish time", () => {
    const badSource = {
      ...source,
      url: "https://example.edu/careers/job/profile/123",
    };
    const result = normalizeVisualBatchResult({
      is_true_change: true,
      is_alert_worthy: true,
      source_relevance: "primary",
      changed_award_facts: [{ fact: "Deadline changed", added_text: "Application deadline: March 15, 2027" }],
      before: "Application deadline: March 1, 2027",
      after: "Application deadline: March 15, 2027",
      section: "Deadlines",
      change_type: "deadline",
      confidence: "high",
      noise_flags: [],
      rejection_reason: null,
    }, { candidate, source: badSource });

    expect(validateVisualBatchReview({ candidate, source: badSource, result })).toMatchObject({
      allowed: false,
    });
  });

  it("rejects ACLS/JUMP AppSolutions version churn before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["JUMP AppSolutions Version 5.1.7"],
        removed_text: ["JUMP AppSolutions Version 5.1.6"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "popup_modal_noise",
    });
  });

  it("rejects Ask LOC security-question pages before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://ask.loc.gov/security/question",
        title: "Security Question",
      }),
      diff: {
        added_text: ["Security question answer required"],
        removed_text: ["Security question"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "access_error",
      source_rejected: true,
    });
  });

  it("rejects unclear SFFILM general FAQ sources before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://sffilm.org/faq",
        title: "General FAQ",
        page_type: "faq",
        page_metadata: {
          baseline_facts: {
            award_relevance: "unclear",
            cycle_relevance: "current_or_upcoming",
          },
        },
      }),
      diff: {
        added_text: ["Frequently asked questions were reordered."],
        removed_text: ["General questions"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      reason: "source_quality_ai_review_reviewed_unclear_needs_manual_review_award_relevance_unclear",
      source_rejected: true,
    });
  });

  it("rejects Audubon popup/free app modal changes before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://example.edu/audubon/scholarship/apply",
        title: "Audubon Scholarship Application",
      }),
      diff: {
        added_text: ["Download our free app to continue"],
        removed_text: ["Close"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "popup_modal_noise",
    });
  });

  it("rejects PDF file-size/hash changes with no text evidence before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://example.edu/scholarships/example-award/guide.pdf",
        title: "Example Award Guide PDF",
        page_type: "pdf",
      }),
      diff: {
        added_text: [],
        removed_text: [],
      },
      deterministic: { candidate_change: true, reason: "pdf_file_hash_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "pdf_metadata_only",
    });
  });

  it("rejects fellow profile/testimonial rotation before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Featured fellow testimonial: I loved the program."],
        removed_text: ["Featured fellow testimonial: This changed my career."],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "profile_roster_rotation",
    });
  });

  it("rejects job board updates before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        url: "https://example.edu/careers/jobs/123",
        title: "Program Coordinator Job",
      }),
      diff: {
        added_text: ["The job posting close date changed."],
        removed_text: ["Apply now for this job."],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      source_rejected: true,
    });
  });

  it("rejects sibling PhRMA Faculty Starter Grants under the wrong award before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source: sourceFixture({
        shared_awards: { name: "PhRMA Foundation Predoctoral Fellowship" },
        title: "PhRMA Foundation Predoctoral Fellowship",
      }),
      diff: {
        added_text: ["Faculty Starter Grants application deadline: September 1, 2027"],
        removed_text: ["Faculty Starter Grants application deadline: August 15, 2027"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "sibling_program_or_cross_award",
    });
  });

  it("allows text-only deadline changes without image prompt parts by default", () => {
    const diff = {
      added_text: ["Application deadline: April 2, 2027"],
      removed_text: ["Application deadline: March 15, 2027"],
    };
    const deterministic = { candidate_change: true, reason: "award_relevant_terms_or_context" };
    const decision = classifyVisualReviewCandidate({ source, diff, deterministic });
    const payload = buildVisualReviewPromptPayload({
      source,
      baseline: { text_hash: "old", image_hash: "same" },
      previous: { text: "Application deadline: March 15, 2027", thumbPath: "previous.jpg" },
      capture: { text: "Application deadline: April 2, 2027", text_hash: "new", image_hash: "same", thumbPath: "new.jpg" },
      diff,
      deterministic: { ...deterministic, classification: decision.label },
    });

    expect(decision).toMatchObject({
      allowed: true,
      label: "applicant_fact_change",
      candidate_kind: "text_only",
    });
    expect(payload.include_images).toBe(false);
  });

  it("keeps expandable-section candidates compact and section-scoped", () => {
    const diff = {
      candidate_scope: "expandable_section",
      section_key: "eligibility",
      section_label: "Eligibility",
      section_path: "button#eligibility",
      previous_section_hash: "old-section",
      new_section_hash: "new-section",
      added_text: ["Applicants must be enrolled full time."],
      removed_text: ["Applicants must be enrolled part time."],
    };
    const deterministic = { candidate_change: true, reason: "award_relevant_terms_or_context" };
    const first = visualReviewCandidateSignature({
      source,
      baseline: { text_hash: "old-section", image_hash: "same-page" },
      capture: { text_hash: "new-section", image_hash: "same-page" },
      diff,
      deterministic,
      behaviorVersion: 8,
    });
    const second = visualReviewCandidateSignature({
      source,
      baseline: { text_hash: "old-section", image_hash: "same-page" },
      capture: { text_hash: "new-section", image_hash: "same-page" },
      diff: { ...diff, section_key: "requirements" },
      deterministic,
      behaviorVersion: 8,
    });
    const payload = buildVisualReviewPromptPayload({
      source,
      baseline: { text_hash: "old-section", image_hash: "same-page" },
      previous: { text: "Applicants must be enrolled part time." },
      capture: { text: "Applicants must be enrolled full time.", text_hash: "new-section", image_hash: "same-page" },
      diff,
      deterministic,
    });

    expect(second).not.toBe(first);
    expect(payload.include_images).toBe(false);
    expect(payload.section_context).toMatchObject({
      candidate_scope: "expandable_section",
      section_key: "eligibility",
      section_label: "Eligibility",
    });
    expect(payload.hashes).toMatchObject({
      previous_section_hash: "old-section",
      new_section_hash: "new-section",
    });
  });

  it("allows text-only award amount changes", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Award amount: $7,500"],
        removed_text: ["Award amount: $5,000"],
      },
      deterministic: { candidate_change: true, reason: "award_relevant_terms_or_context" },
    });

    expect(decision).toMatchObject({
      allowed: true,
      label: "applicant_fact_change",
      candidate_kind: "text_only",
    });
  });

  it("rejects text-only nav/footer churn before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Footer navigation: Privacy Terms Contact Facebook LinkedIn"],
        removed_text: ["Footer navigation: Privacy Terms Contact Twitter LinkedIn"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "nav_chrome_noise",
    });
  });

  it("rejects text-only timestamp/current-date churn before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Last updated July 8, 2026"],
        removed_text: ["Last updated July 7, 2026"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "nav_chrome_noise",
      reason: "timestamp_or_countdown_noise",
    });
  });

  it("rejects text-only access-denied/login text before AI", () => {
    const decision = classifyVisualReviewCandidate({
      source,
      diff: {
        added_text: ["Access denied. Login required to continue."],
        removed_text: ["Example Award application instructions"],
      },
      deterministic: { candidate_change: true, reason: "text_changed" },
    });

    expect(decision).toMatchObject({
      allowed: false,
      label: "access_error",
    });
  });

  it("rejects an unconfirmed expandable-section removal after AI review", () => {
    const removedText = "Application deadline: February 5, 2025.";
    const decision = validateVisualBatchReview({
      source,
      candidate: {
        ...candidate,
        deterministic_diff: {
          candidate_scope: "expandable_section",
          section_label: "What is the application deadline?",
          previous_section_hash: "old-section",
          new_section_hash: null,
          section_removal_confirmed: false,
          removed_text: [removedText],
          added_text: [],
        },
      },
      result: {
        is_true_change: true,
        is_alert_worthy: true,
        source_relevance: "primary",
        confidence: "high",
        noise_flags: [],
        changed_facts: [{ fact: "deadline", removed_text: removedText }],
        exact_before: removedText,
        exact_after: null,
        reader_summary: "The application deadline was removed.",
        section: "Application deadline",
        change_type: "removed",
      },
    });

    expect(decision).toEqual({
      allowed: false,
      reason: "unconfirmed_expandable_section_removal",
    });
  });

  it("rejects an unconfirmed expandable-section removal before Batch submission", () => {
    expect(
      expandableSectionCandidateRejectReason({
        deterministic_diff: {
          candidate_scope: "expandable_section",
          previous_section_hash: "old-section",
          new_section_hash: null,
          section_removal_confirmed: false,
        },
      }),
    ).toBe("unconfirmed_expandable_section_removal");
  });

  it("rejects a claimed removal when the current page still contains the section", () => {
    expect(
      expandableSectionCandidateRejectReason({
        deterministic_diff: {
          candidate_scope: "expandable_section",
          previous_section_hash: "old-section",
          new_section_hash: null,
          section_removal_confirmed: true,
          section_presence_evidence: {
            current_label_present: true,
          },
        },
      }),
    ).toBe("expandable_section_still_present");
  });

  it("allows a confirmed expandable-section removal with exact evidence", () => {
    const removedText = "Application deadline: February 5, 2025.";
    const decision = validateVisualBatchReview({
      source,
      candidate: {
        ...candidate,
        deterministic_diff: {
          candidate_scope: "expandable_section",
          section_label: "What is the application deadline?",
          previous_section_hash: "old-section",
          new_section_hash: null,
          section_removal_confirmed: true,
          section_presence_evidence: {
            confirmed: true,
            current_label_present: false,
            current_body_present: false,
          },
          removed_text: [removedText],
          added_text: [],
        },
      },
      result: {
        is_true_change: true,
        is_alert_worthy: true,
        source_relevance: "primary",
        confidence: "high",
        noise_flags: [],
        changed_facts: [{ fact: "deadline", removed_text: removedText }],
        exact_before: removedText,
        exact_after: null,
        reader_summary: "The application deadline was removed.",
        section: "Application deadline",
        change_type: "removed",
      },
    });

    expect(decision).toEqual({ allowed: true, reason: "approved" });
  });
});
