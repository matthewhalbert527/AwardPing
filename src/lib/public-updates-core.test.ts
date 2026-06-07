import { describe, expect, it } from "vitest";
import {
  buildPublicDigestChanges,
  createPublicUnsubscribeToken,
  filterSubscribersWithoutDigestDelivery,
  hashToken,
  normalizePublicUpdateEmail,
  publicDigestKey,
  publicDigestSince,
  type PublicDigestCandidate,
} from "@/lib/public-updates-core";

describe("public update digest helpers", () => {
  it("normalizes subscriber email addresses before storage", () => {
    expect(normalizePublicUpdateEmail("  Advisor@Example.EDU ")).toBe(
      "advisor@example.edu",
    );
  });

  it("creates stable hashable unsubscribe tokens without storing raw tokens", () => {
    const subscriber = {
      id: "7d669bcb-7e7b-43b1-a20d-76ec977db7bf",
      email: "advisor@example.edu",
      created_at: "2026-05-27T15:00:00.000Z",
    };

    const token = createPublicUnsubscribeToken(subscriber, "test-secret");
    expect(token).toBe(createPublicUnsubscribeToken(subscriber, "test-secret"));
    expect(token).not.toBe(createPublicUnsubscribeToken(subscriber, "other-secret"));
    expect(hashToken(token)).toHaveLength(64);
  });

  it("uses UTC digest keys and a 36-hour public digest window", () => {
    const date = new Date("2026-05-27T20:00:00.000Z");
    expect(publicDigestKey(date)).toBe("2026-05-27");
    expect(publicDigestSince(date)).toBe("2026-05-26T08:00:00.000Z");
  });

  it("keeps useful official award changes and dedupes repeat summaries", () => {
    const candidates: PublicDigestCandidate[] = [
      {
        id: "newer",
        shared_award_id: "award-a",
        source_title: "How to Apply",
        source_url: "https://example.edu/award/how-to-apply",
        summary:
          "The application instructions now say finalists must submit two recommendation letters by February 1.",
        detected_at: "2026-05-27T12:00:00.000Z",
      },
      {
        id: "older-duplicate",
        shared_award_id: "award-a",
        source_title: "How to Apply",
        source_url: "https://www.example.edu/award/how-to-apply/",
        summary:
          "The application instructions now say finalists must submit two recommendation letters by February 1.",
        detected_at: "2026-05-26T12:00:00.000Z",
      },
      {
        id: "noise",
        shared_award_id: "award-a",
        source_title: "How to Apply",
        source_url: "https://example.edu/award/how-to-apply",
        summary: "No meaningful change was detected.",
        detected_at: "2026-05-27T13:00:00.000Z",
      },
      {
        id: "blocked-url",
        shared_award_id: "award-a",
        source_title: "Newsletter",
        source_url: "https://example.edu/newsletter",
        summary:
          "The eligibility page now says applicants must be enrolled full time.",
        detected_at: "2026-05-27T14:00:00.000Z",
      },
    ];

    const changes = buildPublicDigestChanges(
      candidates,
      new Map([["award-a", "Example Fellowship"]]),
    );

    expect(changes).toEqual([
      expect.objectContaining({
        eventId: "newer",
        awardName: "Example Fellowship",
        sourceTitle: "How to Apply",
      }),
    ]);
  });

  it("keeps structured alert-worthy details even when legacy summary is vague", () => {
    const candidates: PublicDigestCandidate[] = [
      {
        id: "structured",
        shared_award_id: "award-a",
        source_title: "Deadlines",
        source_url: "https://example.edu/award/deadlines",
        summary: "The page was updated.",
        change_details: {
          reader_summary: "The deadline section now says applications close April 15, 2026.",
          before: "Applications close April 1, 2026.",
          after: "Applications close April 15, 2026.",
          section: "Deadlines",
          change_type: "deadline",
          advisor_impact: "Update advising calendars.",
          is_alert_worthy: true,
          confidence: "high",
          structured_diff: {
            added_text: ["Applications close April 15, 2026."],
            removed_text: ["Applications close April 1, 2026."],
            likely_section: "Deadlines",
            page_type: "deadline",
            date_changes: ["Added April 15, 2026"],
            amount_changes: [],
            noise_flags: [],
          },
          source: {},
          quality_flags: [],
          generated_at: "2026-05-28T20:00:00.000Z",
        },
        detected_at: "2026-05-27T12:00:00.000Z",
      },
    ];

    const changes = buildPublicDigestChanges(
      candidates,
      new Map([["award-a", "Example Fellowship"]]),
    );

    expect(changes).toEqual([
      expect.objectContaining({
        eventId: "structured",
        summary: "The deadline section now says applications close April 15, 2026.",
      }),
    ]);
  });

  it("filters subscribers that already have a delivery for the digest key", () => {
    expect(
      filterSubscribersWithoutDigestDelivery(
        [{ id: "sub-a" }, { id: "sub-b" }],
        [{ subscriber_id: "sub-a" }],
      ),
    ).toEqual([{ id: "sub-b" }]);
  });
});
