import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  ensurePublicFormRateLimit: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  resetPasswordForEmail: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  appConfig: { url: "https://awardping.test" },
  hasSupabaseConfig: mocks.hasSupabaseConfig,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("@/lib/public-form-rate-limit", () => ({
  ensurePublicFormRateLimit: mocks.ensurePublicFormRateLimit,
}));

import { POST } from "./route";

describe("password recovery request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.ensurePublicFormRateLimit.mockResolvedValue({
      allowed: true,
      ipHash: "ip-hash",
      reason: null,
      retryAfterSeconds: 0,
    });
    mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    mocks.createSupabaseServerClient.mockResolvedValue({
      auth: { resetPasswordForEmail: mocks.resetPasswordForEmail },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests a recovery link with a canonical server-owned callback", async () => {
    const response = await POST(
      recoveryRequest({
        email: "  Advisor@Example.edu ",
      }),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      message:
        "If an invited AwardPing account uses that email, a password-reset link will arrive shortly.",
    });
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(
      "advisor@example.edu",
      {
        redirectTo:
          "https://awardping.test/auth/confirm",
      },
    );
    expect(mocks.ensurePublicFormRateLimit).toHaveBeenCalledWith({
      request: expect.any(Request),
      kind: "password_recovery",
      limit: 10,
      windowMs: 60 * 60 * 1_000,
    });
  });

  it("returns the same public result when Supabase rejects the request", async () => {
    mocks.resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: { code: "over_email_send_rate_limit", message: "rate limited" },
    });

    const response = await POST(
      recoveryRequest({ email: "missing@example.edu" }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      message:
        "If an invited AwardPing account uses that email, a password-reset link will arrive shortly.",
    });
  });

  it("rejects cross-origin requests before calling Supabase", async () => {
    const response = await POST(
      recoveryRequest(
        { email: "advisor@example.edu" },
        "https://attacker.example",
      ),
    );

    expect(response.status).toBe(403);
    expect(mocks.ensurePublicFormRateLimit).not.toHaveBeenCalled();
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("fails closed when durable rate limiting is unavailable", async () => {
    mocks.ensurePublicFormRateLimit.mockResolvedValue({
      allowed: false,
      ipHash: null,
      reason: "rate_limit_unavailable",
      retryAfterSeconds: 0,
    });

    const response = await POST(
      recoveryRequest({ email: "advisor@example.edu" }),
    );

    expect(response.status).toBe(503);
    expect(mocks.createSupabaseServerClient).not.toHaveBeenCalled();
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("returns a durable retry time after the IP limit is reached", async () => {
    mocks.ensurePublicFormRateLimit.mockResolvedValue({
      allowed: false,
      ipHash: "ip-hash",
      reason: "limit_exceeded",
      retryAfterSeconds: 1_234,
    });

    const response = await POST(
      recoveryRequest({ email: "advisor@example.edu" }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1234");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: false,
      error: "Too many password-reset requests. Try again later.",
    });
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("rejects malformed input without revealing account state", async () => {
    const response = await POST(recoveryRequest({ email: "not-an-email" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Enter a valid email address.",
    });
    expect(mocks.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

function recoveryRequest(
  body: unknown,
  origin = "https://awardping.test",
) {
  return new Request("https://awardping.test/api/auth/password-recovery", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify(body),
  });
}
