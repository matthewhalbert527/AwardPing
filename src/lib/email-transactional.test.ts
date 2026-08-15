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
} from "@/lib/email";

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
});
