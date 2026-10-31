import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));
vi.mock("@/lib/config", () => ({
  appConfig: {
    alertFromEmail: "AwardPing <alerts@awardping.com>",
    resendApiKey: "re_test",
  },
}));

import {
  sendContactFormEmail,
  sendPublicUpdateConfirmationEmail,
  sendChangeAlertEmail,
  sendDailyDigestEmail,
} from "@/lib/email";
import { programChangePresentation } from "@/lib/program-change-presentation";

describe("transactional email idempotency", () => {
  beforeEach(() => {
    mocks.send.mockReset();
    mocks.send.mockResolvedValue({
      data: { id: "email-1" },
      error: null,
      headers: null,
    });
  });

  it("sends public confirmations with the stable subscription key", async () => {
    await sendPublicUpdateConfirmationEmail({
      to: "reader@example.org",
      confirmUrl: "https://awardping.test/confirm?token=secret",
      idempotencyKey: `awardping-public-confirmation:${"a".repeat(64)}`,
    });

    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "reader@example.org",
        subject: "Confirm your AwardPing daily updates",
      }),
      { idempotencyKey: `awardping-public-confirmation:${"a".repeat(64)}` },
    );
  });

  it("sends contact retries with the same content-bound key", async () => {
    await sendContactFormEmail({
      to: "office@awardping.test",
      name: "Test User",
      email: "reader@example.org",
      message: "Please send more information.",
      idempotencyKey: `awardping-contact:${"b".repeat(64)}`,
    });

    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "office@awardping.test",
        replyTo: "reader@example.org",
      }),
      { idempotencyKey: `awardping-contact:${"b".repeat(64)}` },
    );
  });
  it.each(["single", "digest"])("includes program applicant guidance in the %s legacy renderer without changing delivery settings", async kind => {
    const url = "https://funding.example.org/application#programme=2027";
    const details = { schema: "awardping.program-change.v1", event_kind: "program_details_changed",
      summary: "Removed the application portal URL.", program_changes: [{ field: "application_url", operation: "remove",
        summary: "Removed the application portal URL.", previous_quote: { block_id: "source-link-000061",
          start_utf16: 0, end_utf16: url.length, text: url }, current_quote: null }] };
    const presentation = programChangePresentation(details)!;
    const change = { label: "Example Fellowship", url: "https://example.edu/award/apply", summary: details.summary,
      changeDetails: details, detectedAt: "2026-10-30T23:03:00.000Z" };
    const before = structuredClone(change);
    if (kind === "single") await sendChangeAlertEmail({ ...change, to: "reader@example.org" });
    else await sendDailyDigestEmail({ officeName: "Example office", to: "reader@example.org", changes: [change] });
    const payload = mocks.send.mock.calls[0][0];
    expect(payload.text).toContain(`${presentation.text}\n${presentation.context}`);
    expect(payload.html).toContain(presentation.context);
    expect(change).toEqual(before);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
});
