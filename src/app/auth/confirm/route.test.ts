import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: mocks.hasSupabaseConfig,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

import { GET } from "./route";

describe("auth confirmation callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.verifyOtp.mockResolvedValue({ data: {}, error: null });
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: { verifyOtp: mocks.verifyOtp },
    });
  });

  it("redirects a successful supported confirmation to a safe local path", async () => {
    const response = await confirmRequest("/join/ABC123?from=email");

    expect(response.headers.get("location")).toBe(
      "https://awardping.test/join/ABC123?from=email",
    );
    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      token_hash: "token-1",
      type: "signup",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("binds recovery verification to the reset page and preserves a safe nested next path", async () => {
    const response = await confirmRequest(
      "/reset-password?next=%2Fupdates%3Faward%3Dmarshall%23recent",
      "recovery",
    );

    expect(response.headers.get("location")).toBe(
      "https://awardping.test/reset-password?next=%2Fupdates%3Faward%3Dmarshall%23recent",
    );
    expect(mocks.verifyOtp).toHaveBeenCalledWith({
      token_hash: "token-1",
      type: "recovery",
    });
  });

  it.each([
    "/updates",
    "/reset-password?next=https%3A%2F%2Fattacker.example%2Fphish",
    "/reset-password?next=%2F%252f%252fattacker.example%2Fphish",
  ])("never lets a recovery link bypass the reset page: %s", async (next) => {
    const response = await confirmRequest(next, "recovery");

    expect(response.headers.get("location")).toBe(
      "https://awardping.test/reset-password",
    );
  });

  it.each([
    "https://attacker.example/phish",
    "//attacker.example/phish",
    "/\\attacker.example/phish",
    "/%2e%2e//attacker.example/phish",
    "/.%2e//attacker.example/phish",
    "/safe%0aunsafe",
  ])("never redirects confirmation to an external next target: %s", async (next) => {
    const response = await confirmRequest(next);

    expect(new URL(response.headers.get("location") || "").origin).toBe(
      "https://awardping.test",
    );
    expect(response.headers.get("location")).toBe(
      "https://awardping.test/dashboard/onboarding",
    );
  });

  it("does not continue to the requested page after OTP verification fails", async () => {
    mocks.verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Token has expired" },
    });

    const response = await confirmRequest("/dashboard/private");

    expect(response.headers.get("location")).toBe(
      "https://awardping.test/login?confirmation=invalid",
    );
  });

  it("sends an invalid recovery token to an honest recovery error", async () => {
    mocks.verifyOtp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: "Token has expired" },
    });

    const response = await confirmRequest("/reset-password", "recovery");

    expect(response.headers.get("location")).toBe(
      "https://awardping.test/login?recovery=invalid",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects unsupported OTP types without calling Supabase", async () => {
    const response = await confirmRequest("/dashboard/private", "sms");

    expect(response.headers.get("location")).toBe(
      "https://awardping.test/login?confirmation=invalid",
    );
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });
});

function confirmRequest(next: string, type = "signup") {
  const url = new URL("https://awardping.test/auth/confirm");
  url.searchParams.set("token_hash", "token-1");
  url.searchParams.set("type", type);
  url.searchParams.set("next", next);
  return GET(new Request(url));
}
