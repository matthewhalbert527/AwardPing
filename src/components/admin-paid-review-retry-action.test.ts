import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminPaidReviewRetryAction } from "./admin-paid-review-retry-action";

describe("retired paid image-review control", () => {
  it("shows a historical hold without any actionable submission control", () => {
    const html = renderToStaticMarkup(createElement(AdminPaidReviewRetryAction, {
      candidateId: "preserved-id", candidateUpdatedAt: "2026-10-23T12:00:00Z", sourceTitle: "Official rules",
    }));
    expect(html).toContain("Image-review retries for Official rules are retired");
    expect(html).toContain("Existing records are preserved");
    expect(html).not.toMatch(/<button|<form|Approve one paid retry/);
  });
});
