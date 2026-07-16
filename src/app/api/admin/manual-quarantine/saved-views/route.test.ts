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

import {
  DELETE,
  POST,
} from "@/app/api/admin/manual-quarantine/saved-views/route";

const actorId = "10000000-0000-4000-8000-000000000001";
const viewId = "20000000-0000-4000-8000-000000000002";

describe("manual quarantine saved-view routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSupabaseConfig.mockReturnValue(true);
    mocks.hasSupabaseAdminConfig.mockReturnValue(true);
    mocks.getCurrentUser.mockResolvedValue({
      id: actorId,
      email: "admin@awardping.test",
    });
    mocks.isSiteAdminEmail.mockReturnValue(true);
    mocks.createSupabaseAdminClient.mockReturnValue({ rpc: mocks.rpc });
    mocks.rpc.mockImplementation((name: string) =>
      name === "delete_manual_quarantine_saved_view"
        ? Promise.resolve({ data: true, error: null })
        : Promise.resolve({
            data: [
              {
                saved_view_id: viewId,
                saved_view_name: "My queue",
                saved_updated_at: "2026-07-16T12:00:00.000Z",
              },
            ],
            error: null,
          }),
    );
  });

  it("checks same-origin before auth for both mutations", async () => {
    const save = await POST(saveRequest(validSaveBody(), null));
    const remove = await DELETE(deleteRequest({ viewId }, "https://attacker.test"));

    expect(save.status).toBe(403);
    expect(remove.status).toBe(403);
    expect(mocks.getCurrentUser).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns 401 and 403 without constructing a service-role client", async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null);
    const unauthenticated = await POST(saveRequest(validSaveBody()));
    mocks.getCurrentUser.mockResolvedValueOnce({
      id: actorId,
      email: "viewer@awardping.test",
    });
    mocks.isSiteAdminEmail.mockReturnValueOnce(false);
    const forbidden = await DELETE(deleteRequest({ viewId }));

    expect(unauthenticated.status).toBe(401);
    expect(forbidden.status).toBe(403);
    expect(mocks.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("strictly validates save and delete bodies", async () => {
    const invalidSave = await POST(
      saveRequest({ ...validSaveBody(), userId: "browser-controlled" }),
    );
    const invalidDelete = await DELETE(deleteRequest({ viewId: "not-a-uuid" }));

    expect(invalidSave.status).toBe(400);
    expect(invalidDelete.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("binds create, update, and delete ownership to the signed-in user", async () => {
    const save = await POST(saveRequest(validSaveBody()));
    const remove = await DELETE(deleteRequest({ viewId }));

    expect(save.status).toBe(200);
    expect(remove.status).toBe(200);
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      1,
      "save_manual_quarantine_saved_view",
      expect.objectContaining({
        p_user_id: actorId,
        p_user_email: "admin@awardping.test",
        p_view_id: viewId,
      }),
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "delete_manual_quarantine_saved_view",
      { p_view_id: viewId, p_user_id: actorId },
    );
  });

  it("returns a sanitized conflict when a saved-view name is already used", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "23505", message: "private unique-index detail" },
    });

    const response = await POST(saveRequest(validSaveBody()));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.error).not.toContain("private");
  });

  it("returns 503 for a missing saved-view function based on code", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "42883", message: "generic missing function" },
    });

    const response = await POST(saveRequest(validSaveBody()));

    expect(response.status).toBe(503);
  });

  it("sanitizes unexpected database and thrown failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", message: "database password leaked here" },
    });
    const databaseFailure = await POST(saveRequest(validSaveBody()));
    mocks.rpc.mockRejectedValueOnce(new Error("service role key leaked here"));
    const thrownFailure = await DELETE(deleteRequest({ viewId }));
    const databasePayload = await databaseFailure.json();
    const thrownPayload = await thrownFailure.json();

    expect(databaseFailure.status).toBe(500);
    expect(thrownFailure.status).toBe(500);
    expect(databasePayload.error).not.toContain("password");
    expect(thrownPayload.error).not.toContain("service role");
    consoleError.mockRestore();
  });

  it("fails closed on malformed durable save and delete results", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValueOnce({
      data: [{ saved_view_id: viewId }],
      error: null,
    });
    const badSave = await POST(saveRequest(validSaveBody()));
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    const badDelete = await DELETE(deleteRequest({ viewId }));

    expect(badSave.status).toBe(500);
    expect(badDelete.status).toBe(500);
    consoleError.mockRestore();
  });
});

function validSaveBody() {
  return {
    viewId,
    name: "My queue",
    filters: {
      domains: ["example.edu"],
      evidenceFailures: [],
      policyReasons: [],
      repairs: [],
      owners: ["unassigned"],
      statuses: ["quarantined"],
      ageBucket: null,
      search: "",
    },
    groupBy: "domain",
    sort: "oldest",
    pageSize: 25,
  };
}

function saveRequest(body: unknown, origin: string | null = "https://awardping.test") {
  return mutationRequest(
    "https://awardping.test/api/admin/manual-quarantine/saved-views",
    "POST",
    body,
    origin,
  );
}

function deleteRequest(body: unknown, origin: string | null = "https://awardping.test") {
  return mutationRequest(
    "https://awardping.test/api/admin/manual-quarantine/saved-views",
    "DELETE",
    body,
    origin,
  );
}

function mutationRequest(
  url: string,
  method: string,
  body: unknown,
  origin: string | null,
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin !== null) headers.set("origin", origin);
  return new Request(url, { method, headers, body: JSON.stringify(body) });
}
