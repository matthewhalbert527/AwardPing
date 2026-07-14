import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/admin-monitoring-feedback-promotion-control", () => ({
  AdminMonitoringFeedbackPromotionControl: () => null,
}));

import {
  AdminMonitoringFeedbackPendingList,
  type AdminPendingMonitoringFeedback,
} from "@/components/admin-monitoring-feedback-pending-list";

const feedback: AdminPendingMonitoringFeedback = {
  id: "40000000-0000-4000-8000-000000000004",
  eventId: "20000000-0000-4000-8000-000000000002",
  sourceId: null,
  awardId: "50000000-0000-4000-8000-000000000005",
  eventSummary: "The application deadline moved.",
  eventSourceUrl: "https://example.org/award/deadline",
  eventSourceTitle: "Award deadline",
  eventSourcePageType: "deadline",
  eventDetectedAt: "2026-07-14T18:55:00.000Z",
  eventEvidence: {
    section: "Application timeline",
    exact_before: "Applications close April 1.",
    exact_after: "Applications close April 15.",
  },
  reasonCode: "content_churn",
  note: "This date is copied from an unrelated news card.",
  requestedScope: "global",
  policyRuleId: null,
  policyVersion: "policy-8.memory-4",
  actorEmail: "admin@awardping.test",
  createdAt: "2026-07-14T19:00:00.000Z",
};

describe("AdminMonitoringFeedbackPendingList", () => {
  it("renders the immutable event context, source link, and structured evidence", () => {
    const html = renderToStaticMarkup(
      createElement(AdminMonitoringFeedbackPendingList, {
        feedback: [feedback],
        feedbackTotal: 1,
        policyRuleIds: ["content_rotation"],
      }),
    );

    expect(html).toContain("Award deadline");
    expect(html).toContain("The application deadline moved.");
    expect(html).toContain("Captured evidence:");
    expect(html).toContain("Section: Application timeline");
    expect(html).toContain("Before: Applications close April 1.");
    expect(html).toContain("After: Applications close April 15.");
    expect(html).toContain('href="https://example.org/award/deadline"');
    expect(html).toContain("Reviewer context:");
  });

  it("does not render a non-HTTP source URL as a link", () => {
    const html = renderToStaticMarkup(
      createElement(AdminMonitoringFeedbackPendingList, {
        feedback: [{ ...feedback, eventSourceUrl: "javascript:alert(1)" }],
        feedbackTotal: 1,
        policyRuleIds: [],
      }),
    );

    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("Original source");
  });
});
