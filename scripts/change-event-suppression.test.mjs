import { describe, expect, it } from "vitest";
import { awardMonitoringPolicy } from "./lib/award-monitoring-policy.mjs";
import {
  changeEventMatchesMonitoringPolicyRule,
  changeEventSuppressionDecision,
  qualityFlagSuppressionCandidate,
} from "./lib/change-event-suppression.mjs";

const source = {
  id: "source-1",
  url: "https://example.edu/scholarships/example-award",
  title: "Example Award",
  page_type: "application",
  admin_review_status: "open",
  page_metadata_generated_at: "2026-07-14T00:00:00.000Z",
  page_metadata_model: "gemini-test",
  page_metadata: {
    baseline_facts: {
      award_relevance: "primary",
      cycle_relevance: "current_or_upcoming",
      quality_flags: [],
    },
  },
};

function event(summary, changeDetails = {}, sourceOverride = source) {
  return {
    id: `event-${summary.slice(0, 20)}`,
    shared_award_source_id: sourceOverride.id,
    source_url: sourceOverride.url,
    source_title: sourceOverride.title,
    source_page_type: sourceOverride.page_type,
    summary,
    change_details: changeDetails,
  };
}

describe("scheduled change-event suppression", () => {
  it("shadow-matches a proposed rule without changing the event", () => {
    const candidate = event("The donation widget changed its suggested gift amount.", {
      is_alert_worthy: true,
    });

    expect(
      changeEventMatchesMonitoringPolicyRule(
        candidate,
        source,
        "fundraising_form_change",
      ),
    ).toBe(true);
    expect(candidate).not.toHaveProperty("suppressed_at");
  });

  it("does not shadow-match a legitimate applicant-facing deadline", () => {
    expect(
      changeEventMatchesMonitoringPolicyRule(
        event("The application deadline changed from March 1 to March 15.", {
          is_alert_worthy: true,
          structured_diff: {
            added_text: ["Application deadline: March 15"],
            removed_text: ["Application deadline: March 1"],
          },
        }),
        source,
        "fundraising_form_change",
      ),
    ).toBe(false);
  });

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
      event("The application deadline changed from March 1, 2027 to March 15, 2027.", {
        is_alert_worthy: true,
        generation_status: "generated",
        structured_diff: {
          added_text: ["Application deadline: March 15, 2027"],
          removed_text: ["Application deadline: March 1, 2027"],
        },
      }, eventSource),
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
      event("A recipient profile was added to the news story.", { is_alert_worthy: true }, newsSource),
      newsSource,
    )).toMatchObject({ suppressed: true });
  });

  it("does not permanently suppress a true historical event from mutable source lifecycle state", () => {
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
      source,
    );

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

  it("still suppresses immutable deterministic noise during a retro sweep", () => {
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

  it("uses the global alert-blocking policy flag set", () => {
    const decision = changeEventSuppressionDecision(
      {
        id: "event-1",
        shared_award_source_id: source.id,
        source_url: source.url,
        source_title: source.title,
        source_page_type: source.page_type,
        summary: "A donation widget changed.",
        change_details: {
          is_alert_worthy: true,
          quality_flags: ["fundraising-form-change"],
        },
      },
      source,
    );

    expect(decision).toEqual({
      suppressed: true,
      reason: "policy_flag_fundraising_form_change",
    });
  });

  it("excludes an unresolved promotion rule and can recompute another valid reason", () => {
    const candidate = event("Only formatting and the donation widget changed.", {
      is_alert_worthy: true,
      quality_flags: ["fundraising-form-change", "format-only-change"],
    });
    expect(
      changeEventSuppressionDecision(candidate, source, {
        mode: "retro_sweep",
        excludedPolicyRuleIds: ["fundraising_form_change"],
      }),
    ).toEqual({
      suppressed: true,
      reason: "policy_flag_format_only_change",
    });

    expect(
      changeEventSuppressionDecision(
        {
          ...candidate,
          suppressed_at: "2026-07-15T00:00:00.000Z",
          suppression_reason: "policy_flag_fundraising_form_change",
          suppression_source: "scheduled-downstream-policy-sweep",
          change_details: {
            is_alert_worthy: true,
            quality_flags: ["fundraising-form-change"],
          },
        },
        source,
        {
          mode: "retro_sweep",
          excludedPolicyRuleIds: ["fundraising_form_change"],
          ignoreExistingSuppression: true,
        },
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
      );
      expect(rule).toBeTruthy();
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

  it("preserves an overlapping text-derived reason when the first match is excluded", () => {
    const candidate = event("Invalid AI JSON after an access denied page", {
      is_alert_worthy: true,
    });

    expect(changeEventMatchesMonitoringPolicyRule(candidate, source, "ai_invalid_json")).toBe(true);
    expect(changeEventMatchesMonitoringPolicyRule(candidate, source, "source_access_error")).toBe(true);
    expect(
      changeEventSuppressionDecision(candidate, source, {
        mode: "retro_sweep",
        excludedPolicyRuleIds: ["ai_invalid_json"],
      }),
    ).toEqual({
      suppressed: true,
      reason: "policy_flag_source_access_error",
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
  ])("suppresses legacy flag %s with canonical reason", (alias, expected) => {
    const decision = changeEventSuppressionDecision(
      {
        id: `event-${alias}`,
        shared_award_source_id: source.id,
        source_url: source.url,
        source_title: source.title,
        source_page_type: source.page_type,
        summary: "Application deadline changed from March 1 to March 15.",
        change_details: {
          is_alert_worthy: true,
          quality_flags: [alias],
        },
      },
      source,
    );

    expect(decision).toEqual({
      suppressed: true,
      reason: `policy_flag_${expected}`,
    });
  });

  it("preserves a generated true change after local evidence correction keeps supported evidence", () => {
    const decision = changeEventSuppressionDecision(
      {
        id: "event-corrected-evidence",
        shared_award_source_id: source.id,
        source_url: source.url,
        source_title: source.title,
        source_page_type: source.page_type,
        summary: "The application deadline changed from March 1 to March 15.",
        change_details: {
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
        },
      },
      source,
    );

    expect(decision).toEqual({ suppressed: false, reason: null });
  });

  it("keeps corrected diagnostics blocking when no supported evidence remains", () => {
    const decision = changeEventSuppressionDecision(
      {
        id: "event-corrected-without-evidence",
        shared_award_source_id: source.id,
        source_url: source.url,
        source_title: source.title,
        source_page_type: source.page_type,
        summary: "The page changed.",
        change_details: {
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
        },
      },
      source,
    );

    expect(decision).toEqual({
      suppressed: true,
      reason: "policy_flag_unsupported_structured_fact",
    });
  });

  it("does not infer a global rule for other-grants section wording", () => {
    const decision = changeEventSuppressionDecision(
      {
        id: "event-other-grants",
        shared_award_source_id: source.id,
        source_url: source.url,
        source_title: source.title,
        source_page_type: source.page_type,
        summary: "Application deadline changed from March 1 to March 15.",
        change_details: {
          is_alert_worthy: true,
          quality_flags: ["other_grants_and_fellowships_section_changed"],
        },
      },
      source,
    );

    expect(decision).toEqual({ suppressed: false, reason: null });
  });

  it("does not suppress a recognized alias when its policy is inactive or non-blocking", () => {
    const rule = awardMonitoringPolicy.policy_flags.find((item) => item.id === "vague_summary");
    expect(rule).toBeDefined();
    if (!rule) return;
    const originalActive = rule.active;
    const originalAlertBlocking = rule.alert_blocking;
    const buildDecision = () =>
      changeEventSuppressionDecision(
        {
          id: "event-vague-summary",
          shared_award_source_id: source.id,
          source_url: source.url,
          source_title: source.title,
          source_page_type: source.page_type,
          summary: "Application deadline changed from March 1 to March 15.",
          change_details: {
            is_alert_worthy: true,
            quality_flags: ["vague-summary"],
          },
        },
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
});
