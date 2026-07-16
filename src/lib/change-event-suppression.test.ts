import { describe, expect, it } from "vitest";
import { awardMonitoringPolicy } from "@/lib/award-monitoring-policy";
import {
  changeEventSuppressionDecision,
  qualityFlagSuppressionCandidate,
} from "@/lib/change-event-suppression";

const source = {
  id: "source-1",
  url: "https://example.edu/scholarships/example-award",
  title: "Example Award",
  page_type: "application",
  admin_review_status: "open",
  page_metadata_generated_at: "2026-07-08T00:00:00.000Z",
  page_metadata_model: "gemini-test",
  page_metadata: {
    baseline_facts: {
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      quality_flags: [],
    },
  },
};

function event(summary: string, changeDetails: unknown = {}) {
  return {
    id: "event-1",
    shared_award_source_id: "source-1",
    source_url: source.url,
    source_title: source.title,
    source_page_type: source.page_type,
    summary,
    change_details: changeDetails,
  };
}

describe("change event suppression", () => {
  it.each([
    ["The donation widget changed its suggested gift amount.", "fundraising_form_change"],
    ["The current date and last updated timestamp changed.", "current_date_only_churn"],
    ["The FAQ link order was reordered.", "navigation_or_reorder_only_change"],
    ["The cookie consent banner appeared and changed.", "site_chrome_or_transient_notice"],
    ["The impact number count-up statistic drifted while loading.", "animated_stat_counter"],
    ["A raw scrape artifact leaked HTML markup.", "raw_scrape_signal"],
  ])("detects unflagged deterministic noise: %s", (summary, expectedFlag) => {
    expect(changeEventSuppressionDecision(event(summary, { is_alert_worthy: true }), source)).toEqual({
      suppressed: true,
      reason: `policy_flag_${expectedFlag}`,
    });
  });

  it("allows applicant-facing deadline evidence on an otherwise conditional event URL", () => {
    const eventSource = {
      ...source,
      url: "https://example.edu/events/example-award-deadline",
      title: "Example Award deadline event",
      page_type: "event",
    };
    expect(changeEventSuppressionDecision(
      {
        ...event("The application deadline changed from March 1, 2027 to March 15, 2027.", {
          is_alert_worthy: true,
          generation_status: "generated",
          structured_diff: {
            added_text: ["Application deadline: March 15, 2027"],
            removed_text: ["Application deadline: March 1, 2027"],
          },
        }),
        source_url: eventSource.url,
        source_title: eventSource.title,
        source_page_type: eventSource.page_type,
      },
      eventSource,
    )).toEqual({ suppressed: false, reason: null });
  });

  it("keeps a recipient-news page suppressed without applicant-facing evidence", () => {
    const newsSource = {
      ...source,
      url: "https://example.edu/news/example-award-recipients",
      title: "Award recipient news",
      page_type: "news",
    };
    expect(changeEventSuppressionDecision(
      {
        ...event("A recipient profile was added to the news story.", { is_alert_worthy: true }),
        source_url: newsSource.url,
        source_title: newsSource.title,
        source_page_type: newsSource.page_type,
      },
      newsSource,
    )).toMatchObject({ suppressed: true });
  });

  it("does not persist mutable source lifecycle state over a true historical event", () => {
    const historicalEvent = event(
      "The application deadline changed from March 1, 2027 to March 15, 2027.",
      {
        is_alert_worthy: true,
        generation_status: "generated",
        structured_diff: {
          added_text: ["Application deadline: March 15, 2027"],
          removed_text: ["Application deadline: March 1, 2027"],
        },
      },
    );
    const currentSource = {
      ...source,
      url: "https://example.edu/jobs",
      title: "Current unrelated source classification",
      admin_review_status: "review_later",
      page_metadata: {
        baseline_facts: {
          award_relevance: "unrelated",
          cycle_relevance: "not_program_page",
          quality_flags: ["job_page"],
        },
      },
    };

    expect(changeEventSuppressionDecision(historicalEvent, currentSource)).toMatchObject({
      suppressed: true,
    });
    expect(
      changeEventSuppressionDecision(historicalEvent, currentSource, {
        mode: "retro_sweep",
      }),
    ).toEqual({ suppressed: false, reason: null });
    expect(
      changeEventSuppressionDecision(historicalEvent, null, {
        mode: "retro_sweep",
      }),
    ).toEqual({ suppressed: false, reason: null });
  });

  it("still applies evidence-based global policy during a retro sweep", () => {
    expect(
      changeEventSuppressionDecision(
        event("The donation widget changed its suggested gift amount.", {
          is_alert_worthy: true,
        }),
        { ...source, admin_review_status: "review_later" },
        { mode: "retro_sweep" },
      ),
    ).toEqual({
      suppressed: true,
      reason: "policy_flag_fundraising_form_change",
    });
  });

  it("keeps a new application-portal login requirement as an applicant-facing update", () => {
    expect(changeEventSuppressionDecision(
      event("Applicants are now required to log in to the application portal.", {
        is_alert_worthy: true,
        generation_status: "generated",
      }),
      source,
    )).toEqual({ suppressed: false, reason: null });
  });

  it("does not confuse 'updated on the application page' with date-only churn", () => {
    expect(
      changeEventSuppressionDecision(
        event("Contact information was updated on the scholarship application page.", {
          is_alert_worthy: true,
          generation_status: "generated",
        }),
        source,
        { mode: "retro_sweep" },
      ),
    ).toEqual({ suppressed: false, reason: null });
  });

  it("keeps an application-period closure even when old evidence says apply today", () => {
    expect(
      changeEventSuppressionDecision(
        event("The application period has closed for the 2026-2027 cycle.", {
          is_alert_worthy: true,
          generation_status: "generated",
          structured_diff: {
            added_text: ["Applications are now closed for the 2026-2027 cycle."],
            removed_text: ["Applications are now open.", "APPLY TODAY"],
          },
        }),
        source,
        { mode: "retro_sweep" },
      ),
    ).toEqual({ suppressed: false, reason: null });
  });

  it.each([
    ["profile_roster_rotation", "profile-roster-rotation"],
    ["document_metadata_only_change", "document-metadata-only-change"],
  ])(
    "does not let inactive candidate %s suppress through its raw quality alias",
    (ruleId, alias) => {
      const rule = awardMonitoringPolicy.policy_flags.find(
        (candidate) => candidate.id === ruleId,
      ) as ({ active?: boolean } & Record<string, unknown>) | undefined;
      expect(rule).toBeTruthy();
      if (!rule) return;
      const originalActive = rule.active;
      try {
        rule.active = false;
        const candidate = event("The application deadline remains April 1.", {
          is_alert_worthy: true,
          generation_status: "generated",
          quality_flags: [alias],
          structured_diff: {
            added_text: ["The application deadline remains April 1."],
          },
        });

        expect(changeEventSuppressionDecision(candidate, source)).toEqual({
          suppressed: false,
          reason: null,
        });
        expect(
          changeEventSuppressionDecision(candidate, source, {
            mode: "retro_sweep",
            excludedPolicyRuleIds: [ruleId],
          }),
        ).toEqual({ suppressed: false, reason: null });
      } finally {
        if (originalActive === undefined) delete rule.active;
        else rule.active = originalActive;
      }
    },
  );

  it("does not apply raw quality fallback to a reviewable but inactive rule", () => {
    const options = {
      activePolicyId: null,
      reviewablePolicyId: "profile_roster_rotation",
    };
    expect(
      qualityFlagSuppressionCandidate("profile-roster-rotation", options),
    ).toBeNull();
    expect(
      qualityFlagSuppressionCandidate("profile-roster-rotation", {
        ...options,
        excludedPolicyRuleIds: new Set(["profile_roster_rotation"]),
      }),
    ).toBeNull();
  });

  it.each([
    ["Only the application deadline formatting changed.", "format_only_change"],
    ["The application deadline container-only context changed.", "context_only_change"],
    ["The application deadline evidence is a truncated snippet.", "indistinct_truncated_snippet"],
    ["An orphan punctuation mark appeared beside the application deadline.", "orphan_punctuation"],
  ])("suppresses pure explicitly-described noise: %s", (summary, expectedFlag) => {
    expect(changeEventSuppressionDecision(event(summary, { is_alert_worthy: true }), source)).toEqual({
      suppressed: true,
      reason: `policy_flag_${expectedFlag}`,
    });
  });

  it.each([
    "Only the surrounding formatting changed, and the application deadline changed.",
    "The context-only note appeared while the application deadline changed.",
    "One snippet was truncated, but the application deadline changed.",
    "An orphan punctuation mark appeared while the application deadline changed.",
  ])("preserves mixed noise wording when deterministic applicant evidence remains: %s", (summary) => {
    expect(changeEventSuppressionDecision(event(summary, {
      is_alert_worthy: true,
      generation_status: "generated",
      structured_diff: {
        added_text: ["Application deadline: March 15, 2027"],
        removed_text: ["Application deadline: March 1, 2027"],
      },
    }), source)).toEqual({ suppressed: false, reason: null });
  });

  it("suppresses file size/loading time changed summaries", () => {
    expect(changeEventSuppressionDecision(event("The PDF file size and loading time changed."), source)).toMatchObject({
      suppressed: true,
      reason: "file_size_or_loading_time_noise",
    });
  });

  it("suppresses security question changes", () => {
    expect(changeEventSuppressionDecision(event("The security question changed."), source)).toMatchObject({
      suppressed: true,
      reason: "security_question_or_access_noise",
    });
  });

  it("suppresses JUMP AppSolutions version updates", () => {
    expect(changeEventSuppressionDecision(event("JUMP AppSolutions version updated from 5.1.6 to 5.1.7."), source)).toMatchObject({
      suppressed: true,
      reason: "plugin_or_version_noise",
    });
  });

  it("suppresses related content link updates", () => {
    expect(changeEventSuppressionDecision(event("Related content links were updated."), source)).toMatchObject({
      suppressed: true,
      reason: "related_content_link_noise",
    });
  });

  it("suppresses current fellows/profile content refreshes", () => {
    expect(changeEventSuppressionDecision(event("Current fellows profile content refreshed."), source)).toMatchObject({
      suppressed: true,
      reason: "profile_roster_news_noise",
    });
  });

  it("suppresses every active policy flag without duplicating a hard-coded list", () => {
    expect(
      changeEventSuppressionDecision(
        event("A donation widget changed.", {
          is_alert_worthy: true,
          quality_flags: ["fundraising-form-change"],
        }),
        source,
      ),
    ).toMatchObject({
      suppressed: true,
      reason: "policy_flag_fundraising_form_change",
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
  ])("canonicalizes legacy flag %s in suppression reasons", (alias, expected) => {
    expect(
      changeEventSuppressionDecision(
        event("Application deadline changed from March 1 to March 15.", {
          is_alert_worthy: true,
          quality_flags: [alias],
        }),
        source,
      ),
    ).toEqual({ suppressed: true, reason: `policy_flag_${expected}` });
  });

  it("preserves a generated true change after local evidence correction keeps supported evidence", () => {
    expect(
      changeEventSuppressionDecision(
        event("The application deadline changed from March 1 to March 15.", {
          is_alert_worthy: true,
          generation_status: "generated",
          quality_flags: [
            "visual_snapshot_comparison",
            "evidence_sanity_corrected",
            "unsupported_added_text",
          ],
          structured_diff: {
            added_text: ["Application deadline: March 15"],
            removed_text: ["Application deadline: March 1"],
            noise_flags: ["unsupported_added_text"],
          },
        }),
        source,
      ),
    ).toEqual({ suppressed: false, reason: null });
  });

  it("keeps corrected diagnostics blocking when no supported evidence remains", () => {
    expect(
      changeEventSuppressionDecision(
        event("The page changed.", {
          is_alert_worthy: true,
          generation_status: "generated",
          quality_flags: [
            "visual_snapshot_comparison",
            "evidence_sanity_corrected",
            "unsupported_added_text",
          ],
          structured_diff: {
            added_text: [],
            removed_text: [],
            date_changes: [],
            amount_changes: [],
            noise_flags: ["unsupported_added_text"],
          },
        }),
        source,
      ),
    ).toEqual({
      suppressed: true,
      reason: "policy_flag_unsupported_structured_fact",
    });
  });

  it("does not suppress unconfigured other-grants section wording", () => {
    expect(
      changeEventSuppressionDecision(
        event("Application deadline changed from March 1 to March 15.", {
          is_alert_worthy: true,
          quality_flags: ["other_grants_and_fellowships_section_changed"],
        }),
        source,
      ),
    ).toEqual({ suppressed: false, reason: null });
  });

  it("does not suppress a recognized alias when its policy is inactive or non-blocking", () => {
    const rule = awardMonitoringPolicy.policy_flags.find(
      (item) => item.id === "vague_summary",
    ) as (typeof awardMonitoringPolicy.policy_flags[number] & { active?: boolean }) | undefined;
    expect(rule).toBeDefined();
    if (!rule) return;
    const originalActive = rule.active;
    const originalAlertBlocking = rule.alert_blocking;
    const buildDecision = () =>
      changeEventSuppressionDecision(
        event("Application deadline changed from March 1 to March 15.", {
          is_alert_worthy: true,
          quality_flags: ["vague-summary"],
        }),
        source,
      );
    try {
      rule.alert_blocking = false;
      expect(buildDecision()).toEqual({ suppressed: false, reason: null });
      rule.alert_blocking = originalAlertBlocking;
      rule.active = false;
      expect(buildDecision()).toEqual({ suppressed: false, reason: null });
    } finally {
      rule.alert_blocking = originalAlertBlocking;
      if (originalActive === undefined) delete rule.active;
      else rule.active = originalActive;
    }
  });

  it("does not suppress legitimate deadline changes", () => {
    expect(
      changeEventSuppressionDecision(
        event("Application deadline changed from March 1, 2027 to March 15, 2027.", {
          is_alert_worthy: true,
          generation_status: "generated",
          change_type: "deadline",
        }),
        source,
      ),
    ).toEqual({ suppressed: false, reason: null });
  });

  it("does not suppress legitimate amount changes", () => {
    expect(
      changeEventSuppressionDecision(
        event("Award amount increased from $5,000 to $7,500.", {
          is_alert_worthy: true,
          generation_status: "generated",
          change_type: "funding",
        }),
        source,
      ),
    ).toEqual({ suppressed: false, reason: null });
  });

  it("does not suppress legitimate eligibility changes", () => {
    expect(
      changeEventSuppressionDecision(
        event("Eligibility now includes graduate students.", {
          is_alert_worthy: true,
          generation_status: "generated",
          change_type: "eligibility",
        }),
        source,
      ),
    ).toEqual({ suppressed: false, reason: null });
  });
});
