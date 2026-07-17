import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configured: true,
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  hasSupabaseAdminConfig: () => mocks.configured,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: mocks.rpc }),
}));

import { ensurePublicFormRateLimit } from "@/lib/public-form-rate-limit";

describe("public form rate-limit reservation", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", "1");
    mocks.configured = true;
    mocks.rpc.mockReset();
  });

  it("uses one atomic RPC and never performs a count-then-insert sequence", async () => {
    let reserved = 0;
    mocks.rpc.mockImplementation(async (_name, args: { p_limit: number }) => {
      const allowed = reserved < args.p_limit;
      if (allowed) reserved += 1;
      return {
        data: {
          allowed,
          remaining: Math.max(0, args.p_limit - reserved),
          retry_after_seconds: allowed ? 0 : 3600,
        },
        error: null,
      };
    });
    const request = new Request("https://awardping.com/api/contact", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.7",
        "x-forwarded-for": "198.51.100.99",
      },
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => ensurePublicFormRateLimit({
        request,
        kind: "contact",
        limit: 5,
        windowMs: 60 * 60 * 1000,
      })),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);
    expect(mocks.rpc).toHaveBeenCalledTimes(20);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reserve_public_form_rate_limit",
      expect.objectContaining({
        p_kind: "contact",
        p_limit: 5,
        p_window_seconds: 3600,
        p_ip_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("fails closed when the atomic reservation service is unavailable", async () => {
    mocks.configured = false;
    const result = await ensurePublicFormRateLimit({
      request: new Request("https://awardping.com/api/contact"),
      kind: "contact",
      limit: 5,
      windowMs: 60_000,
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: "rate_limit_unavailable",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
