import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  deferredTasks: [] as Array<() => Promise<void> | void>,
  hasPublicUpdateDeliveryConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  sendPublicUpdateConfirmationEmail: vi.fn(),
  ensurePublicFormRateLimit: vi.fn(),
  createOrRefreshPublicUpdateSubscription: vi.fn(),
  markPublicUpdateConfirmationSent: vi.fn(),
  publicUpdateConfirmationDeliveryIsCurrent: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});

vi.mock("@/lib/config", () => ({
  appConfig: { url: "https://awardping.test" },
  hasPublicUpdateDeliveryConfig: mocks.hasPublicUpdateDeliveryConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/email", () => ({
  sendPublicUpdateConfirmationEmail: mocks.sendPublicUpdateConfirmationEmail,
}));
vi.mock("@/lib/public-form-rate-limit", () => ({
  ensurePublicFormRateLimit: mocks.ensurePublicFormRateLimit,
}));
vi.mock("@/lib/public-updates", () => ({
  createOrRefreshPublicUpdateSubscription:
    mocks.createOrRefreshPublicUpdateSubscription,
  markPublicUpdateConfirmationSent: mocks.markPublicUpdateConfirmationSent,
  publicUpdateConfirmationDeliveryIsCurrent:
    mocks.publicUpdateConfirmationDeliveryIsCurrent,
}));

import { POST } from "@/app/api/public-updates/subscribe/route";

function request() {
  return new Request("https://awardping.test/api/public-updates/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "reader@example.org",
      privacyConsent: true,
    }),
  });
}

describe("public-update confirmation delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deferredTasks.length = 0;
    mocks.after.mockImplementation((task) => {
      mocks.deferredTasks.push(task);
    });
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.hasPublicUpdateDeliveryConfig.mockReturnValue(true);
    mocks.ensurePublicFormRateLimit.mockResolvedValue({ allowed: true });
    mocks.createOrRefreshPublicUpdateSubscription.mockResolvedValue({
      subscriberId: "subscriber-1",
      email: "reader@example.org",
      confirmationToken: "token-1",
      confirmationAttemptSeal: "2026-08-15T01:00:00.000Z",
      confirmationIdempotencyKey: `awardping-public-confirmation:${"a".repeat(64)}`,
      shouldSendConfirmation: true,
    });
    mocks.sendPublicUpdateConfirmationEmail.mockResolvedValue({
      data: { id: "email-1" },
      error: null,
    });
    mocks.publicUpdateConfirmationDeliveryIsCurrent.mockResolvedValue(true);
    mocks.markPublicUpdateConfirmationSent.mockResolvedValue({
      sentAt: "2026-08-15T01:00:00.000Z",
    });
  });

  it("fails before database or rate-limit mutation when email is not configured", async () => {
    mocks.hasPublicUpdateDeliveryConfig.mockReturnValue(false);
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.ensurePublicFormRateLimit).not.toHaveBeenCalled();
    expect(mocks.createOrRefreshPublicUpdateSubscription).not.toHaveBeenCalled();
  });

  it("returns the same non-enumerating response for an active subscriber", async () => {
    mocks.createOrRefreshPublicUpdateSubscription.mockResolvedValue({
      subscriberId: "subscriber-1",
      email: "reader@example.org",
      confirmationToken: null,
      shouldSendConfirmation: false,
    });
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.message).toContain("If confirmation is needed");
    expect(payload.message).toContain("expire after 24 hours");
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.sendPublicUpdateConfirmationEmail).not.toHaveBeenCalled();
    expect(mocks.markPublicUpdateConfirmationSent).not.toHaveBeenCalled();
  });

  it.each([
    [{ skipped: true }],
    [{ data: null, error: { message: "provider rejected" } }],
    [{ data: null, error: null }],
    [{ data: { id: "" }, error: null }],
    [{ data: { id: "email-without-explicit-success" } }],
  ])("never claims a confirmation was sent for an unaccepted result", async (delivery) => {
    mocks.sendPublicUpdateConfirmationEmail.mockResolvedValue(delivery);
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain("If confirmation is needed");
    expect(mocks.sendPublicUpdateConfirmationEmail).not.toHaveBeenCalled();
    await runDeferredTasks();
    expect(mocks.markPublicUpdateConfirmationSent).not.toHaveBeenCalled();
  });

  it("does not claim success when the accepted send cannot be bound to the pending token", async () => {
    mocks.markPublicUpdateConfirmationSent.mockRejectedValue(
      new Error("confirmation state changed"),
    );
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain("If confirmation is needed");
    await runDeferredTasks();
    expect(mocks.markPublicUpdateConfirmationSent).toHaveBeenCalledTimes(1);
  });

  it("returns before provider work, then uses the sealed key and records acceptance", async () => {
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.message).toContain("If confirmation is needed");
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.sendPublicUpdateConfirmationEmail).not.toHaveBeenCalled();
    expect(mocks.markPublicUpdateConfirmationSent).not.toHaveBeenCalled();

    await runDeferredTasks();

    expect(mocks.sendPublicUpdateConfirmationEmail).toHaveBeenCalledWith({
      to: "reader@example.org",
      confirmUrl:
        "https://awardping.test/api/public-updates/confirm?token=token-1",
      idempotencyKey: `awardping-public-confirmation:${"a".repeat(64)}`,
    });
    expect(mocks.markPublicUpdateConfirmationSent).toHaveBeenCalledWith({
      subscriberId: "subscriber-1",
      confirmationToken: "token-1",
      confirmationAttemptSeal: "2026-08-15T01:00:00.000Z",
    });
  });

  it("skips deferred delivery when the sealed attempt is no longer current", async () => {
    mocks.publicUpdateConfirmationDeliveryIsCurrent.mockResolvedValue(false);

    const response = await POST(request());
    expect(response.status).toBe(202);

    await runDeferredTasks();
    expect(mocks.sendPublicUpdateConfirmationEmail).not.toHaveBeenCalled();
    expect(mocks.markPublicUpdateConfirmationSent).not.toHaveBeenCalled();
  });

  it("keeps the attempt retryable when deferred delivery throws", async () => {
    mocks.sendPublicUpdateConfirmationEmail.mockRejectedValue(
      new Error("provider unavailable"),
    );

    const response = await POST(request());
    expect(response.status).toBe(202);

    await runDeferredTasks();
    expect(mocks.markPublicUpdateConfirmationSent).not.toHaveBeenCalled();
  });
});

async function runDeferredTasks() {
  const tasks = mocks.deferredTasks.splice(0);
  for (const task of tasks) await task();
}
