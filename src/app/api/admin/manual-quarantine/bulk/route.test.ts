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

import { POST } from "@/app/api/admin/manual-quarantine/bulk/route";

const actorId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000002";
const caseId = "30000000-0000-4000-8000-000000000003";

describe("manual quarantine bulk route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      id: actorId,
      email: "Admin@AwardPing.test",
    });
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.createSupabaseAdminClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockResolvedValue({
      data: {
        accepted: true,
        replayed: false,
        request_id: requestId,
        action: "assign_to_me",
        requested: 1,
        changed: 1,
        creates_api_charge: false,
        can_retry: false,
        can_resolve: false,
      },
      error: null,
    });
  });

  it.each([null, "https://attacker.test"])(
    "rejects a %s Origin before authentication",
    async (origin) => {
      const response = await POST(bulkRequest(validBody(), origin));

      expect(response.status).toBe(403);
      expect(mocks.getCurrentUser).not.toHaveBeenCalled();
      expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
    },
  );

  it("returns 503 before authentication when server-side Supabase is unavailable", async () => {
    mocks.hasSupabaseAdminConfig.mockReturnValue(false);

    const response = await POST(bulkRequest(validBody()));

    expect(response.status).toBe(503);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
  });

  it("distinguishes unauthenticated and non-admin callers", async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    const unauthenticated = await POST(bulkRequest(validBody()));
    mocks.getCurrentUser.mockResolvedValueOnce({
      id: actorId,
      email: "viewer@awardping.test",
    });
    mocks.isSiteAdminEmail.mockReturnValueOnce(false);
    const forbidden = await POST(bulkRequest(validBody()));

    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("strictly validates selections and duplicate case IDs", async () => {
    const unknownField = await POST(
      bulkRequest({ ...validBody(), actorUserId: "browser-controlled" }),
    );
    const duplicate = await POST(
      bulkRequest({
        ...validBody(),
        cases: [validCase(), validCase()],
      }),
    );

    expect(unknownField.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("binds the actor to the session and accepts only the no-charge result contract", async () => {
    const response = await POST(bulkRequest(validBody()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      action: "assign_to_me",
      requestId,
      requested: 1,
      changed: 1,
      replayed: false,
      createsApiCharge: false,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "apply_manual_quarantine_bulk_action",
      {
        p_request_id: requestId,
        p_action: "assign_to_me",
        p_actor_user_id: actorId,
        p_actor_email: "Admin@AwardPing.test",
        p_cases: [
          {
            id: caseId,
            evidence_hash: "a".repeat(64),
            status: "quarantined",
            assigned_to_email: "owner@awardping.test",
          },
        ],
      },
    );
  });

  it("returns a sanitized conflict for stale selections", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "40001", message: "secret stale database detail" },
    });

    const response = await POST(bulkRequest(validBody()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).toContain("Refresh");
    expect(payload.error).not.toContain("secret");
  });

  it("returns 503 for a missing RPC based on its database code", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "PGRST202", message: "generic not found" },
    });

    const response = await POST(bulkRequest(validBody()));

    expect(response.status).toBe(503);
  });

  it("sanitizes unexpected database errors and thrown failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", message: "database password leaked here" },
    });
    const databaseFailure = await POST(bulkRequest(validBody()));
    mocks.rpc.mockRejectedValueOnce(new Error("service role key leaked here"));
    const thrownFailure = await POST(bulkRequest(validBody()));
    const databasePayload = await databaseFailure.json();
    const thrownPayload = await thrownFailure.json();

    expect(databaseFailure.status).toBe(500);
    expect(thrownFailure.status).toBe(500);
    expect(databasePayload.error).not.toContain("password");
    expect(thrownPayload.error).not.toContain("service role");
    consoleError.mockRestore();
  });

  it("fails closed when the database response changes request identity", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        accepted: true,
        replayed: false,
        request_id: "40000000-0000-4000-8000-000000000004",
        action: "assign_to_me",
        requested: 1,
        changed: 1,
        creates_api_charge: false,
        can_retry: false,
        can_resolve: false,
      },
      error: null,
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(bulkRequest(validBody()));

    expect(response.status).toBe(500);
    consoleError.mockRestore();
  });
});

function validBody() {
  return {
    requestId,
    action: "assign_to_me",
    cases: [validCase()],
  };
}

function validCase() {
  return {
    id: caseId,
    evidenceHash: "a".repeat(64),
    status: "quarantined",
    assignedToEmail: "Owner@AwardPing.test",
  };
}

function bulkRequest(body: unknown, origin: string | null = "https://awardping.test") {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);
  return new Request("https://awardping.test/api/admin/manual-quarantine/bulk", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
