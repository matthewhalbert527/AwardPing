import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requireOfficeContext: vi.fn(),
  requireOfficeRole: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  rpc: vi.fn(),
  sendOfficeInviteEmail: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/config", () => ({ appConfig: { url: "https://awardping.test" } }));
vi.mock("@/lib/email", () => ({ sendOfficeInviteEmail: mocks.sendOfficeInviteEmail }));
vi.mock("@/lib/offices", () => ({
  requireOfficeContext: mocks.requireOfficeContext,
  requireOfficeRole: mocks.requireOfficeRole,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { POST } from "./route";

const inviteId = "33333333-3333-4333-8333-333333333333";
const officeId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";

describe("legacy office invitation security reissue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: userId, email: "owner@example.edu" });
    mocks.requireOfficeContext.mockResolvedValue({
      current: { officeId, officeName: "Fellowships Office" },
    });
    mocks.requireOfficeRole.mockResolvedValue(undefined);
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "prepare_office_invite_security_reissue") {
        return {
          data: [{ invite_email: "advisor@example.edu", office_name: "Fellowships Office" }],
          error: null,
        };
      }
      return { data: true, error: null };
    });
    mocks.createSupabaseAdminClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.sendOfficeInviteEmail.mockResolvedValue({ data: { id: "email-1" }, error: null });
  });

  it("rejects a cross-origin request before authentication or service access", async () => {
    const response = await requestReissue("https://evil.test");

    expect(response.status).toBe(403);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("atomically prepares and emails a strong replacement invitation", async () => {
    const response = await requestReissue();
    const payload = await response.json();
    const [, prepareArgs] = mocks.rpc.mock.calls[0];

    expect(response.status).toBe(200);
    expect(prepareArgs).toMatchObject({
      p_invite_id: inviteId,
      p_office_id: officeId,
      p_reissued_by: userId,
    });
    expect(prepareArgs.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepareArgs.p_invite_code).toMatch(/^[A-F0-9]{32}$/);
    expect(payload.inviteUrl).toMatch(/^https:\/\/awardping\.test\/join\/[A-Za-z0-9_-]{32}$/);
    expect(payload.inviteUrl).not.toContain(prepareArgs.p_invite_code);
    expect(payload.deliveryStatus).toBe("sent");
    expect(payload.registryUpdated).toBe(true);
    expect(mocks.sendOfficeInviteEmail).toHaveBeenCalledWith({
      to: "advisor@example.edu",
      officeName: "Fellowships Office",
      inviteUrl: payload.inviteUrl,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "record_office_invite_security_reissue_delivery",
      expect.objectContaining({
        p_invite_id: inviteId,
        p_reissued_by: userId,
        p_delivery_status: "sent",
      }),
    );
  });

  it("returns the replacement link and keeps the action open when email is unavailable", async () => {
    mocks.sendOfficeInviteEmail.mockResolvedValue({ skipped: true });

    const response = await requestReissue();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.deliveryStatus).toBe("not_configured");
    expect(payload.inviteUrl).toMatch(/^https:\/\/awardping\.test\/join\//);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "record_office_invite_security_reissue_delivery",
      expect.objectContaining({ p_delivery_status: "not_configured" }),
    );
  });

  it("does not create a replacement for an invite outside the durable reissue registry", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });

    const response = await requestReissue();

    expect(response.status).toBe(404);
    expect(mocks.sendOfficeInviteEmail).not.toHaveBeenCalled();
  });
});

function requestReissue(origin = "https://awardping.test") {
  return POST(
    new Request(`https://awardping.test/api/offices/invites/${inviteId}/reissue`, {
      method: "POST",
      headers: { origin },
    }),
    { params: Promise.resolve({ invite: inviteId }) },
  );
}
