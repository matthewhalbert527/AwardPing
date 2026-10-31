import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));
vi.mock("@/lib/config", () => ({
  appConfig: {
    alertFromEmail: "AwardPing <updates@example.org>",
    resendApiKey: "test-key",
  },
}));

import {
  renderPublicDailyDigestEmail,
  sendFrozenPublicDailyDigestEmail,
} from "@/lib/email";
import { buildPublicDigestChanges } from "@/lib/public-updates-core";
import { programChangePresentation } from "@/lib/program-change-presentation";

const changes = [
  {
    eventId: "40000000-0000-4000-8000-000000000001",
    awardName: "Test & Fellowship",
    sourceTitle: "Eligibility <current>",
    sourceUrl: "https://example.edu/apply?a=1&b=2",
    summary: "Applicants must be <25.",
    detectedAt: "2026-07-16T18:00:00.000Z",
  },
];

describe("public digest frozen email", () => {
  beforeEach(() => mocks.send.mockReset());

  it("renders one deterministic, escaped payload before enqueue", () => {
    const input = {
      changes,
      unsubscribeUrl: "https://awardping.org/unsubscribe?a=1&b=2",
    };
    const first = renderPublicDailyDigestEmail(input);
    const second = renderPublicDailyDigestEmail(input);

    expect(first).toEqual(second);
    expect(first.from).toBe("AwardPing <updates@example.org>");
    expect(first.subject).toContain("1 award page update");
    expect(first.html).toContain("Test &amp; Fellowship");
    expect(first.html).toContain("Eligibility &lt;current&gt;");
    expect(first.text).toContain("Applicants must be <25.");
  });

  it("sends the frozen fields verbatim with the supplied payload key", async () => {
    mocks.send.mockResolvedValue({ data: { id: "provider-1" }, error: null });
    const rendered = renderPublicDailyDigestEmail({
      changes,
      unsubscribeUrl: "https://awardping.org/unsubscribe",
    });
    await expect(
      sendFrozenPublicDailyDigestEmail({
        ...rendered,
        to: "reader@example.org",
        idempotencyKey: `awardping-public-digest:${"a".repeat(64)}`,
      }),
    ).resolves.toEqual({ providerMessageId: "provider-1" });

    expect(mocks.send).toHaveBeenCalledWith(
      { ...rendered, to: "reader@example.org" },
      { idempotencyKey: `awardping-public-digest:${"a".repeat(64)}` },
    );
  });
  it("renders the approved program comparison and applicant guidance consistently in HTML and plain text", () => {
    const url = "https://funding.example.org/application#programme=2027";
    const details = { schema: "awardping.program-change.v1", event_kind: "program_details_changed",
      summary: "Removed the application portal URL.", program_changes: [{ field: "application_url", operation: "remove",
        summary: "Removed the application portal URL.", previous_quote: { block_id: "source-link-000061",
          start_utf16: 0, end_utf16: url.length, text: url }, current_quote: null }] };
    const presentation = programChangePresentation(details)!;
    const changes = buildPublicDigestChanges([{ id: "event-portal", shared_award_id: "award-a", summary: details.summary,
      source_url: "https://example.edu/award/apply", source_title: "Application instructions", source_page_type: "application",
      change_details: details, detected_at: "2026-10-30T23:03:00.000Z" }], new Map([["award-a", "Example Fellowship"]]));
    const before = structuredClone(changes);
    const rendered = renderPublicDailyDigestEmail({ changes, unsubscribeUrl: "https://awardping.org/unsubscribe" });
    expect(rendered.text).toContain(`${presentation.text}\n${presentation.context}`);
    expect(rendered.html).toContain(presentation.text);
    expect(rendered.html).toContain(presentation.context);
    expect(rendered.text).not.toContain("Removed the application portal URL.");
    expect(changes).toEqual(before);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("escapes applicant guidance before rendering it into HTML", () => {
    const rendered = renderPublicDailyDigestEmail({ changes: [{ ...changes[0], context: "Check A & B <before> applying." }],
      unsubscribeUrl: "https://awardping.org/unsubscribe" });
    expect(rendered.html).toContain("Check A &amp; B &lt;before&gt; applying.");
    expect(rendered.text).toContain("Check A & B <before> applying.");
  });
});
