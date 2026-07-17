import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requireOfficeContext: vi.fn(),
  requireOfficeRole: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
  single: vi.fn(),
  sendOfficeInviteEmail: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/config", () => ({ appConfig: { url: "https://awardping.test" } }));
vi.mock("@/lib/email", () => ({
  sendOfficeInviteEmail: mocks.sendOfficeInviteEmail,
}));
vi.mock("@/lib/offices", () => ({
  requireOfficeContext: mocks.requireOfficeContext,
  requireOfficeRole: mocks.requireOfficeRole,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocks.createSupabaseAdminClient,
}));

import { POST } from "./route";

describe("office invitation creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@example.edu",
    });
    mocks.requireOfficeContext.mockResolvedValue({
      current: {
        officeId: "22222222-2222-4222-8222-222222222222",
        officeName: "Fellowships Office",
      },
    });
    mocks.requireOfficeRole.mockResolvedValue(undefined);

    const builder = {
      insert: mocks.insert,
      select: mocks.select,
      single: mocks.single,
    };
    mocks.insert.mockReturnValue(builder);
    mocks.select.mockReturnValue(builder);
    mocks.single.mockImplementation(async () => {
      const inserted = mocks.insert.mock.calls.at(-1)?.[0];
      return {
        data: {
          id: "33333333-3333-4333-8333-333333333333",
          ...inserted,
          expires_at: "2026-07-30T00:00:00.000Z",
        },
        error: null,
      };
    });
    mocks.from.mockReturnValue(builder);
    mocks.createSupabaseAdminClient.mockReturnValue({ from: mocks.from });
    mocks.sendOfficeInviteEmail.mockResolvedValue({ data: { id: "email-1" }, error: null });
  });

  it("rejects cross-origin creation before reading the account", async () => {
    const response = await createInvite("https://evil.test");

    expect(response.status).toBe(403);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects an email-less invite before creating a database row", async () => {
    const response = await createInvite("https://awardping.test", {});

    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.sendOfficeInviteEmail).not.toHaveBeenCalled();
  });

  it("emails a strong bearer URL and retains a high-entropy fallback code", async () => {
    const response = await createInvite();
    const payload = await response.json();
    const inserted = mocks.insert.mock.calls[0][0];

    expect(response.status).toBe(200);
    expect(inserted.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.invite_code).toMatch(/^[A-F0-9]{32}$/);
    expect(inserted.email).toBe("advisor@example.edu");
    expect(payload.inviteUrl).toMatch(/^https:\/\/awardping\.test\/join\/[A-Za-z0-9_-]{32}$/);
    expect(payload.inviteUrl).not.toContain(inserted.invite_code);
    expect(payload.deliveryStatus).toBe("sent");
    expect(mocks.sendOfficeInviteEmail).toHaveBeenCalledWith({
      to: "advisor@example.edu",
      officeName: "Fellowships Office",
      inviteUrl: payload.inviteUrl,
    });
  });

  it("reports email delivery truthfully while preserving the secure copy link", async () => {
    mocks.sendOfficeInviteEmail.mockResolvedValue({ skipped: true });

    const response = await createInvite();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.deliveryStatus).toBe("not_configured");
    expect(payload.inviteUrl).toMatch(/^https:\/\/awardping\.test\/join\//);
  });
});

function createInvite(
  origin = "https://awardping.test",
  body: Record<string, string> = { email: "Advisor@Example.edu", role: "member" },
) {
  return POST(
    new Request("https://awardping.test/api/offices/invites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify(body),
    }),
  );
}
