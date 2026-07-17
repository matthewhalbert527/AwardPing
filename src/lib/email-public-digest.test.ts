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
});
