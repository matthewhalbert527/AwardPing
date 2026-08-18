import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

const mocks = vi.hoisted(() => ({
  hasEmailDeliveryConfig: vi.fn(),
  sendContactFormEmail: vi.fn(),
  ensurePublicFormRateLimit: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: {
    alertFromEmail: "AwardPing <alerts@awardping.test>",
    contactToEmail: "office@awardping.test",
  },
  hasEmailDeliveryConfig: mocks.hasEmailDeliveryConfig,
}));
vi.mock("@/lib/email", () => ({
  sendContactFormEmail: mocks.sendContactFormEmail,
}));
vi.mock("@/lib/public-form-rate-limit", () => ({
  ensurePublicFormRateLimit: mocks.ensurePublicFormRateLimit,
}));

import { POST } from "@/app/api/contact/route";

function request() {
  return new Request("https://awardping.test/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: REQUEST_ID,
      name: "Test User",
      email: "reader@example.org",
      message: "Please send me more information.",
    }),
  });
}

describe("contact email delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasEmailDeliveryConfig.mockReturnValue(true);
    mocks.ensurePublicFormRateLimit.mockResolvedValue({ allowed: true });
    mocks.sendContactFormEmail.mockResolvedValue({
      data: { id: "email-1" },
      error: null,
    });
  });

  it("fails before rate-limit mutation when email is not configured", async () => {
    mocks.hasEmailDeliveryConfig.mockReturnValue(false);
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.ensurePublicFormRateLimit).not.toHaveBeenCalled();
    expect(mocks.sendContactFormEmail).not.toHaveBeenCalled();
  });

  it.each([undefined, "not-a-uuid"])(
    "requires a valid client request id before any mutation (%s)",
    async (requestId) => {
      const response = await POST(
        new Request("https://awardping.test/api/contact", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId,
            name: "Test User",
            email: "reader@example.org",
            message: "Please send me more information.",
          }),
        }),
      );

      expect(response.status).toBe(400);
      expect(mocks.ensurePublicFormRateLimit).not.toHaveBeenCalled();
      expect(mocks.sendContactFormEmail).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ skipped: true }],
    [{ data: null, error: { message: "provider rejected" } }],
    [{ data: null, error: null }],
    [{ data: { id: "" }, error: null }],
    [{ data: { id: "email-without-explicit-success" } }],
  ])("never claims delivery for an unaccepted provider result", async (delivery) => {
    mocks.sendContactFormEmail.mockResolvedValue(delivery);
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload.ok).toBe(false);
    expect(payload.error).not.toContain("sent");
  });

  it("reports success only after the provider returns an id", async () => {
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true, message: "Thanks. Your message was sent." });
    expect(mocks.sendContactFormEmail).toHaveBeenCalledWith({
      to: "office@awardping.test",
      name: "Test User",
      email: "reader@example.org",
      message: "Please send me more information.",
      idempotencyKey: expectedIdempotencyKey(REQUEST_ID),
    });
  });

  it("reuses one key for retries but not for a new intentional submission", async () => {
    await POST(request());
    await POST(request());

    const newRequestId = "123e4567-e89b-42d3-a456-426614174001";
    await POST(
      new Request("https://awardping.test/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: newRequestId,
          name: "Test User",
          email: "reader@example.org",
          message: "Please send me more information.",
        }),
      }),
    );

    const keys = mocks.sendContactFormEmail.mock.calls.map(
      ([input]) => input.idempotencyKey,
    );
    expect(keys).toEqual([
      expectedIdempotencyKey(REQUEST_ID),
      expectedIdempotencyKey(REQUEST_ID),
      expectedIdempotencyKey(newRequestId),
    ]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

function expectedIdempotencyKey(requestId: string) {
  const payload = JSON.stringify({
    kind: "awardping-contact-form-v1",
    requestId,
    to: "office@awardping.test",
    from: "AwardPing <alerts@awardping.test>",
    name: "Test User",
    email: "reader@example.org",
    message: "Please send me more information.",
  });
  return `awardping-contact:${crypto.createHash("sha256").update(payload).digest("hex")}`;
}
