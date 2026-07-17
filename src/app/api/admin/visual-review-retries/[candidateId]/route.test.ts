import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  isSiteAdminEmail: vi.fn(),
  hasSupabaseConfig: vi.fn(),
  hasSupabaseAdminConfig: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUser: mocks.getCurrentUser,
  isSiteAdminEmail: mocks.isSiteAdminEmail,
}));
vi.mock("@/lib/config", () => ({
  hasSupabaseConfig: mocks.hasSupabaseConfig,
  hasSupabaseAdminConfig: mocks.hasSupabaseAdminConfig,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { POST } from "@/app/api/admin/visual-review-retries/[candidateId]/route";

const candidateId = "10000000-0000-4000-8000-000000000001";
const updatedAt = "2026-07-16T20:00:00.000Z";

describe("admin paid visual-review retry approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      id: "admin-1",
      email: "admin@awardping.test",
    });
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.createSupabaseAdminClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({
      data: {
        id: "20000000-0000-4000-8000-000000000002",
        candidate_id: candidateId,
        lane_key: "changed_page_review",
        expires_at: "2026-07-17T20:00:00.000Z",
        status: "approved",
      },
      error: null,
    });
  });

  it.each([null, "https://attacker.test"])(
    "rejects a %s Origin before authentication",
    async (origin) => {
      const response = await POST(request(origin), props());

      expect(response.status).toBe(403);
      expect(mocks.getCurrentUser).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("requires a site admin and server-side Supabase", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValueOnce(false);
    const unavailable = await POST(request(), props());
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    const unauthenticated = await POST(request(), props());
    mocks.getCurrentUser.mockResolvedValueOnce({
      id: "viewer-1",
      email: "viewer@awardping.test",
    });
    mocks.isSiteAdminEmail.mockReturnValueOnce(false);
    const forbidden = await POST(request(), props());

    expect(unavailable.status).toBe(503);
    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("records one exact, expiring approval without creating the retry itself", async () => {
    const response = await POST(request(), props());

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "approve_visual_review_paid_retry",
      {
        p_candidate_id: candidateId,
        p_expected_candidate_updated_at: updatedAt,
        p_reason: "Reviewed exact failure evidence.",
        p_actor: "admin@awardping.test",
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      approval: {
        candidateId,
        laneKey: "changed_page_review",
        status: "approved",
      },
    });
  });

  it("fails closed on stale or provider-ambiguous candidates", async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "40001", message: "secret changed before approval" },
    });
    const stale = await POST(request(), props());
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "23514", message: "secret external provider state" },
    });
    const unsafe = await POST(request(), props());

    expect(stale.status).toBe(409);
    expect(unsafe.status).toBe(422);
    await expect(stale.json()).resolves.not.toMatchObject({
      error: expect.stringContaining("secret"),
    });
    await expect(unsafe.json()).resolves.not.toMatchObject({
      error: expect.stringContaining("secret"),
    });
  });
});

function props() {
  return { params: Promise.resolve({ candidateId }) };
}

function request(origin: string | null = "https://awardping.test") {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin) headers.set("origin", origin);
  return new Request(
    `https://awardping.test/api/admin/visual-review-retries/${candidateId}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedCandidateUpdatedAt: updatedAt,
        reason: "Reviewed exact failure evidence.",
      }),
    },
  );
}
