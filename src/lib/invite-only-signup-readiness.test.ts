import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/config", () => ({
  appConfig: {
    supabaseUrl: "",
    supabaseAnonKey: "",
    supabaseServiceRoleKey: "must-never-be-sent",
  },
}));

import {
  checkInviteOnlySignupReleaseReadiness,
  inviteOnlySignupHostedRequirement,
} from "@/lib/invite-only-signup-readiness";

describe("invite-only signup hosted readiness", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reports ready only when hosted Auth disables public signup", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ disable_signup: true }), { status: 200 }),
    );

    const result = await checkInviteOnlySignupReleaseReadiness({
      supabaseUrl: "https://project.supabase.co/",
      anonKey: "public-anon-key",
      fetchImpl,
    });

    expect(result).toEqual({
      ready: true,
      status: "ready",
      disableSignup: true,
      reason: inviteOnlySignupHostedRequirement,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/settings",
      expect.objectContaining({
        method: "GET",
        headers: { apikey: "public-anon-key" },
        cache: "no-store",
      }),
    );
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain("must-never-be-sent");
  });

  it("fails closed when hosted public signup remains enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ disable_signup: false }), { status: 200 }),
    );

    await expect(
      checkInviteOnlySignupReleaseReadiness({
        supabaseUrl: "https://project.supabase.co",
        anonKey: "public-anon-key",
        fetchImpl,
      }),
    ).resolves.toEqual({
      ready: false,
      status: "unsafe",
      disableSignup: false,
      reason: "Hosted Supabase Auth still permits public signup.",
    });
  });

  it.each([
    new Response("unavailable", { status: 503 }),
    new Response(JSON.stringify({}), { status: 200 }),
  ])("returns unknown when the hosted setting cannot be proven", async (response) => {
    const fetchImpl = vi.fn().mockResolvedValue(response);

    const result = await checkInviteOnlySignupReleaseReadiness({
      supabaseUrl: "https://project.supabase.co",
      anonKey: "public-anon-key",
      fetchImpl,
    });

    expect(result.ready).toBe(false);
    expect(result.status).toBe("unknown");
    expect(result.disableSignup).toBeNull();
  });

  it("does not make a request when public Supabase configuration is missing", async () => {
    const fetchImpl = vi.fn();

    const result = await checkInviteOnlySignupReleaseReadiness({ fetchImpl });

    expect(result.status).toBe("unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
