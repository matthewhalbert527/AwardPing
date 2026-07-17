import { describe, expect, it, vi } from "vitest";
import { loadAdminInviteSecurityReissues } from "@/lib/admin-invite-security-reissues";

describe("admin invite security reissue loader", () => {
  it("loads every unresolved reissue with its office owner context", async () => {
    const reissueRows = [{
      invite_id: "33333333-3333-4333-8333-333333333333",
      office_id: "22222222-2222-4222-8222-222222222222",
      email_hash: "a".repeat(64),
      status: "pending_reissue",
      rotated_at: "2026-07-15T17:00:00.000Z",
      replacement_prepared_at: null,
      delivery_status: null,
      last_error: null,
    }];
    const reissueQuery = chainResult({ data: reissueRows, error: null });
    const officeQuery = chainResult({
      data: [{ id: reissueRows[0].office_id, name: "Fellowships Office" }],
      error: null,
    });
    const admin = {
      from: vi.fn((table: string) =>
        table === "office_invite_security_reissues" ? reissueQuery : officeQuery),
    } as unknown as Parameters<typeof loadAdminInviteSecurityReissues>[0];

    const result = await loadAdminInviteSecurityReissues(admin);

    expect(result.loadErrors).toEqual([]);
    expect(result.reissues).toEqual([expect.objectContaining({
      inviteId: reissueRows[0].invite_id,
      officeName: "Fellowships Office",
      status: "pending_reissue",
      emailHash: "a".repeat(64),
    })]);
    expect(reissueQuery.neq).toHaveBeenCalledWith("status", "delivered");
    expect(officeQuery.in).toHaveBeenCalledWith("id", [reissueRows[0].office_id]);
  });

  it("fails closed when the durable registry cannot be read", async () => {
    const reissueQuery = chainResult({
      data: null,
      error: { message: "relation is unavailable" },
    });
    const admin = {
      from: vi.fn(() => reissueQuery),
    } as unknown as Parameters<typeof loadAdminInviteSecurityReissues>[0];

    const result = await loadAdminInviteSecurityReissues(admin);

    expect(result.reissues).toEqual([]);
    expect(result.loadErrors).toEqual([
      "Invite security reissues: relation is unavailable",
    ]);
  });
});

function chainResult(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(),
    neq: vi.fn(),
    order: vi.fn(),
    in: vi.fn(),
    then: (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  };
  builder.select.mockReturnValue(builder);
  builder.neq.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  return builder;
}
