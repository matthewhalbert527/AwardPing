import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasSupabaseAdminConfig: vi.fn(),
  confirmPublicUpdateSubscription: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: { url: "https://awardping.test" },
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/public-updates", () => ({
  confirmPublicUpdateSubscription: mocks.confirmPublicUpdateSubscription,
}));

import { GET } from "@/app/api/public-updates/confirm/route";

describe("public-update confirmation activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.confirmPublicUpdateSubscription.mockResolvedValue(true);
  });

  it("fails closed before activation when database authority is unavailable", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);
    const response = await GET(
      new Request("https://awardping.test/api/public-updates/confirm?token=token-1"),
    );

    expect(response.headers.get("location")).toBe(
      "https://awardping.test/updates?confirmed=invalid",
    );
    expect(mocks.confirmPublicUpdateSubscription).not.toHaveBeenCalled();
  });

  it("passes only the opaque token to database-authoritative activation", async () => {
    const response = await GET(
      new Request("https://awardping.test/api/public-updates/confirm?token=token-1"),
    );

    expect(mocks.confirmPublicUpdateSubscription).toHaveBeenCalledWith("token-1");
    expect(response.headers.get("location")).toBe(
      "https://awardping.test/updates?confirmed=1",
    );
  });
});
