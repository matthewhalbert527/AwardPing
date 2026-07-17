import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/offices", () => ({ officeCookieName: "awardping-office-id" }));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { POST } from "./route";

describe("atomic office invite acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      email: "Advisor@Example.edu",
    });
    mocks.createSupabaseAdminClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({
      data: [{ office_id: "22222222-2222-4222-8222-222222222222" }],
      error: null,
    });
  });

  it("requires an authenticated account", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    const response = await accept("A1B2C3D4E5");

    expect(response.status).toBe(401);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin mutation before reading the account", async () => {
    const response = await accept("A1B2C3D4E5", "https://evil.test");

    expect(response.status).toBe(403);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("delegates the entire membership and invite mutation to one RPC", async () => {
    const response = await accept("A1B2C3D4E5");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      officeId: "22222222-2222-4222-8222-222222222222",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("accept_office_invite_for_user", {
      p_invite_secret: "A1B2C3D4E5",
      p_normalized_email: "advisor@example.edu",
      p_user_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(response.headers.get("set-cookie")).toContain(
      "awardping-office-id=22222222-2222-4222-8222-222222222222",
    );
  });

  it("returns one generic unavailable response for an invalid or failed invite", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });

    const response = await accept("A1B2C3D4E5");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "This invitation is unavailable.",
    });
  });
});

function accept(token: string, origin = "https://awardping.test") {
  return POST(new Request("https://awardping.test/api/offices/invites/accept", {
    method: "POST",
    headers: { origin },
  }), {
    params: Promise.resolve({ invite: token }),
  });
}
