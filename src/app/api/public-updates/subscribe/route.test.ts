import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  deferredTasks: [] as Array<() => Promise<void> | void>,
  hasPublicUpdateDeliveryConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  ensurePublicFormRateLimit: vi.fn(),
  createOrRefreshPublicUpdateSubscription: vi.fn(),
  drainPublicUpdateConfirmationOutbox: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: mocks.after };
});
vi.mock("@/lib/config", () => ({
  hasPublicUpdateDeliveryConfig: mocks.hasPublicUpdateDeliveryConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/public-form-rate-limit", () => ({
  ensurePublicFormRateLimit: mocks.ensurePublicFormRateLimit,
}));
vi.mock("@/lib/public-updates", () => ({
  createOrRefreshPublicUpdateSubscription:
    mocks.createOrRefreshPublicUpdateSubscription,
  drainPublicUpdateConfirmationOutbox:
    mocks.drainPublicUpdateConfirmationOutbox,
}));

import { POST } from "@/app/api/public-updates/subscribe/route";

describe("public-update confirmation enqueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.deferredTasks.length = 0;
    mocks.after.mockImplementation((task) => mocks.deferredTasks.push(task));
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.hasPublicUpdateDeliveryConfig.mockReturnValue(true);
    mocks.ensurePublicFormRateLimit.mockResolvedValue({ allowed: true });
    mocks.createOrRefreshPublicUpdateSubscription.mockResolvedValue({
      outboxId: "89e2ec55-b95e-4e2f-97c3-c67daef39ffc",
      needsDelivery: true,
    });
    mocks.drainPublicUpdateConfirmationOutbox.mockResolvedValue({
      claimed: 1,
      accepted: 1,
    });
  });

  afterEach(() => vi.useRealTimers());

  it("fails before mutation when private delivery configuration is absent", async () => {
    mocks.hasPublicUpdateDeliveryConfig.mockReturnValue(false);
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.ensurePublicFormRateLimit).not.toHaveBeenCalled();
    expect(mocks.createOrRefreshPublicUpdateSubscription).not.toHaveBeenCalled();
  });

  it("returns one delayed non-enumerating response before deferred provider work", async () => {
    const pending = POST(request());
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const response = await pending;
    const payload = await response.json();
    expect(response.status).toBe(202);
    expect(payload.message).toContain("If confirmation is needed");
    expect(payload.message).toContain("expire after 24 hours");
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.drainPublicUpdateConfirmationOutbox).not.toHaveBeenCalled();

    await runDeferredTasks();
    expect(mocks.drainPublicUpdateConfirmationOutbox).toHaveBeenCalledWith({
      outboxId: "89e2ec55-b95e-4e2f-97c3-c67daef39ffc",
    });
  });

  it("uses the same response and deferred path when no new delivery is needed", async () => {
    mocks.createOrRefreshPublicUpdateSubscription.mockResolvedValue({
      outboxId: null,
      needsDelivery: false,
    });

    const response = await completePost();
    expect(response.status).toBe(202);
    expect((await response.json()).message).toContain("If confirmation is needed");
    expect(mocks.after).toHaveBeenCalledOnce();
    await runDeferredTasks();
    expect(mocks.drainPublicUpdateConfirmationOutbox).toHaveBeenCalledWith({
      outboxId: null,
    });
  });

  it("does not enumerate persistence failures in the public response", async () => {
    mocks.createOrRefreshPublicUpdateSubscription.mockRejectedValue(
      new Error("database unavailable"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await completePost();
    expect(response.status).toBe(202);
    expect((await response.json()).message).toContain("If confirmation is needed");
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

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

async function completePost() {
  const pending = POST(request());
  await vi.advanceTimersByTimeAsync(250);
  return pending;
}

async function runDeferredTasks() {
  const tasks = mocks.deferredTasks.splice(0);
  for (const task of tasks) await task();
}
